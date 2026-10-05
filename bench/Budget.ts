// Paid model calls for both runners: one admission ledger, the budgeted OpenRouter client and the
// pinned endpoint whose bounds every reservation uses.
import { Generated, OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Config, Deferred, Effect, Exit, Layer, Option, Ref, Schema } from "effect";
import type * as Agent from "effect-browser/Agent";
import { AiError, type LanguageModel } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientError, HttpClientResponse } from "effect/http";

import * as Diagnostics from "./Diagnostics.ts";

/** A problem with how the bench was asked to run, or a call the budget refused. */
export class BenchError extends Schema.TaggedError<BenchError>()("BenchError", {
  message: Schema.String,
}) {}

export const refuse = (message: string) => Effect.fail(new BenchError({ message }));

export const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Reasoning = (typeof efforts)[number];

/** USD per token, also enforced as provider routing ceilings. */
export interface Rates {
  readonly input: number;
  readonly output: number;
}

const Prices = Schema.Struct({
  prompt: Schema.FiniteFromString,
  completion: Schema.FiniteFromString,
  input_cache_read: Schema.optional(Schema.FiniteFromString),
  input_cache_write: Schema.optional(Schema.FiniteFromString),
  input_cache_write_1h: Schema.optional(Schema.FiniteFromString),
  internal_reasoning: Schema.optional(Schema.FiniteFromString),
  request: Schema.optional(Schema.FiniteFromString),
  image: Schema.optional(Schema.FiniteFromString),
  audio: Schema.optional(Schema.FiniteFromString),
});

export const ListedEndpoint = Schema.Struct({
  tag: Schema.String,
  status: Schema.Finite,
  context_length: Schema.Finite,
  max_prompt_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  max_completion_tokens: Schema.optional(Schema.NullOr(Schema.Finite)),
  supported_parameters: Schema.Array(Schema.String),
  pricing: Schema.Struct({
    ...Prices.fields,
    overrides: Schema.optional(Schema.Array(Prices)),
  }),
});

export type ListedEndpoint = typeof ListedEndpoint.Type;

const Endpoints = Schema.Struct({
  data: Schema.Struct({ endpoints: Schema.Array(ListedEndpoint) }),
});

const listedEndpoints = (model: string) =>
  HttpClient.get(
    `https://openrouter.ai/api/v1/models/${model.split("/").map(encodeURIComponent).join("/")}/endpoints`,
  ).pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(Endpoints)),
    Effect.mapError(() => new BenchError({ message: "could not read OpenRouter endpoint bounds" })),
    Effect.map(({ data }) => data.endpoints),
    Effect.provide(FetchHttpClient.layer),
  );

const givenRates = (text: string) => {
  const [input, output, ...rest] = text.split(",").map(Number);

  return input !== undefined &&
    output !== undefined &&
    rest.length === 0 &&
    Number.isFinite(input) &&
    Number.isFinite(output) &&
    input >= 0 &&
    output >= 0
    ? Effect.succeed<Rates>({ input: input / 1e6, output: output / 1e6 })
    : refuse("--rates takes two finite non-negative numbers, such as 3,15");
};

interface RawUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number | null } | null;
  readonly cost?: number | null;
  readonly is_byok?: boolean;
  readonly cost_details?: { readonly upstream_inference_cost?: number | null } | null;
}

const Charge = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));

// With the caller's own provider key (BYOK), `cost` is only OpenRouter's fee: the provider bills
// the upstream inference separately, and only `upstream_inference_cost` reports it.
const Billed = Schema.Union([
  Schema.Struct({
    is_byok: Schema.Literal(true),
    cost: Charge,
    cost_details: Schema.Struct({ upstream_inference_cost: Charge }),
  }),
  Schema.Struct({ is_byok: Schema.optional(Schema.Literal(false)), cost: Charge }),
]);

/** USD a receipt establishes, or undefined when it does not show the whole charge. */
export const chargeOf = (usage: RawUsage): number | undefined =>
  Option.getOrUndefined(
    Option.map(Schema.decodeUnknownOption(Billed)(usage), (billed) =>
      "cost_details" in billed
        ? billed.cost + billed.cost_details.upstream_inference_cost
        : billed.cost,
    ),
  );

