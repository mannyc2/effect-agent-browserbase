/**
 * The page implementation behind `Page.Page`. `Browser` constructs pages and owns the state they
 * share (the browser-wide input lock, clock mapping, pointer and event publication), so
 * construction stays internal.
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
import type { CDPSession, Page as PlaywrightPage } from "playwright-core";

import {
  BrowserError,
  Closed,
  Failed,
  InvalidRequest,
  NavigationFailed,
  NotActionable,
  NotFound,
  PolicyTimeout,
  type Reason,
  StaleRef,
  Timeout,
} from "../BrowserError.ts";
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
} from "../BrowserEvent.ts";
import { Frame, Image, Screenshot } from "../Frame.ts";
import * as Motion from "../Motion.ts";
import {
  type ClickOptions,
  InputRequest,
  Observation,
  type ObservationMode,
  type Page,
  type Point,
  type PressOptions,
  Region,
  ResolvedTarget,
  type ScreenshotOptions,
  type ScrollOptions,
  type Settings,
  type Target,
  type TypeOptions,
  Zoom,
} from "../Page.ts";
import { Snapshot, type SnapshotOptions } from "../Snapshot.ts";
import * as Capture from "./capture.ts";
import * as BrowserClock from "./clock.ts";
import * as Human from "./human.ts";
import * as Input from "./input.ts";
import * as Keys from "./keys.ts";
import * as Script from "./pageScript.ts";
import * as Url from "./url.ts";

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
const jpegSize = (
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

// Several 60 Hz frame intervals: while a page changes, its stream keeps delivering and its newest
// frame is reused; once the stream goes quiet, a real capture is taken. A lost final paint can be
// served for at most this long after the last frame that did arrive. Delivery time, not paint
// time, measures this, so a remote browser's transport delay does not disqualify every frame.
const currentPaintMillis = 250;

export const make = Effect.fnUntraced(function* (options: MakeOptions) {
  const { id, playwright, cdp, settings, motion, clock, mapping, pointer, inputLock, publish } =
    options;

  const lock = yield* Semaphore.make(1);
  const world = yield* Ref.make(Option.none<number>());
  const nextRef = yield* Ref.make(1);
  // Actions that have started changing the page and not yet ended, and the latest submitted input
  // or page change. While an action runs no cached paint is current; afterwards only paint from
  // after its latest input is. An action ends after its input was handled, so if that input changed
  // the page, newer paint follows; a lost final paint is bounded by recency instead.
  let changing = 0;
  let inputAt = 0;

  const noteInput = () => {
    inputAt = Math.max(inputAt, now());
  };

  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  // Deadlines and pacing guard the browser-wide input lock, so page operations run on the
  // owner's clock; a caller's clock, such as a TestClock, cannot stall or stretch them.
  const owned = Effect.provideService(Clock.Clock, clock);

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

    noteInput();
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

    noteInput();
    publish(event);

    return response;
  };

  const dispatchText = (text: string) => {
    const track = new TextInserted({ at: now(), page: id, text });
    const response = cdp.send("Input.insertText", { text });

    noteInput();
    publish(track);

    return response;
  };

  const flush = (operation: string, run: Input.Run) => inputCall(operation, run.drain);

  // A multi-key action stops before its next key once the page has moved to another document.
  // This session counts main-frame commits as the browser reports them, so a key sent within
  // about one protocol round trip of a commit can still reach the new document.
  let documents = 0;
  let watchingDocuments = false;

  cdp.on("Page.frameNavigated", ({ frame }) => {
    if (frame.parentId === undefined) documents++;
  });

  const currentDocument = (operation: string) =>
    Effect.suspend(() =>
      watchingDocuments
        ? Effect.void
        : native(operation, () => cdp.send("Page.enable")).pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                watchingDocuments = true;
              }),
            ),
          ),
    ).pipe(Effect.map(() => documents));

  const sameDocument = (operation: string, since: number) =>
    Effect.suspend(() =>
      documents === since
        ? Effect.void
        : Effect.fail(
            new BrowserError({
              operation,
              reason: new NotActionable({
                detail: "the page moved to another document, so the remaining keys were not sent",
              }),
              dispatched: false,
            }),
          ),
    );

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
        awaitPromise: true,
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
    viewport: Effect.suspend(() => viewportFor("screencast")),
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

  // Playwright knows the viewport only of a context it created; over CDP it reports none, so the
  // page answers. Pointer bounds, page scrolls, crops, capture size and frame reuse all read this
  // one source; the latest answer serves checks that cannot wait for the page.
  let measuredViewport: { readonly width: number; readonly height: number } | null = null;

  const knownViewport = () => playwright.viewportSize() ?? measuredViewport;

  const viewportFor = (operation: string) =>
    Effect.suspend(() => {
      const known = playwright.viewportSize();

      return known === null
        ? evaluate(operation, scriptCall("viewport")).pipe(
            Effect.flatMap(decodeWith(operation, Script.ViewportResultSchema)),
            Effect.tap((measured) =>
              Effect.sync(() => {
                measuredViewport = measured;
              }),
            ),
          )
        : Effect.succeed(known);
    });

  interface Approval {
    readonly contextId: number;
    readonly check: (options?: Script.ValidationOptions) => Effect.Effect<void, BrowserError>;
  }

  interface InputMarks {
    /** The action's own input, such as a press, key or wheel, has reached the page. */
    readonly sent: Effect.Effect<void>;
    /** Preparatory input, such as the pointer travelling to a target, has reached the page. */
    readonly touched: Effect.Effect<void>;
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
    info: {
      readonly target?: string | undefined;
      readonly text?: string | undefined;
      /** False for navigation, which sends no input and leaves the browser-wide lock free. */
      readonly input?: boolean | undefined;
    },
    timeout: Duration.Duration,
    prepare: Effect.Effect<PolicyPlan, BrowserError>,
    body: (marks: InputMarks, approval: Approval | undefined) => Effect.Effect<A, BrowserError>,
  ): Effect.Effect<A, BrowserError> =>
    Effect.gen(function* () {
      const startedAt = now();
      const sendsInput = info.input ?? true;
      const sent = yield* Ref.make(false);
      const at = yield* Ref.make(Option.none<Point>());

      // The page may react to preparatory input, so no cached paint is current while the action
      // runs, but only the action's own input can have given it effect. `touched` covers both and
      // changes in one step with `changing`, so an interruption cannot unbalance the count.
      let touched = false;

      const touch = Effect.sync(() => {
        if (!touched) changing += 1;
        touched = true;
        noteInput();
      });

      const marks = {
        sent: Ref.set(sent, true).pipe(Effect.andThen(touch)),
        touched: touch,
        at: (point: Point) => Ref.set(at, Option.some(point)),
      };

      const timedOut = (duration: Duration.Duration) =>
        Effect.fail(
          new BrowserError({
            operation: name,
            reason: new Timeout({ millis: Duration.toMillis(duration) }),
            dispatched: false,
          }),
        );

      const bounded = <Value>(
        effect: Effect.Effect<Value, BrowserError>,
        duration: Duration.Duration,
      ) => effect.pipe(Effect.timeoutOrElse({ duration, orElse: () => timedOut(duration) }));

      // Admission waits only on this page: its own unresolved replies and, before the browser's
      // first input, its clock mapping. It runs under the page lock but before the browser-wide
      // input lock, so a stalled page cannot delay input on other pages. The run re-checks the
      // replies under both locks.
      let estimate: BrowserClock.Estimate | undefined;

      const admit = input.idle.pipe(
        Effect.andThen(
          sendsInput
            ? mapping.current(calibrateClock).pipe(
                Effect.tap((current) =>
                  Effect.sync(() => {
                    estimate = current;
                  }),
                ),
                Effect.mapError(
                  (error) =>
                    new BrowserError({ operation: name, reason: error.reason, dispatched: false }),
                ),
              )
            : Effect.void,
        ),
      );

      const useInput = <Value>(action: (run: Input.Run) => Effect.Effect<Value, BrowserError>) =>
        input.begin.pipe(
          // A capture can recalibrate while input is running. One run, including delayed cleanup
          // releases, keeps one mapping so epoch stamps cannot jump backwards during a stroke.
          Effect.tap((run) =>
            Effect.sync(() => {
              if (estimate !== undefined) inputClocks.set(run, estimate);
            }),
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

      // Admission and lock waits end at the action's deadline, undispatched. Holding the locks
      // starts a full deadline of its own, so contention never truncates input under way.
      // Locks are always taken page first, then browser-wide, and the browser-wide one is never
      // held while waiting for anything on one page: its navigation, zoom, replies or clock.
      const dispatch = <Value>(action: Effect.Effect<Value, BrowserError>) =>
        Effect.gen(function* () {
          const held = yield* Deferred.make<void>();

          const acquired = Deferred.succeed(held, undefined).pipe(
            Effect.andThen(bounded(action, timeout)),
          );

          const deadline = Effect.sleep(timeout).pipe(
            Effect.andThen(Deferred.isDone(held)),
            Effect.flatMap((done) => (done ? Effect.never : timedOut(timeout))),
          );

          return yield* Effect.raceFirst(
            admit.pipe(
              Effect.andThen(sendsInput ? inputLock.withPermits(1)(acquired) : acquired),
              lock.withPermits(1),
            ),
            deadline,
          );
        });

      const guard = settings.guard;

      // Only an approval needs binding: without a guard, input goes straight to the page.
      const run =
        guard === undefined
          ? dispatch(useInput((run) => body({ ...marks, input: run }, undefined)))
          : Effect.gen(function* () {
              const plan = yield* bounded(lock.withPermits(1)(prepare), settings.actionTimeout);

              yield* guard(plan.request).pipe(
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

      // Record the outcome even when the caller interrupts: its input may already be in the page.
      return yield* Effect.uninterruptibleMask((restore) =>
        Effect.gen(function* () {
          const exit = yield* Effect.exit(restore(run));
          const dispatched = yield* Ref.get(sent);
          const point = yield* Ref.get(at);

          if (touched) changing -= 1;
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
              error: Option.match(failure, {
                onNone: () => (Exit.hasInterrupts(exit) ? "interrupted" : undefined),
                onSome: (error) => error.message,
              }),
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
        }),
      );
    }).pipe(owned);

  const failWith = (operation: string, reason: Reason) =>
    Effect.fail(new BrowserError({ operation, reason, dispatched: false }));

  // A ref that names nothing is stale on every path, named by the target that failed.
  const inputFailure = (
    operation: string,
    targets: Script.InputPlan["targets"],
    failure: Script.InputFailure,
  ) => {
    const target = failure.index === undefined ? undefined : targets[failure.index];

    return failWith(
      operation,
      failure.error === "outside"
        ? new InvalidRequest({ detail: failure.detail })
        : failure.error === "stale" && typeof target === "string"
          ? new StaleRef({ ref: target })
          : new NotActionable({ detail: failure.detail }),
    );
  };

  const editFailure = (
    operation: string,
    ref: string,
    failure: { readonly error: string; readonly stale?: boolean | undefined },
  ) =>
    failWith(
      operation,
      failure.stale === true ? new StaleRef({ ref }) : new NotActionable({ detail: failure.error }),
    );

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

      if ("error" in prepared) return yield* inputFailure(action, targets, prepared);
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

      const check = (options: Script.ValidationOptions = {}) =>
        evaluateIn(action, scriptCall("validateInput", input, prepared, options), contextId).pipe(
          Effect.catchIf(contextGone, () =>
            failWith(
              action,
              new NotActionable({ detail: "the page changed while input policy was pending" }),
            ),
          ),
          Effect.flatMap(decodeWith(action, Script.ValidatedInputResultSchema)),
          Effect.flatMap((result) =>
            "error" in result ? inputFailure(action, targets, result) : Effect.void,
          ),
        );

      const validate = check().pipe(
        Effect.as<Approval>({
          contextId,
          check,
        }),
      );

      return { request, validate };
    });

  // `mayHaveRun` hears of a failure the script may have started before: without its context or
  // the library's API in it, the call never ran.
  const mutate = (
    operation: string,
    call: string,
    approval: Approval | undefined,
    mayHaveRun: Effect.Effect<void> = Effect.void,
  ) =>
    (approval === undefined
      ? Ref.get(world).pipe(
          Effect.flatMap(
            Option.match({ onNone: () => createWorld(operation), onSome: Effect.succeed }),
          ),
        )
      : Effect.succeed(approval.contextId)
    ).pipe(
      Effect.flatMap((contextId) =>
        evaluateIn(operation, call, contextId).pipe(
          Effect.tapError((error) =>
            error.reason._tag === "Failed" &&
            /Cannot find context|__effectBrowser/i.test(error.reason.detail)
              ? Effect.void
              : mayHaveRun,
          ),
        ),
      ),
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
      const viewport = yield* viewportFor(operation);
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
    yield* marks.touched;
    yield* resolve(operation, target, approval);
    yield* Effect.sleep("150 millis");
    if (approval !== undefined) yield* approval.check();

    return yield* resolve(operation, target, approval, false);
  });

  // Travel toward a press only prepares the action; a hover is its travel, and a drag holds the
  // button it has already pressed.
  const moveTo = (
    operation: string,
    marks: InputMarks,
    to: Point,
    cursor?: string,
    travel: "approach" | "hover" | "drag" = "approach",
  ) =>
    Effect.gen(function* () {
      const dragging = travel === "drag";
      const viewport = yield* viewportFor(operation);

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
              yield* travel === "approach" ? marks.touched : marks.sent;
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
          if (approval !== undefined) yield* approval.check({ presses: [{ index: 0, ...point }] });
          yield* marks.sent;
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
          yield* moveTo("hover", marks, point, resolved.cursor, "hover");
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
          // Both ends are checked before the button goes down: once it is down, a release cannot
          // be withheld, and a dragged element under the pointer would hide the drop target.
          if (approval !== undefined)
            yield* approval.check({
              presses: [
                { index: 0, ...start.point },
                { index: 1, ...end.point },
              ],
            });
          yield* marks.sent;
          yield* sendMouse("drag", marks.input, {
            type: "mousePressed",
            ...start.point,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          yield* moveTo("drag", marks, end.point, end.cursor, "drag");
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
          yield* run.send(() => dispatchText(event.key));

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
          const into = typeOptions.into;
          let corrected = false;
          let eligible = false;

          if (into !== undefined && !/^e\d+$/.test(into))
            return yield* failWith(
              "type",
              new InvalidRequest({ detail: `"${into}" is not a ref; refs look like e12` }),
            );

          // A typed space or letter can press a focused button or change a control. Refuse
          // those before any input, on every path.
          const typeable = yield* (
            approval === undefined
              ? evaluate("type", scriptCall("typeable", into ?? null))
              : mutate("type", scriptCall("typeable", into ?? null), approval)
          ).pipe(Effect.flatMap(decodeWith("type", Script.TypeableResultSchema)));

          if ("error" in typeable)
            return yield* failWith(
              "type",
              typeable.error === "stale" && into !== undefined
                ? new StaleRef({ ref: into })
                : new NotActionable({ detail: typeable.detail }),
            );

          const since = yield* currentDocument("type");

          if (into !== undefined) {
            const ref = into;
            const target = yield* targetFor("type", ref, approval, marks);

            yield* marks.at(target.point);
            if (settings.humanize) {
              yield* moveTo("type", marks, target.point, target.cursor);
              if (approval !== undefined)
                yield* approval.check({ presses: [{ index: 0, ...target.point }] });
              yield* marks.sent;
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
              Effect.flatMap(decodeWith("type", Script.FocusResultSchema)),
            );

            if ("error" in focused) return yield* editFailure("type", ref, focused);
            eligible = focused.prose;
          }
          yield* presentationPause("focus");
          if (approval !== undefined) yield* approval.check({ focused: true });
          yield* marks.sent;
          if (text === "" && replace && typeOptions.into !== undefined) {
            yield* sameDocument("type", since);
            yield* keyStroke("type", marks.input, ["Delete"]);
          } else {
            // Separate down/up deadlines permit overlapping holds without adding one hold to
            // every inter-key gap. The same bounded run owns all releases and interruptions.
            if (settings.humanize) {
              const prose =
                typeOptions.prose === true &&
                typeOptions.into !== undefined &&
                replace &&
                eligible &&
                !/\d|@|[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b[a-z\d-]+\.[a-z]{2,}\b/i.test(text);

              const plan = yield* Human.typing(text, { prose });

              corrected = plan.events.some((event) => event.key === "Backspace");
              const started = now();

              for (const event of plan.events) {
                yield* Effect.sleep(
                  Duration.millis(Math.max(0, started + event.afterMillis - now())),
                );
                if (event.phase !== "up") yield* sameDocument("type", since);
                yield* typeEvent(marks.input, event);
              }
            } else {
              for (const character of text) {
                yield* sameDocument("type", since);
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

            if ("error" in checked) return yield* editFailure("type", typeOptions.into, checked);
          }
          if (typeOptions.submit === true) {
            // Typing can move focus or change the form; Enter goes only to the approved field.
            if (approval !== undefined) yield* approval.check({ focused: true });
            yield* sameDocument("type", since);
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
      (marks, approval) =>
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
          const activates = parts.at(-1) === "Enter" || parts.at(-1) === "Space";
          const since = yield* currentDocument("press");
          let due = now();

          yield* marks.sent;
          for (let index = 0; index < times; index++) {
            // A repeated key stays in the document it began in. Under a guard, a repeated Enter
            // or Space must also reach the approved element after the previous press settled.
            if (index > 0 && approval !== undefined && activates) {
              yield* flush("press", marks.input);
              yield* approval.check({ focused: true });
            }
            yield* sameDocument("press", since);
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

  const scroll = (scrollOptions: ScrollOptions = {}) => {
    const target = scrollOptions.at;

    const valid =
      Number.isFinite(scrollOptions.dx ?? 0) && Number.isFinite(scrollOptions.dy ?? 0)
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
          // Scrolling the page has no target: whatever sits mid-viewport is not what is scrolled.
          preparePolicy(
            "scroll",
            { target: typeof target === "string" ? target : undefined },
            target === undefined ? [] : [target],
          ),
        ),
      ),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* valid;
          // Over CDP the page reports its own viewport, so the read shares the action's deadline.
          const viewport = yield* viewportFor("scroll");

          const middle = {
            x: Math.round(viewport.width / 2),
            y: Math.round(viewport.height / 2),
          };

          const dx = scrollOptions.dx ?? 0;

          const dy =
            scrollOptions.dy ??
            (scrollOptions.dx === undefined ? Math.round(viewport.height * 0.8) : 0);

          // A page scroll has no target, but a visible pointer still shows the cursor it lands on.
          const resolved =
            target !== undefined
              ? yield* targetFor("scroll", target, approval, marks)
              : settings.humanize
                ? yield* resolve("scroll", middle, approval).pipe(
                    Effect.orElseSucceed(() => undefined),
                  )
                : undefined;

          const point = resolved?.point ?? middle;

          yield* marks.at(point);
          yield* moveTo("scroll", marks, point, resolved?.cursor);
          yield* marks.sent;
          yield* wheel("scroll", marks.input, point, dx, dy);
          yield* flush("scroll", marks.input);
          yield* Effect.sleep(Duration.millis(150));
          yield* presentationPause("action");
        }),
    );
  };

  const select = (ref: string, values: ReadonlyArray<string>) =>
    perform(
      "select",
      { target: ref, text: values.join(", ") },
      settings.actionTimeout,
      preparePolicy("select", { target: ref, text: values.join(", ") }, [ref]),
      (marks, approval) =>
        Effect.gen(function* () {
          yield* targetFor("select", ref, approval, marks);

          // The script refuses before it changes anything. Only a choice it made, or a script
          // that may have run without an intact answer, may have reached the page.
          const result = yield* mutate(
            "select",
            scriptCall("select", ref, values),
            approval,
            marks.sent,
          ).pipe(
            Effect.flatMap((value) =>
              decodeWith(
                "select",
                Script.EditResultSchema,
              )(value).pipe(Effect.tapError(() => marks.sent)),
            ),
          );

          if ("error" in result) return yield* editFailure("select", ref, result);
          yield* marks.sent;

          return result.detail;
        }),
    );

  const navigation = (name: string, run: () => Promise<unknown>, url: string) =>
    perform(
      name,
      { target: url, input: false },
      settings.navigationTimeout,
      preparePolicy(name, { target: url }, [], { destination: url }),
      (marks) =>
        marks.sent.pipe(
          Effect.andThen(native(name, run)),
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

  const history = native("back", () => cdp.send("Page.getNavigationHistory"));

  // While a traversal swaps documents, Chromium can briefly route this session to the outgoing
  // document, which has become inactive (for instance after it entered the back-forward cache),
  // so a read during the traversal is retried until the session reaches the active document.
  const traversingHistory = history.pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(50)),
      while: (error) =>
        error.reason._tag === "Failed" &&
        /not attached to an active page/i.test(error.reason.detail),
    }),
  );

  const noPrevious = failWith("back", new NotFound({ target: "a previous page in this tab" }));

  const prepareBack = Effect.gen(function* () {
    const before = yield* history;
    const current = before.entries[before.currentIndex];
    const previous = before.entries[before.currentIndex - 1];

    if (previous === undefined) return yield* noPrevious;
    const plan = yield* preparePolicy("back", {}, [], { destination: previous.url });

    return {
      request: plan.request,
      validate: Effect.gen(function* () {
        const approval = yield* plan.validate;
        const latest = yield* history;

        if (
          latest.currentIndex !== before.currentIndex ||
          latest.entries[latest.currentIndex]?.id !== current?.id ||
          latest.entries[latest.currentIndex - 1]?.id !== previous.id ||
          latest.entries[latest.currentIndex - 1]?.url !== previous.url
        )
          return yield* failWith(
            "back",
            new NotActionable({
              detail: "the navigation history changed while input policy was pending",
            }),
          );

        return approval;
      }),
    };
  });

  // One protocol traversal on every path. It has committed once the tab leaves its entry, which
  // also covers entries that only an iframe created, where the main frame never navigates, and
  // entries sharing a URL. A frame navigation then shows Playwright has caught up before the
  // main document's readiness is read.
  const goBack = (marks: InputMarks) =>
    Effect.gen(function* () {
      const before = yield* history;
      const current = before.entries[before.currentIndex];
      const previous = before.entries[before.currentIndex - 1];

      if (current === undefined || previous === undefined) return yield* noPrevious;
      const navigated = yield* Deferred.make<void>();

      const onNavigation = () => {
        Deferred.doneUnsafe(navigated, Effect.void);
      };

      yield* Effect.acquireUseRelease(
        Effect.sync(() => playwright.on("framenavigated", onNavigation)),
        () =>
          Effect.gen(function* () {
            yield* marks.sent;
            yield* native("back", () =>
              cdp.send("Page.navigateToHistoryEntry", { entryId: previous.id }),
            );
            yield* traversingHistory.pipe(
              Effect.repeat({
                schedule: Schedule.spaced(Duration.millis(50)),
                until: (latest) => latest.entries[latest.currentIndex]?.id !== current.id,
              }),
            );
            yield* Deferred.await(navigated);
          }),
        () => Effect.sync(() => playwright.off("framenavigated", onNavigation)),
      );
      yield* native("back", () => playwright.waitForLoadState("domcontentloaded", { timeout: 0 }));
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
      owned,
    );

  // The newest screencast frame, only while it demonstrably shows the viewport now. Delivery can
  // be delayed, so its whole paint interval must follow the latest input, and no action may be
  // changing the page. A screencast sends only changes and can miss a page's final paint, so a
  // quiet stream is no evidence that its newest frame is still current: it must also have been
  // delivered recently, at the viewport's size.
  const currentPaint = Effect.gen(function* () {
    const frame = yield* capture.latest;
    const active = yield* capture.active;
    const viewport = knownViewport();

    return Option.filter(
      frame,
      (latest) =>
        active &&
        changing === 0 &&
        latest.hostTime - latest.timing.uncertaintyMillis > inputAt &&
        latest.receivedAt > now() - currentPaintMillis &&
        latest.width === viewport?.width &&
        latest.height === viewport.height,
    );
  });

  const takeScreenshot = (screenshotOptions: ScreenshotOptions) =>
    Effect.gen(function* () {
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

      const size = jpegSize(data) ?? knownViewport() ?? { width: 0, height: 0 };

      return new Image({ data, mediaType: "image/jpeg", width: size.width, height: size.height });
    });

  const screenshot = (screenshotOptions: ScreenshotOptions = {}) =>
    Effect.gen(function* () {
      const reusable =
        screenshotOptions.fresh === true || screenshotOptions.clip !== undefined
          ? Option.none<Frame>()
          : yield* currentPaint;

      return Option.isSome(reusable)
        ? reusable.value.image
        : yield* takeScreenshot(screenshotOptions);
    });

  // A new screenshot has no paint time, only the host interval in which it was taken.
  const currentFrame = Effect.gen(function* () {
    const reusable = yield* currentPaint;

    if (Option.isSome(reusable)) return reusable.value;
    const startedAt = now();
    const image = yield* takeScreenshot({});
    const finishedAt = now();

    return new Frame({
      page: id,
      data: image.data,
      timing: new Screenshot({
        hostTime: startedAt + (finishedAt - startedAt) / 2,
        uncertaintyMillis: (finishedAt - startedAt) / 2,
      }),
      receivedAt: finishedAt,
      width: image.width,
      height: image.height,
    });
  }).pipe(owned);

  const zoom = (requested: Region) =>
    lock
      .withPermits(1)(
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

          const viewport = yield* viewportFor("zoom");

          if (
            region.x + region.width > viewport.width ||
            region.y + region.height > viewport.height
          )
            return yield* failWith(
              "zoom",
              new InvalidRequest({ detail: "the crop must fit entirely within the viewport" }),
            );
          const image = yield* screenshot({ clip: region });

          return new Zoom({ page: id, region, image });
        }),
      )
      .pipe(
        // Waiting behind another operation on this page counts against the deadline too.
        Effect.timeoutOrElse({
          duration: settings.actionTimeout,
          orElse: () =>
            failWith("zoom", new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
        }),
        owned,
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
      owned,
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
      owned,
    );
  };

  const page: Page = {
    id,
    playwright,
    url: Effect.sync(() => playwright.url()),
    title: native("title", () => playwright.title()),
    goto,
    back: perform(
      "back",
      { target: "back", input: false },
      settings.navigationTimeout,
      prepareBack,
      goBack,
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
    currentFrame,
    zoom,
    viewport: viewportFor("viewport").pipe(
      Effect.timeoutOrElse({
        duration: settings.actionTimeout,
        orElse: () =>
          failWith("viewport", new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
      }),
      owned,
    ),
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
