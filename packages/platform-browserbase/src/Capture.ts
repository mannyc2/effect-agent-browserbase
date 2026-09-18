import { Effect, Schema, type Stream, type Scope } from "effect";
import type { BrowserbaseSession } from "./InteractiveBrowser.ts";
import { BrowserbaseError, Target } from "./Types.ts";
import { captureParent } from "./internal/Association.ts";
import { startCapture } from "./internal/Capture.ts";

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
  readonly maxFrames?: number;
  readonly maxBufferedBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxDurationMillis?: number;
  readonly quality?: number;
}
export class CaptureSummary extends Schema.Class<CaptureSummary>("BrowserbaseCaptureSummary")({
  target: Target,
  reason: Schema.String.check(Schema.isMaxLength(64)),
  received: Schema.Natural, delivered: Schema.Natural, dropped: Schema.Natural, duplicates: Schema.Natural,
  peakBufferedFrames: Schema.Natural, peakBufferedBytes: Schema.Natural,
  bufferedFrames: Schema.Natural, bufferedBytes: Schema.Natural,
  sourceFirstMillis: Schema.NullOr(Schema.Finite), sourceLastMillis: Schema.NullOr(Schema.Finite),
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

/** Capture the same selected remote page. The package owns no encoder, filesystem, or audio source. */
export const start = (
  session: BrowserbaseSession,
  options: CaptureOptions = {},
): Effect.Effect<CaptureInterval, BrowserbaseError, Scope.Scope> => Effect.suspend(() => {
  const parent = captureParent(session);
  return parent === undefined ? Effect.fail(new BrowserbaseError({ operation: "capture", reason: "closed" })) : startCapture(parent, options);
});

