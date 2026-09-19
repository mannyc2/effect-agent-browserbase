import { Schema, type Effect, type Stream } from "effect";

import { BrowserbaseError, Target, type PageInfo } from "../Types.ts";

/** Bytes are owned by the consumer. This is not a canonical thread or model Tool value. */
export interface CapturedFrame {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg";
  readonly target: Target;
  readonly sequence: number;
  readonly sourceTimeMillis: number;
  readonly sourceClock: "presentation-unix-millis";
  readonly receivedMonotonicNanos: bigint;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

export interface CaptureOptions {
  /** Explicit page identity returned by `session.pages`; omitted means the selected page. */
  readonly target?: PageInfo;
  readonly maxFrames?: number;
  readonly maxBufferedBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxDurationMillis?: number;
  readonly quality?: number;
}

export class CaptureSummary extends Schema.Class<CaptureSummary>("BrowserbaseCaptureSummary")({
  target: Target,
  reason: Schema.String.check(Schema.isMaxLength(64)),
  received: Schema.Natural,
  delivered: Schema.Natural,
  dropped: Schema.Natural,
  duplicates: Schema.Natural,
  peakBufferedFrames: Schema.Natural,
  peakBufferedBytes: Schema.Natural,
  bufferedFrames: Schema.Natural,
  bufferedBytes: Schema.Natural,
  sourceFirstMillis: Schema.NullOr(Schema.Finite),
  sourceLastMillis: Schema.NullOr(Schema.Finite),
  nativeStop: Schema.Literals(["confirmed", "unconfirmed"]),
  /** Package accounting cannot measure frames omitted by Chromium, transport, or the provider. */
  upstreamDrops: Schema.Literal("unknown"),
  error: Schema.optionalKey(BrowserbaseError),
}) {}

export interface CaptureInterval {
  /** Single subscription. Ending or interrupting it stops this interval, not its browser. */
  readonly frames: Stream.Stream<CapturedFrame, BrowserbaseError>;
  readonly stop: Effect.Effect<CaptureSummary>;
  readonly completed: Effect.Effect<CaptureSummary>;
}
