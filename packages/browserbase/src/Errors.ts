import { Schema } from "effect";
import { AllocationAttempt, SessionReference } from "./References.ts";

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
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

const RequestReason = Schema.Literals([
  "configuration", "authorization", "rate-limited", "not-found", "active", "disabled",
  "expired", "provider", "transport", "timeout", "malformed", "limit", "unsafe-url", "content-type",
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
export class SessionError extends Schema.TaggedError<SessionError>()("SessionError", RequestFields) {}
export class ContextError extends Schema.TaggedError<ContextError>()("ContextError", RequestFields) {}
export class ExtensionError extends Schema.TaggedError<ExtensionError>()("ExtensionError", RequestFields) {}
export class FileError extends Schema.TaggedError<FileError>()("FileError", {
  ...RequestFields,
  reason: Schema.Literals([
    ...RequestReason.literals, "unsafe-filename", "ambiguous", "checksum", "unsupported",
  ]),
}) {}
export class ArtifactError extends Schema.TaggedError<ArtifactError>()("ArtifactError", {
  ...RequestFields,
  reason: Schema.Literals([
    ...RequestReason.literals, "failed", "byos", "assembly-unknown", "unsupported", "ambiguous",
  ]),
}) {}
export class InitializationError extends Schema.TaggedError<InitializationError>()("InitializationError", {
  operation: Schema.Literals(["configure", "register", "ready", "callback", "dispose"]),
  step: Schema.String.check(Schema.isMaxLength(128)),
  reason: Schema.Literals([
    "configuration", "unsupported", "origin", "stale", "busy", "closed", "timeout", "input", "output", "native",
  ]),
}) {}

/** Creation has a known rejection or an uncertain effect; absence of a reply is not a rejection. */
export class AllocationError extends Schema.TaggedError<AllocationError>()("AllocationError", {
  attempt: AllocationAttempt,
  reference: Schema.optionalKey(SessionReference),
  outcome: Schema.Literals(["rejected", "unknown"]),
  reason: Schema.Literals(["authorization", "rate-limited", "configuration", "provider", "transport", "timeout", "malformed"]),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
}) {}
