import { Schema, type Effect, type Stream } from "effect";

import { BrowserbaseError, type PageInfo, Target } from "../Types.ts";

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

/** Source-fit request in pixels. Actual JPEG bounds are checked before any frame is delivered. */
export const CaptureSize = Schema.Struct({
  width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
  height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
});

export type CaptureSize = typeof CaptureSize.Type;

export interface CaptureOptions {
  /** Pin capture to a page returned by `session.pages`. Omit to preserve selected-page behavior. */
  readonly target?: PageInfo;
  readonly maxFrames?: number;
  readonly maxBufferedBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxDurationMillis?: number;
  readonly quality?: number;
  /** Fit the source within these bounds without resizing the live viewport. JPEG only; not an FPS cap. */
  readonly size?: CaptureSize;
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
