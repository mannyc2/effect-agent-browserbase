import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { PlatformError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";

const HttpUrl = Schema.NonEmptyString.check(
  Schema.isMaxLength(8192),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        (url.protocol === "https:" || url.protocol === "http:") && !url.username && !url.password
      );
    } catch {
      return false;
    }
  }),
);

export const PageFetchRequest = Schema.Struct({
  url: HttpUrl,
  allowRedirects: Schema.optionalKey(Schema.Boolean),
  allowInsecureSsl: Schema.optionalKey(Schema.Boolean),
  proxies: Schema.optionalKey(Schema.Boolean),
  /** `raw` by default; `json` extracts with `schema`, `markdown` converts the page. */
  format: Schema.optionalKey(Schema.Literals(["raw", "json", "markdown"])),
  /** A JSON Schema describing the object to extract when `format` is `json`. */
  schema: Schema.optionalKey(Schema.Record(Schema.String, Schema.Json)),
});

export type PageFetchRequest = typeof PageFetchRequest.Type;

export class PageFetchResult extends Schema.Class<PageFetchResult>("BrowserbasePageFetchResult")({
  id: Schema.String.check(Schema.isMaxLength(256)),
  statusCode: Schema.Int,
  headers: Schema.Record(Schema.String, Schema.String),
  content: Schema.Union([Schema.String, Schema.Json]),
  contentType: Schema.String.check(Schema.isMaxLength(1024)),
  encoding: Schema.String.check(Schema.isMaxLength(64)),
}) {}

/**
 * Browserbase's Fetch API: one page retrieved by the provider without a browser session.
 * Replies are bounded by the 1 MiB control-plane limit (`reason: "limit"`); each call is
 * billed and never retried. `statusCode` is the target site's status, not the API's.
 */
export class BrowserbasePageFetch extends Context.Service<
  BrowserbasePageFetch,
  {
    readonly fetch: (request: PageFetchRequest) => Effect.Effect<PageFetchResult, PlatformError>;
  }
>()("@effect-agent/browserbase/PageFetch") {
  static readonly layer: Layer.Layer<BrowserbasePageFetch, never, BrowserbaseClient> = Layer.effect(
    BrowserbasePageFetch,
    Effect.gen(function* () {
      const api = resource(yield* BrowserbaseClient, (failure) =>
        PlatformError.make({ ...failure, service: "fetch" }),
      );

      const fetch = Effect.fn("BrowserbasePageFetch.fetch")(function* (request: PageFetchRequest) {
        const value = yield* api.input(PageFetchRequest, request, "fetch");

        if (value.schema !== undefined && value.format !== "json")
          return yield* api.configuration("fetch");

        return yield* api.request("POST", "/v1/fetch", PageFetchResult, "fetch", value);
      });

      return BrowserbasePageFetch.of({ fetch });
    }),
  );
}
