import { Schema } from "effect";
import { SessionReference } from "./References.ts";
import { SessionStatus } from "./SessionData.ts";

export class CleanupIssue extends Schema.Class<CleanupIssue>("BrowserbaseCleanupIssue")({
  step: Schema.Literals(["fence", "capture", "initialization", "disconnect", "release", "status"]),
  reason: Schema.Literals(["timeout", "failed", "interrupted"]),
}) {}

/** Local disconnection, release acknowledgement, and terminal observation are separate facts. */
export class CleanupResult extends Schema.Class<CleanupResult>("BrowserbaseCleanupResult")({
  reference: SessionReference,
  ownership: Schema.Literals(["owned", "borrowed"]),
  releaseRequested: Schema.Boolean,
  remote: Schema.Literals(["confirmed", "pending", "unknown", "not-owned"]),
  local: Schema.Literals(["closed", "failed", "not-connected", "pending"]),
  observedStatus: Schema.optionalKey(SessionStatus),
  issues: Schema.Array(CleanupIssue).check(Schema.isMaxLength(64)),
}) {}
