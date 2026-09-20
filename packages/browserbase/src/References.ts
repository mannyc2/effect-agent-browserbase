import { Schema } from "effect";

export const Identifier = Schema.NonEmptyString.check(
  Schema.isMaxLength(256),
  Schema.isPattern(/^[A-Za-z0-9_-]+$/),
);

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
  timeoutSeconds: Schema.Int.check(Schema.isBetween({ minimum: 60, maximum: 21600 })),
}) {}

/** Project-qualified durable identity; no browser connection or credential is retained. */
export class ContextReference extends Schema.Class<ContextReference>("BrowserbaseContextReference")({
  provider: Schema.Literal("browserbase"),
  projectId: Identifier,
  contextId: Identifier,
}) {}

export class ExtensionReference extends Schema.Class<ExtensionReference>("BrowserbaseExtensionReference")({
  provider: Schema.Literal("browserbase"),
  projectId: Identifier,
  extensionId: Identifier,
}) {}
