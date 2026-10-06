// Runs the free scripted bench by default. Paid model/provider runs need the explicit opt-ins below.
// Each trial owns its browser, random seed and accounting; only the admission budget is shared.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import {
  Cause,
  Clock,
  Config,
  Console,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  Schema,
} from "effect";
import type * as Agent from "effect-browser/Agent";
import type { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { AiError, type LanguageModel } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as Diagnostics from "./Diagnostics.ts";
import { type Task, tasks } from "./Tasks.ts";

const help = `Usage: bun run bench -- [options]

  --task <name>         Run this task; repeat for more. Defaults to all:
                        ${tasks.map((task) => task.name).join(", ")}
  --trials <n>          Trials per task. Defaults to 1.
  --concurrency <n>     Independent trials in flight. Defaults to 4.
  --seed <integer>      Base seed for reproducible page data. Defaults to 1.
  --model <id>          OpenRouter model; omit for the free scripted solutions.
  --reasoning <effort>  none, minimal, low, medium, high, xhigh or max.
                        Defaults to medium for operate and none for understand.
  --max-usd <amount>    Shared token/provider admission budget. Defaults to 2.
  --max-output-tokens <n>  Completion ceiling per call, including reasoning. Defaults to 4096.
  --rates <in,out>      Provider price ceilings in USD/million tokens; defaults to listed prices.
  --browser <name>      chromium (default) or browserbase.
  --humanize           Move the pointer and type at a human pace.
  --out <dir>          Results directory. Defaults to .work/bench in the repository.`;

/** A problem with how the bench was asked to run. */
class BenchError extends Schema.TaggedError<BenchError>()("BenchError", {
  message: Schema.String,
}) {}

const refuse = (message: string) => Effect.fail(new BenchError({ message }));

const flags = Effect.try({
  try: () =>
    parseArgs({
      options: {
        task: { type: "string", multiple: true },
        trials: { type: "string", default: "1" },
        concurrency: { type: "string", default: "4" },
        seed: { type: "string", default: "1" },
        model: { type: "string" },
        reasoning: { type: "string" },
        "max-usd": { type: "string", default: "2" },
        "max-output-tokens": { type: "string", default: "4096" },
        rates: { type: "string" },
        browser: { type: "string", default: "chromium" },
        humanize: { type: "boolean", default: false },
        out: { type: "string" },
        help: { type: "boolean", default: false },
      },
    }).values,
  catch: (error) =>
    new BenchError({
      message: `${error instanceof Error ? error.message : "bad flags"}\n\n${help}`,
    }),
});

const efforts = ["none", "minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type Reasoning = (typeof efforts)[number];

/** USD per token, also enforced as provider routing ceilings. */
interface Rates {
  readonly input: number;
  readonly output: number;
}

const Prices = Schema.Struct({
  prompt: Schema.FiniteFromString,
  completion: Schema.FiniteFromString,
  input_cache_read: Schema.optional(Schema.FiniteFromString),
  input_cache_write: Schema.optional(Schema.FiniteFromString),
  input_cache_write_1h: Schema.optional(Schema.FiniteFromString),
});

const Endpoints = Schema.Struct({
  data: Schema.Struct({
    endpoints: Schema.Array(
      Schema.Struct({
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
      }),
    ),
  }),
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

const noUsage: Agent.Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

interface RawUsage {
  readonly prompt_tokens: number;
  readonly completion_tokens: number;
  readonly prompt_tokens_details?: { readonly cached_tokens?: number | null } | null;
  readonly cost?: number | null;
}

/** Known charges remain distinct from upper bounds for requests whose bill is unknown. */
export interface Accounting {
  readonly calls: number;
  readonly usage: Agent.Usage;
  readonly knownUsd: number;
  readonly reservedUsd: number;
  readonly uncertainCalls: number;
}

const emptyAccounting: Accounting = {
  calls: 0,
  usage: noUsage,
  knownUsd: 0,
  reservedUsd: 0,
  uncertainCalls: 0,
};

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

        return {
          snapshot: Ref.get(account),
          lastResponse: Ref.get(lastResponse),
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
                  if (admission.denied)
                    return yield* refuse(`no call fits the remaining $${maxUsd} budget`);
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

                if (
                  usage.cost === undefined ||
                  usage.cost === null ||
                  !Number.isFinite(usage.cost) ||
                  usage.cost < 0
                ) {
                  yield* settle(undefined);
                  yield* remember();

                  return response;
                }

                const charged = Math.ceil(usage.cost * units);

                yield* settle(charged);
                yield* Ref.update(account, (value) => ({
                  ...value,
                  knownUsd: value.knownUsd + charged / units,
                  reservedUsd: Math.max(0, value.reservedUsd - reservation / units),
                  uncertainCalls: value.uncertainCalls - 1,
                }));

                yield* remember();

                if (charged > reservation)
                  return yield* refuse(
                    "provider charge exceeded its enforced price/token bounds; stopped",
                  );

                return response;
              }),
            ),
        };
      }),
    };
  });

