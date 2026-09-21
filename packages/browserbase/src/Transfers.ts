import { Schema } from "effect";

import { Identifier, SessionReference } from "./References.ts";

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Shared caller-owned transfer bounds. Omitted timeout retains the 60-second default. */
export const ArtifactTransferPolicy = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 })),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

export type ArtifactTransferPolicy = typeof ArtifactTransferPolicy.Type;

/** Portable basename only; never a local or remote filesystem path. */
export const SafeFilename = Schema.NonEmptyString.check(
  Schema.isMaxLength(240),
  Schema.makeFilter(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !/[\x00-\x1f\x7f/\\:]/.test(value) &&
      !/[. ]$/.test(value) &&
      !/^\s/.test(value) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
    { title: "a portable, non-path download filename" },
  ),
);

export class DownloadMetadata extends Schema.Class<DownloadMetadata>("BrowserbaseDownloadMetadata")(
  {
    id: Identifier,
    sessionId: Identifier,
    filename: SafeFilename,
    mimeType: Schema.NonEmptyString.check(Schema.isMaxLength(128)),
    size: Schema.Natural,
    checksum: Schema.String.check(Schema.isPattern(/^[a-fA-F0-9]{64}$/)),
    createdAt: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  },
) {}

/** A native event identity is not a provider download ID. Associate provider metadata explicitly. */
export class DownloadObservation extends Schema.Class<DownloadObservation>(
  "BrowserbaseDownloadObservation",
)({
  reference: SessionReference,
  downloadId: Identifier,
  filename: SafeFilename,
  state: Schema.Literals(["started", "completed", "failed", "unknown"]),
}) {}

export class RecordingPageReference extends Schema.Class<RecordingPageReference>(
  "BrowserbaseRecordingPageReference",
)({
  session: SessionReference,
  pageId: Identifier,
}) {}

export class RecordingPage extends Schema.Class<RecordingPage>("BrowserbaseRecordingPage")({
  pageId: Identifier,
  status: Schema.Literals(["NOT_REQUESTED", "PENDING", "COMPLETED", "FAILED"]),
  delivery: Schema.Literals(["not-ready", "download", "external-storage"]),
  completedAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
}) {}

export class RecordingBatch extends Schema.Class<RecordingBatch>("BrowserbaseRecordingBatch")({
  reference: SessionReference,
  pages: Schema.Array(RecordingPage).check(Schema.isMaxLength(256)),
  timedOut: Schema.Boolean,
}) {}

export class ReplayPage extends Schema.Class<ReplayPage>("BrowserbaseReplayPage")({
  pageId: Identifier,
  startTimeMs: Schema.Finite,
  endTimeMs: Schema.Finite,
}) {}
