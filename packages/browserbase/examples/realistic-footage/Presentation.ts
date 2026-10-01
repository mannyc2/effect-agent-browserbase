import { Context, Deferred, Effect, Schema, Stream } from "effect";
import { type AnySession, type Page, checkPage } from "effect-browser/browser";
import type { CapturedFrame } from "effect-browser/capture";
import type { Event, Selector } from "effect-browser/timeline-data";

import type { Broadcast } from "./Broadcast.ts";
import { FootageError } from "./FootageError.ts";
import type { Telemetry } from "./Telemetry.ts";

const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

/** Audience artwork contains no browser capability, raw event, address, input text or SDK value. */
export const View = Schema.Struct({
  viewport: Schema.NullOr(Schema.Struct({ width: Schema.Finite, height: Schema.Finite })),
  cursor: Schema.NullOr(Point),
  qualification: Schema.Literals(["commanded-point", "intended-aim", "unknown"]),
  caption: Schema.String.check(Schema.isMaxLength(120)),
  pulse: Schema.NullOr(
    Schema.Struct({
      position: Point,
      remainingMillis: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 350 })),
    }),
  ),
  glide: Schema.NullOr(
    Schema.Struct({
      id: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 65536 })),
      delayMillis: Schema.Finite,
      samples: Schema.Array(Schema.Struct({ afterMillis: Schema.Finite, position: Point })).check(
        Schema.isMaxLength(128),
      ),
    }),
  ),
});

export type View = typeof View.Type;

type Drawing =
  | {
      readonly kind: "cursor" | "pulse";
      readonly atNanos: bigint;
      readonly point: typeof Point.Type;
    }
  | { readonly kind: "caption"; readonly atNanos: bigint; readonly text: string };

export interface Graphics {
  readonly drawings: ReadonlyArray<Drawing>;
  readonly firstFrameNanos: bigint;
  readonly endedNanos: bigint;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly clockUncertaintyNanos: bigint;
}

export class Presentation extends Context.Service<
  Presentation,
  {
    readonly caption: (text: string) => Effect.Effect<void, FootageError>;
    readonly frame: (frame: CapturedFrame) => Effect.Effect<void>;
    readonly read: (consumer: "graphics" | "metrics") => Effect.Effect<void, FootageError>;
    readonly stop: Effect.Effect<void>;
    /** After its owned readers stop, clear speculative artwork and drain retained metrics. */
    readonly abort: Effect.Effect<void>;
    readonly graphics: Effect.Effect<Graphics, FootageError>;
  }
>()("effect-browserbase/examples/realistic-footage/Presentation") {}