/** Known charges remain distinct from upper bounds for requests whose bill is unknown. */
export interface Accounting {
  readonly calls: number;
  readonly usage: Agent.Usage;
  readonly knownUsd: number;
  readonly reservedUsd: number;
  readonly uncertainCalls: number;
}

export const emptyAccounting: Accounting = {
  calls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  knownUsd: 0,
  reservedUsd: 0,
  uncertainCalls: 0,
};

/**
 * Why the ledger stopped one of an account's calls: `budget` refused admission before dispatch;
 * `bound` withheld a response whose charge exceeded its reservation.
 */
export type Refusal = "budget" | "bound";

/** What classifying one unit of work needs to know about its calls. */
export interface Calls {
  readonly accounting: Accounting;
  readonly lastResponse: Diagnostics.LastResponse | null;
  readonly refusal: Refusal | null;
}

export const noCalls: Calls = { accounting: emptyAccounting, lastResponse: null, refusal: null };

// Integer nanodollars round reservations up and the limit down. Floating subtraction must never
// admit one extra request at the shared boundary.
const units = 1e9;

/** Admission is atomic; failed, interrupted and unpriced responses keep their reservations. */
export const ledger = (maxUsd: number, requestUsd: number) =>
  Effect.gen(function* () {
    const limit = Math.floor(maxUsd * units);
    const reservation = Math.ceil(requestUsd * units);

    if (
      !Number.isSafeInteger(limit) ||
      !Number.isSafeInteger(reservation) ||
      limit <= 0 ||
      reservation < 0
    )
      return yield* refuse("the budget and request bounds must be finite non-negative amounts");

    const changed = yield* Deferred.make<void>();
    const state = yield* Ref.make({ known: 0, reserved: 0, active: 0, blocked: false, changed });

    const settle = (charged: number | undefined) =>
      Effect.gen(function* () {
        const next = yield* Deferred.make<void>();

        const previous = yield* Ref.modify(state, (value) => [
          value.changed,
          {
            known: value.known + (charged ?? 0),
            reserved: value.reserved - (charged === undefined ? 0 : reservation),
            active: value.active - reservation,
            blocked: value.blocked || (charged !== undefined && charged > reservation),
            changed: next,
          },
        ]);

        yield* Deferred.succeed(previous, undefined);
      });

    return {
      // Stop only future admission; dispatched calls still own and settle their reservations.
      stop: Effect.gen(function* () {
        const next = yield* Deferred.make<void>();

        const previous = yield* Ref.modify(state, (value) => [
          value.changed,
          { ...value, blocked: true, changed: next },
        ]);

        yield* Deferred.succeed(previous, undefined);
      }),
      snapshot: Ref.get(state).pipe(
        Effect.map((value) => ({
          knownUsd: value.known / units,
          reservedUsd: value.reserved / units,
        })),
      ),
      exhausted: Ref.get(state).pipe(
        Effect.map(
          (value) =>
            value.blocked || value.known + value.reserved - value.active + reservation > limit,
        ),
      ),
      account: Effect.gen(function* () {
        const account = yield* Ref.make(emptyAccounting);
        const lastResponse = yield* Ref.make<Diagnostics.LastResponse | null>(null);
        const refusal = yield* Ref.make<Refusal | null>(null);

        return {
          snapshot: Ref.get(account),
          lastResponse: Ref.get(lastResponse),
          calls: Effect.all({
            accounting: Ref.get(account),
            lastResponse: Ref.get(lastResponse),
            refusal: Ref.get(refusal),
          }),
          run: <A, E, R>(
            request: Effect.Effect<A, E, R>,
            usageOf: (response: A) => RawUsage | undefined,
            receiptOf?: (response: A) => Diagnostics.Receipt,
          ): Effect.Effect<A, E | BenchError, R> =>
            Effect.uninterruptibleMask((restore) =>
              Effect.gen(function* () {
                // A pending receipt may release enough capacity. Permanent uncertainty may not.
                while (true) {
                  const admission = yield* Ref.modify(state, (value) => {
                    const fits =
                      !value.blocked && value.known + value.reserved + reservation <= limit;

                    return [
                      {
                        fits,
                        denied:
                          value.blocked ||
                          value.known + value.reserved - value.active + reservation > limit,
                        changed: value.changed,
                      },
                      fits
                        ? {
                            ...value,
                            reserved: value.reserved + reservation,
                            active: value.active + reservation,
                          }
                        : value,
                    ];
                  });

                  if (admission.fits) break;
                  if (admission.denied) {
                    yield* Ref.set(refusal, "budget");

                    return yield* refuse(`no call fits the remaining $${maxUsd} budget`);
                  }
                  yield* restore(Deferred.await(admission.changed));
                }

                const dispatched = yield* Ref.updateAndGet(account, (value) => ({
                  ...value,
                  calls: value.calls + 1,
                  reservedUsd: value.reservedUsd + reservation / units,
                  uncertainCalls: value.uncertainCalls + 1,
                }));

                yield* Ref.set(lastResponse, null);

                // Only the provider request is interruptible. Once a receipt arrives, account for
                // it before any tool, answer decoder, or caller interruption can discard it.
                const response = yield* restore(request).pipe(
                  Effect.onExit((exit) => (Exit.isFailure(exit) ? settle(undefined) : Effect.void)),
                );

                const usage = usageOf(response);

                const remember = () =>
                  receiptOf === undefined
                    ? Effect.void
                    : Ref.set(lastResponse, { call: dispatched.calls, ...receiptOf(response) });

                if (usage === undefined) {
                  yield* settle(undefined);
                  yield* remember();

                  return response;
                }

                yield* Ref.update(account, (value) => ({
                  ...value,
                  usage: {
                    inputTokens: value.usage.inputTokens + usage.prompt_tokens,
                    outputTokens: value.usage.outputTokens + usage.completion_tokens,
                    cachedInputTokens:
                      value.usage.cachedInputTokens +
                      (usage.prompt_tokens_details?.cached_tokens ?? 0),
                  },
                }));

                const billed = chargeOf(usage);

                if (billed === undefined) {
                  yield* settle(undefined);
                  yield* remember();

                  return response;
                }

                const charged = Math.ceil(billed * units);

                yield* settle(charged);
                yield* Ref.update(account, (value) => ({
                  ...value,
                  knownUsd: value.knownUsd + charged / units,
                  reservedUsd: Math.max(0, value.reservedUsd - reservation / units),
                  uncertainCalls: value.uncertainCalls - 1,
                }));

                yield* remember();

                if (charged > reservation) {
                  yield* Ref.set(refusal, "bound");

                  return yield* refuse(
                    "provider charge exceeded its enforced price/token bounds; stopped",
                  );
                }

                return response;
              }),
            ),
        };
      }),
    };
  });

