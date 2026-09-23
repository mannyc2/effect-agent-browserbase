import { Effect, Option, Redacted } from "effect";

import type { Lifetime, Source } from "../../BrowserRuntime.ts";
import { BrowserError, Reasons } from "../../Errors.ts";
import { cleanupStep, reported } from "../browser/ConnectionCleanup.ts";
import { ScriptedCleanupIssue, ScriptedCleanupResult, type ScriptedReference } from "./Script.ts";

export interface ScriptedLease extends Lifetime {
  readonly reference: ScriptedReference;
  readonly closeChecked: Effect.Effect<ScriptedCleanupResult, BrowserError>;
  readonly release: Effect.Effect<ScriptedCleanupResult>;
  readonly cleanupResult: Effect.Effect<Option.Option<ScriptedCleanupResult>>;
}

/**
 * A lifetime with nothing outside the connection: no process to terminate and no provider to
 * release. Cleanup runs the same local steps an owned Chromium runs, each settling on its own,
 * and reports the same kind of receipt.
 */
export const scriptedSource =
  (
    reference: ScriptedReference,
    onCleanup?: (result: ScriptedCleanupResult) => Effect.Effect<void>,
  ): Source<ScriptedLease, never, never> =>
  (local) =>
    Effect.gen(function* () {
      let latest: ScriptedCleanupResult | undefined;
      let closing = false;

      const close = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.gen(function* () {
            const issues: ScriptedCleanupIssue[] = [];

            const step = <A, E>(name: ScriptedCleanupIssue["step"], action: Effect.Effect<A, E>) =>
              cleanupStep(action, 3000).pipe(
                Effect.tap((result) =>
                  Effect.sync(() => {
                    if (result._tag === "Failure")
                      issues.push(ScriptedCleanupIssue.make({ step: name, reason: result.reason }));
                  }),
                ),
              );

            yield* step("fence", local.fence);
            yield* step("capture", local.capture);
            yield* step("initialization", local.initialization);
            const disconnected = yield* step("disconnect", local.disconnect);

            const result = ScriptedCleanupResult.make({
              reference,
              connection: disconnected._tag === "Success" ? disconnected.value : "failed",
              issues,
            });

            Object.freeze(result.issues);
            latest = Object.freeze(result);

            return latest;
          }),
        ),
      );

      const release = yield* Effect.cached(
        Effect.gen(function* () {
          closing = true;
          const result = yield* close;

          if (onCleanup !== undefined) yield* reported(Effect.suspend(() => onCleanup(result)));

          return result;
        }).pipe(Effect.uninterruptible),
      );

      yield* Effect.addFinalizer(() => release.pipe(Effect.asVoid));

      return {
        reference,
        connection: () =>
          Effect.suspend(() =>
            closing
              ? Effect.fail(
                  BrowserError.make({
                    operation: "connect",
                    reason: Reasons.Closed.make({}),
                    outcome: "undispatched",
                  }),
                )
              : Effect.succeed(Redacted.make(`scripted://${reference.id}`)),
          ),
        release,
        closeChecked: release.pipe(
          Effect.filterOrFail(
            (result) => result.connection === "closed" && result.issues.length === 0,
            () =>
              BrowserError.make({
                operation: "close",
                reason: Reasons.Failed.make({}),
                outcome: "unknown",
              }),
          ),
        ),
        cleanupResult: Effect.sync(() => Option.fromNullishOr(latest)),
        controlRetired: Effect.sync(() => latest !== undefined && latest.connection === "closed"),
      } satisfies ScriptedLease;
    });
