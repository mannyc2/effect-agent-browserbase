import { Effect, Schema, Stream } from "effect";
import { BrowserError, Reasons, type BrowserReason } from "effect-browser/errors";
import { FetchHttpClient, HttpClient } from "effect/unstable/http";

const maximumBytes = 64 * 1024;
const Endpoint = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(16384));
const Version = Schema.fromJsonString(Schema.Struct({ webSocketDebuggerUrl: Endpoint }));

const failure = (reason: BrowserReason) =>
  BrowserError.make({ operation: "capture-start", reason, outcome: "undispatched" });

const malformed = () => failure(Reasons.Malformed.make({}));

const parseUrl = (endpoint: string) =>
  Effect.try({ try: () => new URL(endpoint), catch: malformed });

/** Only trusted host routing can introduce HTTP discovery; provider addresses are already checked. */
export const observationWebSocket = Effect.fnUntraced(
  function* (client: HttpClient.HttpClient, endpoint: string) {
    const url = yield* parseUrl(endpoint);

    if (url.protocol === "ws:" || url.protocol === "wss:") return endpoint;
    if (url.protocol !== "http:" && url.protocol !== "https:")
      return yield* failure(Reasons.UnsafeUrl.make({}));
    // Match Playwright's CDP discovery path, including a host's prefix and query parameters.
    if (!url.pathname.endsWith("/")) url.pathname += "/";
    url.pathname += "json/version/";

    const response = yield* HttpClient.withScope(client)
      .get(url.href)
      .pipe(Effect.mapError(() => failure(Reasons.Transport.make({}))));

    if (response.status !== 200)
      return yield* failure(Reasons.Provider.make({ status: response.status }));
    const bytes = new Uint8Array(maximumBytes);
    let received = 0;

    yield* response.stream.pipe(
      Stream.mapError(() => failure(Reasons.Transport.make({}))),
      Stream.runForEach((chunk) =>
        Effect.suspend(() => {
          if (chunk.byteLength > maximumBytes - received)
            return Effect.fail(
              failure(
                Reasons.Limit.make({
                  dimension: "returned-bytes",
                  maximum: maximumBytes,
                  observed: received + chunk.byteLength,
                }),
              ),
            );
          bytes.set(chunk, received);
          received += chunk.byteLength;

          return Effect.void;
        }),
      ),
    );

    const text = yield* Effect.try({
      try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, received)),
      catch: malformed,
    });

    const decoded = yield* Schema.decodeEffect(Version)(text).pipe(Effect.mapError(malformed));
    const socketUrl = yield* parseUrl(decoded.webSocketDebuggerUrl);

    if (socketUrl.protocol !== "ws:" && socketUrl.protocol !== "wss:")
      return yield* failure(Reasons.UnsafeUrl.make({}));

    return decoded.webSocketDebuggerUrl;
  },
  Effect.scoped,
  Effect.provideService(FetchHttpClient.RequestInit, {
    credentials: "omit",
    redirect: "error",
    headers: {},
  }),
  Effect.provideService(HttpClient.TracerDisabledWhen, () => true),
);