export type Budget = Effect.Success<ReturnType<typeof ledger>>;
export type Account = Effect.Success<Budget["account"]>;

// Listed prices are decimal strings; 0.0000002 * 1e6 is 0.19999999999999998, a ceiling below the
// listed $0.20 that would exclude the pinned endpoint. Fifteen digits recover the decimal.
const perMillion = (perToken: number) => String(Number((perToken * 1e6).toPrecision(15)));

const unbudgeted = "the bench budgets only non-streaming chat completions";

const refused = (method: string) =>
  Effect.fail(
    AiError.make({
      module: "bench",
      method,
      reason: new AiError.InvalidRequestError({ description: unbudgeted }),
    }),
  );

// The generated client reaches every paid endpoint; this one fails each request before sending it.
const refusingClient = Generated.make(
  HttpClient.make((request) =>
    Effect.fail(
      new HttpClientError.HttpClientError({
        reason: new HttpClientError.TransportError({ request, description: unbudgeted }),
      }),
    ),
  ),
);

/**
 * Keep the real OpenRouter LanguageModel path while charging its raw receipt before decoding.
 * Streaming, decisions and the raw generated client have no admission, so they are refused.
 */
export const budgetedClient = (
  client: OpenRouterClient.Service,
  account: Account,
  bounds: {
    readonly rates: Rates;
    readonly maxOutputTokens: number;
    readonly outputParameter?: "max_tokens" | "max_completion_tokens";
    readonly provider?: string;
  },
): OpenRouterClient.Service => ({
  client: refusingClient,
  createDecisions: () => refused("createDecisions"),
  createChatCompletionStream: () => refused("createChatCompletionStream"),
  createChatCompletion: (request) =>
    account
      .run(
        client.createChatCompletion({
          ...request,
          ...(bounds.outputParameter === "max_completion_tokens"
            ? { max_completion_tokens: bounds.maxOutputTokens }
            : { max_tokens: bounds.maxOutputTokens }),
          service_tier: "default",
          modalities: ["text"],
          // Omission inherits account defaults. Enforced account plugins still need an external
          // policy check before live runs, because OpenRouter can prevent request overrides. The
          // request schema cannot disable web-fetch or moderation; the README says so.
          plugins: [
            { id: "web", enabled: false },
            { id: "file-parser", enabled: false },
            { id: "response-healing", enabled: false },
            { id: "context-compression", enabled: false },
            { id: "auto-router", enabled: false },
            { id: "auto-beta-router", enabled: false },
            { id: "pareto-router", enabled: false },
            { id: "fusion", enabled: false },
          ],
          provider: {
            ...(bounds.provider === undefined ? {} : { only: [bounds.provider] }),
            allow_fallbacks: false,
            require_parameters: true,
            max_price: {
              prompt: perMillion(bounds.rates.input),
              completion: perMillion(bounds.rates.output),
              request: "0",
              image: "0",
              audio: "0",
            },
          },
        }),
        ([response]) => response.usage,
        Diagnostics.receipt,
      )
      .pipe(
        Effect.mapError((error) =>
          error._tag === "BenchError"
            ? AiError.make({
                module: "bench",
                method: "createChatCompletion",
                reason: new AiError.InvalidRequestError({ description: error.message }),
              })
            : error,
        ),
      ),
});

