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

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: BrowserOperation,
  reason: Schema.Literals([
    "configuration",
    "unregistered-session",
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
    // The host's own admission policy refused it, on facts read just before any input.
    "denied",
    // Keys would not reach it: neither it nor anything inside it has focus.
    "not-focused",
  ]),
  outcome: Schema.optionalKey(Schema.Literals(["undispatched", "rejected", "unknown"])),
  status: Schema.optionalKey(Schema.Int),
  retryAfterMillis: Schema.optionalKey(Schema.Natural),
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
