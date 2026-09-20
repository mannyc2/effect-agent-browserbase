import { Context, Effect, Layer, Schema } from "effect";
import { BrowserbaseClient } from "./Client.ts";
import { ClientError, ContextError } from "./Errors.ts";
import { ContextReference, Identifier } from "./References.ts";
import { isContextWriterBusy } from "./internal/session/ContextWriter.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const ContextName = Schema.NonEmptyString.check(Schema.isMaxLength(1024), Schema.makeFilter((value) => value.trim().length > 0));
const ProviderContext = Schema.Struct({
  id: Identifier, projectId: Identifier, createdAt: Timestamp, updatedAt: Timestamp,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
});
export class ContextMetadata extends Schema.Class<ContextMetadata>("BrowserbaseContextMetadata")({
  reference: ContextReference, createdAt: Timestamp, updatedAt: Timestamp,
  name: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
}) {}
export class ContextCreation extends Schema.Class<ContextCreation>("BrowserbaseContextCreation")({ reference: ContextReference }) {}

const fromClient = (operation: string, error: ClientError): ContextError => ContextError.make({
  operation, reason: error.reason,
  ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
});
const configuration = (operation: string) => ContextError.make({ operation, reason: "configuration", outcome: "undispatched" });
const malformed = (operation: string, mutation = false) => ContextError.make({ operation, reason: "malformed", ...(mutation ? { outcome: "unknown" as const } : {}) });

/** Context administration is independent of any live browser connection. */
export class BrowserbaseContexts extends Context.Service<BrowserbaseContexts, {
  readonly create: (options?: { readonly name?: string }) => Effect.Effect<ContextCreation, ContextError>;
  readonly retrieve: (reference: ContextReference) => Effect.Effect<ContextMetadata, ContextError>;
  readonly delete: (reference: ContextReference) => Effect.Effect<void, ContextError>;
}>()("@effect-agent/browserbase/Contexts") {
  static readonly layer: Layer.Layer<BrowserbaseContexts, never, BrowserbaseClient> = Layer.effect(BrowserbaseContexts, Effect.gen(function* () {
    const client = yield* BrowserbaseClient;
    const validate = Effect.fnUntraced(function* (reference: ContextReference, operation: string) {
      const ref = yield* Schema.decodeUnknownEffect(ContextReference)(reference, { onExcessProperty: "error" }).pipe(Effect.mapError(() => configuration(operation)));
      if (ref.projectId !== client.projectId) return yield* ContextError.make({ operation, reason: "authorization", outcome: "undispatched" });
      return ref;
    });
    const create = Effect.fn("BrowserbaseContexts.create")(function* (options: { readonly name?: string } = {}) {
      const value = yield* Schema.decodeUnknownEffect(Schema.Struct({ name: Schema.optionalKey(ContextName) }))(options, { onExcessProperty: "error" }).pipe(Effect.mapError(() => configuration("context-create")));
      const raw = yield* client.json("POST", "/v1/contexts", {
        projectId: client.projectId, ...(value.name === undefined ? {} : { name: value.name.trim() }),
      }).pipe(Effect.mapError((error) => fromClient("context-create", error)));
      const created = yield* Schema.decodeUnknownEffect(Schema.Struct({ id: Identifier }))(raw).pipe(Effect.mapError(() => malformed("context-create", true)));
      return ContextCreation.make({ reference: ContextReference.make({ provider: "browserbase", projectId: client.projectId, contextId: created.id }) });
    });
    const retrieve = Effect.fn("BrowserbaseContexts.retrieve")(function* (reference: ContextReference) {
      const ref = yield* validate(reference, "context-retrieve");
      const raw = yield* client.json("GET", `/v1/contexts/${encodeURIComponent(ref.contextId)}`).pipe(Effect.mapError((error) => fromClient("context-retrieve", error)));
      const value = yield* Schema.decodeUnknownEffect(ProviderContext)(raw).pipe(Effect.mapError(() => malformed("context-retrieve")));
      if (value.id !== ref.contextId || value.projectId !== ref.projectId) return yield* malformed("context-retrieve");
      return ContextMetadata.make({ reference: ref, createdAt: value.createdAt, updatedAt: value.updatedAt, ...(value.name === undefined ? {} : { name: value.name }) });
    });
    const remove = Effect.fn("BrowserbaseContexts.delete")(function* (reference: ContextReference) {
      const ref = yield* validate(reference, "context-delete");
      if (isContextWriterBusy(ref)) return yield* ContextError.make({ operation: "context-delete", reason: "active", outcome: "undispatched" });
      yield* client.noContent("DELETE", `/v1/contexts/${encodeURIComponent(ref.contextId)}`).pipe(Effect.mapError((error) => fromClient("context-delete", error)));
    });
    return BrowserbaseContexts.of({ create, retrieve, delete: remove });
  }));
}
