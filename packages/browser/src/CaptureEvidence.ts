import { type Effect, Schema, type Scope, type Stream } from "effect";

import { Identifier, Target } from "./BrowserData.ts";
import type { CapturedFrame } from "./CaptureData.ts";

/** A new identity for every owned source, independent of connection-local target IDs. */
export const SourceId = Identifier;

/** Metadata only: no JPEG bytes, URL, provider receipt or live browser authority. */
export const FrameReceipt = Schema.Struct({
  sourceId: SourceId,
  target: Target,
  sequence: Schema.Natural,
  document: Schema.Natural,
  sourceTimeMillis: Schema.Finite,
  sourceClock: Schema.Literal("presentation-unix-millis"),
  receivedMonotonicNanos: Schema.BigInt,
  receivedClock: Schema.Literal("host-monotonic-nanos"),
  byteLength: Schema.Natural,
  width: Schema.Natural,
  height: Schema.Natural,
  viewportWidth: Schema.Natural,
  viewportHeight: Schema.Natural,
});

export type FrameReceipt = typeof FrameReceipt.Type;

/** Canonical JSON represents bigint clocks as decimal strings; decoding restores bigint. */
export const FrameReceiptJson = Schema.toCodecJson(FrameReceipt);

export const Event = Schema.Union([
  Schema.TaggedStruct("Frame", { revision: Schema.Natural, receipt: FrameReceipt }),
  Schema.TaggedStruct("Ended", {
    revision: Schema.Natural,
    sourceId: SourceId,
    reason: Schema.String.check(Schema.isMaxLength(64)),
  }),
]);

export type Event = typeof Event.Type;

export const EventJson = Schema.toCodecJson(Event);

export const Baseline = Schema.Struct({
  sourceId: SourceId,
  revision: Schema.Natural,
  latest: Schema.NullOr(FrameReceipt),
  phase: Schema.Literals(["open", "ended"]),
  reason: Schema.NullOr(Schema.String.check(Schema.isMaxLength(64))),
});

export type Baseline = typeof Baseline.Type;

export const BaselineJson = Schema.toCodecJson(Baseline);

export const ObservationOptions = Schema.Struct({
  maxEvents: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 }))),
  /** Each pending event reserves 4096 metadata bytes; this excludes JavaScript allocator overhead. */
  maxBufferedBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 4096, maximum: 4 * 1024 * 1024 })),
  ),
});

export type ObservationOptions = typeof ObservationOptions.Type;

export class ObservationError extends Schema.TaggedError<ObservationError>()(
  "CaptureObservationError",
  {
    sourceId: SourceId,
    reason: Schema.Literals(["configuration", "limit", "overflow", "already-consumed"]),
    afterRevision: Schema.Natural,
  },
) {}

export interface Observation {
  /** Captured atomically with subscription registration; events begin after this revision. */
  readonly baseline: Baseline;
  /** Consume once. Overflow ends this observer with a typed error; it never blocks capture. */
  readonly events: Stream.Stream<Event, ObservationError>;
}

export type Observe = (
  options?: ObservationOptions,
) => Effect.Effect<Observation, ObservationError, Scope.Scope>;

/** Project a delivered frame into immutable evidence without copying its pixels into a record. */
export const receipt = (sourceId: string, frame: CapturedFrame): FrameReceipt =>
  Object.freeze({
    sourceId,
    target: Object.freeze(Target.make(frame.target)),
    sequence: frame.sequence,
    document: frame.document,
    sourceTimeMillis: frame.sourceTimeMillis,
    sourceClock: frame.sourceClock,
    receivedMonotonicNanos: frame.receivedMonotonicNanos,
    receivedClock: "host-monotonic-nanos",
    byteLength: frame.bytes.byteLength,
    width: frame.width,
    height: frame.height,
    viewportWidth: frame.viewportWidth,
    viewportHeight: frame.viewportHeight,
  });
