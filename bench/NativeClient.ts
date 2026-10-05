/**
 * Parent-owned Responses transport. The same account used by the planner settles the raw receipt
 * before a native action decoder can fail. Worker routing and pricing fields are never trusted.
 */
import { Config, Effect, Redacted, Schema, Stream } from "effect";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as Native from "./Native.ts";
import type { Account } from "./run.ts";

export const maxResponseBytes = 2 * 1024 * 1024;
export const requestTimeoutMillis = 600_000;

export interface Options {
  readonly account: Account;
  readonly model: string;
  readonly reasoning: Native.Options["reasoning"];
  readonly maxOutputTokens: number;
  readonly bounds: {
    readonly rates: { readonly input: number; readonly output: number };
    readonly provider: string;
    readonly outputParameter?: "max_tokens" | "max_completion_tokens";
  };
}

const Positive = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));

const Settings = Schema.Struct({
  model: Native.RequestSchema.fields.model,
  reasoning: Native.RequestSchema.fields.reasoning.fields.effort,
  maxOutputTokens: Native.RequestSchema.fields.max_output_tokens,
  provider: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  inputRate: Positive,
  outputRate: Positive,
});

const Receipt = Schema.Struct({
  input_tokens: Count,
  output_tokens: Count,
  input_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        cached_tokens: Schema.optional(Schema.NullOr(Count)),
        image_tokens: Schema.optional(Schema.NullOr(Count)),
      }),
    ),
  ),
  output_tokens_details: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        reasoning_tokens: Schema.optional(Schema.NullOr(Count)),
      }),
    ),
  ),
  cost: Schema.optional(Schema.NullOr(Positive)),
});

const Billed = Schema.Struct({ usage: Receipt });
const decodeBill = Schema.decodeUnknownOption(Billed);
const fail = (code: Native.Code) => new Native.NativeError({ code });

const receipt = (reply: { readonly status: number; readonly body: unknown }) => {
  if (reply.status < 200 || reply.status >= 300) return undefined;
  const parsed = decodeBill(reply.body);

  if (parsed._tag === "None") return undefined;
  const usage = parsed.value.usage;
  const cached = usage.input_tokens_details?.cached_tokens;
  const image = usage.input_tokens_details?.image_tokens;
  const reasoning = usage.output_tokens_details?.reasoning_tokens;

  if (
    (cached !== undefined && cached !== null && cached > usage.input_tokens) ||
    (image !== undefined && image !== null && image > usage.input_tokens) ||
    (reasoning !== undefined && reasoning !== null && reasoning > usage.output_tokens)
  )
    return undefined;

  return {
    prompt_tokens: usage.input_tokens,
    completion_tokens: usage.output_tokens,
    prompt_tokens_details: {
      ...(cached === undefined ? {} : { cached_tokens: cached }),
      ...(image === undefined ? {} : { image_tokens: image }),
    },
    completion_tokens_details: reasoning === undefined ? {} : { reasoning_tokens: reasoning },
    ...(usage.cost === undefined ? {} : { cost: usage.cost }),
  };
};

