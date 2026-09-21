import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { PlatformError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";

const Text = Schema.String.check(Schema.isMaxLength(16_384));

export const SearchQuery = Schema.Struct({
  query: Schema.NonEmptyString.check(Schema.isMaxLength(2048)),
  /** 1–25; the provider defaults to 10. */
  numResults: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 25 }))),
});

export type SearchQuery = typeof SearchQuery.Type;

export class SearchResult extends Schema.Class<SearchResult>("BrowserbaseSearchResult")({
  id: Text,
  url: Text,
  title: Text,
  author: Schema.optionalKey(Text),
  publishedDate: Schema.optionalKey(Text),
  image: Schema.optionalKey(Text),
  favicon: Schema.optionalKey(Text),
}) {}

export class SearchResults extends Schema.Class<SearchResults>("BrowserbaseSearchResults")({
  requestId: Text,
  query: Text,
  results: Schema.Array(SearchResult).check(Schema.isMaxLength(25)),
}) {}

/** Browserbase web search. Each call is billed and is never retried. */
export class BrowserbaseSearch extends Context.Service<
  BrowserbaseSearch,
  {
    readonly web: (query: SearchQuery) => Effect.Effect<SearchResults, PlatformError>;
  }
>()("effect-browserbase/Search") {
  static readonly layer: Layer.Layer<BrowserbaseSearch, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseSearch,
    Effect.gen(function* () {
      const api = resource(yield* BrowserbaseClient, (failure) =>
        PlatformError.make({ ...failure, service: "search" }),
      );

      const web = Effect.fn("BrowserbaseSearch.web")(function* (query: SearchQuery) {
        const value = yield* api.input(SearchQuery, query, "search-web");

        return yield* api.request("POST", "/v1/search", SearchResults, "search-web", value);
      });

      return BrowserbaseSearch.of({ web });
    }),
  );
}
