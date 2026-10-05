/**
 * A small client for the Browserbase REST API: sessions, stored contexts, web search and page
 * fetch.
 *
 * It runs on the `HttpClient` the application provides, such as `FetchHttpClient.layer`. The API
 * key travels only in the `X-BB-API-Key` header and is redacted from logs and traces. Redirects
 * are refused rather than followed, because following one would send the key wherever it points.
 *
 * Every request has a deadline, so a provider that never answers cannot hold a caller's scope open.
 * Reads are retried twice on transient failures. Writes are not: a session create that fails in
 * transit or misses its deadline may still have created the session, which then ends at its timeout.
 *
 * @since 0.3.0
 */
import {
  Config,
  Context,
  Duration,
  Effect,
  flow,
  identity,
  Layer,
  Option,
  Redacted,
  Schedule,
  Schema,
} from "effect";
import {
  FetchHttpClient,
  Headers,
  HttpClient,
  HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import {
  BrowserbaseError,
  Decode,
  InvalidRequest,
  isTransient,
  NotFound,
  RateLimited,
  type Reason,
  Status,
  Transport,
  Unauthorized,
} from "./BrowserbaseError.ts";

export const defaultBaseUrl = "https://api.browserbase.com";

export class Session extends Schema.Class<Session>("effect-browserbase/Session")({
  id: Schema.String,
  /** `PENDING`, `RUNNING`, `ERROR`, `TIMED_OUT` or `COMPLETED`, kept open for new values. */
  status: Schema.String,
  region: Schema.String,
  keepAlive: Schema.Boolean,
  createdAt: Schema.String,
  expiresAt: Schema.String,
  endedAt: Schema.optional(Schema.String),
  contextId: Schema.optional(Schema.String),
  proxyBytes: Schema.optional(Schema.Finite),
  userMetadata: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  /** The CDP WebSocket address, a credential. Only create and get return it. */
  connectUrl: Schema.optional(Schema.RedactedFromValue(Schema.String)),
}) {}

/** Links that let a person watch and control a running session. They are credentials. */
export class LiveView extends Schema.Class<LiveView>("effect-browserbase/LiveView")({
  /** The active tab, without browser chrome: suited to an iframe. */
  debuggerFullscreenUrl: Schema.RedactedFromValue(Schema.String),
  debuggerUrl: Schema.RedactedFromValue(Schema.String),
  pages: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      url: Schema.String,
      title: Schema.String,
      debuggerFullscreenUrl: Schema.RedactedFromValue(Schema.String),
    }),
  ),
}) {}

/** Browser state (cookies, storage, cache) kept by Browserbase for sessions to load and save. */
export class StoredContext extends Schema.Class<StoredContext>("effect-browserbase/StoredContext")({
  id: Schema.String,
  name: Schema.optional(Schema.String),
}) {}

export class SearchResult extends Schema.Class<SearchResult>("effect-browserbase/SearchResult")({
  url: Schema.String,
  title: Schema.String,
  author: Schema.optional(Schema.String),
  publishedDate: Schema.optional(Schema.String),
}) {}

/** A page fetched without a browser. */
export class FetchedPage extends Schema.Class<FetchedPage>("effect-browserbase/FetchedPage")({
  statusCode: Schema.Finite,
  contentType: Schema.String,
  headers: Schema.Record(Schema.String, Schema.String),
  /** Text for the `raw` and `markdown` formats; the extracted object for `json`. */
  content: Schema.Union([Schema.String, Schema.Record(Schema.String, Schema.Unknown)]),
}) {}

/** A session create request, as Browserbase's API reference describes it. */
export interface SessionOptions {
  /** Defaults to the API key's project. */
  readonly projectId?: string | undefined;
  readonly extensionId?: string | undefined;
  /** Seconds until Browserbase ends the session, from 60 to 21,600. Defaults to the project's. */
  readonly timeout?: number | undefined;
  /** Keep the session running after every client disconnects, until released or timed out. */
  readonly keepAlive?: boolean | undefined;
  readonly region?: "us-west-2" | "us-east-1" | "eu-central-1" | "ap-southeast-1" | undefined;
  /** `true` for Browserbase's proxies, or rules per domain. */
  readonly proxies?: boolean | ReadonlyArray<ProxyRule> | undefined;
  /** Labels that `listSessions` can query. */
  readonly userMetadata?: Readonly<Record<string, unknown>> | undefined;
  readonly browserSettings?: BrowserSettings | undefined;
}

