import type { Effect } from "effect";
import { Schema } from "effect";

import { CleanupResult } from "../../Cleanup.ts";
import { AllocationAttempt, ContextReference, SessionReference } from "../../References.ts";

/**
 * The writer vocabulary both the public coordination entry point and the permit
 * implementation need. Keeping it here leaves one direction of dependency:
 * `ContextCoordination` and `ContextWriter` both read this module, never each other.
 */
export const PersistenceEvidence = Schema.Union([
  Schema.TaggedStruct("NotRequested", {}),
  Schema.TaggedStruct("Unconfirmed", {
    reason: Schema.Literals(["writer-active", "writer-unknown", "flush-unacknowledged"]),
  }),
  Schema.TaggedStruct("Observed", {
    method: Schema.Literal("consumer-readback"),
    observedAtMillis: Schema.Finite,
  }),
]);

export type PersistenceEvidence = typeof PersistenceEvidence.Type;

export class WriterAttemptFacts extends Schema.Class<WriterAttemptFacts>(
  "BrowserbaseWriterAttemptFacts",
)({
  attempt: AllocationAttempt,
  session: Schema.optionalKey(SessionReference),
  state: Schema.Literals(["admitted", "rejected", "unknown", "terminal"]),
  cleanup: Schema.optionalKey(CleanupResult),
}) {}

export class WriterSettlementFacts extends Schema.Class<WriterSettlementFacts>(
  "BrowserbaseWriterSettlementFacts",
)({
  reference: ContextReference,
  attempts: Schema.Array(WriterAttemptFacts).check(Schema.isMaxLength(64)),
  persistence: PersistenceEvidence,
  disposition: Schema.Literals(["release", "quarantine"]),
}) {}

export interface WriterLease<E, R> {
  readonly settle: (facts: WriterSettlementFacts) => Effect.Effect<void, E, R>;
}

export interface ContextWriterBackend<E, R> {
  readonly acquire: (reference: ContextReference) => Effect.Effect<WriterLease<E, R>, E, R>;
}

export interface ContextWriterPermit {
  readonly _tag: "ContextWriterPermit";
  readonly reference: ContextReference;
}

export interface WriterOptions<A, VerifyE, VerifyR> {
  /** Bounded consumer-controlled readback, not a provider-wide flush acknowledgement. */
  readonly verify?: (value: A) => Effect.Effect<void, VerifyE, VerifyR>;
  readonly settlementTimeoutMillis?: number;
}
