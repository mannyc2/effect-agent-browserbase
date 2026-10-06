// Runs the bench. From bench/: `bun run bench -- --help`.
//
// Without --model, each task runs its scripted solution, a free check of the pages, the grading and
// the browser. With --model, an OpenRouter model does the tasks. That costs money, so it needs
// EFFECT_BROWSER_BENCH_LIVE=1, and the run stops once it has spent --max-usd. --browser browserbase
// gives every trial a new Browserbase session, which costs money too, and needs
// EFFECT_BROWSER_BENCH_HOSTED=1. Each trial is one line of a JSON Lines file.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import {
  Cause,
  Config,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  Schema,
} from "effect";
import type * as Agent from "effect-browser/Agent";
import * as Chromium from "effect-browser/Chromium";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import { type Task, tasks } from "./Tasks.ts";

const help = `Usage: bun run bench -- [options]

  --task <name>         Run this task; repeat for more. Defaults to all:
                        ${tasks.map((task) => task.name).join(", ")}
  --trials <n>          Trials per task. Defaults to 1.
  --model <id>          An OpenRouter model id. Without one, the scripted solutions run.
  --reasoning <effort>  none, minimal, low, medium, high, xhigh or max. Defaults to the model's.
  --max-usd <amount>    Stop once model calls have cost this much. Defaults to 2.
  --rates <in,out>      USD per million input and output tokens. Defaults to OpenRouter's prices.
  --browser <name>      chromium (the default) or browserbase.
  --humanize            Move the pointer and type at a human pace.
  --out <dir>           Where results go. Defaults to .work/bench in the repository.`;

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
        model: { type: "string" },
        reasoning: { type: "string" },
        "max-usd": { type: "string", default: "2" },
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

/** USD per token. */
export interface Rates {
  readonly input: number;
  readonly cachedInput: number;
  readonly output: number;
}

const ListedModels = Schema.Struct({
  data: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      pricing: Schema.Struct({
        prompt: Schema.FiniteFromString,
        completion: Schema.FiniteFromString,
        input_cache_read: Schema.optional(Schema.FiniteFromString),
      }),
    }),
  ),
});

/** The model's prices, from OpenRouter's public model list. */
const listedRates = (model: string) =>
  HttpClient.get("https://openrouter.ai/api/v1/models").pipe(
    Effect.flatMap(HttpClientResponse.schemaBodyJson(ListedModels)),
    Effect.orElseSucceed(() => ({ data: [] })),
    Effect.flatMap(({ data }) => {
      const pricing = data.find((listed) => listed.id === model)?.pricing;

      return pricing === undefined
        ? refuse(`found no OpenRouter price for ${model}: pass --rates`)
        : Effect.succeed<Rates>({
            input: pricing.prompt,
            cachedInput: pricing.input_cache_read ?? pricing.prompt,
            output: pricing.completion,
          });
    }),
    Effect.provide(FetchHttpClient.layer),
  );

const givenRates = (text: string) => {
  const [input, output, ...rest] = text.split(",").map(Number);

  return input !== undefined &&
    output !== undefined &&
    rest.length === 0 &&
    input >= 0 &&
    output >= 0
    ? Effect.succeed<Rates>({ input: input / 1e6, cachedInput: input / 1e6, output: output / 1e6 })
    : refuse("--rates takes two numbers, such as 3,15");
};

const costOf = (rates: Rates, usage: Agent.Usage) =>
  (usage.inputTokens - usage.cachedInputTokens) * rates.input +
  usage.cachedInputTokens * rates.cachedInput +
  usage.outputTokens * rates.output;

/** Counts what model calls cost. Charging the call that reaches `maxUsd` fails, which stops the task. */
export const ledger = (rates: Rates, maxUsd: number) =>
  Effect.gen(function* () {
    const spent = yield* Ref.make(0);

    return {
      spent: Ref.get(spent),
      exhausted: Ref.get(spent).pipe(Effect.map((total) => total >= maxUsd)),
      run: (task: Task) =>
        task.withModel({
          onUsage: (usage) =>
            Ref.updateAndGet(spent, (total) => total + costOf(rates, usage)).pipe(
              Effect.flatMap((total) =>
                total >= maxUsd ? refuse(`stopped at the $${maxUsd} budget`) : Effect.void,
              ),
            ),
        }),
    };
  });