export interface BrowserSettings {
  /** Load a stored context, and save the session's changes back to it when `persist` is set. */
  readonly context?: { readonly id: string; readonly persist?: boolean | undefined } | undefined;
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  readonly blockAds?: boolean | undefined;
  /** Defaults to true. */
  readonly solveCaptchas?: boolean | undefined;
  /** Defaults to true. */
  readonly recordSession?: boolean | undefined;
  /** Defaults to true. */
  readonly logSession?: boolean | undefined;
  /** Verified browser mode, on plans that include it. */
  readonly verified?: boolean | undefined;
  readonly os?: "windows" | "mac" | "linux" | "mobile" | "tablet" | undefined;
  /** Restrict top-level navigation to these domains and their subdomains. */
  readonly allowedDomains?: ReadonlyArray<string> | undefined;
  readonly ignoreCertificateErrors?: boolean | undefined;
}

export type ProxyRule =
  | {
      readonly type: "browserbase";
      readonly geolocation?:
        | {
            readonly country: string;
            readonly state?: string | undefined;
            readonly city?: string | undefined;
          }
        | undefined;
      readonly domainPattern?: string | undefined;
    }
  | {
      readonly type: "external";
      readonly server: string;
      readonly username?: string | undefined;
      readonly password?: string | undefined;
      readonly domainPattern?: string | undefined;
    }
  | { readonly type: "none"; readonly domainPattern?: string | undefined };

export interface FetchOptions {
  /** `raw` (the default) returns the body as is; `json` needs `schema`. */
  readonly format?: "raw" | "markdown" | "json" | undefined;
  /** JSON Schema of the object to extract with the `json` format. */
  readonly schema?: Readonly<Record<string, unknown>> | undefined;
  readonly allowRedirects?: boolean | undefined;
  readonly allowInsecureSsl?: boolean | undefined;
  readonly proxies?: boolean | undefined;
}

export interface Service {
  readonly createSession: (options?: SessionOptions) => Effect.Effect<Session, BrowserbaseError>;
  readonly getSession: (id: string) => Effect.Effect<Session, BrowserbaseError>;
  /** Sessions with the given status, or all. `query` filters on user metadata, in Browserbase's syntax. */
  readonly listSessions: (options?: {
    readonly status?: string | undefined;
    readonly query?: string | undefined;
  }) => Effect.Effect<ReadonlyArray<Session>, BrowserbaseError>;
  /** End the session now, which stops its billing. Ending an ended session succeeds. */
  readonly releaseSession: (id: string) => Effect.Effect<void, BrowserbaseError>;
  /** Live view links. They last `expiresInSeconds`, or as long as the session. */
  readonly liveView: (
    id: string,
    options?: { readonly expiresInSeconds?: number | undefined },
  ) => Effect.Effect<LiveView, BrowserbaseError>;
  readonly createContext: (options?: {
    readonly name?: string | undefined;
  }) => Effect.Effect<StoredContext, BrowserbaseError>;
  readonly getContext: (id: string) => Effect.Effect<StoredContext, BrowserbaseError>;
  readonly deleteContext: (id: string) => Effect.Effect<void, BrowserbaseError>;
  /** Search the web for up to `results` hits, from 1 to 25. Defaults to 10. */
  readonly search: (
    query: string,
    options?: { readonly results?: number | undefined },
  ) => Effect.Effect<ReadonlyArray<SearchResult>, BrowserbaseError>;
  readonly fetch: (
    url: string,
    options?: FetchOptions,
  ) => Effect.Effect<FetchedPage, BrowserbaseError>;
}

export class BrowserbaseClient extends Context.Service<BrowserbaseClient, Service>()(
  "effect-browserbase/BrowserbaseClient",
) {}

export interface Options {
  readonly apiKey: Redacted.Redacted<string>;
  /** Defaults to `https://api.browserbase.com`. */
  readonly baseUrl?: string | undefined;
  /** Bound on each request attempt, including reading its answer. Defaults to 60 seconds. */
  readonly requestTimeout?: Duration.Input | undefined;
}

