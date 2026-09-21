import type { Scope } from "effect";
import { Clock, Effect, Exit, Schema } from "effect";

import { ContextError } from "./Errors.ts";
import {
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

export {
  PersistenceEvidence,
  WriterAttemptFacts,
  WriterSettlementFacts,
  type ContextWriterBackend,
  type ContextWriterPermit,
  type WriterLease,
  type WriterOptions,
} from "./internal/session/WriterFacts.ts";

/**
 * Owns the backend lease, child browser scopes, and exact attempt evidence. The backend must
 * handle uncertain distributed lease acquisition itself. It must persist quarantine facts;
 * a local Scope closing is never permission to admit another remote writer.
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
        const ref = yield* Schema.decodeEffect(ContextReference)(reference, {
          onExcessProperty: "error",
        }).pipe(
          Effect.mapError(() =>
            ContextError.make({
              operation: "writer",
              reason: "configuration",
              outcome: "undispatched",
            }),
          ),
        );

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
          closeContextWriterPermit(permit, false);

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
