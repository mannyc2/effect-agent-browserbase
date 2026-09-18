import { Clock, Effect, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/unstable/http";
import type { HttpClientResponse } from "effect/unstable/http";
import { BrowserbaseError, Identifier } from "../Types.ts";
import { deadlineAfter, nowMillis, within } from "./Deadline.ts";

export interface BrowserbaseOptions {
  readonly projectId: string;
  readonly apiKey: Redacted.Redacted<string>;
  /** Exact HTTPS origins allowed for credential-free provider media downloads. */
  readonly artifactOrigins?: ReadonlyArray<string>;
  readonly requestTimeoutMillis?: number;
}

/** Project an interactive configuration onto the strictly validated HTTP boundary. */
export const httpOptions = (options: BrowserbaseOptions): BrowserbaseOptions => ({
  projectId: options.projectId,
  apiKey: options.apiKey,
  ...(options.artifactOrigins === undefined ? {} : { artifactOrigins: options.artifactOrigins }),
  ...(options.requestTimeoutMillis === undefined ? {} : { requestTimeoutMillis: options.requestTimeoutMillis }),
});

const API_ORIGIN = "https://api.browserbase.com";
const MAX_JSON_BYTES = 1024 * 1024;
const Options = Schema.Struct({
  projectId: Identifier,
  apiKey: Schema.Redacted(Schema.NonEmptyString.check(
    Schema.isMaxLength(8192), Schema.isPattern(/^[\x21-\x7e]+$/),
  )),
  artifactOrigins: Schema.optionalKey(Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(Schema.isMaxLength(32))),
  requestTimeoutMillis: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 }))),
});

/** Bound structural depth before the JSON Schema walks the decoded graph. */
const withinJsonDepth = (text: string, maximum: number): boolean => {
  let depth = 0;
  let quoted = false;
  let escaped = false;
  for (const character of text) {
    if (quoted) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "{" || character === "[") {
      if (++depth > maximum) return false;
    } else if (character === "}" || character === "]") depth--;
  }
  // Syntax validity remains the JSON decoder's job, not this depth preflight's.
  return true;
};

export const decode = <A>(schema: Schema.Codec<A, unknown, never, never>, value: unknown, operation: string) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(
    Effect.mapError(() => new BrowserbaseError({ operation, reason: "malformed" })),
  );

export const mediaType = (value: string | undefined): string => value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const retryAfter = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined || value.length > 128) return undefined;
  const seconds = Number(value);
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(value);
  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - now)) : undefined;
};

const statusError = (status: number, operation: string, after?: number) => new BrowserbaseError({
  operation,
  reason: status === 401 || status === 403 ? "authorization" :
    status === 429 ? "rate-limited" : status === 409 ? "active" :
    status === 410 ? "expired" : status === 422 ? "disabled" :
    status === 404 ? "not-found" : "provider",
  status,
  ...(after === undefined ? {} : { retryAfterMillis: after }),
});

const collect = (stream: Stream.Stream<Uint8Array, BrowserbaseError>, maximum: number, operation: string) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let total = 0;
    yield* Stream.runForEach(stream, (chunk) => Effect.suspend(() => {
      if (chunk.byteLength > maximum - total) return Effect.fail(new BrowserbaseError({ operation, reason: "limit" }));
      total += chunk.byteLength;
      chunks.push(chunk);
      return Effect.void;
    }));
    const body = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { body.set(chunk, offset); offset += chunk.byteLength; }
    return body;
  });

/**
 * Use the official FetchHttpClient, but not a caller-transformed ambient HttpClient.
 * Capture the host's fetch implementation once; reset RequestInit and tracing at every send.
 * A trusted test/host can supply fetch when constructing this private transport.
 */