const ids = /^[A-Za-z0-9_-]{1,128}$/;
const ErrorBody = Schema.fromJsonString(Schema.Struct({ message: Schema.String }));
const SearchResponse = Schema.Struct({ results: Schema.Array(SearchResult) });

const statusReason = (status: number, detail: string): Reason => {
  if (status < 200 || (status >= 300 && status < 400)) {
    return new Status({
      status,
      detail: "redirected; redirects are refused so the API key stays with Browserbase",
    });
  }
  if (status === 401 || status === 403) return new Unauthorized({ detail });
  if (status === 404) return new NotFound({ detail });
  if (status === 429) return new RateLimited({ detail });

  return new Status({ status, detail });
};

/** Run the request with fetch's redirect mode set to manual, keeping any other fetch options. */
const refuseRedirects = <A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
  Effect.contextWith((context: Context.Context<never>) =>
    Effect.provideService(effect, FetchHttpClient.RequestInit, {
      ...Context.getOrUndefined(context, FetchHttpClient.RequestInit),
      redirect: "manual",
    }),
  );

export const make = Effect.fnUntraced(function* (options: Options) {
  const http = (yield* HttpClient.HttpClient).pipe(
    HttpClient.mapRequest(
      flow(
        HttpClientRequest.prependUrl(options.baseUrl ?? defaultBaseUrl),
        HttpClientRequest.setHeader("x-bb-api-key", Redacted.value(options.apiKey)),
        HttpClientRequest.acceptJson,
      ),
    ),
    HttpClient.transformResponse(
      flow(
        refuseRedirects,
        Effect.updateService(Headers.CurrentRedactedNames, (names) => [...names, "x-bb-api-key"]),
      ),
    ),
  );

  const failure = (operation: string, reason: Reason) =>
    new BrowserbaseError({ operation, reason });

  const requestTimeout = Duration.fromInputUnsafe(options.requestTimeout ?? Duration.seconds(60));

  /** Send one request; on a success status, read the answer with `read`. */
  const send = <A>(
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    read: (response: HttpClientResponse.HttpClientResponse) => Effect.Effect<A, BrowserbaseError>,
  ): Effect.Effect<A, BrowserbaseError> =>
    http.execute(request).pipe(
      Effect.mapError((error) => failure(operation, new Transport({ detail: error.message }))),
      Effect.flatMap((response) =>
        response.status >= 200 && response.status < 300
          ? read(response)
          : response.text.pipe(
              Effect.map((text) =>
                Option.getOrElse(
                  Option.map(Schema.decodeOption(ErrorBody)(text), (body) => body.message),
                  () => text.slice(0, 300),
                ),
              ),
              Effect.orElseSucceed(() => ""),
              Effect.flatMap((detail) =>
                Effect.fail(failure(operation, statusReason(response.status, detail))),
              ),
            ),
      ),
      // The deadline also applies inside a caller's uninterruptible acquisition, such as the
      // session create in Browserbase.open, so that acquisition always settles.
      Effect.timeoutOrElse({
        duration: requestTimeout,
        orElse: () =>
          Effect.fail(
            failure(
              operation,
              new Transport({
                detail: `no answer within ${Duration.format(requestTimeout)}`,
              }),
            ),
          ),
      }),
      request.method === "GET"
        ? Effect.retry({
            while: isTransient,
            times: 2,
            schedule: Schedule.exponential("250 millis").pipe(Schedule.jittered),
          })
        : identity,
      Effect.withSpan(`Browserbase.${operation}`),
    );

  const json =
    <A>(operation: string, schema: Schema.Decoder<A>) =>
    (response: HttpClientResponse.HttpClientResponse) =>
      HttpClientResponse.schemaBodyJson(schema)(response).pipe(
        Effect.mapError((error) =>
          failure(operation, new Decode({ detail: error.message.split("\n")[0] ?? "" })),
        ),
      );

  const ignoreBody = () => Effect.void;

  const withBody = (
    operation: string,
    request: HttpClientRequest.HttpClientRequest,
    body: unknown,
  ) =>
    HttpClientRequest.bodyJson(request, body).pipe(
      Effect.mapError((error) => failure(operation, new InvalidRequest({ detail: error.message }))),
    );

  const checkId = (operation: string, id: string): Effect.Effect<string, BrowserbaseError> =>
    ids.test(id)
      ? Effect.succeed(id)
      : Effect.fail(
          failure(
            operation,
            new InvalidRequest({ detail: `${JSON.stringify(id)} is not a Browserbase id` }),
          ),
        );

  return BrowserbaseClient.of({
    createSession: (body = {}) =>
      withBody("createSession", HttpClientRequest.post("/v1/sessions"), body).pipe(
        Effect.flatMap((request) => send("createSession", request, json("createSession", Session))),
      ),
    getSession: (id) =>
      checkId("getSession", id).pipe(
        Effect.flatMap(() =>
          send(
            "getSession",
            HttpClientRequest.get(`/v1/sessions/${id}`),
            json("getSession", Session),
          ),
        ),
      ),
    listSessions: (filter = {}) =>
      send(
        "listSessions",
        HttpClientRequest.get("/v1/sessions", {
          urlParams: {
            ...(filter.status === undefined ? {} : { status: filter.status }),
            ...(filter.query === undefined ? {} : { q: filter.query }),
          },
        }),
        json("listSessions", Schema.Array(Session)),
      ),
    releaseSession: (id) =>
      checkId("releaseSession", id).pipe(
        Effect.flatMap(() =>
          withBody("releaseSession", HttpClientRequest.post(`/v1/sessions/${id}`), {
            status: "REQUEST_RELEASE",
          }),
        ),
        Effect.flatMap((request) => send("releaseSession", request, ignoreBody)),
      ),
    liveView: (id, options = {}) =>
      checkId("liveView", id).pipe(
        Effect.flatMap(() =>
          send(
            "liveView",
            HttpClientRequest.get(`/v1/sessions/${id}/debug`, {
              urlParams:
                options.expiresInSeconds === undefined
                  ? {}
                  : { expiresIn: options.expiresInSeconds },
            }),
            json("liveView", LiveView),
          ),
        ),
      ),
    createContext: (body = {}) =>
      withBody("createContext", HttpClientRequest.post("/v1/contexts"), body).pipe(
        Effect.flatMap((request) =>
          send("createContext", request, json("createContext", StoredContext)),
        ),
      ),
    getContext: (id) =>
      checkId("getContext", id).pipe(
        Effect.flatMap(() =>
          send(
            "getContext",
            HttpClientRequest.get(`/v1/contexts/${id}`),
            json("getContext", StoredContext),
          ),
        ),
      ),
    deleteContext: (id) =>
      checkId("deleteContext", id).pipe(
        Effect.flatMap(() =>
          send("deleteContext", HttpClientRequest.delete(`/v1/contexts/${id}`), ignoreBody),
        ),
      ),
    search: (query, options = {}) =>
      withBody("search", HttpClientRequest.post("/v1/search"), {
        query,
        ...(options.results === undefined ? {} : { numResults: options.results }),
      }).pipe(
        Effect.flatMap((request) => send("search", request, json("search", SearchResponse))),
        Effect.map((response) => response.results),
      ),
    fetch: (url, options = {}) =>
      withBody("fetch", HttpClientRequest.post("/v1/fetch"), { url, ...options }).pipe(
        Effect.flatMap((request) => send("fetch", request, json("fetch", FetchedPage))),
      ),
  });
});

export const layer = (
  options: Options,
): Layer.Layer<BrowserbaseClient, never, HttpClient.HttpClient> =>
  Layer.effect(BrowserbaseClient, make(options));

/** The client configured from `BROWSERBASE_API_KEY` and, optionally, `BROWSERBASE_BASE_URL`. */
export const layerConfig = (
  options: {
    readonly apiKey?: Config.Config<Redacted.Redacted<string>> | undefined;
    readonly baseUrl?: Config.Config<string> | undefined;
  } = {},
): Layer.Layer<BrowserbaseClient, Config.ConfigError, HttpClient.HttpClient> =>
  Layer.effect(
    BrowserbaseClient,
    Effect.gen(function* () {
      const apiKey = yield* options.apiKey ?? Config.Redacted("BROWSERBASE_API_KEY");

      const baseUrl = yield* (
        options.baseUrl ??
          Config.String("BROWSERBASE_BASE_URL").pipe(Config.withDefault(defaultBaseUrl))
      );

      return yield* make({ apiKey, baseUrl });
    }),
  );
