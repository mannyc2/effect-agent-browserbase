/**
 * One browser tab: navigation, snapshots, pictures and input.
 *
 * Input dispatch is serialized across the browser's pages. A policy holds outside the input
 * locks while other actions continue; its target is revalidated before dispatch. Element targets are refs from
 * a snapshot; point targets are viewport coordinates in CSS pixels, the same coordinates as a
 * screenshot's pixels. Mouse and keyboard input share a bounded pipeline, so pacing does not
 * wait for each protocol reply. Target lookup happens before the input is sent.
 *
 * @since 0.3.0
 */
import {
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  MutableRef,
  Option,
  Ref,
  Schedule,
  Schema,
  Semaphore,
  Stream,
} from "effect";
import type { CDPSession, Frame as PlaywrightFrame, Page as PlaywrightPage } from "playwright-core";

import {
  BrowserError,
  Closed,
  Failed,
  InvalidRequest,
  NavigationFailed,
  NotActionable,
  NotFound,
  type PolicyDenied,
  PolicyTimeout,
  type Reason,
  StaleRef,
  Timeout,
} from "./BrowserError.ts";
import {
  Action,
  type BrowserEvent,
  CursorChanged,
  KeyChanged,
  PointerPressed,
  PointerReleased,
  TextInserted,
  TrackPerformed,
  TrackPlanned,
  WheelScrolled,
} from "./BrowserEvent.ts";
import { type CaptureStats, type Frame, Image, type ScreencastOptions } from "./Frame.ts";
import * as Capture from "./internal/capture.ts";
import * as BrowserClock from "./internal/clock.ts";
import * as Human from "./internal/human.ts";
import * as Input from "./internal/input.ts";
import * as Keys from "./internal/keys.ts";
import * as Script from "./internal/pageScript.ts";
import * as Url from "./internal/url.ts";
import * as Motion from "./Motion.ts";
import { Snapshot, type SnapshotOptions } from "./Snapshot.ts";

export interface Point {
  readonly x: number;
  readonly y: number;
}

/** A ref from a snapshot, such as `"e12"`, or a viewport point. */
export type Target = string | Point;

