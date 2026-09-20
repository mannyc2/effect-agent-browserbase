import { Schema, type Effect, type Stream } from "effect";

import { BrowserbaseError, PageInfo, Target } from "../Types.ts";

const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 }));
const BufferedBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 }));

/** Defaults shared by admission and the optional public data schema. */
export const CaptureDefaults = Object.freeze({
  maxFrames: 4,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxDurationMillis: 60000,
  quality: 80,
});

const LimitFields = {
  maxFrames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxBufferedBytes: BufferedBytes,
  maxFrameBytes: BufferedBytes,
  maxDurationMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 })),
  quality: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
};

const FrameBudget = Schema.makeFilter(
  (value: { readonly maxFrameBytes?: number; readonly maxBufferedBytes?: number }) =>
    (value.maxFrameBytes ?? CaptureDefaults.maxFrameBytes) <=
    (value.maxBufferedBytes ?? CaptureDefaults.maxBufferedBytes),
  { message: "A frame must fit within the resolved buffer budget" },
);

/** Private resolved admission schema. It is not an additional public options API. */
export const CaptureLimits = Schema.Struct(LimitFields).check(FrameBudget);

/**
 * Binary frame data, not a live capability or a JSON/thread/Tool value. Decoding validates
 * fields; it does not copy bytes, decode JPEG pixels, prove target authority, or repair clocks.
 * Capture itself owns the byte copy and verifies JPEG framing before delivery.
 */
export const CapturedFrame = Schema.Struct({
  bytes: Schema.Uint8Array.check(Schema.isMinLength(4), Schema.isMaxLength(64 * 1024 * 1024)),
  mediaType: Schema.Literal("image/jpeg"),
  target: Target,
  sequence: Schema.Natural,
  sourceTimeMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
  sourceClock: Schema.Literal("presentation-unix-millis"),
  receivedMonotonicNanos: Schema.BigInt,
  width: Dimension,
  height: Dimension,
  viewportWidth: Dimension,
  viewportHeight: Dimension,
}).check(
  Schema.makeFilter((frame) => frame.width * frame.height <= 33_554_432, {
    message: "Frame geometry exceeds the capture pixel bound",
  }),
);

export type CapturedFrame = typeof CapturedFrame.Type;

/** Source-fit request in pixels. Actual JPEG bounds are checked before any frame is delivered. */
export const CaptureSize = Schema.Struct({ width: Dimension, height: Dimension });

export type CaptureSize = typeof CaptureSize.Type;

/** Optional capture data. Defaults are applied at admission, not during schema decoding. */
export const CaptureOptions = Schema.Struct({
  /** Pin to a page from `session.pages`; omission preserves selected-page behavior. */
  target: Schema.optionalKey(PageInfo),
  maxFrames: Schema.optionalKey(LimitFields.maxFrames),
  maxBufferedBytes: Schema.optionalKey(LimitFields.maxBufferedBytes),
  maxFrameBytes: Schema.optionalKey(LimitFields.maxFrameBytes),
  maxDurationMillis: Schema.optionalKey(LimitFields.maxDurationMillis),
  quality: Schema.optionalKey(LimitFields.quality),
  /** Source fit only. Does not resize the viewport or impose an FPS cap. */
  size: Schema.optionalKey(CaptureSize),
}).check(FrameBudget);

export type CaptureOptions = typeof CaptureOptions.Type;

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

/** Live stream/Effect capabilities intentionally have no data schema or serialization contract. */
export interface CaptureInterval {
  /** Single subscription. Ending or interrupting it stops this interval, not its browser. */
  readonly frames: Stream.Stream<CapturedFrame, BrowserbaseError>;
  readonly stop: Effect.Effect<CaptureSummary>;
  readonly completed: Effect.Effect<CaptureSummary>;
}