/** Supply HttpClient for an in-memory test; makeLive installs the real fetch-backed client. */
export const make = Effect.fnUntraced(function* (options: Options) {
  const settings = yield* Schema.decodeEffect(Settings)({
    model: options.model,
    reasoning: options.reasoning,
    maxOutputTokens: options.maxOutputTokens,
    provider: options.bounds.provider,
    inputRate: options.bounds.rates.input,
    outputRate: options.bounds.rates.output,
  }).pipe(Effect.mapError(() => fail("InvalidOptions")));

  if (!Number.isFinite(settings.inputRate * 1e6) || !Number.isFinite(settings.outputRate * 1e6))
    return yield* fail("InvalidOptions");

  const key = yield* Config.Redacted("OPENROUTER_API_KEY").pipe(
    Effect.mapError(() => fail("InvalidOptions")),
  );

  if (Redacted.value(key).length === 0) return yield* fail("InvalidOptions");
  const client = yield* HttpClient.HttpClient;

  return Effect.fnUntraced(function* (
    raw: Native.Request,
  ): Effect.fn.Return<Native.Reply, Native.NativeError> {
    const request = yield* Schema.decodeEffect(Native.RequestSchema, {
      onExcessProperty: "error",
    })(raw).pipe(Effect.mapError(() => fail("InvalidOptions")));

    // Select fields explicitly; Responses always uses max_output_tokens, regardless of the
    // chat endpoint's advertised outputParameter used to select the shared reservation bound.
    const body = yield* Effect.try({
      try: () =>
        JSON.stringify({
          model: settings.model,
          store: false,
          include: ["reasoning.encrypted_content"],
          instructions: request.instructions,
          input: request.input,
          tools: [{ type: "computer" }],
          reasoning: { effort: settings.reasoning },
          max_output_tokens: settings.maxOutputTokens,
          service_tier: "default",
          plugins: [
            "web",
            "file-parser",
            "response-healing",
            "context-compression",
            "auto-router",
            "auto-beta-router",
            "pareto-router",
            "fusion",
          ].map((id) => ({ id, enabled: false })),
          provider: {
            only: [settings.provider],
            allow_fallbacks: false,
            require_parameters: true,
            max_price: {
              prompt: String(settings.inputRate * 1e6),
              completion: String(settings.outputRate * 1e6),
              request: "0",
              image: "0",
              audio: "0",
            },
          },
        }),
      catch: () => fail("InvalidOptions"),
    });

    if (Buffer.byteLength(body, "utf8") > Native.limits.historyBytes)
      return yield* fail("HistoryLimit");

    const outgoing = HttpClientRequest.post("https://openrouter.ai/api/v1/responses").pipe(
      HttpClientRequest.bearerToken(key),
      HttpClientRequest.bodyText(body, "application/json"),
    );

    const send = Effect.gen(function* () {
      const response = yield* client.execute(outgoing).pipe(
        Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
        Effect.mapError(() => fail("RequestUncertain")),
      );

      // A bounded private buffer is discarded after decoding. No headers, URLs or provider error
      // text enter NativeError or the accounting snapshots.
      const bytes = new Uint8Array(maxResponseBytes);
      let length = 0;

      yield* response.stream.pipe(
        Stream.mapError(() => fail("RequestUncertain")),
        Stream.runForEach((chunk) =>
          Effect.suspend(() => {
            if (length + chunk.length > maxResponseBytes)
              return Effect.fail(fail("ResponseEnvelopeInvalid"));
            bytes.set(chunk, length);
            length += chunk.length;

            return Effect.void;
          }),
        ),
      );
      // Non-success responses cannot establish a usable receipt. Keep the dispatched reservation.
      if (response.status < 200 || response.status >= 300)
        return { status: response.status, body: undefined };

      const text = yield* Effect.try({
        try: () => new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, length)),
        catch: () => fail("ResponseEnvelopeInvalid"),
      });

      const value = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Unknown))(text).pipe(
        Effect.mapError(() => fail("ResponseEnvelopeInvalid")),
      );

      return { status: response.status, body: value };
    }).pipe(
      Effect.timeoutOrElse({
        duration: requestTimeoutMillis,
        orElse: () => Effect.fail(fail("RequestUncertain")),
      }),
    );

    const reply = yield* options.account
      .run(send, receipt)
      .pipe(
        Effect.mapError((error) =>
          error._tag === "BenchError" ? fail("AdmissionStopped") : error,
        ),
      );

    if (reply.status < 200 || reply.status >= 300) return yield* fail("NativeRouteRejected");
    const accounted = yield* options.account.snapshot;

    // A caller must never receive an actionable body whose cost still holds an uncertain reserve.
    if (accounted.uncertainCalls > 0) return yield* fail("UnpricedResponse");
    const billed = receipt(reply);

    if (billed === undefined) return yield* fail("UnpricedResponse");

    return {
      status: reply.status,
      body: reply.body,
      usage: {
        inputTokens: billed.prompt_tokens,
        outputTokens: billed.completion_tokens,
        cachedInputTokens: billed.prompt_tokens_details.cached_tokens ?? 0,
      },
    };
  });
});

export const makeLive = (options: Options) =>
  make(options).pipe(Effect.provide(FetchHttpClient.layer));
