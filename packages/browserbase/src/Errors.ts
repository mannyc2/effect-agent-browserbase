import { Schema } from "effect";

import { AllocationAttempt, SessionReference } from "./References.ts";

/**
 * What a caller asked the owned browser to do. The vocabulary is closed: the owner stamps it
 * when it admits an operation, so a native step's own name can never become API, and a new
 * spelling is a deliberate edit here rather than a string that merely compiles.
 */
export const BrowserOperation = Schema.Literals([
  // configuration and lifetime
  "configure",
  "launch",
  "connect",
  "reconnect",
  "detach",
  "disconnect",
  "close",
  "handoff",
  "resume",
  "live-view",
  // targets
  "target",
  "handle",
  "list-pages",
  "list-frames",
  "select-page",
  "select-frame",
  "new-page",
  "close-page",
  "resize",
  // reading
  "ready",
  "observe",
  "read-text",
  "screenshot",
  "wait",
  // input
  "navigate",
  "click",
  "fill",
  "scroll",
  "click-and-wait",
  "download-action",
  "select-files",
  "file-chooser",
  "action-result",
  // native pointer input
  "pointer-move",
  "hover",
  "wheel",
  // page control
  "page-control",
  "page-state",
  "page-suspend",
  "page-resume",
  // capture
  "capture",
  "capture-start",
  "capture-stop",
  "capture-consume",
]);

export type BrowserOperation = typeof BrowserOperation.Type;

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: BrowserOperation,
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
    "active",
    "disabled",
    "expired",
    "failed",
    "unsafe-url",
    "content-type",
    "timestamp",
    "resized",
    "target-changed",
    "interrupted",
    "context-lease",
    // The pointer cannot be placed on it: outside the viewport, without area, or covered.
    "not-visible",
  ]),
  outcome: Schema.optionalKey(Schema.Literals(["undispatched", "rejected", "unknown"])),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
}) {}

const RequestReason = Schema.Literals([
  "configuration",
  "authorization",
  "rate-limited",
  "not-found",
  "active",
  "disabled",
  "expired",
  "provider",
  "transport",
  "timeout",
  "malformed",
  "limit",
  "unsafe-url",
  "content-type",
]);

/**
 * Every control-plane error shares these fields, but never a vocabulary: each names only the
 * operations its own service performs, so a caller can match on them exhaustively.
 */
const requestFields = <const Operations extends ReadonlyArray<string>>(operations: Operations) => ({
  operation: Schema.Literals(operations),
  reason: RequestReason,
  outcome: Schema.optionalKey(Schema.Literals(["undispatched", "rejected", "unknown"])),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
});

/** Credential-free control-plane failures; response bodies and native causes never escape. */
export class ClientError extends Schema.TaggedError<ClientError>()(
  "ClientError",
  requestFields([
    "configure",
    "provider-read",
    "provider-mutation",
    "provider-upload",
    "media-download",
  ]),
) {}

export class SessionError extends Schema.TaggedError<SessionError>()(
  "SessionError",
  requestFields([
    "session-retrieve",
    "session-list",
    "session-release",
    "session-wait",
    "session-logs",
    "session-live-view",
    "session-connect",
    "session-attach",
  ]),
) {}

export class ContextError extends Schema.TaggedError<ContextError>()(
  "ContextError",
  requestFields([
    "context-create",
    "context-retrieve",
    "context-delete",
    "writer",
    "writer-admit",
    "writer-authority",
    "writer-readback",
    "writer-settle",
  ]),
) {}

/**
 * `extension-archive` is the local inspection of the bytes a caller supplied, before any
 * request. Why an archive was refused is its reason, never a second operation.
 */
export class ExtensionError extends Schema.TaggedError<ExtensionError>()("ExtensionError", {
  ...requestFields([
    "extension-archive",
    "extension-register",
    "extension-retrieve",
    "extension-delete",
  ]),
  reason: Schema.Literals([...RequestReason.literals, "unsafe-filename"]),
}) {}

/** Project inspection and usage. */
export class ProjectError extends Schema.TaggedError<ProjectError>()(
  "ProjectError",
  requestFields(["project-list", "project-retrieve", "project-usage"]),
) {}

/** Proxy CA certificate administration. */
export class CertificateError extends Schema.TaggedError<CertificateError>()(
  "CertificateError",
  requestFields([
    "certificate-create",
    "certificate-list",
    "certificate-retrieve",
    "certificate-delete",
  ]),
) {}

/**
 * Browserbase platform services outside a browser session: Search, Fetch, Agents, Functions
 * and Webhooks. `service` names which one; these are host APIs, never model-facing tools.
 */
export class PlatformError extends Schema.TaggedError<PlatformError>()("PlatformError", {
  ...requestFields([
    "search-web",
    "fetch",
    "agent-create",
    "agent-list",
    "agent-retrieve",
    "agent-update",
    "agent-delete",
    "agent-run",
    "agent-run-list",
    "agent-run-retrieve",
    "agent-run-messages",
    "agent-run-stop",
    "agent-run-wait",
    "function-list",
    "function-retrieve",
    "function-versions",
    "function-version",
    "function-builds",
    "function-build",
    "function-build-logs",
    "function-invoke",
    "function-invocations",
    "function-invocation",
    "function-invocation-logs",
    "function-wait",
    "webhook-create",
    "webhook-list",
    "webhook-retrieve",
    "webhook-update",
    "webhook-delete",
    "webhook-rotate-secret",
  ]),
  service: Schema.Literals(["search", "fetch", "agents", "functions", "webhooks"]),
}) {}

export class FileError extends Schema.TaggedError<FileError>()("FileError", {
  ...requestFields([
    "upload",
    "downloads-list",
    "download-metadata",
    "download",
    "download-wait",
    "download-delete",
  ]),
  reason: Schema.Literals([
    ...RequestReason.literals,
    "unsafe-filename",
    "ambiguous",
    "checksum",
    "unsupported",
  ]),
}) {}

export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  ...requestFields([
    "recording-request",
    "recording-status",
    "recording-wait",
    "recording",
    "recording-download",
    "replay-metadata",
    "replay",
    "replay-playlist",
    "replay-media",
  ]),
  reason: Schema.Literals([
    ...RequestReason.literals,
    "failed",
    "byos",
    "assembly-unknown",
    "unsupported",
    "ambiguous",
  ]),
}) {}

export class InitializationError extends Schema.TaggedError<InitializationError>()(
  "InitializationError",
  {
    operation: Schema.Literals(["configure", "register", "ready", "callback", "dispose"]),
    step: Schema.String.check(Schema.isMaxLength(128)),
    reason: Schema.Literals([
      "configuration",
      "unsupported",
      "origin",
      "stale",
      "busy",
      "closed",
      "timeout",
      "input",
      "output",
      "native",
    ]),
  },
) {}

/** Creation has a known rejection or an uncertain effect; absence of a reply is not a rejection. */
export class AllocationError extends Schema.TaggedError<AllocationError>()("AllocationError", {
  attempt: AllocationAttempt,
  reference: Schema.optionalKey(SessionReference),
  outcome: Schema.Literals(["rejected", "unknown"]),
  reason: Schema.Literals([
    "authorization",
    "rate-limited",
    "configuration",
    "provider",
    "transport",
    "timeout",
    "malformed",
  ]),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
}) {}