/** Trials of the model through OpenRouter, within the budget. */
const modelRunner = (options: {
  readonly model: string;
  readonly reasoning: (typeof efforts)[number] | undefined;
  readonly rates: string | undefined;
  readonly maxUsd: number;
}) =>
  Effect.gen(function* () {
    const rates = yield* options.rates === undefined
      ? listedRates(options.model)
      : givenRates(options.rates);

    const budget = yield* ledger(rates, options.maxUsd);

    const languageModel = OpenRouterLanguageModel.layer({
      model: options.model,
      config: options.reasoning === undefined ? {} : { reasoning: { effort: options.reasoning } },
    }).pipe(
      Layer.provide(
        OpenRouterClient.layerConfig({ apiKey: Config.Redacted("OPENROUTER_API_KEY") }),
      ),
      Layer.provide(FetchHttpClient.layer),
    );

    return { ...budget, run: (task: Task) => budget.run(task).pipe(Effect.provide(languageModel)) };
  });

/** Trials of the scripted solutions, which cost nothing. */
const scriptedRunner = {
  spent: Effect.succeed(0),
  exhausted: Effect.succeed(false),
  run: (task: Task) => task.scripted,
};

interface TrialRecord {
  readonly task: string;
  readonly kind: Task["kind"];
  readonly trial: number;
  readonly startedAt: string;
  readonly model: string | null;
  readonly reasoning: string | null;
  readonly browser: string;
  readonly pass: boolean;
  readonly detail: string;
  readonly error: string | null;
  readonly answer: unknown;
  readonly steps: number;
  readonly usage: Agent.Usage | null;
  readonly usd: number;
  readonly seconds: number;
}

const errorText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  return error instanceof Error ? error.message : Cause.pretty(cause);
};

const main = Effect.gen(function* () {
  const options = yield* flags;

  if (options.help) {
    yield* Console.log(help);

    return true;
  }

  const trials = Number(options.trials);
  const maxUsd = Number(options["max-usd"]);
  const names = options.task ?? tasks.map((task) => task.name);
  const unknown = names.filter((name) => !tasks.some((task) => task.name === name));
  const reasoning = efforts.find((effort) => effort === options.reasoning);
  const model = options.model;

  if (unknown.length > 0) return yield* refuse(`no task named ${unknown.join(", ")}\n\n${help}`);
  if (!Number.isInteger(trials) || trials < 1) return yield* refuse("--trials must be 1 or more");
  if (!(maxUsd > 0)) return yield* refuse("--max-usd must be more than 0");
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
          session: { browserSettings: { viewport: { width: 1280, height: 720 } } },
        }).pipe(
          Layer.provide(BrowserbaseClient.layerConfig()),
          Layer.provide(FetchHttpClient.layer),
        )
      : Chromium.layer({ humanize: options.humanize });

  const runner =
    model === undefined
      ? scriptedRunner
      : yield* modelRunner({ model, reasoning, rates: options.rates, maxUsd });

  const label = model?.replace(/[^\w.-]+/g, "_") ?? "scripted";
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const directory = options.out ?? fileURLToPath(new URL("../.work/bench/", import.meta.url));
  const file = join(directory, `${stamp}-${label}.jsonl`);
  const records: Array<TrialRecord> = [];

  mkdirSync(directory, { recursive: true });

  for (const task of tasks.filter((candidate) => names.includes(candidate.name))) {
    for (let trial = 1; trial <= trials && !(yield* runner.exhausted); trial++) {
      const started = yield* DateTime.now;
      const before = yield* runner.spent;

      const exit = yield* runner
        .run(task)
        .pipe(Effect.provide(browser), Effect.timeout(Duration.minutes(10)), Effect.exit);

      const outcome = Exit.isSuccess(exit) ? exit.value : undefined;

      const record: TrialRecord = {
        task: task.name,
        kind: task.kind,
        trial,
        startedAt: DateTime.formatIso(started),
        model: model ?? null,
        reasoning: reasoning ?? null,
        browser: options.browser,
        pass: outcome?.pass ?? false,
        detail: outcome?.detail ?? "",
        error: Exit.isFailure(exit) ? errorText(exit.cause) : null,
        answer: outcome?.answer ?? null,
        steps: outcome?.steps ?? 0,
        usage: outcome?.usage ?? null,
        usd: (yield* runner.spent) - before,
        seconds: Duration.toSeconds(DateTime.distance(started, yield* DateTime.now)),
      };

      records.push(record);
      appendFileSync(file, `${JSON.stringify(record)}\n`);
      yield* Console.log(
        `${task.name.padEnd(14)} #${trial}  ${record.pass ? "pass" : "FAIL"}  ${record.seconds.toFixed(1)}s  ${record.steps} steps  $${record.usd.toFixed(4)}  ${record.error ?? record.detail}`,
      );
    }
  }

  const passed = records.filter((record) => record.pass).length;

  yield* Console.log(
    `\n${passed} of ${records.length} trials passed; spent $${(yield* runner.spent).toFixed(4)} of $${maxUsd}; results in ${file}`,
  );

  // A failing scripted solution is a broken bench; a failing model is a result.
  return model !== undefined || passed === records.length;
});

// Run only from the command line, so tests can import the ledger.
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
