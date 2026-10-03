import { Effect, Schema } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";

export const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export const TargetRect = Schema.Struct({
  kind: Schema.Literals(["dom", "canvas"]),
  center: Point,
  width: Schema.Finite.check(Schema.isGreaterThan(0)),
  height: Schema.Finite.check(Schema.isGreaterThan(0)),
});

export const InputEvent = Schema.Struct({
  kind: Schema.Literals(["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "keyup"]),
  atMillis: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  documentTimeOriginMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
  sourceTimeMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
  sourceOrigin: Bootstrap.Origin,
  coordinateSpace: Schema.Literals(["main-viewport", "frame-viewport"]),
  trusted: Schema.Boolean,
  point: Schema.NullOr(Point),
  code: Schema.NullOr(Schema.String.check(Schema.isMaxLength(32))),
  repeat: Schema.Boolean,
  delta: Schema.NullOr(Point),
  target: Schema.NullOr(TargetRect),
});

export type InputEvent = typeof InputEvent.Type;

export const InputBatch = Schema.Struct({
  events: Schema.Array(InputEvent).check(Schema.isMaxLength(64)),
  lost: Schema.Natural,
});

const Options = Schema.Struct({
  origins: Schema.Array(Bootstrap.Origin).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(16),
    Schema.isUnique(),
  ),
  maxEvents: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 })),
});

/** Browser code: no text or field values; cross-site children relay measured geometry through parents. */
const install = (bindingName: string, origins: ReadonlyArray<string>) => {
  const queue: InputEvent[] = [];
  let lost = 0;
  let busy = false;
  let failures = 0;
  const keys = new Map<string, string>();

  const flush = async () => {
    if (busy || (queue.length === 0 && lost === 0)) return;
    busy = true;
    const batch = { events: queue.splice(0, 64), lost };

    lost = 0;
    try {
      const binding: (batch: typeof InputBatch.Type) => Promise<null> = Reflect.get(
        globalThis,
        bindingName,
      );

      await binding(batch);
    } catch {
      // Failed samples cannot be replayed as if the first delivery never happened.
      failures++;
      lost += batch.events.length + batch.lost;
    } finally {
      busy = false;
    }
  };

  const forward = (event: InputEvent) => {
    if (window !== window.top) {
      window.parent.postMessage(
        { marker: "bench-input-v1", event, viewport: { width: innerWidth, height: innerHeight } },
        "*",
      );

      return;
    }
    if (queue.length >= 512) lost++;
    else queue.push(event);
  };

  window.addEventListener("message", (message) => {
    const payload = message.data as {
      marker?: string;
      event: InputEvent;
      viewport: { width: number; height: number };
    } | null;

    if (
      payload?.marker !== "bench-input-v1" ||
      !origins.includes(message.origin) ||
      !origins.includes(payload.event?.sourceOrigin)
    )
      return;

    const iframe = [...document.querySelectorAll("iframe")].find(
      (frame) => frame.contentWindow === message.source,
    );

    if (iframe === undefined || payload.viewport.width <= 0 || payload.viewport.height <= 0) return;
    const bounds = iframe.getBoundingClientRect();
    const sx = iframe.clientWidth / payload.viewport.width;
    const sy = iframe.clientHeight / payload.viewport.height;

    const point = (value: typeof Point.Type) => ({
      x: bounds.left + iframe.clientLeft + value.x * sx,
      y: bounds.top + iframe.clientTop + value.y * sy,
    });

    const event = payload.event;

    forward({
      ...event,
      coordinateSpace: window === window.top ? "main-viewport" : "frame-viewport",
      point: event.point === null ? null : point(event.point),
      target:
        event.target === null
          ? null
          : {
              ...event.target,
              center: point(event.target.center),
              width: event.target.width * sx,
              height: event.target.height * sy,
            },
    });
  });

  const capture = (event: PointerEvent | WheelEvent | KeyboardEvent) => {
    const atMillis = performance.now();
    const element = event.target instanceof Element ? event.target : null;
    const rectangle = element?.getBoundingClientRect();
    const key = event instanceof KeyboardEvent;

    // A private reference never needs the letters typed in a password or other field.
    if (key && element instanceof HTMLInputElement && element.type === "password") return;
    if (key && !keys.has(event.code)) keys.set(event.code, `key-${keys.size + 1}`);
    forward({
      kind: event.type as InputEvent["kind"],
      atMillis,
      documentTimeOriginMillis: performance.timeOrigin,
      sourceTimeMillis: performance.timeOrigin + atMillis,
      sourceOrigin: location.origin,
      coordinateSpace: window === window.top ? "main-viewport" : "frame-viewport",
      trusted: event.isTrusted,
      point: key ? null : { x: event.clientX, y: event.clientY },
      code: key ? (keys.get(event.code) ?? null) : null,
      repeat: key && event.repeat,
      delta: event instanceof WheelEvent ? { x: event.deltaX, y: event.deltaY } : null,
      target:
        event.type === "pointerdown" &&
        rectangle !== undefined &&
        rectangle.width > 0 &&
        rectangle.height > 0
          ? {
              kind: element instanceof HTMLCanvasElement ? "canvas" : "dom",
              center: {
                x: rectangle.left + rectangle.width / 2,
                y: rectangle.top + rectangle.height / 2,
              },
              width: rectangle.width,
              height: rectangle.height,
            }
          : null,
    });
  };

  for (const kind of ["pointermove", "pointerdown", "pointerup", "wheel", "keydown", "keyup"])
    window.addEventListener(kind, capture as EventListener, { capture: true, passive: true });

  const interval = setInterval(() => {
    void flush();
  }, 50);

  window.addEventListener(
    "pagehide",
    () => {
      clearInterval(interval);
      void flush();
    },
    { once: true },
  );
  Object.assign(window, { __benchInput: { flush, failures: () => failures } });
};

