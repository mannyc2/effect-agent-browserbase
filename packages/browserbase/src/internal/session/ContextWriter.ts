import { Effect } from "effect";
import { type ContextWriterPermit, type PersistenceEvidence, WriterAttemptFacts, WriterSettlementFacts } from "../../ContextCoordination.ts";
import { ContextError } from "../../Errors.ts";
import type { AllocationAttempt, ContextReference, SessionReference } from "../../References.ts";
import type { CleanupResult } from "../../Cleanup.ts";

/** There is one record per exact allocation attempt, not parallel uncorrelated arrays. */
interface AttemptRecord {
  readonly attempt: AllocationAttempt;
  session?: SessionReference;
  state: "admitted" | "rejected" | "unknown" | "terminal";
  cleanup?: CleanupResult;
}
export interface ContextWriterPermitInternal extends ContextWriterPermit {
  readonly recordAttempt: (attempt: AllocationAttempt) => Effect.Effect<void, ContextError>;
  readonly recordSession: (attempt: AllocationAttempt, reference: SessionReference) => void;
  readonly rejected: (attempt: AllocationAttempt) => void;
  readonly completed: (attempt: AllocationAttempt, cleanup: CleanupResult) => void;
  readonly confirmReadback: (atMillis: number) => Effect.Effect<void, ContextError>;
  readonly quarantine: Effect.Effect<void>;
  readonly snapshot: Effect.Effect<WriterSettlementFacts>;
}
const authentic = new WeakMap<ContextWriterPermit, ContextWriterPermitInternal>();
const active = new Map<string, ContextWriterPermitInternal | "quarantined">();
const key = (ref: ContextReference) => `${ref.projectId}/${ref.contextId}`;
export const isContextWriterBusy = (ref: ContextReference): boolean => active.has(key(ref));

export const makeContextWriterPermit = (reference: ContextReference): Effect.Effect<ContextWriterPermitInternal, ContextError> => Effect.suspend(() => {
  if (active.has(key(reference)) || active.size >= 2048) return Effect.fail(ContextError.make({ operation: "writer", reason: "active", outcome: "undispatched" }));
  const owned = Object.freeze(reference);
  const attempts = new Map<string, AttemptRecord>();
  let closed = false, quarantined = false;
  let persistence: PersistenceEvidence = { _tag: "NotRequested" };
  const unknown = () => { quarantined = true; persistence = { _tag: "Unconfirmed", reason: "writer-unknown" }; };
  const noActive = () => [...attempts.values()].every((entry) => entry.state === "rejected" || entry.state === "terminal");
  const permit: ContextWriterPermitInternal = {
    _tag: "ContextWriterPermit", reference: owned,
    recordAttempt: (attempt) => Effect.suspend(() => {
      if (closed || quarantined || !noActive() || attempt.projectId !== owned.projectId ||
        (attempts.size > 0 && persistence._tag === "Unconfirmed")) {
        return Effect.fail(ContextError.make({ operation: "writer-admit", reason: "active", outcome: "undispatched" }));
      }
      if (attempts.has(attempt.attemptId) || attempts.size >= 64) return Effect.fail(ContextError.make({ operation: "writer-admit", reason: "limit", outcome: "undispatched" }));
      const copy = Object.freeze(attempt);
      attempts.set(copy.attemptId, { attempt: copy, state: "admitted" });
      persistence = { _tag: "Unconfirmed", reason: "writer-active" };
      return Effect.void;
    }),
    recordSession: (attempt, session) => {
      const record = attempts.get(attempt.attemptId);
      if (record === undefined || record.attempt !== attempt || session.projectId !== owned.projectId ||
        (record.session !== undefined && record.session.sessionId !== session.sessionId)) { unknown(); return; }
      // Retain identity even when cancellation/quarantine races a late allocation reply.
      record.session = Object.freeze(session);
    },
    rejected: (attempt) => {
      const record = attempts.get(attempt.attemptId);
      if (record === undefined || record.session !== undefined) { unknown(); return; }
      record.state = "rejected";
      if ([...attempts.values()].every((item) => item.state === "rejected")) persistence = { _tag: "NotRequested" };
    },
    completed: (attempt, cleanup) => {
      const record = attempts.get(attempt.attemptId);
      if (record === undefined || record.attempt !== attempt || record.session === undefined ||
        record.session.sessionId !== cleanup.reference.sessionId || cleanup.reference.projectId !== owned.projectId) { unknown(); return; }
      record.cleanup = cleanup;
      if (cleanup.remote !== "confirmed") { record.state = "unknown"; unknown(); return; }
      record.state = "terminal";
      if (cleanup.observedStatus !== "COMPLETED") { unknown(); return; }
      if (!quarantined) persistence = { _tag: "Unconfirmed", reason: "flush-unacknowledged" };
    },
    confirmReadback: (atMillis) => Effect.suspend(() => {
      if (closed || quarantined || !noActive() || !Number.isFinite(atMillis) || attempts.size === 0 ||
        [...attempts.values()].some((entry) => entry.state === "terminal" && entry.cleanup?.observedStatus !== "COMPLETED")) {
        return Effect.fail(ContextError.make({ operation: "writer-readback", reason: "active", outcome: "undispatched" }));
      }
      persistence = { _tag: "Observed", method: "consumer-readback", observedAtMillis: atMillis };
      return Effect.void;
    }),
    quarantine: Effect.sync(unknown),
    snapshot: Effect.sync(() => WriterSettlementFacts.make({
      reference: owned,
      attempts: [...attempts.values()].map((entry) => WriterAttemptFacts.make({
        attempt: entry.attempt, state: entry.state,
        ...(entry.session === undefined ? {} : { session: entry.session }),
        ...(entry.cleanup === undefined ? {} : { cleanup: entry.cleanup }),
      })),
      persistence,
      disposition: quarantined || !noActive() || persistence._tag === "Unconfirmed" ? "quarantine" : "release",
    })),
  };
  Object.freeze(permit);
  authentic.set(permit, permit);
  active.set(key(owned), permit);
  // Explicit retirement closes admission without losing evidence attached to escaped permits.
  retirement.set(permit, (released) => {
    closed = true;
    if (active.get(key(owned)) !== permit) return;
    if (released) active.delete(key(owned)); else active.set(key(owned), "quarantined");
  });
  return Effect.succeed(permit);
});
const retirement = new WeakMap<ContextWriterPermitInternal, (released: boolean) => void>();
export const closeContextWriterPermit = (permit: ContextWriterPermitInternal, released: boolean): void => retirement.get(permit)?.(released);
export const requireContextWriterPermit = (permit: ContextWriterPermit, reference: ContextReference): Effect.Effect<ContextWriterPermitInternal, ContextError> => Effect.suspend(() => {
  const actual = authentic.get(permit);
  return actual !== undefined && active.get(key(reference)) === actual && actual.reference.contextId === reference.contextId && actual.reference.projectId === reference.projectId
    ? Effect.succeed(actual)
    : Effect.fail(ContextError.make({ operation: "writer-authority", reason: "authorization", outcome: "undispatched" }));
});
