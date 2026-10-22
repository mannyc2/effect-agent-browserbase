/** HTTP record/replay keeps provider codecs in the test and reserves every live request. */
import { Config, Context, Effect, Layer, Ref, Schema } from "effect";
import {
  HttpClient,
  HttpClientError,
  type HttpClientRequest,
  HttpClientResponse,
} from "effect/http";

import { canonical, ScriptError } from "./TestModel.ts";

/** Request identities contain hashes only; credentials and prompt text are never written. */
export const Exchange = Schema.Struct({
  key: Schema.String,
  response: Schema.Struct({
    status: Schema.Int,
    headers: Schema.Record(Schema.String, Schema.String),
    body: Schema.String,
  }),
});

export type Exchange = typeof Exchange.Type;

type Paid = {
  readonly http: HttpClient.HttpClient;
  /** A finite positive budget, in the same units as the reservation returned below. */
  readonly cap: number;
  /** Reserve an upper bound before dispatch, using the caller's existing admission ledger. */
  readonly reserve: (
    request: HttpClientRequest.HttpClientRequest,
  ) => Effect.Effect<number, ScriptError>;
};

export type Options =
  | {
      readonly mode: "replay";
      readonly exchanges: ReadonlyArray<Exchange>;
      readonly recordCommand?: string;
    }
  | (Paid & { readonly mode: "live" })
  | (Paid & {
      readonly mode: "record";
      readonly append: (exchange: Exchange) => Effect.Effect<void, ScriptError>;
    });

const problem = (detail: string) => new ScriptError({ detail });

const transport = (request: HttpClientRequest.HttpClientRequest, error: ScriptError) =>
  new HttpClientError.HttpClientError({
    reason: new HttpClientError.TransportError({ request, description: error.detail }),
  });

const identity = (request: HttpClientRequest.HttpClientRequest, url: URL) =>
  Effect.gen(function* () {
    if (request.body._tag !== "Empty" && request.body._tag !== "Uint8Array") {
      return yield* problem("cassette requests require a finite encoded body");
    }
    const text = request.body._tag === "Empty" ? "" : new TextDecoder().decode(request.body.body);
    let body: unknown = text;

    if (text !== "") {
      const decoded = Schema.decodeOption(Schema.fromJsonString(Schema.Unknown))(text);

      if (decoded._tag === "Some") body = decoded.value;
    }
    const normalized = new URL(url);

    normalized.searchParams.sort();
    normalized.hash = "";

    const bytes = new TextEncoder().encode(
      canonical({ method: request.method, url: normalized.href, body }),
    );

    const digest = yield* Effect.promise(() => crypto.subtle.digest("SHA-256", bytes));

    return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  });

// Fetch forbids even an empty-string body for these status codes.
const responseOf = (request: HttpClientRequest.HttpClientRequest, response: Exchange["response"]) =>
  HttpClientResponse.fromWeb(
    request,
    new Response([204, 205, 304].includes(response.status) ? null : response.body, response),
  );

/** Construct the same HTTP seam for replay, recording, or explicitly admitted live runs. */
export const make = (options: Options) =>
  Effect.gen(function* () {
    if (options.mode !== "replay") {
      const optIn = yield* Config.String("EFFECT_BROWSER_BENCH_LIVE").pipe(
        Config.withDefault(""),
        Effect.mapError(() => problem("live HTTP opt-in could not be read")),
      );

      if (optIn !== "1")
        return yield* problem("live HTTP requires EFFECT_BROWSER_BENCH_LIVE exactly 1");
      if (!(Number.isFinite(options.cap) && options.cap > 0))
        return yield* problem("live HTTP requires a finite positive cap");
    }
    const remaining = yield* Ref.make(options.mode === "replay" ? options.exchanges : []);
    const used = yield* Ref.make(0);
    const failures = yield* Ref.make(0);

    const refuse = (detail: string) =>
      Effect.andThen(
        Ref.update(failures, (count) => count + 1),
        Effect.fail(problem(detail)),
      );

    const http = HttpClient.make((request, url) =>
      Effect.gen(function* () {
        const key = yield* identity(request, url);

        if (options.mode === "replay") {
          const exchange = yield* Ref.modify(remaining, (rows) =>
            rows[0]?.key === key ? [rows[0], rows.slice(1)] : [undefined, rows],
          );

          if (exchange === undefined)
            return yield* refuse(
              `cassette request changed or ran out; re-record with ${options.recordCommand ?? "the scenario's record command"}`,
            );

          return responseOf(request, exchange.response);
        }
        const bound = yield* options.reserve(request);

        if (!(Number.isFinite(bound) && bound >= 0))
          return yield* refuse("request reservation must be a finite non-negative upper bound");

        const admitted = yield* Ref.modify(used, (total) =>
          total + bound <= options.cap ? [true, total + bound] : [false, total],
        );

        if (!admitted) return yield* refuse("request reservation exceeds the live HTTP cap");
        const response = yield* options.http.execute(request);

        if (options.mode === "live") return response;
        const body = yield* response.text;

        const headers = Object.fromEntries(
          Object.entries(response.headers).filter(([name]) =>
            ["content-type", "retry-after"].includes(name),
          ),
        );

        const exchange: Exchange = { key, response: { status: response.status, headers, body } };

        yield* options.append(exchange);

        return responseOf(request, exchange.response);
      }).pipe(
        Effect.mapError((error) =>
          Schema.is(ScriptError)(error) ? transport(request, error) : error,
        ),
      ),
    );

    return {
      http,
      assertExhausted: Effect.gen(function* () {
        const unused = (yield* Ref.get(remaining)).length;
        const unexpected = yield* Ref.get(failures);

        if (unused > 0 || unexpected > 0)
          return yield* problem(
            `cassette end check: ${unused} unused responses, ${unexpected} unexpected requests`,
          );
      }),
    };
  });

/** Provide this HTTP layer beneath an actual provider model layer in every mode. */
export class Cassette extends Context.Service<Cassette, Effect.Success<ReturnType<typeof make>>>()(
  "effect-agent-browser/testing/HttpCassette",
) {}

export const layer = (options: Options) =>
  Layer.unwrap(
    Effect.map(make(options), (cassette) =>
      Layer.merge(
        Layer.succeed(HttpClient.HttpClient, cassette.http),
        Layer.succeed(Cassette, cassette),
      ),
    ),
  );

/** A scenario chooses its mode through Config while retaining the same provider and assertions. */
export const configured = (
  options: Paid & {
    readonly exchanges: ReadonlyArray<Exchange>;
    readonly append: (exchange: Exchange) => Effect.Effect<void, ScriptError>;
    readonly recordCommand: string;
  },
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const mode = yield* Config.String("EFFECT_BROWSER_TEST_MODEL_MODE").pipe(
        Config.withDefault("replay"),
      );

      if (mode !== "replay" && mode !== "record" && mode !== "live")
        return yield* problem("EFFECT_BROWSER_TEST_MODEL_MODE must be replay, record, or live");

      return layer({ ...options, mode });
    }),
  );