export interface InputLog {
  readonly bootstrap: Bootstrap.Plan<never, never>;
  readonly snapshot: () => {
    readonly sourceClock: "document-performance-plus-time-origin";
    readonly events: ReadonlyArray<InputEvent>;
    readonly lost: number;
    readonly completeness: "navigation-tail-unverified";
  };
}

export const makeInputLog = Effect.fn("Bench.makeInputLog")(function* (options: {
  readonly origins: ReadonlyArray<string>;
  readonly maxEvents?: number;
}): Effect.fn.Return<InputLog, Schema.SchemaError> {
  const config = yield* Schema.decodeEffect(Options)({
    origins: options.origins,
    maxEvents: options.maxEvents ?? 65536,
  });

  const events: InputEvent[] = [];
  let lost = 0;

  const bootstrap = Bootstrap.combine(
    Bootstrap.binding({
      name: "recordBenchInput",
      origins: config.origins,
      input: InputBatch,
      output: Schema.Null,
      maxConcurrent: 1,
      maxInputBytes: 32768,
      maxOutputBytes: 16,
      timeoutMillis: 3000,
      failureMode: "reject-call",
      handle: (batch) =>
        Effect.sync(() => {
          lost += batch.lost;
          for (const event of batch.events) {
            if (events.length < config.maxEvents) events.push(event);
            else lost++;
          }

          return null;
        }),
    }),
    Bootstrap.init({
      id: "bench-input-log",
      origins: config.origins,
      content: `(${install.toString()})("recordBenchInput",${JSON.stringify(config.origins)});`,
      readiness: {
        expression: "globalThis.__benchInput !== undefined",
        timeoutMillis: 3000,
        existingDocuments: "RequireFreshNavigation",
      },
    }),
  );

  return {
    bootstrap,
    snapshot: () => ({
      sourceClock: "document-performance-plus-time-origin",
      events: structuredClone(events),
      lost,
      completeness: "navigation-tail-unverified",
    }),
  };
});
