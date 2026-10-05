/**
 * One browser tab: navigation, snapshots, pictures and input.
 *
 * Every operation on a page runs one at a time, in call order. Element targets are refs from a
 * snapshot; point targets are viewport coordinates in CSS pixels, the same coordinates as a
 * screenshot's pixels. Mouse input goes straight to the Chrome DevTools Protocol and is pipelined,
 * so its dispatch costs one round trip even on a remote browser. Targets are resolved first.
 *
 * @since 0.3.0
 */
import {
  type Clock,
  Duration,
  Effect,
  Exit,
  Option,
  PubSub,
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
  type Reason,
  StaleRef,
  Timeout,
} from "./BrowserError.ts";
import { Action, type BrowserEvent, PointerMoved } from "./BrowserEvent.ts";
import { Frame, Image, type ScreencastOptions } from "./Frame.ts";
import * as Human from "./internal/human.ts";
import * as Keys from "./internal/keys.ts";
import * as Script from "./internal/pageScript.ts";
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
  /** A region of the viewport, for reading a detail at full resolution. */
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
  at: Schema.Finite,
}) {}

/** What a guard sees before input reaches the page. */
export interface InputRequest {
  readonly page: string;
  readonly action: string;
  readonly target?: string | undefined;
  /** How the targeted element read when it was resolved, such as `<button> "Place bet"`. */
  readonly element?: string | undefined;
  readonly point?: Point | undefined;
  readonly text?: string | undefined;
}

/** Checked before every input; failing refuses the input before anything is sent. */
export type InputGuard = (request: InputRequest) => Effect.Effect<void, BrowserError>;

