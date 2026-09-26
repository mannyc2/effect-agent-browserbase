import { Schema } from "effect";

import { Identifier } from "./BrowserData.ts";
import { CaptureSnapshot, FrameSubscriptionReport } from "./CaptureData.ts";

const DeadlineMillis = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 }));

/** Bounds apply to cooperative Effects. A deadline is not proof that native work has halted. */
export const RecordingOptions = Schema.Struct({
  maxFrames: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1024 }))),
  maxBufferedBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 64 * 1024 * 1024 })),
  ),
  /** First successfully written real frame, by default within ten seconds. */
  readyTimeoutMillis: Schema.optionalKey(DeadlineMillis),
  /** One writer call, by default within ten seconds. No failed call is retried. */
  writeTimeoutMillis: Schema.optionalKey(DeadlineMillis),
  /** After detachment, finish admitted writes within ten seconds by default. */
  drainTimeoutMillis: Schema.optionalKey(DeadlineMillis),
  /** Finish or abort the writer within ten seconds by default. */
  finalizeTimeoutMillis: Schema.optionalKey(DeadlineMillis),
});

export type RecordingOptions = typeof RecordingOptions.Type;

export class RecordingError extends Schema.TaggedError<RecordingError>()("RecordingError", {
  reason: Schema.Literals([
    "configuration",
    "empty",
    "ready-timeout",
    "write-timeout",
    "drain-timeout",
    "finalize-timeout",
    "abort-timeout",
  ]),
}) {}

/** Receipt-time coverage. The first write acknowledgement is readiness, not pixel attribution. */
export const RecordingSample = Schema.Struct({
  sequence: Schema.Natural,
  document: Schema.Natural,
  sourceTimeMillis: Schema.Finite,
  sourceClock: Schema.Literal("presentation-unix-millis"),
  receivedMonotonicNanos: Schema.BigInt,
  writtenMonotonicNanos: Schema.BigInt,
});

export type RecordingSample = typeof RecordingSample.Type;

const Progress = {
  writtenFrames: Schema.Natural,
  writtenBytes: Schema.Natural,
  first: Schema.NullOr(RecordingSample),
  last: Schema.NullOr(RecordingSample),
};

export class RecordingSnapshot extends Schema.Class<RecordingSnapshot>("BrowserRecordingSnapshot")({
  ...Progress,
  phase: Schema.Literals(["recording", "draining", "finalizing", "settled"]),
}) {}

/** Bounded domain facts only. The job separately retains typed host failures and artifact values. */
export class RecordingReport extends Schema.Class<RecordingReport>("BrowserRecordingReport")({
  ...Progress,
  sourceId: Identifier,
  status: Schema.Literals(["complete", "partial", "failed"]),
  writer: Schema.Literals(["finalized", "aborted", "unresolved"]),
  artifactRetained: Schema.Boolean,
  captureAtStart: CaptureSnapshot,
  captureAtEnd: CaptureSnapshot,
  subscription: FrameSubscriptionReport,
  /** The source remains borrowed. These facts do not establish compositor completeness. */
  upstreamDrops: Schema.Literal("unknown"),
}) {}
