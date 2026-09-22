import { Schema } from "effect";

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
  "checkpoint",
  "control-facts",
  "revalidate",
  "read-text",
  "screenshot",
  "wait",
  // input
  "navigate",
  "navigate-stop",
  "click",
  "fill",
  "select-option",
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
  // native key input
  "press",
  "type",
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

/** Dispatch evidence belongs to the operation, independently of its failure reason. */
export const BrowserOutcome = Schema.Literals(["undispatched", "rejected", "unknown"]);

export type BrowserOutcome = typeof BrowserOutcome.Type;

/** Limits report measured producer facts; an unavailable measurement is never invented. */
export const LimitDimension = Schema.Literals([
  "actions",
  "elapsed",
  "returned-bytes",
  "pages",
  "frames",
  "frame-depth",
  "buffered-frames",
  "buffered-bytes",
  "host-reads",
  "controls",
  "text",
  "captures",
  "frame-bytes",
  "width",
  "height",
  "pixels",
]);

const SchemaPath = Schema.String.check(Schema.isMaxLength(512));

/** Validated constructors for host reasons. The model receives a separate bounded projection. */
export const Reasons = {
  Configuration: Schema.TaggedStruct("Configuration", { path: Schema.optionalKey(SchemaPath) }),
  UnregisteredSession: Schema.TaggedStruct("UnregisteredSession", {}),
  Unsupported: Schema.TaggedStruct("Unsupported", {}),
  Busy: Schema.TaggedStruct("Busy", {}),
  Closed: Schema.TaggedStruct("Closed", {}),
  Stale: Schema.TaggedStruct("Stale", {}),
  NotFound: Schema.TaggedStruct("NotFound", {}),
  Ambiguous: Schema.TaggedStruct("Ambiguous", {}),
  Malformed: Schema.TaggedStruct("Malformed", { path: Schema.optionalKey(SchemaPath) }),
  Limit: Schema.TaggedStruct("Limit", {
    dimension: LimitDimension,
    maximum: Schema.Natural,
    observed: Schema.Natural,
  }),
  Timeout: Schema.TaggedStruct("Timeout", {}),
  Transport: Schema.TaggedStruct("Transport", { status: Schema.optionalKey(Schema.Int) }),
  Provider: Schema.TaggedStruct("Provider", { status: Schema.optionalKey(Schema.Int) }),
  Authorization: Schema.TaggedStruct("Authorization", {}),
  RateLimited: Schema.TaggedStruct("RateLimited", {
    retryAfterMillis: Schema.optionalKey(Schema.Natural),
  }),
  Disconnected: Schema.TaggedStruct("Disconnected", {}),
  Active: Schema.TaggedStruct("Active", {}),
  Disabled: Schema.TaggedStruct("Disabled", {}),
  Expired: Schema.TaggedStruct("Expired", {}),
  Failed: Schema.TaggedStruct("Failed", {}),
  UnsafeUrl: Schema.TaggedStruct("UnsafeUrl", {}),
  ContentType: Schema.TaggedStruct("ContentType", {}),
  Timestamp: Schema.TaggedStruct("Timestamp", {}),
  Resized: Schema.TaggedStruct("Resized", {}),
  TargetChanged: Schema.TaggedStruct("TargetChanged", {}),
  Interrupted: Schema.TaggedStruct("Interrupted", {}),
  ContextLease: Schema.TaggedStruct("ContextLease", {}),
  NotVisible: Schema.TaggedStruct("NotVisible", {}),
  Denied: Schema.TaggedStruct("Denied", {}),
  NotFocused: Schema.TaggedStruct("NotFocused", {}),
} as const;

export const BrowserReason = Schema.Union(Object.values(Reasons));

export type BrowserReason = typeof BrowserReason.Type;

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: BrowserOperation,
  reason: BrowserReason,
  outcome: BrowserOutcome,
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
