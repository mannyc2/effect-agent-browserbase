import { Cause, Effect, Exit, Option } from "effect";

import { CleanupIssue, CleanupResult } from "../../Cleanup.ts";
import type { BrowserError, InitializationError } from "../../Errors.ts";
import type { SessionReference } from "../../References.ts";
import type { SessionStatus } from "../../SessionData.ts";
import type { BrowserbaseSessions } from "../../Sessions.ts";

/** All effects are captured by the owning connection; no native value is exported. */
export interface LocalCleanup {
  readonly fence: Effect.Effect<void>;
  readonly capture: Effect.Effect<void, BrowserError>;
  readonly initialization: Effect.Effect<void, BrowserError | InitializationError>;
  readonly disconnect: Effect.Effect<CleanupResult["local"], BrowserError>;
}

export const noLocalConnection: LocalCleanup = {
  fence: Effect.void,
  capture: Effect.void,
  initialization: Effect.void,
  disconnect: Effect.succeed("not-connected"),
};

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
  local: LocalCleanup,
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
          action.pipe(
            Effect.interruptible,
            Effect.timeoutOrElse({
              duration: milliseconds,
              orElse: () =>
                Effect.fail(CleanupIssue.make({ step: name, reason: "timeout" })),
            }),
            Effect.exit,
            Effect.tap((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) return;
                const reason = Cause.findErrorOption(exit.cause);
                issues.push(
                  CleanupIssue.make({
                    step: name,
                    reason:
                      Option.isSome(reason) && reason.value instanceof CleanupIssue
                        ? reason.value.reason
                        : Cause.hasInterrupts(exit.cause)
                          ? "interrupted"
                          : "failed",
                  }),
                );
              }),
            ),
          );

        // The fence runs synchronously before interruptible native teardown begins.
        yield* step("fence", local.fence, limits.localStepMillis);
        yield* step("capture", local.capture, limits.localStepMillis);
        yield* step("initialization", local.initialization, limits.localStepMillis);
        const disconnected = yield* step("disconnect", local.disconnect, limits.localStepMillis);
        const localState = Exit.isSuccess(disconnected) ? disconnected.value : "failed";

        let releaseRequested = false;
        let remote: CleanupResult["remote"] = ownership === "borrowed" ? "not-owned" : "unknown";
        let observedStatus: SessionStatus | undefined;
        if (ownership === "owned") {
          const requested = yield* step("release", sessions.requestRelease(reference), limits.releaseMillis);
          releaseRequested = Exit.isSuccess(requested);
          // A POST response is never substituted for a passive terminal-state observation.
          const terminal = yield* step(
            "status",
            sessions.waitForTerminal(reference, { timeoutMillis: limits.terminalMillis }),
            limits.terminalMillis,
          );
          if (Exit.isSuccess(terminal)) {
            remote = "confirmed";
            observedStatus = terminal.value.status;
          } else if (Exit.isSuccess(requested)) {
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
