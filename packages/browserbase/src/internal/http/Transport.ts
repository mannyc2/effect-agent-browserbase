import { Clock, Duration, Effect, Redacted, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

import type { ClientMethod, ClientOptions } from "../../Client.ts";
import { ClientError } from "../../Errors.ts";
import { Identifier } from "../../References.ts";

const API_ORIGIN = "https://api.browserbase.com";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;

const Options = Schema.Struct({
  projectId: Identifier,
  apiKey: Schema.Redacted(
    Schema.NonEmptyString.check(Schema.isMaxLength(8192), Schema.isPattern(/^[\x21-\x7e]+$/)),
  ),
  artifactOrigins: Schema.optionalKey(
    Schema.Array(Schema.String.check(Schema.isMaxLength(8192))).check(
      Schema.isMaxLength(32),
      Schema.isUnique(),
    ),
  ),
  requestTimeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  ),
});

const nowMillis = Clock.monotonicTimeNanos.pipe(Effect.map((value) => Number(value) / 1_000_000));

const deadlineAfter = (millis: number) => nowMillis.pipe(Effect.map((now) => now + millis));

const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  operation: string,
  outcome?: "undispatched" | "unknown",
): Effect.Effect<A, E | ClientError, R> =>
  Effect.suspend(() =>
    nowMillis.pipe(
      Effect.flatMap((now) => {
        const remaining = deadline - now;

        const timeout = () =>
          Effect.fail(
            ClientError.make({
              operation,
              reason: "timeout",
              ...(outcome === undefined ? {} : { outcome }),
            }),
          );

        return remaining <= 0
          ? timeout()
          : effect.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(remaining),
                orElse: timeout,
              }),
            );
      }),
    ),
  );

const withinJsonDepth = (text: string): boolean => {
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
      if (++depth > MAX_JSON_DEPTH) return false;
    } else if (character === "}" || character === "]") depth--;
  }

  return true;
};

const mediaType = (value: string | undefined): string =>
  value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

const retryAfter = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined || value.length > 128) return undefined;
  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(value);

  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - now)) : undefined;
};

const mutationOutcome = (
  method: ClientMethod,
  status?: number,
): "rejected" | "unknown" | undefined => {
  if (method === "GET") return undefined;
  if (status !== undefined && [400, 401, 403, 404, 409, 410, 422, 429].includes(status)) {
    return "rejected";
  }

  return "unknown";
};

const statusError = (method: ClientMethod, status: number, operation: string, after?: number) =>
  ClientError.make({
    operation,
    reason:
      status === 401 || status === 403
        ? "authorization"
        : status === 429
          ? "rate-limited"
          : status === 409
            ? "active"
            : status === 410
              ? "expired"
              : status === 422
                ? "disabled"
                : status === 404
                  ? "not-found"
                  : "provider",
    status,
    ...(mutationOutcome(method, status) === undefined
      ? {}
      : { outcome: mutationOutcome(method, status) }),
    ...(after === undefined ? {} : { retryAfterMillis: after }),
  });

const collect = (
  stream: Stream.Stream<Uint8Array, ClientError>,
  maximum: number,
  operation: string,
) =>
  Effect.gen(function* () {
    const chunks: Uint8Array[] = [];
    let total = 0;

    yield* Stream.runForEach(stream, (chunk) =>
      Effect.suspend(() => {
        if (chunk.byteLength > maximum - total) {
          return Effect.fail(ClientError.make({ operation, reason: "limit" }));
        }
        total += chunk.byteLength;
        chunks.push(chunk);

        return Effect.void;
      }),
    );

    const body = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      body.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return body;
  });

const validApiPath = (path: string): boolean =>
  path.startsWith("/v1/") && !path.includes("\\") && !path.includes("#") && path.length <= 16_384;

