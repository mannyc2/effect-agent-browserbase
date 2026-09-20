import { Schema } from "effect";

/** Transport-safe data only. This entry point imports no native browser or encoder. */
export const Identifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Shared caller-owned transfer bounds. Omitted timeout retains the 60-second default. */
export const ArtifactTransferPolicy = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 })),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

export type ArtifactTransferPolicy = typeof ArtifactTransferPolicy.Type;

export const SessionStatus = Schema.Literals([
  "PENDING",
  "RUNNING",
  "COMPLETED",
  "ERROR",
  "TIMED_OUT",
]);

export type SessionStatus = typeof SessionStatus.Type;

/** A durable association, never a connection URL or proof that a browser is still alive. */
export class SessionReference extends Schema.Class<SessionReference>("BrowserbaseSessionReference")(
  {
    provider: Schema.Literal("browserbase"),
    projectId: Identifier,
    sessionId: Identifier,
  },
) {}

/** The nonce is reconciliation metadata, not provider idempotency. */
export class AllocationAttempt extends Schema.Class<AllocationAttempt>(
  "BrowserbaseAllocationAttempt",
)({
  projectId: Identifier,
  attemptId: Identifier,
  requestedAtMillis: Schema.Finite,
  timeoutSeconds: PositiveInt,
}) {}

/** Serializable host failures intentionally contain neither arbitrary causes nor page data. */
export class BrowserbaseError extends Schema.TaggedError<BrowserbaseError>()("BrowserbaseError", {
  operation: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  reason: Schema.Literals([
    "configuration",
    "unsupported",
    "busy",
    "closed",
    "stale",
    "not-found",
    "ambiguous",
    "malformed",
    "limit",
    "timeout",
    "transport",
    "provider",
    "authorization",
    "rate-limited",
    "disconnected",
    "allocation-unknown",
    "assembly-unknown",
    "active",
    "disabled",
    "expired",
    "failed",
    "byos",
    "unsafe-url",
    "unsafe-filename",
    "content-type",
    "timestamp",
    "resized",
    "target-changed",
    "interrupted",
    "context-lease",
  ]),
  outcome: Schema.optionalKey(Schema.Literals(["undispatched", "rejected", "unknown"])),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
}) {}

export class CleanupResult extends Schema.Class<CleanupResult>("BrowserbaseCleanupResult")({
  reference: SessionReference,
  releaseRequested: Schema.Boolean,
  remote: Schema.Literals(["confirmed", "pending", "unknown"]),
  local: Schema.Literals(["closed", "failed", "not-connected", "pending"]),
  observedStatus: Schema.optionalKey(SessionStatus),
  error: Schema.optionalKey(BrowserbaseError),
  reporting: Schema.optionalKey(Schema.Literals(["reported", "failed", "not-configured"])),
}) {}

export class Viewport extends Schema.Class<Viewport>("BrowserbaseViewport")(
  Schema.Struct({
    width: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)),
    height: PositiveInt.check(Schema.isLessThanOrEqualTo(4096)),
  }).check(
    Schema.makeFilter((v) => v.width * v.height <= 8_388_608, {
      title: "at most 8,388,608 viewport pixels",
    }),
  ),
) {}

/** Page/frame IDs are connection-local; targetId is a separate Chromium identity. */
export class Target extends Schema.Class<Target>("BrowserbaseTarget")({
  generation: Schema.Natural,
  pageId: Identifier,
  frameId: Identifier,
}) {}

export class PageInfo extends Schema.Class<PageInfo>("BrowserbasePageInfo")({
  pageId: Identifier,
  targetId: Identifier,
  url: Schema.String.check(Schema.isMaxLength(8192)),
  title: Schema.String.check(Schema.isMaxLength(512)),
  selected: Schema.Boolean,
}) {}

export class FrameInfo extends Schema.Class<FrameInfo>("BrowserbaseFrameInfo")({
  frameId: Identifier,
  parentFrameId: Schema.NullOr(Identifier),
  url: Schema.String.check(Schema.isMaxLength(8192)),
  name: Schema.String.check(Schema.isMaxLength(256)),
}) {}

export class ObservedControl extends Schema.Class<ObservedControl>("BrowserbaseObservedControl")({
  elementId: Identifier,
  kind: Schema.Literals(["link", "button", "input", "select", "textarea", "other"]),
  label: Schema.String.check(Schema.isMaxLength(256)),
  disabled: Schema.Boolean,
}) {}

/** Revision is admission fencing, not a claim of a complete DOM version or atomic snapshot. */
export class Observation extends Schema.Class<Observation>("BrowserbaseObservation")({
  target: Target,
  observationId: Identifier,
  revision: Schema.Natural,
  url: Schema.String.check(Schema.isMaxLength(8192)),
  text: Schema.String.check(Schema.isMaxLength(131072)),
  controls: Schema.Array(ObservedControl).check(Schema.isMaxLength(64)),
  controlsTruncated: Schema.Boolean,
  textTruncated: Schema.Boolean,
}) {}

export class ObservedElement extends Schema.Class<ObservedElement>("BrowserbaseObservedElement")({
  observationId: Identifier,
  elementId: Identifier,
}) {}

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
