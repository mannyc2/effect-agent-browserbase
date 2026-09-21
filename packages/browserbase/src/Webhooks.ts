import { Context, Effect, Layer, Redacted, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { PlatformError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";
import { Identifier } from "./References.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));

/** Provider event names. Browserbase currently emits Functions events only. */
export const WebhookEventType = Schema.Literals([
  "functions.builds.running",
  "functions.builds.completed",
  "functions.builds.failed",
  "functions.invocations.pending",
  "functions.invocations.running",
  "functions.invocations.completed",
  "functions.invocations.failed",
]);

export type WebhookEventType = typeof WebhookEventType.Type;

const Endpoint = Schema.NonEmptyString.check(
  Schema.isMaxLength(2048),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  }),
);

const EventTypes = Schema.Array(WebhookEventType).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(7),
  Schema.isUnique(),
);

export const WebhookSettings = Schema.Struct({ endpoint: Endpoint, eventTypes: EventTypes });
export type WebhookSettings = typeof WebhookSettings.Type;

export const WebhookUpdate = Schema.Struct({
  endpoint: Schema.optionalKey(Endpoint),
  eventTypes: Schema.optionalKey(EventTypes),
});

export type WebhookUpdate = typeof WebhookUpdate.Type;

export class WebhookMetadata extends Schema.Class<WebhookMetadata>("BrowserbaseWebhookMetadata")({
  webhookId: Identifier,
  projectId: Identifier,
  endpoint: Schema.String.check(Schema.isMaxLength(2048)),
  eventTypes: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(
    Schema.isMaxLength(64),
  ),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

/** A signing secret is returned once, redacted so it cannot be logged by accident. */
export interface WebhookRegistration {
  readonly webhook: WebhookMetadata;
  readonly secret: Redacted.Redacted<string>;
}

export interface WebhookPage {
  readonly webhooks: ReadonlyArray<WebhookMetadata>;
  readonly nextCursor: string | undefined;
}

const ProviderWebhook = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  endpoint: WebhookMetadata.fields.endpoint,
  eventTypes: WebhookMetadata.fields.eventTypes,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

const Secret = Schema.NonEmptyString.check(Schema.isMaxLength(1024));

const Page = Schema.Struct({
  data: Schema.Array(ProviderWebhook).check(Schema.isMaxLength(100)),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String.check(Schema.isMaxLength(4096)))),
});

export const WebhookListQuery = Schema.Struct({
  cursor: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(4096))),
  limit: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
});

export type WebhookListQuery = typeof WebhookListQuery.Type;

/** Webhook administration for the Client's project. Mutations are never retried. */
export class BrowserbaseWebhooks extends Context.Service<
  BrowserbaseWebhooks,
  {
    readonly create: (
      settings: WebhookSettings,
    ) => Effect.Effect<WebhookRegistration, PlatformError>;
    readonly list: (query?: WebhookListQuery) => Effect.Effect<WebhookPage, PlatformError>;
    readonly retrieve: (webhookId: string) => Effect.Effect<WebhookMetadata, PlatformError>;
    readonly update: (
      webhookId: string,
      update: WebhookUpdate,
    ) => Effect.Effect<WebhookMetadata, PlatformError>;
    readonly delete: (webhookId: string) => Effect.Effect<void, PlatformError>;
    /** Issues a new secret; the old one keeps working unless `revokeImmediately`. */
    readonly rotateSecret: (
      webhookId: string,
      options?: { readonly revokeImmediately?: boolean },
    ) => Effect.Effect<Redacted.Redacted<string>, PlatformError>;
  }
>()("@effect-agent/browserbase/Webhooks") {
  static readonly layer: Layer.Layer<BrowserbaseWebhooks, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseWebhooks,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const api = resource(client, (failure) =>
        PlatformError.make({ ...failure, service: "webhooks" }),
      );

      const decode = (operation: string, mutation: boolean, expected?: string) =>
        Effect.fnUntraced(function* (value: typeof ProviderWebhook.Type) {
          if (
            value.projectId !== client.projectId ||
            (expected !== undefined && value.id !== expected)
          )
            return yield* api.malformed(operation, mutation);

          const { id, ...rest } = value;

          return WebhookMetadata.make({ webhookId: id, ...rest });
        });

      const path = (id: string) => `/v1/webhooks/${api.segment(id)}`;

      const create = Effect.fn("BrowserbaseWebhooks.create")(function* (settings: WebhookSettings) {
        const value = yield* api.input(WebhookSettings, settings, "webhook-create");

        const created = yield* api.request(
          "POST",
          "/v1/webhooks",
          Schema.Struct({ ...ProviderWebhook.fields, secret: Secret }),
          "webhook-create",
          value,
        );

        const { secret, ...webhook } = created;

        return {
          webhook: yield* decode("webhook-create", true)(webhook),
          secret: Redacted.make(secret),
        };
      });

      const list = Effect.fn("BrowserbaseWebhooks.list")(function* (query: WebhookListQuery = {}) {
        const value = yield* api.input(WebhookListQuery, query, "webhook-list");

        const page = yield* api.request(
          "GET",
          `/v1/webhooks${api.query(value)}`,
          Page,
          "webhook-list",
        );

        return {
          webhooks: yield* Effect.forEach(page.data, decode("webhook-list", false)),
          nextCursor: page.nextCursor ?? undefined,
        };
      });

      const retrieve = Effect.fn("BrowserbaseWebhooks.retrieve")(function* (webhookId: string) {
        const id = yield* api.input(Identifier, webhookId, "webhook-retrieve");
        const value = yield* api.request("GET", path(id), ProviderWebhook, "webhook-retrieve");

        return yield* decode("webhook-retrieve", false, id)(value);
      });

      const update = Effect.fn("BrowserbaseWebhooks.update")(function* (
        webhookId: string,
        changes: WebhookUpdate,
      ) {
        const id = yield* api.input(Identifier, webhookId, "webhook-update");
        const value = yield* api.input(WebhookUpdate, changes, "webhook-update");

        if (value.endpoint === undefined && value.eventTypes === undefined)
          return yield* api.configuration("webhook-update");

        const updated = yield* api.request(
          "PATCH",
          path(id),
          ProviderWebhook,
          "webhook-update",
          value,
        );

        return yield* decode("webhook-update", true, id)(updated);
      });

      const remove = Effect.fn("BrowserbaseWebhooks.delete")(function* (webhookId: string) {
        const id = yield* api.input(Identifier, webhookId, "webhook-delete");

        yield* api.remove(path(id), "webhook-delete");
      });

      const rotateSecret = Effect.fn("BrowserbaseWebhooks.rotateSecret")(function* (
        webhookId: string,
        options: { readonly revokeImmediately?: boolean } = {},
      ) {
        const id = yield* api.input(Identifier, webhookId, "webhook-rotate-secret");

        const value = yield* api.input(
          Schema.Struct({ revokeImmediately: Schema.optionalKey(Schema.Boolean) }),
          options,
          "webhook-rotate-secret",
        );

        const rotated = yield* api.request(
          "POST",
          `${path(id)}/secret`,
          Schema.Struct({ secret: Secret }),
          "webhook-rotate-secret",
          value,
        );

        return Redacted.make(rotated.secret);
      });

      return BrowserbaseWebhooks.of({
        create,
        list,
        retrieve,
        update,
        delete: remove,
        rotateSecret,
      });
    }),
  );
}
