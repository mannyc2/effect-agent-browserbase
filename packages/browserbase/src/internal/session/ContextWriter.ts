import { Effect } from "effect";

import {
  type ContextWriterPermit,
  type PersistenceEvidence,
  WriterSettlementFacts,
} from "../../Contexts.ts";
import { ContextError } from "../../Errors.ts";
import type { AllocationAttempt, ContextReference, SessionReference } from "../../References.ts";

/** Package-private mutation authority carried by the public opaque permit. */
export interface ContextWriterPermitInternal extends ContextWriterPermit {
  readonly recordAttempt: (attempt: AllocationAttempt) => Effect.Effect<void, ContextError>;
  readonly recordSession: (reference: SessionReference) => Effect.Effect<void, ContextError>;
  readonly setPersistence: (evidence: PersistenceEvidence) => Effect.Effect<void, ContextError>;
  readonly quarantine: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<WriterSettlementFacts>;
}

const authentic = new WeakSet<object>();

export const makeContextWriterPermit = (
  reference: ContextReference,
): ContextWriterPermitInternal => {
  const attempts: AllocationAttempt[] = [];
  const sessions: SessionReference[] = [];
  let persistence: PersistenceEvidence = { _tag: "Unconfirmed", reason: "writer-active" };
  let quarantined = false;

  const permit: ContextWriterPermitInternal = {
    _tag: "ContextWriterPermit",
    reference,
    recordAttempt: (attempt) =>
      Effect.suspend(() => {
        if (quarantined || attempt.projectId !== reference.projectId) {
          return Effect.fail(
            ContextError.make({
              operation: "context-writer",
              reason: "active",
              outcome: "undispatched",
            }),
          );
        }
        if (attempts.some((item) => item.attemptId === attempt.attemptId)) return Effect.void;
        if (attempts.length >= 64) {
          return Effect.fail(
            ContextError.make({
              operation: "context-writer",
              reason: "limit",
              outcome: "undispatched",
            }),
          );
        }
        attempts.push(attempt);
        return Effect.void;
      }),
    recordSession: (session) =>
      Effect.suspend(() => {
        if (quarantined || session.projectId !== reference.projectId) {
          return Effect.fail(
            ContextError.make({
              operation: "context-writer",
              reason: "active",
              outcome: "undispatched",
            }),
          );
        }
        if (sessions.some((item) => item.sessionId === session.sessionId)) return Effect.void;
        if (sessions.length >= 64) {
          return Effect.fail(
            ContextError.make({
              operation: "context-writer",
              reason: "limit",
              outcome: "undispatched",
            }),
          );
        }
        sessions.push(session);
        return Effect.void;
      }),
    setPersistence: (evidence) =>
      Effect.sync(() => {
        persistence = evidence;
      }),
    quarantine: Effect.sync(() => {
      quarantined = true;
      persistence = { _tag: "Unconfirmed", reason: "writer-unknown" };
    }),
    snapshot: Effect.sync(() =>
      WriterSettlementFacts.make({
        reference,
        attempts: [...attempts],
        sessions: [...sessions],
        persistence,
        disposition: quarantined ? "quarantine" : "release",
      }),
    ),
  };

  authentic.add(permit);
  return permit;
};

export const requireContextWriterPermit = (
  permit: ContextWriterPermit,
): Effect.Effect<ContextWriterPermitInternal, ContextError> =>
  authentic.has(permit as object)
    ? Effect.succeed(permit as ContextWriterPermitInternal)
    : Effect.fail(
        ContextError.make({
          operation: "context-writer",
          reason: "authorization",
          outcome: "undispatched",
        }),
      );
