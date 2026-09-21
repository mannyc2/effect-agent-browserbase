import { Clock, Duration, Effect, Redacted, Schema, Stream } from "effect";
import {
  FetchHttpClient,
  HttpClient,
  HttpClientRequest,
  type HttpClientResponse,
} from "effect/unstable/http";

import type { MultipartFile } from "../../Client.ts";
import { ClientError } from "../../Errors.ts";

const API_ORIGIN = "https://api.browserbase.com";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;

const mediaType = (value: string | undefined): string =>
  value?.split(";", 1)[0]?.trim().toLowerCase() ?? "";

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

const retryAfter = (value: string | undefined, now: number): number | undefined => {
  if (value === undefined || value.length > 128) return undefined;
  const seconds = Number(value);

  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(60_000, seconds * 1000);
  const date = Date.parse(value);

  return Number.isFinite(date) ? Math.min(60_000, Math.max(0, date - now)) : undefined;
};

const statusError = (status: number, operation: string, after?: number) =>
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
    outcome: [400, 401, 403, 404, 409, 410, 422, 429].includes(status) ? "rejected" : "unknown",
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
          return Effect.fail(
            ClientError.make({ operation, reason: "limit", outcome: "unknown" }),
          );
        }
        total += chunk.byteLength;
        chunks.push(chunk);

        return Effect.void;
      }),
    );

    const bytes = new Uint8Array(total);
    let offset = 0;

    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }

    return bytes;
  });

const inspectJson = Effect.fnUntraced(function* (
  response: HttpClientResponse.HttpClientResponse,
  operation: string,
) {
  if (![200, 201, 202].includes(response.status)) {
    return yield* statusError(
      response.status,
      operation,
      retryAfter(response.headers["retry-after"], yield* Clock.currentTimeMillis),
    );
  }
  if (mediaType(response.headers["content-type"]) !== "application/json") {
    return yield* ClientError.make({
      operation,
      reason: "content-type",
      outcome: "unknown",
    });
  }

  const length = response.headers["content-length"];
  if (length !== undefined && (!/^\d+$/.test(length) || Number(length) > MAX_JSON_BYTES)) {
    return yield* ClientError.make({ operation, reason: "limit", outcome: "unknown" });
  }

  let received = 0;
  return response.stream.pipe(
    Stream.mapError(() =>
      ClientError.make({ operation, reason: "transport", outcome: "unknown" }),
    ),
    Stream.mapEffect((chunk) =>
      Effect.suspend(() => {
        if (chunk.byteLength > MAX_JSON_BYTES - received) {
          return Effect.fail(
            ClientError.make({ operation, reason: "limit", outcome: "unknown" }),
          );
        }
        received += chunk.byteLength;
        return Effect.succeed(new Uint8Array(chunk));
      }),
    ),
  );
});

/** Multipart is a narrow Client transport capability for provider file resources. It never retries. */
export const makeMultipartTransport = Effect.fnUntraced(function* (
  apiKey: Redacted.Redacted<string>,
  requestTimeoutMillis: number,
) {
  const fetch = yield* FetchHttpClient.Fetch;
  const client = yield* HttpClient.HttpClient.pipe(Effect.provide(FetchHttpClient.layer));
  const scoped = HttpClient.withScope(client);
  const key = Redacted.value(apiKey);

  const execute = (request: HttpClientRequest.HttpClientRequest) =>
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
          operation: "provider-multipart",
          reason: "transport",
          outcome: "unknown",
        }),
      ),
    );

  return Effect.fnUntraced(function* (path: string, file: MultipartFile) {
    if (
      !path.startsWith("/v1/") ||
      path.includes("\\") ||
      path.includes("#") ||
      path.length > 16_384 ||
      !Number.isSafeInteger(requestTimeoutMillis) ||
      requestTimeoutMillis < 1 ||
      requestTimeoutMillis > 60_000
    ) {
      return yield* ClientError.make({
        operation: "provider-multipart",
        reason: "configuration",
        outcome: "undispatched",
      });
    }

    const owned = Uint8Array.from(file.bytes);
    const form = new FormData();
    form.append(file.field, new Blob([owned], { type: file.mediaType }), file.fileName);

    const request = HttpClientRequest.post(`${API_ORIGIN}${path}`).pipe(
      HttpClientRequest.setHeader("x-bb-api-key", key),
      HttpClientRequest.setHeader("accept", "application/json"),
      HttpClientRequest.bodyFormData(form),
    );

    const once = Effect.gen(function* () {
      const response = yield* execute(request);
      const stream = yield* inspectJson(response, "provider-multipart");
      const bytes = yield* collect(stream, MAX_JSON_BYTES, "provider-multipart");
      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes),
        catch: () =>
          ClientError.make({
            operation: "provider-multipart",
            reason: "malformed",
            outcome: "unknown",
          }),
      });

      if (!withinJsonDepth(text)) {
        return yield* ClientError.make({
          operation: "provider-multipart",
          reason: "limit",
          outcome: "unknown",
        });
      }

      return yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(text).pipe(
        Effect.mapError(() =>
          ClientError.make({
            operation: "provider-multipart",
            reason: "malformed",
            outcome: "unknown",
          }),
        ),
      );
    });

    return yield* Effect.scoped(once).pipe(
      Effect.timeoutOrElse({
        duration: Duration.millis(requestTimeoutMillis),
        orElse: () =>
          Effect.fail(
            ClientError.make({
              operation: "provider-multipart",
              reason: "timeout",
              outcome: "unknown",
            }),
          ),
      }),
    );
  });
});