/** An integer rectangle in viewport CSS pixels. */
export class Region extends Schema.Class<Region>("effect-browser/Region")({
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/** A crop and its viewport origin: add that origin to a point read from the crop. */
export class Zoom extends Schema.Class<Zoom>("effect-browser/Zoom")({
  page: Schema.String,
  region: Region,
  image: Image,
}) {}

/** The target as it read before input. Point coordinates are never snapped to another position. */
export class ResolvedTarget extends Schema.Class<ResolvedTarget>("effect-browser/ResolvedTarget")({
  point: Schema.Struct({ x: Schema.Finite, y: Schema.Finite }),
  element: Schema.String,
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  cursor: Schema.String,
  href: Schema.optional(Schema.String),
}) {}

export interface ClickOptions {
  readonly button?: "left" | "right" | "middle" | undefined;
  /** 2 for a double click. */
  readonly clickCount?: number | undefined;
  /** Hold the button down this long before releasing it. */
  readonly holdMillis?: number | undefined;
}

export interface TypeOptions {
  /** Type into this field: it is focused first, and its content replaced unless `replace` is false. */
  readonly into?: string | undefined;
  readonly replace?: boolean | undefined;
  /** Press Enter afterwards. */
  readonly submit?: boolean | undefined;
  /** Allow corrected slips when replacing an explicit eligible prose ref while humanized. Sensitive fields stay exact. */
  readonly prose?: boolean | undefined;
}

export interface PressOptions {
  /** Press the keys this many times. */
  readonly times?: number | undefined;
  /** Hold the keys down this long before releasing them, as a game control might need. */
  readonly holdMillis?: number | undefined;
}

export interface ScrollOptions {
  readonly dx?: number | undefined;
  /** Pixels to scroll down; negative scrolls up. Defaults to most of a viewport. */
  readonly dy?: number | undefined;
  /** Scroll whatever is under this point or element. Defaults to the middle of the viewport. */
  readonly at?: Target | undefined;
}

export interface ScreenshotOptions {
  /** Capture a new image even when a screencast frame is available. */
  readonly fresh?: boolean | undefined;
  /** A region of the viewport, captured in CSS pixels at the viewport's own scale. */
  readonly clip?:
    | { readonly x: number; readonly y: number; readonly width: number; readonly height: number }
    | undefined;
  /** JPEG quality, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
}

/** What to include in an observation of the current viewport. */
export type ObservationMode = "outline" | "screenshot" | "both";

/** One observation, suitable for passing between an agent and its consumer. */
export class Observation extends Schema.Class<Observation>("effect-browser/Observation")({
  snapshot: Schema.optional(Snapshot),
  image: Schema.optional(Image),
  /** Host monotonic milliseconds from the browser's captured Effect Clock. */
  at: Schema.Finite,
}) {}

/** Signals inferred from the target and the action, rather than a guarantee of its consequences. */
export const Classification = Script.Classification;

export type Classification = typeof Classification.Type;

/** What a guard sees before input reaches the page. Preparation never scrolls or focuses. */
export class InputRequest extends Schema.Class<InputRequest>("effect-browser/InputRequest")({
  page: Schema.String,
  action: Schema.String,
  target: Schema.optional(Schema.String),
  element: Schema.optional(Schema.String),
  /** Literal pixel targets only; ref coordinates are resolved after the policy allows them. */
  point: Schema.optional(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
  text: Schema.optional(Schema.String),
  role: Schema.optional(Schema.NullOr(Schema.String)),
  name: Schema.optional(Schema.String),
  href: Schema.optional(Schema.String),
  destination: Schema.optional(Schema.String),
  classifications: Schema.Array(Classification),
}) {}

/** Succeed to allow, fail to deny, or await an external signal to hold the input. */
export type InputGuard = (request: InputRequest) => Effect.Effect<void, PolicyDenied>;

export interface Settings {
  readonly actionTimeout: Duration.Duration;
  readonly policyTimeout: Duration.Duration;
  readonly navigationTimeout: Duration.Duration;
  /** Move the pointer along curved paths and type with human pacing, for watched browsing. */
  readonly humanize: boolean;
  /** Screencast frames kept for `recentFrames`. */
  readonly frameHistory: number;
  readonly guard: InputGuard | undefined;
}

export interface Page {
  readonly id: string;
  /** The Playwright page, for anything this API does not cover. Never give it to a model. */
  readonly playwright: PlaywrightPage;
  readonly url: Effect.Effect<string>;
  readonly title: Effect.Effect<string, BrowserError>;

  readonly goto: (url: string) => Effect.Effect<void, BrowserError>;
  readonly back: Effect.Effect<void, BrowserError>;
  readonly reload: Effect.Effect<void, BrowserError>;
  /** Make this the visible tab. Background tabs paint rarely and send few screencast frames. */
  readonly bringToFront: Effect.Effect<void, BrowserError>;
  readonly close: Effect.Effect<void>;

  readonly snapshot: (options?: SnapshotOptions) => Effect.Effect<Snapshot, BrowserError>;
  /** A picture of the viewport: the latest screencast frame when one is current, else a screenshot. */
  readonly screenshot: (options?: ScreenshotOptions) => Effect.Effect<Image, BrowserError>;
  /** A crop in CSS pixels, unmagnified, with the origin that keeps later input in viewport pixels. */
  readonly zoom: (region: Region) => Effect.Effect<Zoom, BrowserError>;
  /** An outline, a picture, or both (the default), taken together. */
  readonly observe: (options?: {
    readonly mode?: ObservationMode;
    readonly full?: boolean;
    readonly maxChars?: number;
  }) => Effect.Effect<Observation, BrowserError>;
  readonly hasText: (text: string) => Effect.Effect<boolean, BrowserError>;

  readonly click: (
    target: Target,
    options?: ClickOptions,
  ) => Effect.Effect<ResolvedTarget, BrowserError>;
  readonly hover: (target: Target) => Effect.Effect<void, BrowserError>;
  readonly drag: (from: Target, to: Target) => Effect.Effect<void, BrowserError>;
  readonly type: (text: string, options?: TypeOptions) => Effect.Effect<void, BrowserError>;
  /** Keys such as `"Enter"`, `"Space"`, `"ArrowLeft"` or `"Control+A"`. */
  readonly press: (keys: string, options?: PressOptions) => Effect.Effect<void, BrowserError>;
  readonly scroll: (options?: ScrollOptions) => Effect.Effect<void, BrowserError>;
  /** Choose options of a `<select>` by value or label; returns the chosen labels. */
  readonly select: (
    ref: string,
    values: ReadonlyArray<string>,
  ) => Effect.Effect<string, BrowserError>;

  readonly waitForText: (
    text: string,
    timeout?: Duration.Input,
  ) => Effect.Effect<void, BrowserError>;
  /** Wait until the screen stops changing, such as reels coming to rest. Needs no running screencast. */
  readonly waitForStill: (options?: {
    readonly quietMillis?: number;
    readonly timeout?: Duration.Input;
  }) => Effect.Effect<void, BrowserError>;

  /** Screencast frames for as long as the stream runs. Concurrent streams share one screencast. */
  readonly screencast: (options?: ScreencastOptions) => Stream.Stream<Frame, BrowserError>;
  /** Native delivery, filtering and observed subscriber loss across capture generations. */
  readonly captureStats: Effect.Effect<CaptureStats>;
  readonly latestFrame: Effect.Effect<Option.Option<Frame>>;
  /** The frames received in the last `frameHistory` frames, oldest first. */
  readonly recentFrames: Effect.Effect<ReadonlyArray<Frame>>;
}

const messageOf = (cause: unknown): string =>
  cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "unknown error";

const closedPattern =
  /has been closed|Target closed|Session closed|browser has disconnected|Target page, context or browser/i;

/** A call to the page script, its arguments quoted as JavaScript literals. */
const scriptCall = (name: string, ...args: ReadonlyArray<unknown>): string =>
  `${name}(${args.map((arg) => JSON.stringify(arg)).join(", ")})`;

/**
 * Map a Playwright or protocol failure to a reason. A call that gives Playwright a timeout passes
 * the same bound, so its `Timeout` reports it; without one, Playwright's own message stays.
 */
export const reasonOf = (cause: unknown, timeoutMillis?: number): Reason => {
  const message = messageOf(cause);

  if (closedPattern.test(message)) return new Closed();
  if (cause instanceof Error && cause.name === "TimeoutError" && timeoutMillis !== undefined)
    return new Timeout({ millis: timeoutMillis });
  const line = message.split("\n")[0] ?? message;

  return new Failed({ detail: line.replace(/^[\w.]+: /, "") });
};

const contextGone = (error: BrowserError) =>
  error.reason._tag === "Failed" &&
  /Cannot find context|Execution context was destroyed|__effectBrowser|Inspected target navigated/i.test(
    error.reason.detail,
  );

/** Read a JPEG's dimensions from its start-of-frame marker. */
export const jpegSize = (
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined => {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);

    if (marker >= 0xc0 && marker <= 0xc3)
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
      };
    offset += 2 + length;
  }

  return undefined;
};

export interface MakeOptions {
  readonly id: string;
  readonly playwright: PlaywrightPage;
  readonly cdp: CDPSession;
  readonly settings: Settings;
  readonly motion: Motion.Service;
  readonly clock: Clock.Clock;
  /** The browser's epoch mapping; pages measure it only when the browser has none. */
  readonly mapping: BrowserClock.Mapping;
  readonly pointer: Ref.Ref<Option.Option<Point>>;
  readonly inputLock: Semaphore.Semaphore;
  readonly publish: (event: BrowserEvent) => number;
}

type MouseEvent = {
  readonly type: "mouseMoved" | "mousePressed" | "mouseReleased" | "mouseWheel";
  readonly x: number;
  readonly y: number;
  readonly button?: "none" | "left" | "right" | "middle";
  readonly buttons?: number;
  readonly clickCount?: number;
  readonly deltaX?: number;
  readonly deltaY?: number;
};

const buttonMask = { none: 0, left: 1, right: 2, middle: 4 } as const;

export const make = Effect.fnUntraced(function* (options: MakeOptions) {
  const { id, playwright, cdp, settings, motion, clock, mapping, pointer, inputLock, publish } =
    options;

  const lock = yield* Semaphore.make(1);
  const world = yield* Ref.make(Option.none<number>());
  const nextRef = yield* Ref.make(1);
  const lastInputAt = yield* Ref.make(0);
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const input = Input.make();
  const inputClocks = new WeakMap<Input.Run, BrowserClock.Estimate>();

  // Every protocol or Playwright call. Errors are undispatched here; `perform` marks them
  // dispatched once input has gone out.
  const native = <A>(operation: string, run: () => Promise<A>, timeoutMillis?: number) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new BrowserError({ operation, reason: reasonOf(cause, timeoutMillis), dispatched: false }),
    });

  // Every run records its mapping when it begins; a missing one leaves Chromium's own receipt time.
  const stamp = (estimate: BrowserClock.Estimate | undefined, at: number) =>
    estimate === undefined ? {} : { timestamp: BrowserClock.toBrowserSeconds(estimate, at) };

  const inputCall = <A>(operation: string, effect: Effect.Effect<A, Input.InputFailure>) =>
    effect.pipe(
      Effect.mapError(
        (error) =>
          new BrowserError({ operation, reason: reasonOf(error.cause), dispatched: false }),
      ),
    );

  const dispatchMouse = (
    event: MouseEvent,
    estimate: BrowserClock.Estimate | undefined,
    submitted?: () => void,
  ) => {
    const at = now();
    const point = { x: event.x, y: event.y };
    const button = event.button ?? "left";

    // Construct boundary data before dispatch: validation must never abandon the native reply.
    const track =
      event.type === "mousePressed" && button !== "none"
        ? new PointerPressed({
            at,
            page: id,
            ...point,
            button,
            clickCount: event.clickCount ?? 1,
          })
        : event.type === "mouseReleased" && button !== "none"
          ? new PointerReleased({
              at,
              page: id,
              ...point,
              button,
              clickCount: event.clickCount ?? 1,
            })
          : event.type === "mouseWheel"
            ? new WheelScrolled({
                at,
                page: id,
                ...point,
                dx: event.deltaX ?? 0,
                dy: event.deltaY ?? 0,
              })
            : undefined;

    const response = cdp.send("Input.dispatchMouseEvent", { ...event, ...stamp(estimate, at) });

    if (event.type === "mouseMoved") MutableRef.set(pointer.ref, Option.some(point));
    if (track !== undefined) publish(track);
    submitted?.();

    return response;
  };

  const sendMouse = (
    operation: string,
    run: Input.Run,
    event: MouseEvent,
    submitted?: () => void,
  ) =>
    inputCall(
      operation,
      Effect.gen(function* () {
        const held = `mouse:${event.button ?? "left"}`;
        const estimate = inputClocks.get(run);

        if (event.type === "mouseReleased") return yield* run.up(held);
        if (event.type === "mousePressed") {
          yield* run.reserve(2);
          yield* run.down(
            held,
            () => dispatchMouse(event, estimate, submitted),
            () =>
              dispatchMouse(
                {
                  type: "mouseReleased",
                  ...Option.getOrElse(Ref.getUnsafe(pointer), () => ({ x: event.x, y: event.y })),
                  button: event.button ?? "left",
                  buttons: 0,
                  clickCount: event.clickCount ?? 1,
                },
                estimate,
              ),
          );
        } else {
          yield* run.reserve(1);
          yield* run.send(() => dispatchMouse(event, estimate, submitted));
        }
      }),
    );

  const dispatchKey = (
    key: string,
    phase: "down" | "up",
    command: (at: number, estimate: BrowserClock.Estimate | undefined) => Promise<unknown>,
    run: Input.Run,
  ) => {
    const at = now();
    const event = new KeyChanged({ at, page: id, key, phase });
    const response = command(at, inputClocks.get(run));

    publish(event);

    return response;
  };

  const flush = (operation: string, run: Input.Run) => inputCall(operation, run.drain);

  const createWorld = (operation: string) =>
    Effect.gen(function* () {
      const tree = yield* native(operation, () => cdp.send("Page.getFrameTree"));

      const created = yield* native(operation, () =>
        cdp.send("Page.createIsolatedWorld", {
          frameId: tree.frameTree.frame.id,
          worldName: "effect-browser",
        }),
      );

      const installed = yield* native(operation, () =>
        cdp.send("Runtime.evaluate", {
          contextId: created.executionContextId,
          expression: `${Script.installSource}.version`,
          returnByValue: true,
        }),
      );

      if (installed.exceptionDetails !== undefined)
        return yield* new BrowserError({
          operation,
          reason: new Failed({ detail: installed.exceptionDetails.text }),
          dispatched: false,
        });
      yield* Ref.set(world, Option.some(created.executionContextId));

      return created.executionContextId;
    });

  const evaluateIn = (operation: string, call: string, contextId: number) =>
    native(operation, () =>
      cdp.send("Runtime.evaluate", {
        contextId,
        expression: `globalThis.__effectBrowser.${call}`,
        returnByValue: true,
      }),
    ).pipe(
      Effect.flatMap((result) =>
        result.exceptionDetails === undefined
          ? Effect.succeed<unknown>(result.result.value)
          : Effect.fail(
              new BrowserError({
                operation,
                reason: new Failed({
                  detail:
                    result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
                }),
                dispatched: false,
              }),
            ),
      ),
    );

  // Ordinary reads can recreate a document's world. Approval validation deliberately cannot.
  const evaluateWithContext = (operation: string, call: string) => {
    const attempt = (contextId: number) =>
      evaluateIn(operation, call, contextId).pipe(Effect.map((value) => ({ contextId, value })));

    return Ref.get(world).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => createWorld(operation), onSome: Effect.succeed }),
      ),
      Effect.flatMap(attempt),
      Effect.catchIf(contextGone, () => createWorld(operation).pipe(Effect.flatMap(attempt))),
    );
  };

  const evaluate = (operation: string, call: string) =>
    evaluateWithContext(operation, call).pipe(Effect.map(({ value }) => value));

  const calibrateClock = evaluateWithContext("calibrate", "version").pipe(
    Effect.flatMap(({ contextId }) =>
      BrowserClock.calibrate(cdp, clock, contextId).pipe(
        Effect.mapError(
          (failure) =>
            new BrowserError({
              operation: "calibrate",
              reason: reasonOf(failure.cause),
              dispatched: false,
            }),
        ),
      ),
    ),
    Effect.timeoutOrElse({
      duration: Duration.seconds(4),
      orElse: () =>
        Effect.fail(
          new BrowserError({
            operation: "calibrate",
            reason: new Timeout({ millis: 4000 }),
            dispatched: false,
          }),
        ),
    }),
    Effect.provideService(Clock.Clock, clock),
  );

  // Input and capture share the owner's monotonic clock; caller-provided clocks cannot move it.
  // Registration measures nothing: a page that is busy while it opens, such as a popup running
  // its first script, must still be tracked. The browser's mapping serves every other page, so
  // only a browser with no estimate yet needs this page's renderer to answer.
  const capture = yield* Capture.make({
    id,
    cdp,
    clock,
    calibrate: mapping.refresh(calibrateClock),
    frameHistory: settings.frameHistory,
    viewport: () => playwright.viewportSize(),
    onClose: (listener) => {
      playwright.on("close", listener);
      if (playwright.isClosed()) listener();

      return () => {
        playwright.off("close", listener);
      };
    },
    imageSize: jpegSize,
    error: (cause) =>
      new BrowserError({ operation: "screencast", reason: reasonOf(cause), dispatched: false }),
  });

  const decodeWith =
    <A>(operation: string, schema: Schema.Codec<A, unknown>) =>
    (value: unknown) =>
      Schema.decodeUnknownEffect(schema)(value).pipe(
        Effect.mapError(
          (error) =>
            new BrowserError({
              operation,
              reason: new Failed({ detail: error.message }),
              dispatched: false,
            }),
        ),
      );

  interface Approval {
    readonly contextId: number;
    readonly targets: ReadonlyArray<Script.InspectedTarget | null>;
    readonly check: (focused?: boolean) => Effect.Effect<void, BrowserError>;
    readonly navigate?: Effect.Effect<void, BrowserError> | undefined;
  }

  interface InputMarks {
    readonly sent: Effect.Effect<void>;
    readonly at: (point: Point) => Effect.Effect<void>;
    readonly input: Input.Run;
  }

  interface PolicyPlan {
    readonly request: InputRequest;
    readonly validate: Effect.Effect<Approval, BrowserError>;
  }

  // Record the whole operation, but never keep the page locked or spend its action timeout
  // while a policy is waiting. Validation binds approval to the document and targets it saw.
  const perform = <A>(
    name: string,
    info: { readonly target?: string | undefined; readonly text?: string | undefined },
    timeout: Duration.Duration,
    prepare: Effect.Effect<PolicyPlan, BrowserError>,
    body: (marks: InputMarks, approval: Approval | undefined) => Effect.Effect<A, BrowserError>,
  ): Effect.Effect<A, BrowserError> =>
    Effect.gen(function* () {
      const startedAt = now();
      const sent = yield* Ref.make(false);
      const at = yield* Ref.make(Option.none<Point>());

      const marks = {
        sent: Ref.set(sent, true),
        at: (point: Point) => Ref.set(at, Option.some(point)),
      };

      const bounded = <Value>(
        effect: Effect.Effect<Value, BrowserError>,
        duration: Duration.Duration,
      ) =>
        effect.pipe(
          Effect.timeoutOrElse({
            duration,
            orElse: () =>
              Effect.fail(
                new BrowserError({
                  operation: name,
                  reason: new Timeout({ millis: Duration.toMillis(duration) }),
                  dispatched: false,
                }),
              ),
          }),
        );

      const useInput = <Value>(action: (run: Input.Run) => Effect.Effect<Value, BrowserError>) =>
        mapping.current(calibrateClock).pipe(
          Effect.mapError(
            (error) =>
              new BrowserError({ operation: name, reason: error.reason, dispatched: false }),
          ),
          // A capture can recalibrate while input is running. One run, including delayed cleanup
          // releases, keeps one mapping so epoch stamps cannot jump backwards during a stroke.
          Effect.flatMap((estimate) =>
            input.begin.pipe(
              Effect.tap((run) => Effect.sync(() => inputClocks.set(run, estimate))),
            ),
          ),
          Effect.flatMap((run) =>
            action(run).pipe(
              Effect.matchEffect({
                onFailure: (error) =>
                  run.close.pipe(
                    Effect.andThen(flush(name, run).pipe(Effect.ignore)),
                    Effect.andThen(Effect.fail(error)),
                  ),
                onSuccess: (value) =>
                  run.close.pipe(Effect.andThen(flush(name, run)), Effect.as(value)),
              }),
              // The finalizer only submits missing releases. It cannot wait forever for a
              // disconnected peer; the page retains those replies and gates its next action.
              Effect.ensuring(run.close),
            ),
          ),
        );

      const dispatch = <Value>(action: Effect.Effect<Value, BrowserError>) =>
        inputLock.withPermits(1)(lock.withPermits(1)(bounded(action, timeout)));

      const guard = settings.guard;

      const run =
        guard === undefined && !settings.humanize
          ? dispatch(useInput((run) => body({ ...marks, input: run }, undefined)))
          : Effect.gen(function* () {
              const plan = yield* lock.withPermits(1)(bounded(prepare, settings.actionTimeout));

              yield* (guard === undefined ? Effect.void : guard(plan.request)).pipe(
                Effect.mapError(
                  (reason) => new BrowserError({ operation: name, reason, dispatched: false }),
                ),
                Effect.timeoutOrElse({
                  duration: settings.policyTimeout,
                  orElse: () =>
                    Effect.fail(
                      new BrowserError({
                        operation: name,
                        reason: new PolicyTimeout({
                          millis: Duration.toMillis(settings.policyTimeout),
                        }),
                        dispatched: false,
                      }),
                    ),
                }),
              );

              return yield* dispatch(
                useInput((run) =>
                  plan.validate.pipe(
                    Effect.flatMap((approval) => body({ ...marks, input: run }, approval)),
                  ),
                ),
              );
            });

      const exit = yield* Effect.exit(run);
      const dispatched = yield* Ref.get(sent);
      const point = yield* Ref.get(at);

      if (dispatched) yield* Ref.set(lastInputAt, now());
      const failure = Exit.isFailure(exit) ? Exit.findErrorOption(exit) : Option.none();

      publish(
        new Action({
          at: now(),
          startedAt,
          page: id,
          name,
          target: info.target,
          text: info.text === undefined ? undefined : info.text.slice(0, 200),
          x: Option.getOrUndefined(Option.map(point, (p) => p.x)),
          y: Option.getOrUndefined(Option.map(point, (p) => p.y)),
          ok: Exit.isSuccess(exit),
          dispatched,
          error: Option.getOrUndefined(Option.map(failure, (error) => error.message)),
        }),
      );
      if (Exit.isSuccess(exit)) return exit.value;
      if (dispatched)
        return yield* Exit.mapError(exit, (error) =>
          error.dispatched
            ? error
            : new BrowserError({
                operation: error.operation,
                reason: error.reason,
                dispatched: true,
              }),
        );

      return yield* exit;
    });

  const failWith = (operation: string, reason: Reason) =>
    Effect.fail(new BrowserError({ operation, reason, dispatched: false }));

  const readPoint = (
    operation: string,
    target: Target,
    approval: Approval | undefined,
    scroll: boolean,
  ) =>
    (approval === undefined
      ? evaluate(operation, scriptCall("point", target, scroll))
      : mutate(operation, scriptCall("point", target, scroll), approval)
    ).pipe(Effect.flatMap(decodeWith(operation, Script.PointResultSchema)));

  const pointFailure = (
    operation: string,
    target: Target,
    result: Extract<Script.PointResult, { readonly error: string }>,
  ) =>
    failWith(
      operation,
      result.error === "stale" && typeof target === "string"
        ? new StaleRef({ ref: target })
        : result.error === "outside"
          ? new InvalidRequest({ detail: result.detail })
          : new NotActionable({ detail: result.detail }),
    );

  const resolve = (operation: string, target: Target, approval?: Approval, scroll = true) => {
    if (typeof target === "string" && !/^e\d+$/.test(target))
      return failWith(
        operation,
        new InvalidRequest({ detail: target + " is not a ref; refs look like e12" }),
      );
    if (typeof target !== "string" && (!Number.isFinite(target.x) || !Number.isFinite(target.y)))
      return failWith(
        operation,
        new InvalidRequest({ detail: "point coordinates must be finite" }),
      );

    return readPoint(operation, target, approval, scroll).pipe(
      Effect.flatMap((result) =>
        "error" in result
          ? pointFailure(operation, target, result)
          : Effect.succeed(resolvedTarget(result)),
      ),
    );
  };

  const resolvedTarget = (result: Script.ResolvedPoint): ResolvedTarget =>
    new ResolvedTarget({
      point: { x: result.x, y: result.y },
      element: result.element,
      role: result.role,
      name: result.name,
      cursor: result.cursor,
      ...(result.href === undefined ? {} : { href: result.href }),
    });

  const preparePolicy = (
    action: string,
    info: { readonly target?: string | undefined; readonly text?: string | undefined },
    targets: Script.InputPlan["targets"],
    flags: {
      readonly submit?: boolean;
      readonly keys?: string;
      readonly destination?: string;
    } = {},
  ): Effect.Effect<PolicyPlan, BrowserError> =>
    Effect.gen(function* () {
      for (const target of targets) {
        if (typeof target === "string" && !/^e\d+$/.test(target))
          return yield* failWith(
            action,
            new InvalidRequest({ detail: `"${target}" is not a ref; refs look like e12` }),
          );
        if (
          target !== null &&
          typeof target !== "string" &&
          (!Number.isFinite(target.x) || !Number.isFinite(target.y))
        )
          return yield* failWith(
            action,
            new InvalidRequest({ detail: "point coordinates must be finite" }),
          );
      }

      const input: Script.InputPlan = {
        action,
        targets,
        submit: flags.submit ?? false,
        keys: flags.keys ?? null,
        destination: flags.destination ?? null,
      };

      const { contextId, value } = yield* evaluateWithContext(
        action,
        scriptCall("prepareInput", input),
      );

      const prepared = yield* decodeWith(action, Script.PreparedInputResultSchema)(value);

      if ("error" in prepared)
        return yield* failWith(
          action,
          prepared.error === "outside"
            ? new InvalidRequest({ detail: prepared.detail })
            : prepared.error === "stale" && typeof targets[0] === "string"
              ? new StaleRef({ ref: targets[0] })
              : new NotActionable({ detail: prepared.detail }),
        );
      const first = prepared.targets[0];
      const target = targets[0];

      const request = new InputRequest({
        page: id,
        action,
        target: info.target,
        text: info.text,
        element: first?.element,
        role: first?.role,
        name: first?.name,
        href: first?.href,
        point: target !== null && typeof target === "object" ? target : undefined,
        destination: prepared.destination,
        classifications: prepared.classifications,
      });

      const check = (focused = false) =>
        evaluateIn(action, scriptCall("validateInput", input, prepared, focused), contextId).pipe(
          Effect.catchIf(contextGone, () =>
            failWith(
              action,
              new NotActionable({ detail: "the page changed while input policy was pending" }),
            ),
          ),
          Effect.flatMap(decodeWith(action, Script.ValidatedInputResultSchema)),
          Effect.flatMap((result) =>
            "error" in result
              ? failWith(action, new NotActionable({ detail: result.detail }))
              : Effect.void,
          ),
        );

      const validate = check().pipe(
        Effect.as<Approval>({
          contextId,
          targets: prepared.targets,
          check,
        }),
      );

      return { request, validate };
    });

  const mutate = (operation: string, call: string, approval: Approval | undefined) =>
    (approval === undefined
      ? Ref.get(world).pipe(
          Effect.flatMap(
            Option.match({ onNone: () => createWorld(operation), onSome: Effect.succeed }),
          ),
          Effect.flatMap((contextId) => evaluateIn(operation, call, contextId)),
        )
      : evaluateIn(operation, call, approval.contextId)
    ).pipe(
      Effect.catchIf(contextGone, () =>
        failWith(
          operation,
          new NotActionable({ detail: "the page changed before the approved input could run" }),
        ),
      ),
    );

  const targetFor = Effect.fnUntraced(function* (
    operation: string,
    target: Target,
    approval: Approval | undefined,
    marks: InputMarks,
  ) {
    if (!settings.humanize || typeof target !== "string")
      return yield* resolve(operation, target, approval);

    // Inspection and policy approval happen before this point. Every retry is geometry only;
    // scrolling never obtains a fresh approval or silently follows a replacement document.
    for (let attempt = 0; attempt < 3; attempt++) {
      const result = yield* readPoint(operation, target, approval, false);

      if (!("error" in result)) return resolvedTarget(result);
      if (result.error !== "offscreen") return yield* pointFailure(operation, target, result);

      const plan = yield* mutate(operation, scriptCall("scrollPlan", target), approval).pipe(
        Effect.flatMap(decodeWith(operation, Script.ScrollPlanSchema)),
      );

      if (plan === null) break;
      const viewport = playwright.viewportSize() ?? { width: 1280, height: 720 };
      const point = { x: plan.x, y: plan.y };

      yield* marks.at(point);
      yield* moveTo(operation, marks, point);
      yield* wheel(
        operation,
        marks.input,
        point,
        Math.max(-viewport.width * 0.9, Math.min(viewport.width * 0.9, plan.dx)),
        Math.max(-viewport.height * 0.9, Math.min(viewport.height * 0.9, plan.dy)),
      );
      yield* flush(operation, marks.input);
      yield* Effect.sleep("150 millis");
      if (approval !== undefined) yield* approval.check();
    }

    // Wheels may be prevented or the target may need unsupported nested/frame geometry. One
    // explicit fallback preserves reachability without a distance-dependent protocol loop.
    yield* marks.sent;
    yield* resolve(operation, target, approval);
    yield* Effect.sleep("150 millis");
    if (approval !== undefined) yield* approval.check();

    return yield* resolve(operation, target, approval, false);
  });

  const moveTo = (
    operation: string,
    marks: InputMarks,
    to: Point,
    cursor?: string,
    dragging = false,
  ) =>
    Effect.gen(function* () {
      const viewport = playwright.viewportSize() ?? { width: 1280, height: 720 };

      const previous = Option.getOrElse(yield* Ref.get(pointer), () => ({
        x: Math.round(viewport.width / 2),
        y: Math.round(viewport.height / 2),
      }));

      const from = {
        x: Math.max(0, Math.min(viewport.width - 1, previous.x)),
        y: Math.max(0, Math.min(viewport.height - 1, previous.y)),
      };

      const planned = settings.humanize
        ? yield* motion.plan(from, to)
        : dragging
          ? Array.from({ length: 8 }, (_, index) => ({
              x: index === 7 ? to.x : from.x + ((to.x - from.x) * (index + 1)) / 8,
              y: index === 7 ? to.y : from.y + ((to.y - from.y) * (index + 1)) / 8,
              afterMillis: (index + 1) * 8,
            }))
          : [{ ...to, afterMillis: 0 }];

      // A custom planner is a boundary. Decoding reads each sample once into a fresh copy and
      // checks that copy, so neither accessors nor later mutation can change what is admitted.
      const invalid = failWith(
        operation,
        new InvalidRequest({
          detail: "motion must be a bounded, ordered schedule ending at the target",
        }),
      );

      const samples = yield* Schema.decodeEffect(Motion.Plan)(planned).pipe(
        Effect.catch(() => invalid),
      );

      if (samples.at(-1)?.x !== to.x || samples.at(-1)?.y !== to.y) return yield* invalid;
      const run = marks.input;

      // Admit the whole motion before starting its clock. Dense original samples must not be
      // stretched by per-sample reply backpressure; unsent reservations belong to this run.
      yield* inputCall(operation, run.reserveMotion(samples.length));
      yield* Ref.set(pointer, Option.some(from));
      const estimate = inputClocks.get(run);
      const at = now();
      let dispatched = 0;
      let last = from;

      // The complete plan exists before its first move. A canceled performer always clips
      // that future to the prefix it actually submitted, including interruption during sleep.
      yield* Effect.acquireUseRelease(
        Effect.sync(() => publish(new TrackPlanned({ at, page: id, from, samples }))),
        () =>
          Effect.gen(function* () {
            for (const sample of samples) {
              const remaining = at + sample.afterMillis - now();

              if (remaining > 0) yield* Effect.sleep(Duration.millis(remaining));
              yield* marks.sent;
              yield* inputCall(
                operation,
                run.send(() =>
                  dispatchMouse(
                    {
                      type: "mouseMoved",
                      x: sample.x,
                      y: sample.y,
                      button: dragging ? "left" : "none",
                      ...(dragging ? { buttons: 1 } : {}),
                    },
                    estimate,
                    () => {
                      dispatched++;
                      last = { x: sample.x, y: sample.y };
                      if (dispatched === samples.length && cursor !== undefined)
                        publish(new CursorChanged({ at: now(), page: id, cursor }));
                    },
                  ),
                ),
              );
            }
          }),
        (plan) =>
          Effect.sync(() =>
            publish(
              new TrackPerformed({
                at: now(),
                page: id,
                plan,
                dispatched,
                ...last,
                complete: dispatched === samples.length,
              }),
            ),
          ),
      );
    });

  const wheel = Effect.fnUntraced(function* (
    operation: string,
    run: Input.Run,
    point: Point,
    dx: number,
    dy: number,
  ) {
    const steps = settings.humanize
      ? Math.max(1, Math.min(8, Math.round(Math.hypot(dx, dy) / 120)))
      : 1;

    for (let index = 0; index < steps; index++) {
      if (index > 0) yield* Effect.sleep(Duration.millis(yield* Human.pause("scroll")));
      yield* sendMouse(operation, run, {
        type: "mouseWheel",
        ...point,
        deltaX: dx / steps,
        deltaY: dy / steps,
      });
    }
  });

  const presentationPause = (kind: "action" | "focus") =>
    settings.humanize
      ? Human.pause(kind).pipe(Effect.flatMap((millis) => Effect.sleep(Duration.millis(millis))))
      : Effect.void;

  // Give a navigation the input started a moment to begin, then wait for its document.
  // Presentation randomness supplements this floor; it can never shorten readiness.
  const settle = Effect.sleep(Duration.millis(settings.humanize ? 250 : 120)).pipe(
    Effect.andThen(
      Effect.tryPromise(() =>
        playwright.waitForLoadState("domcontentloaded", { timeout: 5_000 }),
      ).pipe(Effect.ignore),
    ),
    Effect.andThen(presentationPause("action")),
  );

  const click = (target: Target, clickOptions: ClickOptions = {}) =>
    perform(
      "click",
      { target: typeof target === "string" ? target : `${target.x},${target.y}` },
      settings.actionTimeout,
      Effect.suspend(() =>
        Number.isFinite(clickOptions.clickCount ?? 1)
          ? preparePolicy("click", { target: typeof target === "string" ? target : undefined }, [
              target,
            ])
          : failWith("click", new InvalidRequest({ detail: "clickCount must be finite" })),
      ),
      (marks, approval) =>
        Effect.gen(function* () {
          if (!Number.isFinite(clickOptions.clickCount ?? 1))
            return yield* failWith(
              "click",
              new InvalidRequest({ detail: "clickCount must be finite" }),
            );
          const resolved = yield* targetFor("click", target, approval, marks);
          const { point } = resolved;
          const button = clickOptions.button ?? "left";
          const count = Math.max(1, Math.min(3, clickOptions.clickCount ?? 1));

          yield* marks.at(point);
          yield* moveTo("click", marks, point, resolved.cursor);
          if (approval !== undefined) yield* approval.check();
          for (let index = 1; index <= count; index++) {
            yield* sendMouse("click", marks.input, {
              type: "mousePressed",
              ...point,
              button,
              buttons: buttonMask[button],
              clickCount: index,
            });

            const hold =
              clickOptions.holdMillis ?? (settings.humanize ? yield* Human.pressDelay : 0);

            if (hold > 0) yield* Effect.sleep(Duration.millis(hold));
            yield* sendMouse("click", marks.input, {
              type: "mouseReleased",
              ...point,
              button,
              buttons: 0,
              clickCount: index,
            });
          }
          yield* flush("click", marks.input);
          yield* settle;

          return resolved;
        }),
    );

  const hover = (target: Target) =>
    perform(
      "hover",
      { target: typeof target === "string" ? target : `${target.x},${target.y}` },
      settings.actionTimeout,
      preparePolicy("hover", { target: typeof target === "string" ? target : undefined }, [target]),
      (marks, approval) =>
        Effect.gen(function* () {
          const resolved = yield* targetFor("hover", target, approval, marks);
          const { point } = resolved;

          yield* marks.at(point);
          yield* moveTo("hover", marks, point, resolved.cursor);
          yield* flush("hover", marks.input);
        }),
    );

  const drag = (from: Target, to: Target) =>
    perform(
      "drag",
      { target: `${JSON.stringify(from)} -> ${JSON.stringify(to)}` },
      settings.actionTimeout,
      preparePolicy("drag", {}, [from, to]),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* targetFor("drag", from, approval, marks);
          yield* targetFor("drag", to, approval, marks);
          // Bringing the second endpoint into view may move the first. Both must still be
          // actionable in the final viewport before the first button press.
          const start = yield* resolve("drag", from, approval, false);
          const end = yield* resolve("drag", to, approval, false);

          yield* marks.at(end.point);
          yield* moveTo("drag", marks, start.point, start.cursor);
          if (approval !== undefined) yield* approval.check();
          yield* sendMouse("drag", marks.input, {
            type: "mousePressed",
            ...start.point,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          yield* moveTo("drag", marks, end.point, end.cursor, true);
          yield* sendMouse("drag", marks.input, {
            type: "mouseReleased",
            ...end.point,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          yield* flush("drag", marks.input);
        }),
    );

  const keyStroke = (
    operation: string,
    run: Input.Run,
    parts: ReadonlyArray<string>,
    holdMillis = 0,
  ) =>
    Effect.gen(function* () {
      yield* inputCall(operation, run.reserve(parts.length * 2));
      for (const part of parts)
        yield* inputCall(
          operation,
          run.down(
            `playwright:${part}`,
            () => dispatchKey(part, "down", () => playwright.keyboard.down(part), run),
            () => dispatchKey(part, "up", () => playwright.keyboard.up(part), run),
          ),
        );
      if (holdMillis > 0) yield* Effect.sleep(Duration.millis(holdMillis));
      for (const part of parts.toReversed())
        yield* inputCall(operation, run.up(`playwright:${part}`));
    });

  const typeEvent = (
    run: Input.Run,
    event: { readonly phase: "down" | "up" | "insert"; readonly key: string },
  ) =>
    inputCall(
      "type",
      Effect.gen(function* () {
        if (event.phase === "insert") {
          yield* run.reserve(1);
          yield* run.send(() => {
            const track = new TextInserted({ at: now(), page: id, text: event.key });
            const response = cdp.send("Input.insertText", { text: event.key });

            publish(track);

            return response;
          });

          return;
        }

        const description = Keys.description(event.key);

        if (description === undefined) return yield* Effect.die("invalid planned key");
        const { key, code, keyCode, text } = description;
        const held = "raw:" + code;

        if (event.phase === "up") return yield* run.up(held);
        yield* run.reserve(2);
        yield* run.down(
          held,
          () =>
            dispatchKey(
              key,
              "down",
              (at, estimate) =>
                cdp.send("Input.dispatchKeyEvent", {
                  type: "keyDown",
                  ...stamp(estimate, at),
                  modifiers: 0,
                  windowsVirtualKeyCode: keyCode,
                  code,
                  commands: [],
                  key,
                  text,
                  unmodifiedText: text,
                  autoRepeat: false,
                  location: 0,
                  isKeypad: false,
                }),
              run,
            ),
          () =>
            dispatchKey(
              key,
              "up",
              (at, estimate) =>
                cdp.send("Input.dispatchKeyEvent", {
                  type: "keyUp",
                  ...stamp(estimate, at),
                  modifiers: 0,
                  windowsVirtualKeyCode: keyCode,
                  code,
                  key,
                  location: 0,
                }),
              run,
            ),
        );
      }),
    );

  const typeText = (text: string, typeOptions: TypeOptions = {}) =>
    perform(
      "type",
      { target: typeOptions.into, text },
      Duration.sum(
        settings.actionTimeout,
        Duration.millis(settings.humanize ? Human.typingDuration(text) : 0),
      ),
      preparePolicy("type", { target: typeOptions.into, text }, [typeOptions.into ?? null], {
        submit: typeOptions.submit ?? false,
      }),
      (marks, approval) =>
        Effect.gen(function* () {
          const replace = typeOptions.replace ?? true;
          let corrected = false;

          if (typeOptions.into !== undefined) {
            const ref = typeOptions.into;

            if (!/^e\d+$/.test(ref))
              return yield* failWith(
                "type",
                new InvalidRequest({ detail: `"${ref}" is not a ref; refs look like e12` }),
              );
            const target = yield* targetFor("type", ref, approval, marks);

            yield* marks.at(target.point);
            if (settings.humanize) {
              yield* moveTo("type", marks, target.point, target.cursor);
              yield* sendMouse("type", marks.input, {
                type: "mousePressed",
                ...target.point,
                button: "left",
                buttons: 1,
                clickCount: 1,
              });
              yield* sendMouse("type", marks.input, {
                type: "mouseReleased",
                ...target.point,
                button: "left",
                buttons: 0,
                clickCount: 1,
              });
              yield* flush("type", marks.input);
            }

            // Focusing can run page handlers, including navigation, before the script returns.
            yield* marks.sent;

            const focused = yield* mutate("type", scriptCall("focus", ref, replace), approval).pipe(
              Effect.flatMap(decodeWith("type", Script.EditResultSchema)),
            );

            if ("error" in focused)
              return yield* failWith("type", new NotActionable({ detail: focused.error }));
          }
          yield* presentationPause("focus");
          if (approval !== undefined) yield* approval.check(true);
          yield* marks.sent;
          if (text === "" && replace && typeOptions.into !== undefined)
            yield* keyStroke("type", marks.input, ["Delete"]);
          else {
            // Separate down/up deadlines permit overlapping holds without adding one hold to
            // every inter-key gap. The same bounded run owns all releases and interruptions.
            if (settings.humanize) {
              const prose =
                typeOptions.prose === true &&
                typeOptions.into !== undefined &&
                replace &&
                approval?.targets[0]?.prose === true &&
                !/\d|@|[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b[a-z\d-]+\.[a-z]{2,}\b/i.test(text);

              const plan = yield* Human.typing(text, { prose });

              corrected = plan.events.some((event) => event.key === "Backspace");
              const started = now();

              for (const event of plan.events) {
                yield* Effect.sleep(
                  Duration.millis(Math.max(0, started + event.afterMillis - now())),
                );
                yield* typeEvent(marks.input, event);
              }
            } else {
              for (const character of text) {
                if (Keys.description(character) === undefined)
                  yield* typeEvent(marks.input, { phase: "insert", key: character });
                else {
                  yield* typeEvent(marks.input, { phase: "down", key: character });
                  yield* typeEvent(marks.input, { phase: "up", key: character });
                }
              }
            }
          }
          // Public Playwright keys preserve platform editing commands. Drain the raw text
          // session before Enter uses Playwright's session, so submit cannot overtake typing.
          yield* flush("type", marks.input);
          if (corrected && typeOptions.into !== undefined) {
            const checked = yield* mutate(
              "type",
              scriptCall("checkText", typeOptions.into, text),
              approval,
            ).pipe(Effect.flatMap(decodeWith("type", Script.EditResultSchema)));

            if ("error" in checked)
              return yield* failWith("type", new NotActionable({ detail: checked.error }));
          }
          if (typeOptions.submit === true) {
            yield* keyStroke("type", marks.input, ["Enter"]);
            yield* flush("type", marks.input);
            yield* settle;
          }
        }),
    );

  const press = (keys: string, pressOptions: PressOptions = {}) =>
    perform(
      "press",
      { target: keys },
      settings.actionTimeout,
      Effect.suspend(() => {
        if (!Number.isFinite(pressOptions.times ?? 1))
          return failWith("press", new InvalidRequest({ detail: "times must be finite" }));
        const combination = Keys.normalize(keys);

        return combination === undefined
          ? failWith(
              "press",
              new InvalidRequest({
                detail: `"${keys}" is not a key; try Enter, Space, ArrowLeft or Control+A`,
              }),
            )
          : preparePolicy("press", { text: combination }, [null], { keys: combination });
      }),
      (marks) =>
        Effect.gen(function* () {
          if (!Number.isFinite(pressOptions.times ?? 1))
            return yield* failWith("press", new InvalidRequest({ detail: "times must be finite" }));
          const parts = Keys.parts(keys);

          if (parts === undefined)
            return yield* failWith(
              "press",
              new InvalidRequest({
                detail: `"${keys}" is not a key; try Enter, Space, ArrowLeft or Control+A`,
              }),
            );
          const times = Math.max(1, Math.min(50, pressOptions.times ?? 1));
          const hold = pressOptions.holdMillis ?? 0;
          let due = now();

          yield* marks.sent;
          for (let index = 0; index < times; index++) {
            yield* keyStroke("press", marks.input, parts, hold);
            if (index + 1 < times && settings.humanize) {
              due += hold + (yield* Human.keyDelay);
              yield* Effect.sleep(Duration.millis(Math.max(0, due - now())));
            }
          }
          yield* flush("press", marks.input);
          yield* settle;
        }),
    );

  const scroll = (scrollOptions: ScrollOptions = {}) =>
    Effect.suspend(() => {
      const viewport = playwright.viewportSize() ?? { width: 1280, height: 720 };

      const middle = {
        x: Math.round(viewport.width / 2),
        y: Math.round(viewport.height / 2),
      };

      const target = scrollOptions.at ?? middle;

      const dx = scrollOptions.dx ?? 0;

      const dy =
        scrollOptions.dy ??
        (scrollOptions.dx === undefined ? Math.round(viewport.height * 0.8) : 0);

      const valid =
        Number.isFinite(dx) && Number.isFinite(dy)
          ? Effect.void
          : failWith("scroll", new InvalidRequest({ detail: "scroll deltas must be finite" }));

      return perform(
        "scroll",
        {
          target:
            scrollOptions.at === undefined
              ? undefined
              : typeof scrollOptions.at === "string"
                ? scrollOptions.at
                : `${scrollOptions.at.x},${scrollOptions.at.y}`,
        },
        settings.actionTimeout,
        valid.pipe(
          Effect.andThen(
            preparePolicy("scroll", { target: typeof target === "string" ? target : undefined }, [
              target,
            ]),
          ),
        ),
        (marks, approval) =>
          Effect.gen(function* () {
            yield* valid;

            const resolved =
              approval === undefined && scrollOptions.at === undefined
                ? undefined
                : yield* targetFor("scroll", target, approval, marks);

            const point = resolved?.point ?? middle;

            yield* marks.at(point);
            yield* moveTo("scroll", marks, point, resolved?.cursor);

            yield* wheel("scroll", marks.input, point, dx, dy);
            yield* flush("scroll", marks.input);
            yield* Effect.sleep(Duration.millis(150));
            yield* presentationPause("action");
          }),
      );
    });

  const select = (ref: string, values: ReadonlyArray<string>) =>
    perform(
      "select",
      { target: ref, text: values.join(", ") },
      settings.actionTimeout,
      preparePolicy("select", { target: ref, text: values.join(", ") }, [ref]),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* targetFor("select", ref, approval, marks);

          yield* marks.sent;

          const result = yield* mutate("select", scriptCall("select", ref, values), approval).pipe(
            Effect.flatMap(decodeWith("select", Script.EditResultSchema)),
          );

          return "error" in result
            ? yield* failWith("select", new NotActionable({ detail: result.error }))
            : result.detail;
        }),
    );

  const navigation = (
    name: string,
    run: () => Promise<unknown>,
    url: string,
    prepare = preparePolicy(name, { target: url }, [], { destination: url }),
  ) =>
    perform(name, { target: url }, settings.navigationTimeout, prepare, (marks, approval) =>
      marks.sent.pipe(
        Effect.andThen(approval?.navigate ?? native(name, run)),
        Effect.mapError((error) =>
          error.reason._tag === "Failed" &&
          /net::|NS_ERROR|Cannot navigate/i.test(error.reason.detail)
            ? new BrowserError({
                operation: name,
                reason: new NavigationFailed({ url, detail: error.reason.detail }),
                dispatched: true,
              })
            : error,
        ),
        Effect.asVoid,
      ),
    );

  const prepareBack = Effect.gen(function* () {
    const history = yield* native("back", () => cdp.send("Page.getNavigationHistory"));
    const current = history.entries[history.currentIndex];
    const previous = history.entries[history.currentIndex - 1];

    const plan = yield* preparePolicy(
      "back",
      {},
      [],
      previous === undefined ? {} : { destination: previous.url },
    );

    return {
      request: plan.request,
      validate: Effect.gen(function* () {
        const approval = yield* plan.validate;
        const latestHistory = yield* native("back", () => cdp.send("Page.getNavigationHistory"));

        if (
          latestHistory.currentIndex !== history.currentIndex ||
          latestHistory.entries[latestHistory.currentIndex]?.id !== current?.id ||
          latestHistory.entries[latestHistory.currentIndex - 1]?.id !== previous?.id ||
          latestHistory.entries[latestHistory.currentIndex - 1]?.url !== previous?.url
        )
          return yield* failWith(
            "back",
            new NotActionable({
              detail: "the navigation history changed while input policy was pending",
            }),
          );

        const navigate =
          previous === undefined
            ? Effect.void
            : Effect.gen(function* () {
                const committed = yield* Deferred.make<void>();

                const onNavigation = (frame: PlaywrightFrame) => {
                  if (frame === playwright.mainFrame()) Deferred.doneUnsafe(committed, Effect.void);
                };

                // A history traversal can keep the URL unchanged. Subscribe before dispatch instead
                // of treating an already-matching URL as evidence that the traversal finished.
                yield* Effect.acquireUseRelease(
                  Effect.sync(() => playwright.on("framenavigated", onNavigation)),
                  () =>
                    native("back", () =>
                      cdp.send("Page.navigateToHistoryEntry", { entryId: previous.id }),
                    ).pipe(
                      Effect.andThen(Deferred.await(committed)),
                      Effect.andThen(
                        native("back", () =>
                          playwright.waitForLoadState("domcontentloaded", { timeout: 0 }),
                        ),
                      ),
                      Effect.asVoid,
                    ),
                  () => Effect.sync(() => playwright.off("framenavigated", onNavigation)),
                );
              });

        return { ...approval, navigate };
      }),
    };
  });

  const goto = (url: string) => {
    const parsed = Url.parse(url);

    if (
      parsed === null ||
      !["http:", "https:", "about:", "data:", "file:"].includes(parsed.protocol)
    )
      return failWith("navigate", new InvalidRequest({ detail: `"${url}" is not a URL` }));

    return navigation(
      "navigate",
      () => playwright.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 0 }),
      parsed.href,
    );
  };

  const snapshot = (snapshotOptions: SnapshotOptions = {}) =>
    Effect.gen(function* () {
      const request: Script.SnapshotRequest = {
        full: snapshotOptions.full ?? false,
        query: snapshotOptions.query ?? null,
        maxChars: snapshotOptions.maxChars ?? 12_000,
        firstRef: yield* Ref.get(nextRef),
      };

      const result = yield* evaluate("snapshot", scriptCall("snapshot", request)).pipe(
        Effect.flatMap(decodeWith("snapshot", Script.SnapshotResultSchema)),
      );

      yield* Ref.set(nextRef, result.nextRef);

      return new Snapshot({
        url: result.url,
        title: result.title,
        text: result.text,
        truncated: result.truncated,
        above: result.above,
        below: result.below,
        viewport: { width: result.width, height: result.height },
        scroll: { y: result.scrollY, height: result.scrollHeight },
      });
    }).pipe(
      Effect.timeoutOrElse({
        duration: settings.actionTimeout,
        orElse: () =>
          failWith("snapshot", new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
      }),
    );

  const screenshot = (screenshotOptions: ScreenshotOptions = {}) =>
    Effect.gen(function* () {
      const frame = yield* capture.latest;
      const active = yield* capture.active;
      const since = yield* Ref.get(lastInputAt);

      // Delivery can be delayed. Only paint whose entire clock interval follows input is reusable.
      const viewport = playwright.viewportSize();

      if (
        screenshotOptions.fresh !== true &&
        screenshotOptions.clip === undefined &&
        active &&
        Option.isSome(frame) &&
        frame.value.hostTime - frame.value.timing.uncertaintyMillis > since + 100 &&
        frame.value.width === viewport?.width &&
        frame.value.height === viewport.height
      )
        return frame.value.image;
      const quality = screenshotOptions.quality ?? 80;
      const timeout = Duration.toMillis(settings.actionTimeout);

      const data = yield* native(
        "screenshot",
        () =>
          playwright.screenshot({
            type: "jpeg",
            quality,
            scale: "css",
            timeout,
            ...(screenshotOptions.clip === undefined ? {} : { clip: screenshotOptions.clip }),
          }),
        timeout,
      );

      const size = jpegSize(data) ?? playwright.viewportSize() ?? { width: 0, height: 0 };

      return new Image({ data, mediaType: "image/jpeg", width: size.width, height: size.height });
    });

  const zoom = (requested: Region) =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const region = yield* Schema.decodeEffect(Region)(requested).pipe(
          Effect.mapError(
            (error) =>
              new BrowserError({
                operation: "zoom",
                reason: new InvalidRequest({ detail: error.message }),
                dispatched: false,
              }),
          ),
        );

        const viewport =
          playwright.viewportSize() ??
          (yield* evaluate("zoom", scriptCall("viewport")).pipe(
            Effect.flatMap(decodeWith("zoom", Script.ViewportResultSchema)),
          ));

        if (region.x + region.width > viewport.width || region.y + region.height > viewport.height)
          return yield* failWith(
            "zoom",
            new InvalidRequest({ detail: "the crop must fit entirely within the viewport" }),
          );
        const image = yield* screenshot({ clip: region });

        return new Zoom({ page: id, region, image });
      }).pipe(
        Effect.timeoutOrElse({
          duration: settings.actionTimeout,
          orElse: () =>
            failWith("zoom", new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
        }),
      ),
    );

  const observe = (
    observeOptions: {
      readonly mode?: ObservationMode;
      readonly full?: boolean;
      readonly maxChars?: number;
    } = {},
  ) =>
    Effect.all(
      {
        snapshot:
          observeOptions.mode === "screenshot"
            ? Effect.void
            : snapshot({ full: observeOptions.full, maxChars: observeOptions.maxChars }),
        image: observeOptions.mode === "outline" ? Effect.void : screenshot(),
      },
      { concurrency: 2 },
    ).pipe(
      Effect.map(
        ({ snapshot, image }) =>
          new Observation({
            snapshot: snapshot ?? undefined,
            image: image ?? undefined,
            at: now(),
          }),
      ),
    );

  const hasText = (text: string) =>
    evaluate("hasText", scriptCall("hasText", text)).pipe(
      Effect.flatMap(decodeWith("hasText", Schema.Boolean)),
    );

  const waitForText = (text: string, timeout: Duration.Input = Duration.seconds(10)) =>
    hasText(text).pipe(
      Effect.repeat({ schedule: Schedule.spaced(Duration.millis(250)), until: (found) => found }),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () => failWith("waitForText", new NotFound({ target: JSON.stringify(text) })),
      }),
      Effect.asVoid,
    );

  const screencast = capture.stream;

  const waitForStill = (
    stillOptions: { readonly quietMillis?: number; readonly timeout?: Duration.Input } = {},
  ) => {
    const quiet = stillOptions.quietMillis ?? 600;

    return screencast().pipe(
      Stream.timeout(Duration.millis(quiet)),
      Stream.runDrain,
      Effect.timeoutOrElse({
        duration: stillOptions.timeout ?? Duration.seconds(15),
        orElse: () =>
          failWith(
            "waitForStill",
            new Timeout({
              millis: Duration.toMillis(stillOptions.timeout ?? Duration.seconds(15)),
            }),
          ),
      }),
    );
  };

  const page: Page = {
    id,
    playwright,
    url: Effect.sync(() => playwright.url()),
    title: native("title", () => playwright.title()),
    goto,
    back: navigation(
      "back",
      () => playwright.goBack({ waitUntil: "domcontentloaded", timeout: 0 }),
      "back",
      prepareBack,
    ),
    reload: Effect.suspend(() =>
      navigation(
        "reload",
        () => playwright.reload({ waitUntil: "domcontentloaded", timeout: 0 }),
        playwright.url(),
      ),
    ),
    bringToFront: native("bringToFront", () => playwright.bringToFront()),
    close: Effect.tryPromise(() => playwright.close()).pipe(Effect.ignore),
    snapshot,
    screenshot,
    zoom,
    observe,
    hasText,
    click,
    hover,
    drag,
    type: typeText,
    press,
    scroll,
    select,
    waitForText,
    waitForStill,
    screencast,
    captureStats: capture.stats,
    latestFrame: capture.latest,
    recentFrames: capture.recent,
  };

  return page;
});