export interface Settings {
  readonly actionTimeout: Duration.Duration;
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
  /** A full-resolution crop, with the origin needed to keep subsequent input in viewport pixels. */
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

/** Map a Playwright or protocol failure to a reason. */
export const reasonOf = (cause: unknown): Reason => {
  const message = messageOf(cause);

  if (closedPattern.test(message)) return new Closed();
  if (cause instanceof Error && cause.name === "TimeoutError") return new Timeout({ millis: 0 });
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
  readonly clock: Clock.Clock;
  readonly publish: (event: BrowserEvent) => void;
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
  const { id, playwright, cdp, settings, clock, publish } = options;
  const lock = yield* Semaphore.make(1);
  const world = yield* Ref.make(Option.none<number>());
  const nextRef = yield* Ref.make(1);
  const pointer = yield* Ref.make<Point>({ x: 0, y: 0 });
  const lastInputAt = yield* Ref.make(0);
  const frames = yield* PubSub.sliding<Frame>(16);
  // Written from Playwright's frame callback, outside any fiber.
  let latest = Option.none<Frame>();
  let history: ReadonlyArray<Frame> = [];

  const capture = yield* Ref.make<{
    readonly users: number;
    readonly stop: Option.Option<() => Promise<void>>;
  }>({
    users: 0,
    stop: Option.none(),
  });

  const captureLock = yield* Semaphore.make(1);
  const now = () => clock.currentTimeMillisUnsafe();

  // Every protocol or Playwright call. Errors are undispatched here; `perform` marks them
  // dispatched once input has gone out.
  const native = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) => new BrowserError({ operation, reason: reasonOf(cause), dispatched: false }),
    });

  // Input events are sent without waiting for each reply, then awaited together. The protocol
  // keeps their order on the one connection.
  const pending: Array<Promise<unknown>> = [];

  const sendMouse = (event: MouseEvent) => {
    const sent = cdp.send("Input.dispatchMouseEvent", event);

    sent.catch(() => undefined);
    pending.push(sent);
  };

  const flush = (operation: string) => native(operation, () => Promise.all(pending.splice(0)));

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

  // Evaluate one call of the installed script, recreating the world once if the document changed.
  const evaluate = (operation: string, call: string) => {
    const attempt = (contextId: number) =>
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
                      result.exceptionDetails.exception?.description ??
                      result.exceptionDetails.text,
                  }),
                  dispatched: false,
                }),
              ),
        ),
      );

    return Ref.get(world).pipe(
      Effect.flatMap(
        Option.match({ onNone: () => createWorld(operation), onSome: Effect.succeed }),
      ),
      Effect.flatMap(attempt),
      Effect.catchIf(contextGone, () => createWorld(operation).pipe(Effect.flatMap(attempt))),
    );
  };

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

  // Run one page operation under the page's lock, bound its time, mark its failures dispatched
  // once input went out, and record it as an Action event.
  const perform = <A>(
    name: string,
    info: { readonly target?: string | undefined; readonly text?: string | undefined },
    timeout: Duration.Duration,
    body: (marks: {
      readonly sent: Effect.Effect<void>;
      readonly at: (point: Point) => Effect.Effect<void>;
    }) => Effect.Effect<A, BrowserError>,
  ): Effect.Effect<A, BrowserError> =>
    lock.withPermits(1)(
      Effect.gen(function* () {
        const startedAt = now();
        const sent = yield* Ref.make(false);
        const at = yield* Ref.make(Option.none<Point>());

        const exit = yield* body({
          sent: Ref.set(sent, true),
          at: (point) => Ref.set(at, Option.some(point)),
        }).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                new BrowserError({
                  operation: name,
                  reason: new Timeout({ millis: Duration.toMillis(timeout) }),
                  dispatched: false,
                }),
              ),
          }),
          Effect.exit,
        );

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
      }),
    );

  const failWith = (operation: string, reason: Reason) =>
    Effect.fail(new BrowserError({ operation, reason, dispatched: false }));

  const resolve = (operation: string, target: Target) => {
    if (typeof target === "string" && !/^e\d+$/.test(target))
      return failWith(
        operation,
        new InvalidRequest({ detail: `"${target}" is not a ref; refs look like e12` }),
      );
    if (typeof target !== "string" && (!Number.isFinite(target.x) || !Number.isFinite(target.y)))
      return failWith(
        operation,
        new InvalidRequest({ detail: "point coordinates must be finite" }),
      );

    return evaluate(operation, scriptCall("point", target)).pipe(
      Effect.flatMap(decodeWith(operation, Script.PointResultSchema)),
      Effect.flatMap((result) =>
        "error" in result
          ? failWith(
              operation,
              result.error === "stale" && typeof target === "string"
                ? new StaleRef({ ref: target })
                : result.error === "outside"
                  ? new InvalidRequest({ detail: result.detail })
                  : new NotActionable({ detail: result.detail }),
            )
          : Effect.succeed(
              new ResolvedTarget({
                point: { x: result.x, y: result.y },
                element: result.element,
                role: result.role,
                name: result.name,
                cursor: result.cursor,
                ...(result.href === undefined ? {} : { href: result.href }),
              }),
            ),
      ),
    );
  };

  const guard = (request: InputRequest) =>
    settings.guard === undefined ? Effect.void : settings.guard(request);

  const moveTo = (to: Point) =>
    Effect.gen(function* () {
      if (!settings.humanize) {
        sendMouse({ type: "mouseMoved", x: to.x, y: to.y, button: "none" });
        yield* Ref.set(pointer, to);

        return;
      }
      const from = yield* Ref.get(pointer);
      const steps = yield* Human.path(from, to);

      for (const step of steps) {
        yield* Effect.sleep(Duration.millis(step.delay));
        sendMouse({ type: "mouseMoved", x: step.x, y: step.y, button: "none" });
        publish(new PointerMoved({ at: now(), page: id, x: step.x, y: step.y }));
      }
      yield* Ref.set(pointer, to);
    });

  // Give a navigation the input started a moment to begin, then wait for its document.
  const settle = Effect.sleep(Duration.millis(settings.humanize ? 250 : 120)).pipe(
    Effect.andThen(
      Effect.tryPromise(() =>
        playwright.waitForLoadState("domcontentloaded", { timeout: 5_000 }),
      ).pipe(Effect.ignore),
    ),
  );

  const click = (target: Target, clickOptions: ClickOptions = {}) =>
    perform(
      "click",
      { target: typeof target === "string" ? target : `${target.x},${target.y}` },
      settings.actionTimeout,
      (marks) =>
        Effect.gen(function* () {
          const resolved = yield* resolve("click", target);
          const { point, element } = resolved;
          const button = clickOptions.button ?? "left";
          const count = Math.max(1, Math.min(3, clickOptions.clickCount ?? 1));

          yield* guard({
            page: id,
            action: "click",
            target: typeof target === "string" ? target : undefined,
            element,
            point,
          });
          yield* marks.at(point);
          yield* marks.sent;
          yield* moveTo(point);
          for (let index = 1; index <= count; index++) {
            sendMouse({
              type: "mousePressed",
              ...point,
              button,
              buttons: buttonMask[button],
              clickCount: index,
            });

            const hold =
              clickOptions.holdMillis ?? (settings.humanize ? yield* Human.pressDelay : 0);

            if (hold > 0) yield* Effect.sleep(Duration.millis(hold));
            sendMouse({ type: "mouseReleased", ...point, button, buttons: 0, clickCount: index });
          }
          yield* flush("click");
          yield* settle;

          return resolved;
        }),
    );

  const hover = (target: Target) =>
    perform(
      "hover",
      { target: typeof target === "string" ? target : `${target.x},${target.y}` },
      settings.actionTimeout,
      (marks) =>
        Effect.gen(function* () {
          const { point } = yield* resolve("hover", target);

          yield* marks.at(point);
          yield* marks.sent;
          yield* moveTo(point);
          yield* flush("hover");
        }),
    );

  const drag = (from: Target, to: Target) =>
    perform(
      "drag",
      { target: `${JSON.stringify(from)} -> ${JSON.stringify(to)}` },
      settings.actionTimeout,
      (marks) =>
        Effect.gen(function* () {
          const start = yield* resolve("drag", from);
          const end = yield* resolve("drag", to);

          yield* guard({ page: id, action: "drag", element: start.element, point: start.point });
          yield* marks.at(end.point);
          yield* marks.sent;
          yield* moveTo(start.point);
          sendMouse({
            type: "mousePressed",
            ...start.point,
            button: "left",
            buttons: 1,
            clickCount: 1,
          });
          const steps = yield* Human.path(start.point, end.point);

          for (const step of steps) {
            yield* Effect.sleep(Duration.millis(settings.humanize ? step.delay : 8));
            sendMouse({ type: "mouseMoved", x: step.x, y: step.y, button: "left", buttons: 1 });
          }
          sendMouse({
            type: "mouseReleased",
            ...end.point,
            button: "left",
            buttons: 0,
            clickCount: 1,
          });
          yield* Ref.set(pointer, end.point);
          yield* flush("drag");
        }),
    );

  const typeText = (text: string, typeOptions: TypeOptions = {}) =>
    perform(
      "type",
      { target: typeOptions.into, text },
      Duration.sum(
        settings.actionTimeout,
        Duration.millis(settings.humanize ? text.length * 160 : 0),
      ),
      (marks) =>
        Effect.gen(function* () {
          const replace = typeOptions.replace ?? true;

          if (typeOptions.into !== undefined) {
            const ref = typeOptions.into;

            if (!/^e\d+$/.test(ref))
              return yield* failWith(
                "type",
                new InvalidRequest({ detail: `"${ref}" is not a ref; refs look like e12` }),
              );
            const target = yield* resolve("type", ref);

            yield* guard({
              page: id,
              action: "type",
              target: ref,
              element: target.element,
              point: target.point,
              text,
            });
            yield* marks.at(target.point);
            if (settings.humanize) {
              yield* marks.sent;
              yield* moveTo(target.point);
              sendMouse({
                type: "mousePressed",
                ...target.point,
                button: "left",
                buttons: 1,
                clickCount: 1,
              });
              sendMouse({
                type: "mouseReleased",
                ...target.point,
                button: "left",
                buttons: 0,
                clickCount: 1,
              });
              yield* flush("type");
            }

            const focused = yield* evaluate("type", scriptCall("focus", ref, replace)).pipe(
              Effect.flatMap(decodeWith("type", Script.EditResultSchema)),
            );

            if ("error" in focused)
              return yield* failWith("type", new NotActionable({ detail: focused.error }));
          } else yield* guard({ page: id, action: "type", text });
          yield* marks.sent;
          if (text === "" && replace && typeOptions.into !== undefined)
            yield* native("type", () => playwright.keyboard.press("Delete"));
          else if (settings.humanize)
            for (const character of text) {
              yield* native("type", () => playwright.keyboard.type(character));
              yield* Effect.sleep(Duration.millis(yield* Human.keyDelay));
            }
          else yield* native("type", () => playwright.keyboard.insertText(text));
          if (typeOptions.submit === true) {
            yield* native("type", () => playwright.keyboard.press("Enter"));
            yield* settle;
          }
        }),
    );

  const press = (keys: string, pressOptions: PressOptions = {}) =>
    perform("press", { target: keys }, settings.actionTimeout, (marks) =>
      Effect.gen(function* () {
        const combination = Keys.normalize(keys);

        if (combination === undefined)
          return yield* failWith(
            "press",
            new InvalidRequest({
              detail: `"${keys}" is not a key; try Enter, Space, ArrowLeft or Control+A`,
            }),
          );
        const times = Math.max(1, Math.min(50, pressOptions.times ?? 1));

        yield* guard({ page: id, action: "press", text: combination });
        yield* marks.sent;
        for (let index = 0; index < times; index++) {
          if (pressOptions.holdMillis === undefined)
            yield* native("press", () => playwright.keyboard.press(combination));
          else {
            const parts = combination.split("+");

            for (const part of parts) yield* native("press", () => playwright.keyboard.down(part));
            yield* Effect.sleep(Duration.millis(pressOptions.holdMillis));
            for (const part of parts.toReversed())
              yield* native("press", () => playwright.keyboard.up(part));
          }
          if (index + 1 < times && settings.humanize)
            yield* Effect.sleep(Duration.millis(yield* Human.keyDelay));
        }
        yield* settle;
      }),
    );

  const scroll = (scrollOptions: ScrollOptions = {}) =>
    perform(
      "scroll",
      { target: scrollOptions.at === undefined ? undefined : JSON.stringify(scrollOptions.at) },
      settings.actionTimeout,
      (marks) =>
        Effect.gen(function* () {
          const viewport = playwright.viewportSize() ?? { width: 1280, height: 720 };

          const point =
            scrollOptions.at === undefined
              ? { x: Math.round(viewport.width / 2), y: Math.round(viewport.height / 2) }
              : (yield* resolve("scroll", scrollOptions.at)).point;

          const dx = scrollOptions.dx ?? 0;

          const dy =
            scrollOptions.dy ??
            (scrollOptions.dx === undefined ? Math.round(viewport.height * 0.8) : 0);

          yield* marks.at(point);
          yield* marks.sent;
          yield* moveTo(point);

          const steps = settings.humanize
            ? Math.max(1, Math.min(8, Math.round(Math.hypot(dx, dy) / 120)))
            : 1;

          for (let index = 0; index < steps; index++) {
            if (index > 0) yield* Effect.sleep(Duration.millis(40));
            sendMouse({ type: "mouseWheel", ...point, deltaX: dx / steps, deltaY: dy / steps });
          }
          yield* flush("scroll");
          yield* Effect.sleep(Duration.millis(150));
        }),
    );

  const select = (ref: string, values: ReadonlyArray<string>) =>
    perform("select", { target: ref, text: values.join(", ") }, settings.actionTimeout, (marks) =>
      Effect.gen(function* () {
        const target = yield* resolve("select", ref);

        yield* guard({
          page: id,
          action: "select",
          target: ref,
          element: target.element,
          text: values.join(", "),
        });
        yield* marks.sent;

        const result = yield* evaluate("select", scriptCall("select", ref, values)).pipe(
          Effect.flatMap(decodeWith("select", Script.EditResultSchema)),
        );

        return "error" in result
          ? yield* failWith("select", new NotActionable({ detail: result.error }))
          : result.detail;
      }),
    );

  const navigation = (name: string, run: () => Promise<unknown>, url: string) =>
    perform(name, { target: url }, settings.navigationTimeout, (marks) =>
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

  const goto = (url: string) => {
    const parsed = URL.parse(url) ?? URL.parse(`https://${url}`);

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
      const frame = latest;
      const since = yield* Ref.get(lastInputAt);

      // A full-size frame that arrived after the last input already shows the page as it is.
      const viewport = playwright.viewportSize();

      if (
        screenshotOptions.clip === undefined &&
        Option.isSome(frame) &&
        frame.value.receivedAt > since + 100 &&
        frame.value.width === viewport?.width &&
        frame.value.height === viewport.height
      )
        return frame.value.image;
      const quality = screenshotOptions.quality ?? 80;

      const data = yield* native("screenshot", () =>
        playwright.screenshot({
          type: "jpeg",
          quality,
          scale: "css",
          timeout: Duration.toMillis(settings.actionTimeout),
          ...(screenshotOptions.clip === undefined ? {} : { clip: screenshotOptions.clip }),
        }),
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

  // The shared screencast: the first stream starts it and the last one stops it.
  const onFrame = (frame: {
    readonly data: Uint8Array;
    readonly timestamp: number;
    readonly viewportWidth: number;
    readonly viewportHeight: number;
  }) => {
    // Chromium can finish encoding two close frames out of order; keep time moving forward.
    if (Option.isSome(latest) && frame.timestamp <= latest.value.timestamp) return;

    const size = jpegSize(frame.data) ?? {
      width: frame.viewportWidth,
      height: frame.viewportHeight,
    };

    const next = new Frame({
      page: id,
      data: frame.data,
      timestamp: frame.timestamp,
      receivedAt: now(),
      width: size.width,
      height: size.height,
    });

    latest = Option.some(next);
    history =
      history.length >= settings.frameHistory ? [...history.slice(1), next] : [...history, next];
    PubSub.publishUnsafe(frames, next);
  };

  const acquireCapture = (screencastOptions: ScreencastOptions) =>
    Effect.acquireRelease(
      captureLock.withPermits(1)(
        Effect.gen(function* () {
          const state = yield* Ref.get(capture);

          if (Option.isNone(state.stop)) {
            // Playwright scales frames to 800x800 unless told otherwise; default to full size.
            const size = screencastOptions.size ?? playwright.viewportSize() ?? undefined;

            yield* native("screencast", () =>
              playwright.screencast.start({
                onFrame,
                quality: screencastOptions.quality ?? 80,
                ...(size === undefined ? {} : { size: { width: size.width, height: size.height } }),
              }),
            );
            yield* Ref.set(capture, {
              users: 1,
              stop: Option.some(() => playwright.screencast.stop()),
            });
          } else yield* Ref.set(capture, { users: state.users + 1, stop: state.stop });
        }),
      ),
      () =>
        captureLock.withPermits(1)(
          Effect.gen(function* () {
            const state = yield* Ref.get(capture);

            if (state.users > 1)
              return yield* Ref.set(capture, { users: state.users - 1, stop: state.stop });
            yield* Ref.set(capture, { users: 0, stop: Option.none() });
            if (Option.isSome(state.stop)) {
              const stop = state.stop.value;

              yield* Effect.tryPromise(stop).pipe(Effect.ignore);
            }
          }),
        ),
    );

  const screencast = (
    screencastOptions: ScreencastOptions = {},
  ): Stream.Stream<Frame, BrowserError> =>
    Stream.unwrap(
      Effect.gen(function* () {
        const subscription = yield* PubSub.subscribe(frames);

        yield* acquireCapture(screencastOptions);

        return Stream.fromSubscription(subscription);
      }),
    );

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
    ),
    reload: navigation(
      "reload",
      () => playwright.reload({ waitUntil: "domcontentloaded", timeout: 0 }),
      "reload",
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
    latestFrame: Effect.sync(() => latest),
    recentFrames: Effect.sync(() => history),
  };

  return page;
});