export const makeTransport = Effect.fnUntraced(function* (options: ClientOptions) {
  const configured = yield* Schema.decodeEffect(Options)(options, {
    onExcessProperty: "error",
  }).pipe(
    Effect.mapError(() =>
      ClientError.make({
        operation: "configure",
        reason: "configuration",
        outcome: "undispatched",
      }),
    ),
  );

  const apiKey = Redacted.value(configured.apiKey);
  const requestTimeoutMillis = configured.requestTimeoutMillis ?? 10_000;
  const artifactOrigins = new Set<string>();

  for (const origin of configured.artifactOrigins ?? []) {
    const url = yield* Effect.try({
      try: () => new URL(origin),
      catch: () =>
        ClientError.make({
          operation: "configure",
          reason: "configuration",
          outcome: "undispatched",
        }),
    });

    if (url.protocol !== "https:" || url.origin !== origin || url.username || url.password) {
      return yield* ClientError.make({
        operation: "configure",
        reason: "configuration",
        outcome: "undispatched",
      });
    }
    artifactOrigins.add(origin);
  }

  const fetch = yield* FetchHttpClient.Fetch;
  const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  const scoped = HttpClient.withScope(client);

  const execute = (
    request: HttpClientRequest.HttpClientRequest,
    operation: string,
    outcome?: "undispatched" | "unknown",
  ) =>
    scoped.execute(request).pipe(
      Effect.provideService(FetchHttpClient.Fetch, fetch),
      Effect.provideService(FetchHttpClient.RequestInit, {
        redirect: "manual",
        credentials: "omit",
        cache: "no-store",
        referrerPolicy: "no-referrer",
      }),
      Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.withTracerEnabled(false),
      Effect.mapError(() =>
        ClientError.make({
          operation,
          reason: "transport",
          ...(outcome === undefined ? {} : { outcome }),
        }),
      ),
    );

  const apiRequest = (method: ClientMethod, path: string, accept: string) => {
    if (!validApiPath(path)) throw new Error("Invalid internal Browserbase API path");

    return HttpClientRequest.make(method)(`${API_ORIGIN}${path}`).pipe(
      HttpClientRequest.setHeader("x-bb-api-key", apiKey),
      HttpClientRequest.setHeader("accept", accept),
    );
  };

  const inspectJson = Effect.fnUntraced(function* (
    method: ClientMethod,
    response: HttpClientResponse.HttpClientResponse,
    operation: string,
  ) {
    if (response.status !== 200 && response.status !== 201 && response.status !== 202) {
      return yield* statusError(
        method,
        response.status,
        operation,
        retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis),
      );
    }
    if (mediaType(response.headers["content-type"]) !== "application/json") {
      return yield* ClientError.make({
        operation,
        reason: "content-type",
        ...(mutationOutcome(method) === undefined ? {} : { outcome: mutationOutcome(method) }),
      });
    }
    const length = response.headers["content-length"];

    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
      return yield* ClientError.make({
        operation,
        reason: "limit",
        ...(mutationOutcome(method) === undefined ? {} : { outcome: mutationOutcome(method) }),
      });
    }
    let received = 0;

    return response.stream.pipe(
      Stream.mapError(() =>
        ClientError.make({
          operation,
          reason: "transport",
          ...(mutationOutcome(method) === undefined ? {} : { outcome: mutationOutcome(method) }),
        }),
      ),
      Stream.mapEffect((chunk) =>
        Effect.suspend(() => {
          if (chunk.byteLength > MAX_JSON_BYTES - received) {
            return Effect.fail(
              ClientError.make({
                operation,
                reason: "limit",
                ...(mutationOutcome(method) === undefined
                  ? {}
                  : { outcome: mutationOutcome(method) }),
              }),
            );
          }
          received += chunk.byteLength;

          return Effect.succeed(new Uint8Array(chunk));
        }),
      ),
    );
  });

  const jsonOnce = Effect.fnUntraced(function* (
    method: ClientMethod,
    path: string,
    body?: Schema.Json,
  ) {
    const operation = method === "GET" ? "provider-read" : "provider-mutation";
    let request = apiRequest(method, path, "application/json");

    if (body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, body).pipe(
        Effect.mapError(() =>
          ClientError.make({
            operation,
            reason: "configuration",
            outcome: "undispatched",
          }),
        ),
      );
    }
    const response = yield* execute(request, operation, method === "GET" ? undefined : "unknown");
    const stream = yield* inspectJson(method, response, operation);
    const bytes = yield* collect(stream, MAX_JSON_BYTES, operation);

    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
      catch: () =>
        ClientError.make({
          operation,
          reason: "malformed",
          ...(mutationOutcome(method) === undefined ? {} : { outcome: mutationOutcome(method) }),
        }),
    });

    if (!withinJsonDepth(text)) {
      return yield* ClientError.make({
        operation,
        reason: "limit",
        ...(mutationOutcome(method) === undefined ? {} : { outcome: mutationOutcome(method) }),
      });
    }

    return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
      Effect.mapError(() =>
        ClientError.make({
          operation,
          reason: "malformed",
          ...(mutationOutcome(method) === undefined ? {} : { outcome: mutationOutcome(method) }),
        }),
      ),
    );
  });

  const json = Effect.fnUntraced(function* (
    method: ClientMethod,
    path: string,
    body?: Schema.Json,
    outerDeadline?: number,
  ) {
    const deadline = Math.min(
      yield* deadlineAfter(requestTimeoutMillis),
      outerDeadline ?? Infinity,
    );

    for (let attempt = 0; ; attempt++) {
      const result = yield* within(
        Effect.scoped(jsonOnce(method, path, body)),
        deadline,
        "provider-request",
        method === "GET" ? undefined : "unknown",
      ).pipe(Effect.result);

      if (result._tag === "Success") return result.success;
      const error = result.failure;

      const retryable =
        error.reason === "transport" ||
        error.reason === "rate-limited" ||
        (error.reason === "provider" && (error.status ?? 0) >= 500);

      if (method !== "GET" || !retryable || attempt >= 2) return yield* error;
      const delay = error.retryAfterMillis ?? (attempt + 1) * 150;

      if ((yield* nowMillis) + delay >= deadline) return yield* error;
      yield* Effect.sleep(delay);
    }
  });

  const noContent = Effect.fnUntraced(function* (
    method: Exclude<ClientMethod, "GET">,
    path: string,
    body?: Schema.Json,
    outerDeadline?: number,
  ) {
    const operation = "provider-mutation";
    let request = apiRequest(method, path, "*/*");

    if (body !== undefined) {
      request = yield* HttpClientRequest.bodyJson(request, body).pipe(
        Effect.mapError(() =>
          ClientError.make({
            operation,
            reason: "configuration",
            outcome: "undispatched",
          }),
        ),
      );
    }

    const deadline = Math.min(
      yield* deadlineAfter(requestTimeoutMillis),
      outerDeadline ?? Infinity,
    );

    const response = yield* within(
      Effect.scoped(execute(request, operation, "unknown")),
      deadline,
      operation,
      "unknown",
    );

    if (![200, 202, 204].includes(response.status)) {
      return yield* statusError(
        method,
        response.status,
        operation,
        retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis),
      );
    }
  });

  const inspectBytes = Effect.fnUntraced(function* (
    response: HttpClientResponse.HttpClientResponse,
    operation: string,
    types: ReadonlyArray<string>,
    maximum: number,
  ) {
    if (response.status !== 200 && response.status !== 206) {
      return yield* statusError(
        "GET",
        response.status,
        operation,
        retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis),
      );
    }
    if (!types.includes(mediaType(response.headers["content-type"]))) {
      return yield* ClientError.make({ operation, reason: "content-type" });
    }
    const length = response.headers["content-length"];

    if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > maximum)) {
      return yield* ClientError.make({ operation, reason: "limit" });
    }
    let received = 0;

    return response.stream.pipe(
      Stream.mapError(() => ClientError.make({ operation, reason: "transport" })),
      Stream.mapEffect((chunk) =>
        Effect.suspend(() => {
          if (chunk.byteLength > maximum - received) {
            return Effect.fail(ClientError.make({ operation, reason: "limit" }));
          }
          received += chunk.byteLength;

          return Effect.succeed(new Uint8Array(chunk));
        }),
      ),
    );
  });

  const bytes = (
    path: string,
    maximum: number,
    types: ReadonlyArray<string>,
    operation: string,
    timeoutMillis = requestTimeoutMillis,
    outerDeadline?: number,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        if (
          !Number.isSafeInteger(maximum) ||
          maximum < 1 ||
          maximum > 2 ** 31 - 1 ||
          !Number.isSafeInteger(timeoutMillis) ||
          timeoutMillis < 1 ||
          timeoutMillis > 600_000
        ) {
          return yield* ClientError.make({ operation, reason: "configuration" });
        }
        const deadline = Math.min(yield* deadlineAfter(timeoutMillis), outerDeadline ?? Infinity);

        const response = yield* within(
          execute(apiRequest("GET", path, types[0] ?? "application/octet-stream"), operation),
          deadline,
          operation,
        );

        const stream = yield* inspectBytes(response, operation, types, maximum);

        return Stream.transformPull(stream, (pull) =>
          Effect.succeed(within(pull, deadline, operation)),
        );
      }),
    ).pipe(Stream.scoped);

  const text = (path: string, maximum: number, types: ReadonlyArray<string>, operation: string) =>
    collect(bytes(path, maximum, types, operation), maximum, operation).pipe(
      Effect.flatMap((body) =>
        Effect.try({
          try: () => new TextDecoder("utf-8", { fatal: true }).decode(body),
          catch: () => ClientError.make({ operation, reason: "malformed" }),
        }),
      ),
      Effect.timeoutOrElse({
        duration: Duration.millis(requestTimeoutMillis),
        orElse: () => Effect.fail(ClientError.make({ operation, reason: "timeout" })),
      }),
    );

  const validateMediaUrl = (value: string): boolean => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        !url.hash &&
        artifactOrigins.has(url.origin) &&
        value.length <= 16_384
      );
    } catch {
      return false;
    }
  };

  const media = (
    url: Redacted.Redacted<string>,
    maximum: number,
    types: ReadonlyArray<string>,
    timeoutMillis = 60_000,
    outerDeadline?: number,
  ) =>
    Stream.unwrap(
      Effect.gen(function* () {
        const value = Redacted.value(url);

        if (
          !validateMediaUrl(value) ||
          !Number.isSafeInteger(maximum) ||
          maximum < 1 ||
          maximum > 2 ** 31 - 1 ||
          !Number.isSafeInteger(timeoutMillis) ||
          timeoutMillis < 1 ||
          timeoutMillis > 600_000
        ) {
          return yield* ClientError.make({ operation: "media-download", reason: "unsafe-url" });
        }
        const deadline = Math.min(yield* deadlineAfter(timeoutMillis), outerDeadline ?? Infinity);

        const response = yield* within(
          execute(HttpClientRequest.get(value), "media-download"),
          deadline,
          "media-download",
        );

        const stream = yield* inspectBytes(response, "media-download", types, maximum);

        return Stream.transformPull(stream, (pull) =>
          Effect.succeed(within(pull, deadline, "media-download")),
        );
      }),
    ).pipe(Stream.scoped);

  return {
    projectId: configured.projectId,
    json,
    noContent,
    text,
    bytes,
    media,
    validateMediaUrl,
  };
});