/** What a run's requests need from the pinned endpoint. */
export interface Needs {
  /** Operate tasks send tools and a tool choice. */
  readonly tools: boolean;
  /** Understand tasks send a JSON schema response format. */
  readonly structuredOutput: boolean;
}

/** The pinned endpoint and the bounds each call reserves, recorded with every result. */
export interface Endpoint {
  readonly tag: string;
  readonly contextTokens: number;
  readonly outputParameter: "max_tokens" | "max_completion_tokens";
  /** USD per million tokens: the reservation's rates and the request's price ceilings. */
  readonly inputPerMillion: number;
  readonly outputPerMillion: number;
  readonly requestUsd: number;
}

/**
 * Endpoints that can serve every parameter a request sends, under its price ceilings, cheapest
 * reservation first. `require_parameters` and a pinned endpoint make OpenRouter refuse any
 * other, after a reservation was already taken for it.
 */
export const eligibleEndpoints = (
  endpoints: ReadonlyArray<ListedEndpoint>,
  options: {
    readonly maxOutputTokens: number;
    readonly needs: Needs;
    readonly supplied?: Rates | undefined;
  },
): ReadonlyArray<Endpoint> => {
  // Every request carries a reasoning effort, even `none`.
  const required = [
    "reasoning",
    ...(options.needs.tools ? ["tools", "tool_choice"] : []),
    ...(options.needs.structuredOutput ? ["response_format", "structured_outputs"] : []),
  ];

  return endpoints
    .flatMap((endpoint): ReadonlyArray<Endpoint> => {
      const maximum = endpoint.max_completion_tokens;
      const context = endpoint.max_prompt_tokens ?? endpoint.context_length;
      const prices = [endpoint.pricing, ...(endpoint.pricing.overrides ?? [])];

      const rates = {
        input: Math.max(
          ...prices.flatMap((price) => [
            price.prompt,
            price.input_cache_read ?? 0,
            price.input_cache_write ?? 0,
            price.input_cache_write_1h ?? 0,
          ]),
        ),
        output: Math.max(
          ...prices.flatMap((price) => [price.completion, price.internal_reasoning ?? 0]),
        ),
      };

      const outputParameter = endpoint.supported_parameters.includes("max_completion_tokens")
        ? ("max_completion_tokens" as const)
        : endpoint.supported_parameters.includes("max_tokens")
          ? ("max_tokens" as const)
          : undefined;

      // The request's max_price allows no per-request, image or audio charge.
      const unbounded = prices.some(
        (price) => (price.request ?? 0) > 0 || (price.image ?? 0) > 0 || (price.audio ?? 0) > 0,
      );

      if (
        endpoint.status !== 0 ||
        /\/(flex|fast|priority)$/.test(endpoint.tag) ||
        !Number.isSafeInteger(context) ||
        context <= 0 ||
        rates.input < 0 ||
        rates.output < 0 ||
        unbounded ||
        outputParameter === undefined ||
        !required.every((parameter) => endpoint.supported_parameters.includes(parameter)) ||
        (maximum !== undefined && maximum !== null && options.maxOutputTokens > maximum) ||
        (options.supplied !== undefined &&
          (options.supplied.input < rates.input || options.supplied.output < rates.output))
      )
        return [];

      // Price tiers and cache writes can exceed base pricing. Pin one endpoint and reserve its
      // highest published rates across the entire context, including text, tools and screenshots.
      return [
        {
          tag: endpoint.tag,
          contextTokens: context,
          outputParameter,
          inputPerMillion: Number(perMillion(rates.input)),
          outputPerMillion: Number(perMillion(rates.output)),
          requestUsd: context * rates.input + options.maxOutputTokens * rates.output,
        },
      ];
    })
    .toSorted((left, right) => left.requestUsd - right.requestUsd);
};