export const makeHttp = Effect.fnUntraced(function* (
  options: BrowserbaseOptions,
  transport?: typeof globalThis.fetch,
) {
  const configured = yield* Schema.decodeEffect(Options)(options, { onExcessProperty: "error" }).pipe(
    Effect.mapError(() => new BrowserbaseError({ operation: "configure", reason: "configuration" })),
  );
  // Own immutable policy values; later mutation of the caller's options cannot
  // substitute credentials or request limits in an already built service.
  const apiKey = Redacted.value(configured.apiKey);
  const timeout = configured.requestTimeoutMillis ?? 10_000;
  const origins = new Set<string>();
  for (const origin of configured.artifactOrigins ?? []) {
    try {
      const u = new URL(origin);
      if (u.protocol !== "https:" || u.origin !== origin || u.username || u.password) throw new Error();
      origins.add(origin);
    } catch {
      return yield* new BrowserbaseError({ operation: "configure", reason: "configuration" });
    }
  }
  const fetch = transport ?? (yield* FetchHttpClient.Fetch);
  const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  const scoped = HttpClient.withScope(client);

  const execute = (request: HttpClientRequest.HttpClientRequest, operation: string) =>
    scoped.execute(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual", credentials: "omit", cache: "no-store", referrerPolicy: "no-referrer",
      }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.withTracerEnabled(false),
      Effect.mapError(() => new BrowserbaseError({ operation, reason: "transport" })),
    );

  const inspect = Effect.fnUntraced(function* (
    response: HttpClientResponse.HttpClientResponse,
    operation: string,
    types: ReadonlyArray<string>,
    maximum: number,
  ) {
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      return yield* statusError(response.status, operation,
        retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis));
    }
    if (!types.includes(mediaType(response.headers["content-type"]))) {
      return yield* new BrowserbaseError({ operation, reason: "content-type" });
    }
    const length = response.headers["content-length"];
    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
      return yield* new BrowserbaseError({ operation, reason: "limit" });
    }
    let received = 0;
    return response.stream.pipe(
      Stream.mapError(() => new BrowserbaseError({ operation, reason: "transport" })),
      Stream.mapEffect((chunk) => Effect.suspend(() => {
        if (chunk.byteLength > maximum - received) return Effect.fail(new BrowserbaseError({ operation, reason: "limit" }));
        received += chunk.byteLength;
        return Effect.succeed(new Uint8Array(chunk));
      })),
    );
  });

  const apiRequest = (method: "GET" | "POST", path: string, accept: string) => {
    if (!path.startsWith("/v1/") || path.includes("\\") || path.includes("#")) {
      throw new Error("Invalid internal Browserbase API path");
    }
    return HttpClientRequest.make(method)(`${API_ORIGIN}${path}`).pipe(
      HttpClientRequest.setHeader("x-bb-api-key", apiKey),
      HttpClientRequest.setHeader("accept", accept),
    );
  };

  const bytes = (
    path: string, maximum: number, types: ReadonlyArray<string>, operation: string,
    timeoutMillis = timeout, outerDeadline?: number,
  ) =>
    Stream.unwrap(Effect.gen(function* () {
      if (!Number.isSafeInteger(maximum) || maximum < 1 || maximum > 2 ** 31 - 1 ||
          !Number.isSafeInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 600_000) {
        return yield* new BrowserbaseError({ operation, reason: "configuration" });
      }
      const deadline = Math.min(yield* deadlineAfter(timeoutMillis), outerDeadline ?? Infinity);
      const response = yield* within(execute(apiRequest("GET", path, types[0] ?? "application/octet-stream"), operation), deadline, operation);
      const stream = yield* inspect(response, operation, types, maximum);
      return Stream.transformPull(stream, (pull) => Effect.succeed(within(pull, deadline, operation)));
    })).pipe(Stream.scoped);

  const text = (path: string, maximum: number, types: ReadonlyArray<string>, operation: string) =>
    collect(bytes(path, maximum, types, operation), maximum, operation).pipe(
      Effect.flatMap((body) => Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
        catch: () => new BrowserbaseError({ operation, reason: "malformed" }),
      })),
      Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.fail(new BrowserbaseError({ operation, reason: "timeout" })) }),
    );

  const jsonOnce = Effect.fnUntraced(function* (method: "GET" | "POST", path: string, body?: Schema.Json) {
    const operation = method === "POST" ? "provider-mutation" : "provider-read";
    let request = apiRequest(method, path, "application/json");
    if (body !== undefined) request = yield* HttpClientRequest.bodyJson(request, body).pipe(
      Effect.mapError(() => new BrowserbaseError({ operation, reason: "configuration" })),
    );
    const response = yield* execute(request, operation);
    const stream = yield* inspect(response, operation, ["application/json"], MAX_JSON_BYTES);
    const bodyBytes = yield* collect(stream, MAX_JSON_BYTES, operation);
    const bodyText = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bodyBytes),
      catch: () => new BrowserbaseError({ operation, reason: "malformed" }),
    });
    if (!withinJsonDepth(bodyText, 64)) {
      return yield* new BrowserbaseError({ operation, reason: "limit" });
    }
    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(bodyText).pipe(
      Effect.mapError(() => new BrowserbaseError({ operation, reason: "malformed" })),
    );
  }, Effect.scoped, Effect.withTracerEnabled(false));

  const json = Effect.fnUntraced(function* (
    method: "GET" | "POST", path: string, body?: Schema.Json, outerDeadline?: number,
  ) {
    const deadline = Math.min(yield* deadlineAfter(timeout), outerDeadline ?? Infinity);
    // POST is NEVER automatically retried. Every safe-read retry shares this same deadline.
    for (let attempt = 0; ; attempt++) {
      const result = yield* within(jsonOnce(method, path, body), deadline, "provider-request").pipe(Effect.result);
      if (result._tag === "Success") return result.success;
      const error = result.failure;
      const retryable = error.reason === "transport" || error.reason === "rate-limited" ||
        (error.reason === "provider" && (error.status ?? 0) >= 500);
      if (method !== "GET" || !retryable || attempt >= 2) return yield* error;
      const delay = error.retryAfterMillis ?? (attempt + 1) * 150;
      if ((yield* nowMillis) + delay >= deadline) return yield* error;
      yield* Effect.sleep(delay);
    }
  });

  const validateMediaUrl = (value: string): boolean => {
    try {
      const u = new URL(value);
      return u.protocol === "https:" && !u.username && !u.password && !u.hash &&
        origins.has(u.origin) && value.length <= 16_384;
    } catch { return false; }
  };

  const media = (
    url: Redacted.Redacted<string>, maximum: number, types: ReadonlyArray<string>,
    timeoutMillis = 60_000, outerDeadline?: number,
  ) =>
    Stream.unwrap(Effect.gen(function* () {
      if (!validateMediaUrl(Redacted.value(url)) || !Number.isSafeInteger(maximum) || maximum < 1 ||
          maximum > 2 ** 31 - 1 || !Number.isSafeInteger(timeoutMillis) || timeoutMillis < 1 || timeoutMillis > 600_000) {
        return yield* new BrowserbaseError({ operation: "media-download", reason: "unsafe-url" });
      }
      const deadline = Math.min(yield* deadlineAfter(timeoutMillis), outerDeadline ?? Infinity);
      const response = yield* within(execute(HttpClientRequest.get(Redacted.value(url)), "media-download"), deadline, "media-download");
      const stream = yield* inspect(response, "media-download", types, maximum);
      // Bound time spent waiting for the next body chunk, not only time between delivered chunks.
      return Stream.transformPull(stream, (pull) => Effect.succeed(within(pull, deadline, "media-download")));
    })).pipe(Stream.scoped);

  return { json, text, bytes, media, validateMediaUrl };
});

export type Http = Effect.Success<ReturnType<typeof makeHttp>>;
