import { Schema } from "effect";

import { AllocationAttempt, SessionReference } from "./References.ts";

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
