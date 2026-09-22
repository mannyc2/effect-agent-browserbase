import { Schema } from "effect";
import { type InlineFile, SafeFilename } from "effect-browser/browser-data";

export { PositiveInt, SafeFilename } from "effect-browser/browser-data";

import { Identifier, SessionReference } from "./References.ts";

/** Shared caller-owned transfer bounds. Omitted timeout retains the 60-second default. */
export const ArtifactTransferPolicy = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 })),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

export type ArtifactTransferPolicy = typeof ArtifactTransferPolicy.Type;

/**
 * A path the provider reported for a file it already holds. It is only ever decoded from a
 * provider response: no caller, and certainly no model, names a remote filesystem path.
 */
export const RemoteFilePath = Schema.NonEmptyString.check(
  Schema.isMaxLength(4096),
  Schema.makeFilter(
    (value) =>
      value.startsWith("/") &&
      !value.includes("\\") &&
      !value.includes("//") &&
      ![...value].some((character) => character < " " || character === "\x7f") &&
      value.split("/").every((segment) => segment !== "." && segment !== ".."),
    { title: "an absolute, traversal-free remote path" },
  ),
);

/**
 * Evidence of one accepted upload. `remotePath` exists only when the provider returned one;
 * its absence is reported rather than guessed, and attachment is refused without it.
 */
export class UploadReceipt extends Schema.Class<UploadReceipt>("BrowserbaseUploadReceipt")({
  reference: SessionReference,
  filename: SafeFilename,
  bytes: Schema.Natural,
  remotePath: Schema.optionalKey(RemoteFilePath),
  acknowledgement: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
}) {}

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

/**
 * The uploaded branch carries receipts, not paths. Attachment authority is the identity of a
 * receipt this package issued for this exact session, so decoding one back into a new value
 * would discard the very evidence being checked.
 */
export type FileSelection =
  | { readonly _tag: "Inline"; readonly files: ReadonlyArray<InlineFile> }
  | { readonly _tag: "Uploaded"; readonly uploads: ReadonlyArray<UploadReceipt> };

export interface SelectFilesRequest {
  readonly selector: string;
  readonly selection: FileSelection;
}
