import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { ClientError, ContextError } from "./Errors.ts";
import { AllocationAttempt, ContextReference, Identifier, SessionReference } from "./References.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const ContextName = Schema.NonEmptyString.check(Schema.isMaxLength(1024));

const ProviderContext = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
const ProviderCreatedContext = Schema.Struct({ id: Identifier });

export class ContextMetadata extends Schema.Class<ContextMetadata>("BrowserbaseContextMetadata")({
  reference: ContextReference,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
}) {}

export class ContextCreation extends Schema.Class<ContextCreation>("BrowserbaseContextCreation")({
  reference: ContextReference,
}) {}

export const PersistenceEvidence = Schema.Union([
  Schema.Struct({ _tag: Schema.Literal("NotRequested") }),
  Schema.Struct({
    _tag: Schema.Literal("Unconfirmed"),
    reason: Schema.Literals(["writer-active", "writer-unknown", "flush-unacknowledged"]),
  }),
  Schema.Struct({
    _tag: Schema.Literal("Observed"),
    method: Schema.Literal("consumer-readback"),
    observedAtMillis: Schema.Finite,
  }),
]);
export type PersistenceEvidence = typeof PersistenceEvidence.Type;

export class WriterSettlementFacts extends Schema.Class<WriterSettlementFacts>(
  "BrowserbaseWriterSettlementFacts",
)({
  reference: ContextReference,
  attempts: Schema.Array(AllocationAttempt).check(Schema.isMaxLength(64)),
  sessions: Schema.Array(SessionReference).check(Schema.isMaxLength(64)),
  persistence: PersistenceEvidence,
  disposition: Schema.Literals(["release", "quarantine"]),
}) {}

export interface WriterLease<E, R> {
  readonly settle: (facts: WriterSettlementFacts) => Effect.Effect<void, E, R>;
}

export interface ContextWriterBackend<E, R> {
  readonly acquire: (reference: ContextReference) => Effect.Effect<WriterLease<E, R>, E, R>;
}

/** Live, process-local authority returned only after the consumer writer backend admits a writer.
 * The canonical browser acquisition authenticates the object by identity before using it.
 */
export interface ContextWriterPermit {
  readonly _tag: "ContextWriterPermit";
  readonly reference: ContextReference;
}

const fromClient = (operation: string, error: ClientError): ContextError =>
  ContextError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });
const configuration = (operation: string) =>
  ContextError.make({ operation, reason: "configuration", outcome: "undispatched" });
const malformed = (operation: string) => ContextError.make({ operation, reason: "malformed" });

export class BrowserbaseContexts extends Context.Service<
  BrowserbaseContexts,
  {
    readonly create: (options?: { readonly name?: string }) => Effect.Effect<ContextCreation, ContextError>;
    readonly retrieve: (reference: ContextReference) => Effect.Effect<ContextMetadata, ContextError>;
    readonly delete: (reference: ContextReference) => Effect.Effect<void, ContextError>;
  }
>()("@effect-agent/browserbase/Contexts") {
  static readonly layer: Layer.Layer<BrowserbaseContexts, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseContexts,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const validateReference = Effect.fnUntraced(function* (
        reference: ContextReference,
        operation: string,
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(ContextReference)(reference, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration(operation)));
        if (decoded.projectId !== client.projectId) {
          return yield* ContextError.make({
            operation,
            reason: "authorization",
            outcome: "undispatched",
          });
        }
        return decoded;
      });

      const create = Effect.fn("BrowserbaseContexts.create")(function* (
        options: { readonly name?: string } = {},
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(
          Schema.Struct({ name: Schema.optionalKey(ContextName) }),
        )(options, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() => configuration("context-create")),
        );
        const raw = yield* client
          .json("POST", "/v1/contexts", {
            projectId: client.projectId,
            ...(decoded.name === undefined ? {} : { name: decoded.name }),
          })
          .pipe(Effect.mapError((error) => fromClient("context-create", error)));
        const value = yield* Schema.decodeUnknownEffect(ProviderCreatedContext)(raw).pipe(
          Effect.mapError(() => malformed("context-create")),
        );
        return ContextCreation.make({
          reference: ContextReference.make({
            provider: "browserbase",
            projectId: client.projectId,
            contextId: value.id,
          }),
        });
      });

      const retrieve = Effect.fn("BrowserbaseContexts.retrieve")(function* (
        reference: ContextReference,
      ) {
        const ref = yield* validateReference(reference, "context-retrieve");
        const raw = yield* client
          .json("GET", `/v1/contexts/${encodeURIComponent(ref.contextId)}`)
          .pipe(Effect.mapError((error) => fromClient("context-retrieve", error)));
        const value = yield* Schema.decodeUnknownEffect(ProviderContext)(raw).pipe(
          Effect.mapError(() => malformed("context-retrieve")),
        );
        if (value.id !== ref.contextId || value.projectId !== ref.projectId) {
          return yield* malformed("context-retrieve");
        }
        return ContextMetadata.make({
          reference: ref,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          ...(value.name === undefined ? {} : { name: value.name }),
        });
      });

      const remove = Effect.fn("BrowserbaseContexts.delete")(function* (
        reference: ContextReference,
      ) {
        const ref = yield* validateReference(reference, "context-delete");
        yield* client
          .noContent("DELETE", `/v1/contexts/${encodeURIComponent(ref.contextId)}`)
          .pipe(Effect.mapError((error) => fromClient("context-delete", error)));
      });

      return BrowserbaseContexts.of({ create, retrieve, delete: remove });
    }),
  );
}
