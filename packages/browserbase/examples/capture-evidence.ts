import type { CapturedFrame, CaptureSummary } from "@effect-agent/browserbase/capture";
import { Schema } from "effect";

/** Safe, fixed-size failure data. Never project target identity, errors, URLs or image bytes. */
export const CaptureEvidence = Schema.Struct({
  requestedDurationMillis: Schema.Finite,
  collected: Schema.Natural,
  reason: Schema.String.check(Schema.isMaxLength(64)),
  received: Schema.Natural,
  delivered: Schema.Natural,
  dropped: Schema.Natural,
  duplicates: Schema.Natural,
  nativeStop: Schema.Literals(["confirmed", "unconfirmed"]),
  upstreamDrops: Schema.Literal("unknown"),
  sourceFirstMillis: Schema.NullOr(Schema.Finite),
  sourceLastMillis: Schema.NullOr(Schema.Finite),
  captureStartedMonotonicNanos: Schema.String,
  captureCompletedMonotonicNanos: Schema.String,
  firstReceivedMonotonicNanos: Schema.NullOr(Schema.String),
  lastReceivedMonotonicNanos: Schema.NullOr(Schema.String),
});

export const captureEvidence = (
  frames: ReadonlyArray<CapturedFrame>,
  summary: CaptureSummary,
  durationMillis: number,
  started: bigint,
  completed: bigint,
): typeof CaptureEvidence.Type => ({
  requestedDurationMillis: durationMillis,
  collected: frames.length,
  reason: summary.reason,
  received: summary.received,
  delivered: summary.delivered,
  dropped: summary.dropped,
  duplicates: summary.duplicates,
  nativeStop: summary.nativeStop,
  upstreamDrops: summary.upstreamDrops,
  sourceFirstMillis: summary.sourceFirstMillis,
  sourceLastMillis: summary.sourceLastMillis,
  captureStartedMonotonicNanos: started.toString(),
  captureCompletedMonotonicNanos: completed.toString(),
  firstReceivedMonotonicNanos: frames[0]?.receivedMonotonicNanos.toString() ?? null,
  lastReceivedMonotonicNanos: frames[frames.length - 1]?.receivedMonotonicNanos.toString() ?? null,
});
