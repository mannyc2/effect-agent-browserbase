import { Clock, Effect, Exit, Schema, type Scope } from "effect";

import { ContextError, type SessionError } from "./Errors.ts";
import {
  claimReconciliation,
  makeContextWriterPermit,
  closeContextWriterPermit,
  isContextWriterBusy,
} from "./internal/session/ContextWriter.ts";
import type {
  ContextWriterBackend,
  ContextWriterPermit,
  WriterOptions,
} from "./internal/session/WriterFacts.ts";
import { ContextReference } from "./References.ts";
import { isTerminalSessionStatus } from "./SessionData.ts";
import { BrowserbaseSessions } from "./Sessions.ts";

export {
  PersistenceEvidence,
  WriterAttemptFacts,
  WriterSettlementFacts,
  type ContextWriterBackend,
  type ContextWriterPermit,
  type WriterLease,
  type WriterOptions,
} from "./internal/session/WriterFacts.ts";

const decodeReference = (reference: ContextReference, operation: "writer" | "writer-reconcile") =>
  Schema.decodeEffect(ContextReference)(reference, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() =>
      ContextError.make({ operation, reason: "configuration", outcome: "undispatched" }),
    ),
  );

/**
 * Owns the backend lease, child browser scopes, and exact attempt evidence. The backend must
 * handle uncertain distributed lease acquisition itself. It must persist quarantine facts;
 * a local Scope closing is never permission to admit another remote writer. A writer that
 * settles as anything but a release leaves its Context refused in this process until
 * `reconcile` succeeds.
 */
export const withWriter = <A, E, R, LeaseE, LeaseR, VerifyE = never, VerifyR = never>(
  backend: ContextWriterBackend<LeaseE, LeaseR>,
  reference: ContextReference,
  use: (permit: ContextWriterPermit) => Effect.Effect<A, E, R>,
  options: WriterOptions<A, VerifyE, VerifyR> = {},
): Effect.Effect<
  A,
  E | LeaseE | VerifyE | ContextError,
  Exclude<R | LeaseR | VerifyR, Scope.Scope>
> =>
  Effect.scoped(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const ref = yield* decodeReference(reference, "writer");

        const timeout = options.settlementTimeoutMillis ?? 5000;

        if (
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > 60000 ||
          isContextWriterBusy(ref)
        ) {
          return yield* ContextError.make({
            operation: "writer",
            reason: isContextWriterBusy(ref) ? "active" : "configuration",
            outcome: "undispatched",
          });
        }
        const permit = yield* makeContextWriterPermit(ref);
        const acquired = yield* restore(backend.acquire(ref)).pipe(Effect.exit);

        if (Exit.isFailure(acquired)) {
          // `use` never received the permit, so no allocation was attempted under it and this
          // process admitted no remote writer. What the failed acquisition left uncertain
          // remotely is the backend's to resolve.
          closeContextWriterPermit(permit, true);

          return yield* Effect.failCause(acquired.cause);
        }
        const lease = acquired.value;

        const body = yield* restore(Effect.scoped(Effect.suspend(() => use(permit)))).pipe(
          Effect.exit,
        );

        // Every remote-resource finalizer in use() has run before any settlement/readback below.
        if (Exit.isFailure(body)) yield* permit.quarantine;
        let verification: Exit.Exit<void, VerifyE | ContextError> = Exit.void;

        if (Exit.isSuccess(body) && options.verify !== undefined) {
          verification = yield* restore(Effect.scoped(options.verify(body.value))).pipe(
            Effect.exit,
          );
          if (Exit.isSuccess(verification)) {
            verification = yield* permit
              .confirmReadback(yield* Clock.currentTimeMillis)
              .pipe(Effect.exit);
          } else yield* permit.quarantine;
        }
        const facts = yield* permit.snapshot;

        const settlement = yield* restore(lease.settle(facts)).pipe(
          Effect.timeoutOrElse({
            duration: timeout,
            orElse: () =>
              Effect.fail(
                ContextError.make({
                  operation: "writer-settle",
                  reason: "timeout",
                  outcome: "unknown",
                }),
              ),
          }),
          Effect.exit,
        );

        if (Exit.isFailure(settlement)) yield* permit.quarantine;
        closeContextWriterPermit(
          permit,
          Exit.isSuccess(settlement) && facts.disposition === "release",
        );
        // Preserve the primary cause; secondary failure is visible in the retained quarantine and
        // a content-free diagnostic. Never serialize arbitrary consumer/database error values.
        if (Exit.isFailure(body)) {
          if (Exit.isFailure(settlement))
            yield* Effect.logError("Browserbase writer settlement remained unconfirmed");

          return yield* Effect.failCause(body.cause);
        }
        if (Exit.isFailure(verification)) return yield* Effect.failCause(verification.cause);
        if (Exit.isFailure(settlement)) return yield* Effect.failCause(settlement.cause);

        return body.value;
      }),
    ),
  );

/**
 * Lifts this process's quarantine on a Context once no writer it admitted can still write:
 * the provider reports every session the quarantined writer recorded as terminal, and then
 * the consumer's readback of the Context passes. The Context stays held throughout, so no
 * writer is admitted against evidence still being gathered; a live writer is refused rather
 * than waited for. An allocation whose outcome stayed unknown names no session to check, so
 * its Context stays refused. Ending a session is the caller's explicit request; this only
 * reads status. With no quarantine held here, only the readback runs. The backend keeps its
 * own quarantine until the consumer reports this reconciliation to it.
 */
export const reconcile = <E, R>(
  reference: ContextReference,
  readback: Effect.Effect<void, E, R>,
): Effect.Effect<
  void,
  E | ContextError | SessionError,
  BrowserbaseSessions | Exclude<R, Scope.Scope>
> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const ref = yield* decodeReference(reference, "writer-reconcile");
      const sessions = yield* BrowserbaseSessions;
      const claim = yield* claimReconciliation(ref);

      const checked = yield* restore(
        Effect.gen(function* () {
          for (const entry of yield* claim.attempts) {
            // A rejected creation made no session. Any other attempt must name a session the
            // provider has ended, and the readback must come after every one of them.
            if (entry.state === "rejected") continue;

            const ended =
              entry.session !== undefined &&
              isTerminalSessionStatus((yield* sessions.retrieve(entry.session)).status);

            if (!ended) {
              return yield* ContextError.make({
                operation: "writer-reconcile",
                reason: "active",
                outcome: "undispatched",
              });
            }
          }
          yield* Effect.scoped(readback);
        }),
      ).pipe(Effect.exit);

      claim.finish(Exit.isSuccess(checked));

      return yield* checked;
    }),
  );