/** Two independent public journal readers; neither receives or owns the capture stream. */
export const make = Effect.fnUntraced(function* (
  session: AnySession,
  page: Page,
  broadcast: Broadcast["Service"],
  telemetry: Telemetry["Service"],
) {
  yield* checkPage(session, page).pipe(
    Effect.mapError((cause) =>
      FootageError.make({ reason: "presentation-limit", detail: "invalid Page owner", cause }),
    ),
  );
  const before = yield* session.monotonicTimeNanos;
  const start = yield* page.timeline.now;
  const after = yield* session.monotonicTimeNanos;
  const origin = (before + after) / 2n - start.offsetNanos;
  const uncertainty = (after - before) / 2n;
  const closing = yield* Deferred.make<void>();
  let metricsAfter: Selector = { at: start };
  let aborted = false;
  let first: CapturedFrame | undefined;

  let view: View = {
    viewport: null,
    cursor: null,
    qualification: "unknown",
    caption: "",
    pulse: null,
    glide: null,
  };

  const drawings: Array<Drawing> = [];
  let glideId = 0;
  let glideStartedNanos = 0n;
  let pulseStartedNanos = 0n;

  const retain = (drawing: Drawing) => {
    if (drawings.length >= 65536)
      throw FootageError.make({ reason: "presentation-limit", detail: "65536 drawing samples" });
    drawings.push(Object.freeze(drawing));
  };

  const publish = () =>
    Effect.gen(function* () {
      const now = yield* session.monotonicTimeNanos;
      const remainingMillis = 350 - Number(now - pulseStartedNanos) / 1_000_000;

      yield* broadcast.present({
        ...view,
        cursor: aborted ? null : view.cursor,
        qualification: aborted ? "unknown" : view.qualification,
        glide:
          aborted || view.glide === null
            ? null
            : {
                ...view.glide,
                delayMillis: Number(glideStartedNanos - now) / 1_000_000,
              },
        pulse:
          aborted || view.pulse === null || remainingMillis <= 0
            ? null
            : { ...view.pulse, remainingMillis: Math.min(350, remainingMillis) },
      });
    });

  // Consuming a fact and advancing its cursor are one bounded host-only transaction.
  const metrics = (event: Event) =>
    telemetry.timeline(event).pipe(
      Effect.andThen(
        Effect.sync(() => {
          metricsAfter = {
            storeId: event.storeId,
            clockId: event.clockId,
            sequence: event.sequence,
          };
        }),
      ),
      Effect.uninterruptible,
    );

  const render = (envelope: Event) =>
    Effect.gen(function* () {
      if (aborted) return;
      const event = envelope.event;
      const receivedNanos = yield* session.monotonicTimeNanos;
      let changed = false;

      yield* Effect.try({
        try: () => {
          switch (event._tag) {
            case "Glide": {
              const initial = event.schedule[0];

              if (initial === undefined) break;
              const now = receivedNanos;

              glideStartedNanos = origin + initial.at.offsetNanos;

              for (const sample of event.schedule)
                retain({
                  kind: "cursor",
                  atNanos: origin + sample.at.offsetNanos,
                  point: sample.position,
                });
              view = {
                ...view,
                qualification: "intended-aim",
                glide: {
                  id: ++glideId,
                  delayMillis: Number(glideStartedNanos - now) / 1_000_000,
                  samples: event.schedule.map((sample) => ({
                    afterMillis: Number(sample.at.offsetNanos - initial.at.offsetNanos) / 1_000_000,
                    position: sample.position,
                  })),
                },
                pulse: null,
              };
              changed = true;
              break;
            }
            case "Pointer":
              if (event.position !== null) {
                retain({
                  kind: "cursor",
                  atNanos: origin + event.interval.end.offsetNanos,
                  point: event.position,
                });
                view = {
                  ...view,
                  cursor: event.position,
                  qualification: "commanded-point",
                  glide: null,
                  pulse: null,
                };
                changed = true;
              }
              break;
            case "Press": {
              const position = event.position ?? event.intended?.position;

              if (position === undefined) break;
              const atNanos = origin + event.interval.end.offsetNanos;

              retain({ kind: "cursor", atNanos, point: position });
              retain({ kind: "pulse", atNanos, point: position });
              pulseStartedNanos = atNanos;
              view = {
                ...view,
                cursor: position,
                qualification: event.position === null ? "intended-aim" : "commanded-point",
                pulse: { position, remainingMillis: 350 },
                glide: null,
              };
              changed = true;
              break;
            }
            case "Navigated":
              view = { ...view, caption: "", pulse: null };
              retain({ kind: "caption", atNanos: origin + envelope.at.offsetNanos, text: "" });
              changed = true;
              break;
            case "Failed":
            case "Cancelled":
              view = { ...view, cursor: null, qualification: "unknown", pulse: null, glide: null };
              changed = true;
              break;
            case "Terminal":
              if (event.scope === "page")
                throw FootageError.make({
                  reason: "capture-ended",
                  detail: `page ${event.reason}`,
                });
              break;
            case "Acknowledged":
            case "Capture":
            case "CaptureBoundary":
            case "Contained":
            case "Dispatched":
            case "DisplayChanged":
            case "FirstFrame":
            case "FollowUp":
            case "Keys":
            case "Lifecycle":
            case "MetadataChanged":
            case "MetadataOmitted":
            case "PageClosed":
            case "PageOpened":
            case "Picture":
            case "Planned":
            case "Prepared":
            case "Scroll":
            case "Settled":
              break;
          }
        },
        catch: (cause) =>
          Schema.is(FootageError)(cause)
            ? cause
            : FootageError.make({ reason: "presentation-limit", cause }),
      });
      if (changed) yield* publish();
    });

  return Presentation.of({
    caption: (text) =>
      Effect.gen(function* () {
        const safe = yield* Schema.decodeEffect(View.fields.caption)(text).pipe(
          Effect.mapError((cause) => FootageError.make({ reason: "presentation-limit", cause })),
        );

        const atNanos = yield* session.monotonicTimeNanos;

        yield* Effect.try({
          try: () => {
            retain({ kind: "caption", atNanos, text: safe });
            view = { ...view, caption: safe };
          },
          catch: (cause) => FootageError.make({ reason: "presentation-limit", cause }),
        });
        yield* publish();
      }),
    frame: (frame) =>
      Effect.suspend(() => {
        first ??= frame;
        if (
          frame.viewportWidth === undefined ||
          frame.viewportHeight === undefined ||
          (view.viewport?.width === frame.viewportWidth &&
            view.viewport.height === frame.viewportHeight)
        )
          return Effect.void;
        view = { ...view, viewport: { width: frame.viewportWidth, height: frame.viewportHeight } };

        return publish();
      }),
    read: (consumer) =>
      Effect.gen(function* () {
        const snapshot = yield* page.timeline.snapshot({ from: { at: start } });
        const consume = consumer === "graphics" ? render : metrics;

        yield* Effect.forEach(snapshot.events, consume, { discard: true });
        yield* page.timeline
          .events(snapshot.resumeAfter)
          .pipe(Stream.interruptWhen(Deferred.await(closing)), Stream.runForEach(consume));
      }).pipe(
        Effect.catchTag("TimelineGap", (cause) =>
          telemetry
            .timelineGap(consumer)
            .pipe(
              Effect.andThen(
                broadcast.present({ ...view, cursor: null, pulse: null, glide: null }),
              ),
              Effect.andThen(Effect.fail(FootageError.make({ reason: "timeline-gap", cause }))),
            ),
        ),
        Effect.mapError((cause) =>
          Schema.is(FootageError)(cause)
            ? cause
            : FootageError.make({ reason: "timeline-gap", cause }),
        ),
      ),
    stop: Effect.asVoid(Deferred.succeed(closing, undefined)),
    abort: Effect.gen(function* () {
      aborted = true;
      view = { ...view, cursor: null, qualification: "unknown", pulse: null, glide: null };
      yield* publish();
      // This finite snapshot uses the original journal cursor; lost metadata stays an explicit gap.
      // Diagnostic failures cannot replace the original performance Cause during scope cleanup.
      yield* page.timeline.snapshot({ from: metricsAfter }).pipe(
        Effect.flatMap((snapshot) => Effect.forEach(snapshot.events, metrics, { discard: true })),
        Effect.catchTag("TimelineGap", () => telemetry.timelineGap("metrics")),
        Effect.ignore,
      );
    }),
    graphics: Effect.gen(function* () {
      if (
        first === undefined ||
        first.viewportWidth === undefined ||
        first.viewportHeight === undefined
      )
        return yield* FootageError.make({ reason: "no-frames" });

      const presentation = yield* telemetry.presentationTime(first);

      return {
        drawings: Object.freeze([...drawings]),
        firstFrameNanos: presentation.monotonicNanos,
        endedNanos: yield* session.monotonicTimeNanos,
        viewport: { width: first.viewportWidth, height: first.viewportHeight },
        clockUncertaintyNanos: uncertainty + presentation.uncertaintyNanos,
      } satisfies Graphics;
    }),
  });
});