export const modelRunner = (options: {
  readonly model: string;
  readonly rates: string | undefined;
  readonly maxUsd: number;
  readonly maxOutputTokens: number;
  readonly needs: Needs;
}) =>
  Effect.gen(function* () {
    const endpoints = yield* listedEndpoints(options.model);
    const supplied = options.rates === undefined ? undefined : yield* givenRates(options.rates);

    const endpoint = eligibleEndpoints(endpoints, {
      maxOutputTokens: options.maxOutputTokens,
      needs: options.needs,
      supplied,
    })[0];

    if (endpoint === undefined)
      return yield* refuse(
        "no available endpoint supports every request parameter within its token/price bounds",
      );

    const rates: Rates = {
      input: endpoint.inputPerMillion / 1e6,
      output: endpoint.outputPerMillion / 1e6,
    };

    const budget = yield* ledger(options.maxUsd, endpoint.requestUsd);

    if (yield* budget.exhausted)
      return yield* refuse(
        `a call reserves $${endpoint.requestUsd.toFixed(6)}, above --max-usd ${options.maxUsd}`,
      );

    const withModel = <A, E, R>(
      effect: Effect.Effect<A, E, R | LanguageModel.LanguageModel>,
      reasoning: Reasoning,
      account: Account,
    ) => {
      const client = Layer.effect(
        OpenRouterClient.OpenRouterClient,
        Effect.map(OpenRouterClient.OpenRouterClient, (native) =>
          budgetedClient(native, account, {
            rates,
            maxOutputTokens: options.maxOutputTokens,
            outputParameter: endpoint.outputParameter,
            provider: endpoint.tag,
          }),
        ),
      ).pipe(
        Layer.provide(
          OpenRouterClient.layerConfig({ apiKey: Config.Redacted("OPENROUTER_API_KEY") }),
        ),
        Layer.provide(FetchHttpClient.layer),
      );

      const languageModel = OpenRouterLanguageModel.layer({
        model: options.model,
        config: { reasoning: { effort: reasoning } },
      }).pipe(Layer.provide(client));

      return effect.pipe(Effect.provide(languageModel));
    };

    return { ...budget, endpoint, withModel };
  });

export type ModelRunner = Effect.Success<ReturnType<typeof modelRunner>>;
