import { Duration, Effect, Redacted, Schema } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

import type { MultipartFile } from "../../Client.ts";
import { ClientError } from "../../Errors.ts";

const API_ORIGIN = "https://api.browserbase.com";
const MAX_JSON_BYTES = 1024 * 1024;
const MAX_JSON_DEPTH = 64;

const mediaType = (value: string | null): string =>
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

const statusError = (status: number, retryAfterHeader: string | null) => {
  const seconds = retryAfterHeader === null ? Number.NaN : Number(retryAfterHeader);
  const retryAfterMillis =
    Number.isFinite(seconds) && seconds >= 0 ? Math.min(60_000, seconds * 1000) : undefined;

  return ClientError.make({
    operation: "provider-multipart",
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
    ...(retryAfterMillis === undefined ? {} : { retryAfterMillis }),
  });
};

const readBounded = (response: Response) =>
  Effect.tryPromise({
    try: async (signal) => {
      const declared = response.headers.get("content-length");

      if (declared !== null && (!/^\d+$/.test(declared) || Number(declared) > MAX_JSON_BYTES)) {
        throw new RangeError("response limit");
      }
      if (response.body === null) return new Uint8Array(0);

      const reader = response.body.getReader();
      const abort = () => {
        void reader.cancel().catch(() => undefined);
      };

      signal.addEventListener("abort", abort, { once: true });
      const chunks: Uint8Array[] = [];
      let total = 0;

      try {
        for (;;) {
          const next = await reader.read();

          if (next.done) break;
          if (next.value.byteLength > MAX_JSON_BYTES - total) throw new RangeError("response limit");
          total += next.value.byteLength;
          chunks.push(new Uint8Array(next.value));
        }
      } finally {
        signal.removeEventListener("abort", abort);
        reader.releaseLock();
      }

      const bytes = new Uint8Array(total);
      let offset = 0;

      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }

      return bytes;
    },
    catch: (cause) =>
      ClientError.make({
        operation: "provider-multipart",
        reason: cause instanceof RangeError ? "limit" : "transport",
        outcome: "unknown",
      }),
  });

/** Multipart is a narrow Client transport capability for provider file resources. It never retries. */
export const makeMultipartTransport = Effect.fnUntraced(function* (
  apiKey: Redacted.Redacted<string>,
  requestTimeoutMillis: number,
) {
  const fetch = yield* FetchHttpClient.Fetch;
  const key = Redacted.value(apiKey);

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

    const program = Effect.gen(function* () {
      const response = yield* Effect.tryPromise({
        try: (signal) =>
          fetch(`${API_ORIGIN}${path}`, {
            method: "POST",
            headers: { "x-bb-api-key": key, accept: "application/json" },
            body: form,
            redirect: "manual",
            credentials: "omit",
            cache: "no-store",
            referrerPolicy: "no-referrer",
            signal,
          }),
        catch: () =>
          ClientError.make({
            operation: "provider-multipart",
            reason: "transport",
            outcome: "unknown",
          }),
      });

      if (![200, 201, 202].includes(response.status)) {
        return yield* statusError(response.status, response.headers.get("retry-after"));
      }
      if (mediaType(response.headers.get("content-type")) !== "application/json") {
        return yield* ClientError.make({
          operation: "provider-multipart",
          reason: "content-type",
          outcome: "unknown",
        });
      }

      const bytes = yield* readBounded(response);
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

    return yield* program.pipe(
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