export type Budget = Effect.Success<ReturnType<typeof ledger>>;
export type Account = Effect.Success<Budget["account"]>;

/** Keep the real OpenRouter LanguageModel path while charging its raw receipt before decoding. */
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
  ...client,
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
          // policy check before live runs, because OpenRouter can prevent request overrides.
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
              prompt: String(bounds.rates.input * 1e6),
              completion: String(bounds.rates.output * 1e6),
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

export const modelRunner = (options: {
  readonly model: string;
  readonly rates: string | undefined;
  readonly maxUsd: number;
  readonly maxOutputTokens: number;
}) =>
  Effect.gen(function* () {
    const endpoints = yield* listedEndpoints(options.model);
    const supplied = options.rates === undefined ? undefined : yield* givenRates(options.rates);

    const eligible = endpoints
      .flatMap((endpoint) => {
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
          output: Math.max(...prices.map((price) => price.completion)),
        };

        const outputParameter = endpoint.supported_parameters.includes("max_completion_tokens")
          ? ("max_completion_tokens" as const)
          : endpoint.supported_parameters.includes("max_tokens")
            ? ("max_tokens" as const)
            : undefined;

        if (
          endpoint.status !== 0 ||
          /\/(flex|fast|priority)$/.test(endpoint.tag) ||
          !Number.isSafeInteger(context) ||
          context <= 0 ||
          rates.input < 0 ||
          rates.output < 0 ||
          outputParameter === undefined ||
          (maximum !== undefined && maximum !== null && options.maxOutputTokens > maximum) ||
          (supplied !== undefined &&
            (supplied.input < rates.input || supplied.output < rates.output))
        )
          return [];

        // Price tiers and cache writes can exceed base pricing. Pin one endpoint and reserve its
        // highest published rates across the entire context, including text, tools and screenshots.
        return [
          {
            provider: endpoint.tag,
            rates,
            outputParameter,
            requestUsd: context * rates.input + options.maxOutputTokens * rates.output,
          },
        ];
      })
      .sort((left, right) => left.requestUsd - right.requestUsd);

    const bounds = eligible[0];

    if (bounds === undefined)
      return yield* refuse("no available endpoint has supported token/price bounds within --rates");

    const { requestUsd, rates } = bounds;
    const budget = yield* ledger(options.maxUsd, requestUsd);

    if (yield* budget.exhausted)
      return yield* refuse(
        `a call reserves $${requestUsd.toFixed(6)}, above --max-usd ${options.maxUsd}`,
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
            outputParameter: bounds.outputParameter,
            provider: bounds.provider,
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

    return {
      ...budget,
      withModel,
      run: (task: Task, seed: number, reasoning: Reasoning, account: Account) =>
        withModel(task.withModel({ seed, onUsage: () => Effect.void }), reasoning, account),
    };
  });

/** Derivation depends on task identity, never dispatch order or provider random draws. */
export const trialSeed = (base: number, task: string, trial: number): number => {
  let seed = 2166136261;

  for (const character of `${base}:${task}:${trial}`) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  }

  return seed;
};

/** A local memo map prevents parallel trials from sharing a scoped browser layer. */
export const isolatedTrial = <A, E, R, E2, R2>(
  trial: Effect.Effect<A, E, R | Browser>,
  browser: Layer.Layer<Browser, E2, R2>,
) => trial.pipe(Effect.provide(browser, { local: true }));

