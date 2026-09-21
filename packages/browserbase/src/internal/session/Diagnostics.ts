import { Cause, Data, Effect, ErrorReporter } from "effect";

import type { CleanupResult } from "../../Cleanup.ts";
import type { AllocationAttempt } from "../../References.ts";

/**
 * Operator-visible evidence that a session's fate was not settled. It carries identity and
 * outcome labels only: no provider body, connection URL, credential or page content. The
 * transport deliberately disables tracing where credentials travel, so without this an
 * unconfirmed release or an allocation of unknown outcome would leave no trace for anyone who
 * did not register a callback.
 */
class SessionUnsettled extends Data.TaggedError("BrowserbaseSessionUnsettled")<{
  readonly message: string;
  readonly details: Readonly<Record<string, string | number>>;
}> {
  readonly [ErrorReporter.severity] = "Warn" as const;

  get [ErrorReporter.attributes]() {
    return this.details;
  }
}

const surface = (message: string, details: Readonly<Record<string, string | number>>) =>
  Effect.logWarning(message).pipe(
    Effect.annotateLogs(details),
    Effect.andThen(ErrorReporter.report(Cause.fail(new SessionUnsettled({ message, details })))),
  );

/** A borrowed scope never owns release, so only its local teardown can be unsettled. */
export const reportCleanup = (result: CleanupResult): Effect.Effect<void> => {
  const remoteUnsettled =
    result.ownership === "owned" && (result.remote !== "confirmed" || !result.releaseRequested);

  if (!remoteUnsettled && result.local !== "failed" && result.issues.length === 0)
    return Effect.void;

  return surface("Browserbase session cleanup ended without confirmation", {
    projectId: result.reference.projectId,
    sessionId: result.reference.sessionId,
    ownership: result.ownership,
    remote: result.remote,
    local: result.local,
    observedStatus: result.observedStatus ?? "unobserved",
    issues: result.issues.map((issue) => `${issue.step}:${issue.reason}`).join(",") || "none",
  });
};

/** The provider may have allocated a session this process has no reference for. */
export const reportAllocationUncertain = (attempt: AllocationAttempt): Effect.Effect<void> =>
  surface("Browserbase allocation outcome is unknown", {
    projectId: attempt.projectId,
    attemptId: attempt.attemptId,
    requestedAtMillis: attempt.requestedAtMillis,
  });
