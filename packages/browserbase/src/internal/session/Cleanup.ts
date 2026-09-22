import { Effect, Option } from "effect";
import { cleanupStep, noConnection, type ConnectionCleanup } from "effect-browser/browser-runtime";

export { reported } from "effect-browser/browser-runtime";
export type { ConnectionCleanup as LocalCleanup } from "effect-browser/browser-runtime";

import { CleanupIssue, CleanupResult } from "../../Cleanup.ts";
import type { SessionReference } from "../../References.ts";
import type { SessionStatus } from "../../SessionData.ts";
import type { BrowserbaseSessions } from "../../Sessions.ts";

export const noLocalConnection = noConnection;

/** Internal limits, also injectable by deterministic failure tests. */
export interface CleanupLimits {
  readonly localStepMillis: number;
  readonly releaseMillis: number;
  readonly terminalMillis: number;
}

export const defaultCleanupLimits: CleanupLimits = {
  localStepMillis: 3000,
  releaseMillis: 4000,
  terminalMillis: 4000,
};

/**
 * Close is one uninterruptible, bounded transaction over *local cleanup evidence*, not
 * a transaction over the remote browser. Each step observes its own Exit so failures
 * cannot suppress a later disconnect, release request, or exact-session status read.
 */
export const makeCleanup = Effect.fnUntraced(function* (
  reference: SessionReference,
  ownership: CleanupResult["ownership"],
  sessions: BrowserbaseSessions["Service"],
  local: ConnectionCleanup,
  report: (result: CleanupResult) => void,
  limits: CleanupLimits = defaultCleanupLimits,
) {
  let latest: CleanupResult | undefined;

  const close = yield* Effect.cached(
    Effect.uninterruptible(
      Effect.gen(function* () {
        const issues: CleanupIssue[] = [];

        const step = <A, E>(
          name: CleanupIssue["step"],
          action: Effect.Effect<A, E>,
          milliseconds: number,
        ) =>
          cleanupStep(action, milliseconds).pipe(
            Effect.tap((result) =>
              Effect.sync(() => {
                if (result._tag === "Failure")
                  issues.push(CleanupIssue.make({ step: name, reason: result.reason }));
              }),
            ),
          );

        // The fence runs synchronously before interruptible native teardown begins.
        yield* step("fence", local.fence, limits.localStepMillis);
        yield* step("capture", local.capture, limits.localStepMillis);
        yield* step("initialization", local.initialization, limits.localStepMillis);
        const disconnected = yield* step("disconnect", local.disconnect, limits.localStepMillis);
        const localState = disconnected._tag === "Success" ? disconnected.value : "failed";

        let releaseRequested = false;
        let remote: CleanupResult["remote"] = ownership === "borrowed" ? "not-owned" : "unknown";
        let observedStatus: SessionStatus | undefined;

        if (ownership === "owned") {
          const requested = yield* step(
            "release",
            sessions.requestRelease(reference),
            limits.releaseMillis,
          );

          releaseRequested = requested._tag === "Success";

          // A POST response is never substituted for a passive terminal-state observation.
          const terminal = yield* step(
            "status",
            sessions.waitForTerminal(reference, { timeoutMillis: limits.terminalMillis }),
            limits.terminalMillis,
          );

          if (terminal._tag === "Success") {
            remote = "confirmed";
            observedStatus = terminal.value.status;
          } else if (requested._tag === "Success") {
            remote = "pending";
          }
        }

        const result = CleanupResult.make({
          reference,
          ownership,
          releaseRequested,
          remote,
          local: localState,
          ...(observedStatus === undefined ? {} : { observedStatus }),
          issues,
        });

        Object.freeze(result.issues);
        latest = Object.freeze(result);
        report(latest);

        return latest;
      }),
    ),
  );

  return {
    close,
    result: Effect.sync(() => Option.fromNullishOr(latest)),
  };
});