interface TrialRecord {
  readonly task: string;
  readonly kind: Task["kind"];
  readonly trial: number;
  readonly baseSeed: number;
  readonly seed: number;
  readonly startedAt: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly browser: string;
  readonly status: "completed" | "failed" | "skipped";
  readonly pass: boolean;
  readonly detail: string;
  readonly error: string | null;
  readonly diagnostic: Diagnostics.Failure | null;
  readonly lastResponse: Diagnostics.LastResponse | null;
  readonly answer: unknown;
  readonly steps: number;
  readonly usage: Agent.Usage | null;
  readonly usd: number | null;
  readonly knownUsd: number;
  readonly reservedUsd: number;
  readonly uncertainCalls: number;
  readonly seconds: number;
}

const errorText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  // Provider errors may embed connection URLs or session/account identifiers.
  if (Schema.is(BenchError)(error)) return error.message;
  if (Cause.hasInterruptsOnly(cause)) return "Interrupted";

  return error instanceof Error ? error.name : "Trial failed";
};

const write = (operation: () => void) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      new BenchError({
        message: `could not write bench results: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

const main = Effect.gen(function* () {
  const options = yield* flags;

  if (options.help) {
    yield* Console.log(help);

    return true;
  }

  const trials = Number(options.trials);
  const concurrency = Number(options.concurrency);
  const baseSeed = Number(options.seed);
  const maxUsd = Number(options["max-usd"]);
  const maxOutputTokens = Number(options["max-output-tokens"]);
  const names = options.task ?? tasks.map((task) => task.name);
  const unknown = names.filter((name) => !tasks.some((task) => task.name === name));
  const reasoning = efforts.find((effort) => effort === options.reasoning);
  const model = options.model;

  if (unknown.length > 0) return yield* refuse(`no task named ${unknown.join(", ")}\n\n${help}`);
  if (!Number.isSafeInteger(trials) || trials < 1)
    return yield* refuse("--trials must be a positive integer");
  if (!Number.isSafeInteger(concurrency) || concurrency < 1)
    return yield* refuse("--concurrency must be a positive integer");
  if (!Number.isSafeInteger(baseSeed)) return yield* refuse("--seed must be a safe integer");
  if (!Number.isFinite(maxUsd) || maxUsd <= 0)
    return yield* refuse("--max-usd must be finite and positive");
  if (!Number.isSafeInteger(maxOutputTokens) || maxOutputTokens < 16)
    return yield* refuse("--max-output-tokens must be an integer of at least 16");
  if (options.reasoning !== undefined && reasoning === undefined)
    return yield* refuse(`--reasoning must be one of ${efforts.join(", ")}`);
  if (options.browser !== "chromium" && options.browser !== "browserbase")
    return yield* refuse("--browser must be chromium or browserbase");
  if (model !== undefined && process.env.EFFECT_BROWSER_BENCH_LIVE !== "1")
    return yield* refuse("model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them");
  if (options.browser === "browserbase" && process.env.EFFECT_BROWSER_BENCH_HOSTED !== "1")
    return yield* refuse("Browserbase sessions cost money: set EFFECT_BROWSER_BENCH_HOSTED=1");

  const browser =
    options.browser === "browserbase"
      ? Browserbase.layer({
          humanize: options.humanize,
          frameHistory: 1200,
          session: { browserSettings: { viewport: { width: 1280, height: 720 } } },
        }).pipe(
          Layer.provide(BrowserbaseClient.layerConfig()),
          Layer.provide(FetchHttpClient.layer),
        )
      : Chromium.layer({ humanize: options.humanize, frameHistory: 1200 });

  const runner =
    model === undefined
      ? undefined
      : yield* modelRunner({ model, rates: options.rates, maxUsd, maxOutputTokens });

  const label = model?.replace(/[^\w.-]+/g, "_") ?? "scripted";
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const directory = options.out ?? fileURLToPath(new URL("../.work/bench/", import.meta.url));
  const file = join(directory, `${stamp}-${label}.jsonl`);

  const jobs = tasks
    .filter((candidate) => names.includes(candidate.name))
    .flatMap((task) => Array.from({ length: trials }, (_, index) => ({ task, trial: index + 1 })));

  yield* write(() => mkdirSync(directory, { recursive: true }));

  const records = yield* Effect.forEach(
    jobs,
    ({ task, trial }) =>
      Effect.gen(function* () {
        // Skips are durable results too, but must not provision another browser.
        const skipped = runner !== undefined && (yield* runner.exhausted);
        const seed = trialSeed(baseSeed, task.name, trial);
        const effectiveReasoning = reasoning ?? (task.kind === "operate" ? "medium" : "none");
        const started = yield* DateTime.now;
        const startedNanos = yield* Clock.monotonicTimeNanos;
        const account = skipped || runner === undefined ? undefined : yield* runner.account;

        const work =
          runner !== undefined && account !== undefined
            ? runner.run(task, seed, effectiveReasoning, account)
            : task.scripted({ seed });

        const exit = skipped
          ? undefined
          : yield* isolatedTrial(work, browser).pipe(
              Effect.timeout(Duration.minutes(10)),
              Effect.exit,
            );

        const seconds = skipped
          ? 0
          : Number((yield* Clock.monotonicTimeNanos) - startedNanos) / 1e9;

        const outcome = exit !== undefined && Exit.isSuccess(exit) ? exit.value : undefined;
        const accounting = account === undefined ? emptyAccounting : yield* account.snapshot;

        const record: TrialRecord = {
          task: task.name,
          kind: task.kind,
          trial,
          baseSeed,
          seed,
          startedAt: DateTime.formatIso(started),
          model: model ?? null,
          reasoning: model === undefined ? null : effectiveReasoning,
          browser: options.browser,
          status: skipped ? "skipped" : outcome?.pass === true ? "completed" : "failed",
          pass: outcome?.pass ?? false,
          detail: skipped
            ? "Skipped: the remaining model budget cannot reserve another call."
            : (outcome?.detail ?? ""),
          error: exit !== undefined && Exit.isFailure(exit) ? errorText(exit.cause) : null,
          diagnostic:
            exit !== undefined && Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null,
          lastResponse: account === undefined ? null : yield* account.lastResponse,
          answer: outcome?.answer ?? null,
          steps: accounting.calls,
          usage: model === undefined ? null : accounting.usage,
          usd: accounting.uncertainCalls === 0 ? accounting.knownUsd : null,
          knownUsd: accounting.knownUsd,
          reservedUsd: accounting.reservedUsd,
          uncertainCalls: accounting.uncertainCalls,
          seconds,
        };

        yield* write(() => appendFileSync(file, `${JSON.stringify(record)}\n`));
        yield* Console.log(
          `${task.name.padEnd(14)} #${trial}  ${record.status === "skipped" ? "SKIP" : record.pass ? "pass" : "FAIL"}  ${seconds.toFixed(1)}s  ${record.steps} calls  $${record.knownUsd.toFixed(4)} known + $${record.reservedUsd.toFixed(4)} unresolved  ${record.error ?? record.detail}`,
        );

        return record;
      }),
    { concurrency },
  );

  const skipped = records.filter((record) => record.status === "skipped").length;
  const passed = records.filter((record) => record.pass).length;

  const accounting =
    runner === undefined ? { knownUsd: 0, reservedUsd: 0 } : yield* runner.snapshot;

  yield* Console.log(
    `\n${passed} of ${records.length} scheduled trials passed; ${records.length - skipped} attempted, ${skipped} skipped; $${accounting.knownUsd.toFixed(4)} known + $${accounting.reservedUsd.toFixed(4)} unresolved of $${maxUsd}; results in ${file}`,
  );

  // A failing scripted solution is a broken bench; a failing model is a result.
  return model !== undefined || passed === records.length;
});

// Run only from the command line, so free tests can import the budget and trial boundary.
if (import.meta.main) {
  const interrupt = new AbortController();

  process.once("SIGINT", () => interrupt.abort());

  const exit = await Effect.runPromiseExit(main, { signal: interrupt.signal });

  if (Exit.isFailure(exit)) {
    if (!Cause.hasInterruptsOnly(exit.cause)) console.error(errorText(exit.cause));
    process.exitCode = 1;
  } else if (!exit.value) {
    process.exitCode = 1;
  }
}
