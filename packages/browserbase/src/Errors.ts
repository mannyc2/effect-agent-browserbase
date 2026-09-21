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

const RequestFields = {
  operation: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
  reason: RequestReason,
  outcome: Schema.optionalKey(Schema.Literals(["undispatched", "rejected", "unknown"])),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
};

/** Credential-free control-plane failures; response bodies and native causes never escape. */
export class ClientError extends Schema.TaggedError<ClientError>()("ClientError", RequestFields) {}

export class SessionError extends Schema.TaggedError<SessionError>()(
  "SessionError",
  RequestFields,
) {}

export class ContextError extends Schema.TaggedError<ContextError>()(
  "ContextError",
  RequestFields,
) {}

export class ExtensionError extends Schema.TaggedError<ExtensionError>()(
  "ExtensionError",
  RequestFields,
) {}

/** Project inspection and usage. */
export class ProjectError extends Schema.TaggedError<ProjectError>()(
  "ProjectError",
  RequestFields,
) {}

/** Proxy CA certificate administration. */
export class CertificateError extends Schema.TaggedError<CertificateError>()(
  "CertificateError",
  RequestFields,
) {}

/**
 * Browserbase platform services outside a browser session: Search, Fetch, Agents, Functions
 * and Webhooks. `service` names which one; these are host APIs, never model-facing tools.
 */
export class PlatformError extends Schema.TaggedError<PlatformError>()("PlatformError", {
  ...RequestFields,
  service: Schema.Literals(["search", "fetch", "agents", "functions", "webhooks"]),
}) {}

export class FileError extends Schema.TaggedError<FileError>()("FileError", {
  ...RequestFields,
  reason: Schema.Literals([
    ...RequestReason.literals,
    "unsafe-filename",
    "ambiguous",
    "checksum",
    "unsupported",
  ]),
}) {}

export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  ...RequestFields,
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
