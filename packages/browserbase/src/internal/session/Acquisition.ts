import { Clock, Effect, Exit, Option, Schema, Scope } from "effect";

import type { CleanupResult } from "../../Cleanup.ts";
import { BrowserbaseClient } from "../../Client.ts";
import { AllocationError, ContextError, type ClientError, SessionError } from "../../Errors.ts";
import type { LaunchRecipe } from "../../Launch.ts";
import { type AllocationAttempt, Identifier, SessionReference } from "../../References.ts";
import { BrowserbaseSessions } from "../../Sessions.ts";
import { connectionAddress } from "../provider/Connection.ts";
import { compileLaunch } from "../provider/Launch.ts";
import {
  makeCleanup,
  noLocalConnection,
  reported,
  type CleanupLimits,
  type LocalCleanup,
} from "./Cleanup.ts";
import { requireContextWriterPermit, type ContextWriterPermitInternal } from "./ContextWriter.ts";
import type { ContextWriterPermit } from "./WriterFacts.ts";

const AllocatedIdentity = Schema.Struct({ id: Identifier, projectId: Identifier });

export interface AcquisitionOptions {
  readonly launch: LaunchRecipe;
  readonly contextWriter?: ContextWriterPermit;
  readonly allocationDeadline?: number;
  /** Bounded host notification of the canonical facts. Reporting never changes them. */
  readonly onCleanup?: (result: CleanupResult) => Effect.Effect<void>;
  /** Exactly one notification when a creation attempt's effect on the provider is unknown. */
  readonly onAllocationUncertain?: (attempt: AllocationAttempt) => Effect.Effect<void>;
}

/**
 * The remote lease is registered before POST. Local connection work is supplied by
 * the same browser owner; the control plane never invents a second operation owner.
 */
export const acquireRemote = Effect.fnUntraced(function* (
  options: AcquisitionOptions,
  local: LocalCleanup = noLocalConnection,
  limits?: CleanupLimits,
) {
  const client = yield* BrowserbaseClient;
  const sessions = yield* BrowserbaseSessions;
  const parent = yield* Scope.Scope;

  const launch = yield* compileLaunch(options.launch, {
    projectId: client.projectId,
    attemptId: globalThis.crypto.randomUUID(),
    requestedAtMillis: yield* Clock.currentTimeMillis,
  });

  const attempt = launch.attempt;
  let writer: ContextWriterPermitInternal | undefined;

  if (launch.context?.persist) {
    if (options.contextWriter === undefined) {
      return yield* ContextError.make({
        operation: "writer-authority",
        reason: "authorization",
        outcome: "undispatched",
      });
    }
    writer = yield* requireContextWriterPermit(options.contextWriter, {
      provider: "browserbase",
      projectId: client.projectId,
      contextId: launch.context.id,
    });
  } else if (options.contextWriter !== undefined) {
    return yield* ContextError.make({
      operation: "writer-authority",
      reason: "configuration",
      outcome: "undispatched",
    });
  }

  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const resourceScope = yield* Scope.make();
      let reference: SessionReference | undefined;
      let admitted = false;
      let knownRejection = false;
      let closing = false;
      let cleanup: CleanupResult | undefined;

      let uncertainReported = false;

      const allocationUncertain = Effect.suspend(() => {
        if (uncertainReported || options.onAllocationUncertain === undefined) return Effect.void;
        uncertainReported = true;

        return reported(options.onAllocationUncertain(attempt));
      });

      const terminate = yield* Effect.cached(
        Effect.uninterruptible(
          Effect.gen(function* () {
            closing = true;
            if (reference === undefined) {
              if (admitted && !knownRejection) {
                writer?.uncertain(attempt);
                yield* allocationUncertain;
              }

              return;
            }

            const coordinator = yield* makeCleanup(
              reference,
              "owned",
              sessions,
              local,
              (result) => {
                cleanup = result;
                writer?.completed(attempt, result);
              },
              limits,
            );

            yield* coordinator.close;
            if (cleanup !== undefined && options.onCleanup !== undefined)
              yield* reported(options.onCleanup(cleanup));
          }),
        ),
      );

      const closeScope = yield* Effect.cached(Scope.close(resourceScope, Exit.void));

      yield* Scope.addFinalizer(resourceScope, terminate);
      yield* Scope.addFinalizer(parent, closeScope);

      const failedAllocation = (error: ClientError): AllocationError => {
        knownRejection = error.outcome === "rejected" || error.outcome === "undispatched";
        if (knownRejection) writer?.rejected(attempt);
        else writer?.uncertain(attempt);
        const reason = error.reason;

        return AllocationError.make({
          attempt,
          outcome: knownRejection ? "rejected" : "unknown",
          reason:
            reason === "authorization" ||
            reason === "rate-limited" ||
            reason === "configuration" ||
            reason === "transport" ||
            reason === "timeout" ||
            reason === "malformed"
              ? reason
              : "provider",
          ...(error.status === undefined ? {} : { status: error.status }),
          ...(error.retryAfterMillis === undefined
            ? {}
            : { retryAfterMillis: error.retryAfterMillis }),
        });
      };

      const allocate = Effect.gen(function* () {
        if (writer !== undefined) yield* writer.recordAttempt(attempt);
        admitted = true;

        const raw = yield* restore(
          client.json("POST", "/v1/sessions", launch.body, options.allocationDeadline),
        ).pipe(Effect.mapError(failedAllocation));

        const identity = yield* Schema.decodeUnknownEffect(AllocatedIdentity)(raw).pipe(
          Effect.mapError(() =>
            AllocationError.make({ attempt, outcome: "unknown", reason: "malformed" }),
          ),
        );

        // Save identity before interpreting any connection credentials or provider metadata.
        reference = Object.freeze(
          SessionReference.make({
            provider: "browserbase",
            projectId: identity.projectId,
            sessionId: identity.id,
          }),
        );
        writer?.recordSession(attempt, reference);
        if (reference.projectId !== client.projectId) {
          return yield* AllocationError.make({
            attempt,
            reference,
            outcome: "unknown",
            reason: "malformed",
          });
        }
        const ref = reference;

        return {
          reference: ref,
          attempt,
          launch,
          resourceScope,
          isClosed: () => closing,
          connection: (timeoutMillis: number) =>
            Effect.suspend(() =>
              closing
                ? Effect.fail(
                    SessionError.make({
                      operation: "session-connect",
                      reason: "expired",
                      outcome: "undispatched",
                    }),
                  )
                : connectionAddress(client, sessions, ref, timeoutMillis),
            ),
          release: closeScope.pipe(
            Effect.andThen(
              Effect.suspend(() =>
                cleanup === undefined
                  ? Effect.die(new Error("Owned session closed without cleanup evidence"))
                  : Effect.succeed(cleanup),
              ),
            ),
          ),
          cleanupResult: Effect.sync(() => Option.fromNullishOr(cleanup)),
        };
      });

      return yield* allocate.pipe(
        Effect.onError(() => closeScope),
        Effect.onInterrupt(() => closeScope),
      );
    }),
  );
});

export type RemoteAcquisition = Effect.Success<ReturnType<typeof acquireRemote>>;
