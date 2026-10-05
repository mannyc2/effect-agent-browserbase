// A paired local decision experiment. Free runs validate plumbing, never model accuracy.
import { createHash } from "node:crypto";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { Cause, Clock, Console, DateTime, Effect, Exit, Ref, Schema } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

import {
  type Account,
  type Accounting,
  type Budget,
  budgetedClient,
  emptyAccounting,
  ledger,
  modelRunner,
} from "./Budget.ts";
import * as Diagnostics from "./Diagnostics.ts";
import * as Quote from "./QuoteComparison.ts";
import {
  classify,
  isolatedTrial,
  type Reason,
  revision,
  type Status,
  tally,
  trialSeed,
} from "./Trial.ts";

const help = `Usage: bun run understand -- [options]

  --hard-trials <n>       Dense quote pairs. Defaults to 20.
  --control-trials <n>    Easy quote pairs. Defaults to 10.
  --concurrency <n>       Independent cases and maximum concurrent calls. Defaults to 4.
  --seed <integer>        Base seed. Defaults to 1.
  --model <id>            Explicit OpenRouter model; omit for a free scripted dry run.
  --max-usd <amount>      One shared model admission budget. Defaults to 1.
  --max-output-tokens <n> Completion ceiling including reasoning. Defaults to 4096.
  --out <dir>            New results directory. Defaults to .work/understand/<timestamp>.
  --help                 Show this help.

Live calls require EFFECT_BROWSER_BENCH_LIVE=1. This experiment uses local Chromium only.
Each pair shares one capture across A, B and facts, in a deterministic shuffled order.`;

export class RunError extends Schema.TaggedError<RunError>()("UnderstandRunError", {
  message: Schema.String,
}) {}

export interface Options {
  readonly hardTrials: number;
  readonly controlTrials: number;
  readonly concurrency: number;
  readonly seed: number;
  readonly model: string | undefined;
  readonly maxUsd: number;
  readonly maxOutputTokens: number;
  readonly out: string | undefined;
  readonly help: boolean;
}

/** Validate opt-in before constructing a browser or consulting any model endpoint. */
export const options = Effect.fnUntraced(function* (args: ReadonlyArray<string>, live: boolean) {
  const parsed = yield* Effect.try({
    try: () =>
      parseArgs({
        args: [...args],
        options: {
          "hard-trials": { type: "string", default: "20" },
          "control-trials": { type: "string", default: "10" },
          concurrency: { type: "string", default: "4" },
          seed: { type: "string", default: "1" },
          model: { type: "string" },
          "max-usd": { type: "string", default: "1" },
          "max-output-tokens": { type: "string", default: "4096" },
          out: { type: "string" },
          help: { type: "boolean", default: false },
        },
      }).values,
    catch: () => new RunError({ message: "Invalid comparison flags. Use --help." }),
  });

  const value: Options = {
    hardTrials: Number(parsed["hard-trials"]),
    controlTrials: Number(parsed["control-trials"]),
    concurrency: Number(parsed.concurrency),
    seed: Number(parsed.seed),
    model: parsed.model,
    maxUsd: Number(parsed["max-usd"]),
    maxOutputTokens: Number(parsed["max-output-tokens"]),
    out: parsed.out,
    help: parsed.help,
  };

  if (value.help) return value;
  if (
    ![value.hardTrials, value.controlTrials].every(
      (count) => Number.isSafeInteger(count) && count >= 0,
    ) ||
    value.hardTrials + value.controlTrials < 1 ||
    value.hardTrials + value.controlTrials > 10_000
  )
    return yield* new RunError({
      message: "Trial counts must be non-negative integers totalling 1–10000.",
    });
  if (!Number.isSafeInteger(value.concurrency) || value.concurrency < 1)
    return yield* new RunError({ message: "--concurrency must be a positive integer." });
  if (!Number.isSafeInteger(value.seed))
    return yield* new RunError({ message: "--seed must be a safe integer." });
  if (!Number.isFinite(value.maxUsd) || value.maxUsd <= 0)
    return yield* new RunError({ message: "--max-usd must be finite and positive." });
  if (!Number.isSafeInteger(value.maxOutputTokens) || value.maxOutputTokens < 16)
    return yield* new RunError({
      message: "--max-output-tokens must be an integer of at least 16.",
    });
  if (value.model !== undefined && value.model.trim().length === 0)
    return yield* new RunError({ message: "--model must name an explicit model." });
  if (value.model !== undefined && !live)
    return yield* new RunError({
      message: "Model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them.",
    });

  return value;
});

const arms: ReadonlyArray<Quote.Arm> = ["A", "B", "facts"];
const fields = ["ticker", "price", "change1h", "change24h", "column", "table"] as const;

export interface Pair {
  readonly task: "quote-dense" | "quote-table";
  readonly dense: boolean;
  readonly trial: number;
  readonly seed: number;
  readonly order: ReadonlyArray<Quote.Arm>;
}

/** The ordering is independent of worker scheduling and of any provider random draw. */
const armOrder = (seed: number): ReadonlyArray<Quote.Arm> =>
  [...arms].sort((left, right) => trialSeed(seed, left, 0) - trialSeed(seed, right, 0));

const prerequisitesForConsideringFacts = {
  baselineMustReproduceBindingMistakes: true,
  factsMustImproveOverA: true,
  hardQuoteExactTarget: 0.95,
  wrongTickerOrPeriodTarget: 0,
  meanCostNoGreaterThanA: true,
  p95SecondsTarget: 3,
  interpretation:
    "Pre-registered targets only. Small samples do not establish five-point noninferiority; no automatic API decision.",
};

export const manifest = (configuration: Options, createdAt: string) => ({
  version: 1,
  createdAt,
  mode: configuration.model === undefined ? ("dry-run" as const) : ("paid" as const),
  interpretation:
    configuration.model === undefined
      ? "Scripted adapter validation only; these results do not measure model accuracy."
      : "Paired observations; no automatic conclusion about adding a public facts API.",
  model: configuration.model ?? null,
  reasoning: "none" as const,
  browser: "local-chromium" as const,
  configuration,
  arms: {
    A: "Shipping Moment",
    B: "640x360 JPEG plus first 4000 UTF-8 visible-text bytes",
    facts: "Identical Moment plus visible-DOM conclusions with provenance",
  },
  baselineResize: "chromium-canvas-high",
  requestTimeoutMillis: 600_000,
  captureTimeoutMillis: 30_000,
  prerequisitesForConsideringFacts,
  pairs: [
    ...Array.from({ length: configuration.hardTrials }, (_, index): Pair => {
      const seed = trialSeed(configuration.seed, "quote-dense", index + 1);

      return { task: "quote-dense", dense: true, trial: index + 1, seed, order: armOrder(seed) };
    }),
    ...Array.from({ length: configuration.controlTrials }, (_, index): Pair => {
      const seed = trialSeed(configuration.seed, "quote-table", index + 1);

      return { task: "quote-table", dense: false, trial: index + 1, seed, order: armOrder(seed) };
    }),
  ],
});

export type Manifest = ReturnType<typeof manifest>;
type Stop = "infrastructure" | "uncertain-accounting" | "output-failed";

const stopReason: { readonly [Cause in Stop]: Reason } = {
  infrastructure: "stopped-after-infrastructure",
  "uncertain-accounting": "stopped-after-uncertain-charge",
  "output-failed": "stopped-after-output-failure",
};

type Matches = { readonly [Field in (typeof fields)[number]]: boolean };

export interface Record {
  readonly task: Pair["task"];
  readonly trial: number;
  readonly seed: number;
  readonly arm: Quote.Arm;
  readonly mode: Manifest["mode"];
  readonly status: Status;
  readonly reason: Reason;
  /** Null unless the arm was graded. */
  readonly pass: boolean | null;
  readonly matches: Matches | null;
  readonly periodSwap: boolean | null;
  readonly answer: Quote.Answer | null;
  readonly diagnostic: Diagnostics.Failure | null;
  readonly lastResponse: Diagnostics.LastResponse | null;
  readonly evidence: {
    readonly directory: string;
    readonly frames: ReadonlyArray<string>;
    readonly baseline: string;
    readonly visibleTextBytes: number;
  } | null;
  readonly accounting: Accounting;
  readonly seconds: number;
}

const matches = (answer: Quote.Answer, expected: Quote.Answer): Matches => ({
  ticker: answer.ticker === expected.ticker,
  price: answer.price === expected.price,
  change1h: answer.change1h === expected.change1h,
  change24h: answer.change24h === expected.change24h,
  column: answer.column === expected.column,
  table: answer.table === expected.table,
});

const digest = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

export interface Operations<E, R, E2, R2> {
  readonly prepare: (pair: Pair) => Effect.Effect<Quote.QuoteCase, E, R>;
  readonly describe: (
    sample: Quote.QuoteCase,
    arm: Quote.Arm,
    account: Account,
  ) => Effect.Effect<Effect.Success<ReturnType<typeof Quote.describe>>, E2, R2>;
  readonly record: (record: Record) => Effect.Effect<void, RunError>;
}

/**
 * Cases run concurrently; their three arms run serially, preserving the global call bound. An
 * infrastructure failure or an unresolved charge stops new admissions; a graded answer, including
 * malformed model output, never does.
 */
export const compare = Effect.fnUntraced(function* <E, R, E2, R2>(
  plan: Manifest,
  budget: Budget,
  operations: Operations<E, R, E2, R2>,
) {
  const stopped = yield* Ref.make<Stop | null>(null);
  const outputFailure = yield* Ref.make<Cause.Cause<RunError> | null>(null);

  const stop = (reason: Stop) =>
    Ref.update(stopped, (current) => current ?? reason).pipe(Effect.andThen(budget.stop));

  const save = (record: Record) =>
    operations.record(record).pipe(
      Effect.catchCause((cause) =>
        Ref.update(outputFailure, (current) => current ?? cause).pipe(
          Effect.andThen(stop("output-failed")),
        ),
      ),
      Effect.as(record),
    );

  const groups = yield* Effect.forEach(
    plan.pairs,
    (pair) =>
      Effect.gen(function* () {
        const halted = yield* Ref.get(stopped);
        const skipped = halted !== null || (yield* budget.exhausted);
        const prepared = skipped ? undefined : yield* operations.prepare(pair).pipe(Effect.exit);

        if (prepared !== undefined && Exit.isFailure(prepared)) yield* stop("infrastructure");

        const sample =
          prepared !== undefined && Exit.isSuccess(prepared) ? prepared.value : undefined;

        const evidence =
          sample === undefined
            ? null
            : {
                directory: caseDirectory(pair),
                frames: sample.moment.frames.map((frame) => digest(frame.data)),
                baseline: digest(sample.baseline.data),
                visibleTextBytes: new TextEncoder().encode(sample.baseline.text).length,
              };

        return yield* Effect.forEach(pair.order, (arm) =>
          Effect.gen(function* () {
            const base = {
              task: pair.task,
              trial: pair.trial,
              seed: pair.seed,
              arm,
              mode: plan.mode,
              evidence,
            };

            const unanswered = {
              pass: null,
              matches: null,
              periodSwap: null,
              answer: null,
              lastResponse: null,
              accounting: emptyAccounting,
              seconds: 0,
            };

            if (prepared !== undefined && Exit.isFailure(prepared))
              return yield* save({
                ...base,
                ...unanswered,
                status: "infrastructure-failed",
                reason: "preparation-failed",
                diagnostic: Diagnostics.failure(prepared.cause),
              });

            const halt = yield* Ref.get(stopped);

            if (sample === undefined || halt !== null || (yield* budget.exhausted))
              return yield* save({
                ...base,
                ...unanswered,
                ...(halt === null
                  ? { status: "denied", reason: "budget-exhausted" }
                  : { status: "unrun", reason: stopReason[halt] }),
                diagnostic: null,
              });

            const account = yield* budget.account;
            const started = yield* Clock.monotonicTimeNanos;

            const exit = yield* operations
              .describe(sample, arm, account)
              .pipe(Effect.timeout(plan.requestTimeoutMillis), Effect.exit);

            const seconds = Number((yield* Clock.monotonicTimeNanos) - started) / 1e9;
            const calls = yield* account.calls;
            const outcome = classify(exit, calls);
            const halted = yield* Ref.get(stopped);

            // Another arm's stop closes the ledger; that refusal is not this arm's budget.
            const settled =
              outcome.status === "denied" && halted !== null
                ? { status: "unrun" as const, reason: stopReason[halted], pass: null }
                : outcome;

            if (settled.status === "infrastructure-failed") yield* stop("infrastructure");
            if (calls.accounting.uncertainCalls > 0) yield* stop("uncertain-accounting");

            const answer = Exit.isSuccess(exit) ? exit.value.answer : null;

            return yield* save({
              ...base,
              ...settled,
              matches: answer === null ? null : matches(answer, sample.expected),
              periodSwap:
                answer === null
                  ? null
                  : answer.change24h !== sample.expected.change24h &&
                    answer.change24h === sample.expected.change1h,
              answer,
              diagnostic: Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null,
              lastResponse: calls.lastResponse,
              accounting: calls.accounting,
              seconds,
            });
          }),
        );
      }),
    { concurrency: plan.configuration.concurrency },
  );

  // A broken result sink stops admission but cannot interrupt requests that already cost money.
  const failure = yield* Ref.get(outputFailure);

  if (failure !== null) return yield* Effect.failCause(failure);

  return groups.flat();
});

const percentile = (values: ReadonlyArray<number>, fraction: number): number | null => {
  const ordered = [...values].sort((left, right) => left - right);

  return ordered.length === 0 ? null : (ordered[Math.ceil(ordered.length * fraction) - 1] ?? null);
};

const summarizeArms = (records: ReadonlyArray<Record>, scheduled: number) =>
  arms.map((arm) => {
    const rows = records.filter((record) => record.arm === arm);
    const graded = rows.filter((record) => record.status === "graded");
    const times = graded.map((record) => record.seconds);
    const knownUsd = rows.reduce((sum, record) => sum + record.accounting.knownUsd, 0);
    const uncertainCalls = rows.reduce((sum, record) => sum + record.accounting.uncertainCalls, 0);

    const counts = tally(rows);

    // Each record has exactly one status, so these counts add up to `scheduled`.
    return {
      arm,
      scheduled,
      graded: counts.graded,
      passed: counts.passed,
      gradingFailures: counts.failed,
      infrastructureFailed: counts.infrastructureFailed,
      denied: counts.denied,
      unrun: counts.unrun,
      invalidOutputs: graded.filter((record) => record.reason === "invalid-output").length,
      fieldErrors: Object.fromEntries(
        fields.map((field) => [
          field,
          graded.filter((record) => record.matches?.[field] === false).length,
        ]),
      ),
      bindingErrors: graded.filter(
        (record) =>
          record.matches?.ticker === false ||
          record.matches?.table === false ||
          record.matches?.column === false ||
          record.periodSwap === true,
      ).length,
      periodSwaps: graded.filter((record) => record.periodSwap === true).length,
      seconds: { p50: percentile(times, 0.5), p95: percentile(times, 0.95) },
      calls: rows.reduce((sum, record) => sum + record.accounting.calls, 0),
      usage: rows.reduce(
        (sum, record) => ({
          inputTokens: sum.inputTokens + record.accounting.usage.inputTokens,
          outputTokens: sum.outputTokens + record.accounting.usage.outputTokens,
          cachedInputTokens: sum.cachedInputTokens + record.accounting.usage.cachedInputTokens,
        }),
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
      ),
      knownUsd,
      meanGradedUsd:
        graded.length === 0 || graded.some((record) => record.accounting.uncertainCalls > 0)
          ? null
          : graded.reduce((sum, record) => sum + record.accounting.knownUsd, 0) / graded.length,
      reservedUsd: rows.reduce((sum, record) => sum + record.accounting.reservedUsd, 0),
      uncertainCalls,
    };
  });

const summarizePairs = (pairs: ReadonlyArray<Pair>, records: ReadonlyArray<Record>) =>
  (["A", "B"] as const).map((other) => {
    const paired = pairs.flatMap((pair) => {
      const a = records.find(
        (record) =>
          record.task === pair.task &&
          record.seed === pair.seed &&
          record.arm === other &&
          record.status === "graded",
      );

      const facts = records.find(
        (record) =>
          record.task === pair.task &&
          record.seed === pair.seed &&
          record.arm === "facts" &&
          record.status === "graded",
      );

      return a === undefined || facts === undefined ? [] : [{ a, facts }];
    });

    return {
      comparison: "facts vs " + other,
      completePairs: paired.length,
      incompletePairs: pairs.length - paired.length,
      wins: paired.filter(({ a, facts }) => facts.pass && !a.pass).length,
      losses: paired.filter(({ a, facts }) => !facts.pass && a.pass).length,
      ties: paired.filter(({ a, facts }) => facts.pass === a.pass).length,
    };
  });

/** Hard fixtures and controls retain their own denominators; incomplete pairs are explicit. */
export const summarize = (plan: Manifest, records: ReadonlyArray<Record>) => ({
  mode: plan.mode,
  interpretation: plan.interpretation,
  scheduled: plan.pairs.length * 3,
  recorded: records.length,
  arms: summarizeArms(records, plan.pairs.length),
  paired: summarizePairs(plan.pairs, records),
  byTask: (["quote-dense", "quote-table"] as const).map((task) => {
    const pairs = plan.pairs.filter((pair) => pair.task === task);
    const rows = records.filter((record) => record.task === task);

    return {
      task,
      scheduled: pairs.length * 3,
      arms: summarizeArms(rows, pairs.length),
      paired: summarizePairs(pairs, rows),
    };
  }),
  prerequisitesForConsideringFacts: plan.prerequisitesForConsideringFacts,
});

/** The free adapter sees a scripted response from visible facts, never fixture grading truth. */
export const scriptedModel = Effect.fnUntraced(function* (account: Account, content: string) {
  const http = HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            id: "free-scripted",
            object: "chat.completion",
            created: 0,
            model: "openai/free-scripted",
            system_fingerprint: null,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content },
              },
            ],
            usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0, cost: 0 },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );

  const native = yield* OpenRouterClient.make({}).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );

  return yield* OpenRouterLanguageModel.make({ model: "openai/free-scripted" }).pipe(
    Effect.provideService(
      OpenRouterClient.OpenRouterClient,
      budgetedClient(native, account, {
        rates: { input: 0, output: 0 },
        maxOutputTokens: 4096,
      }),
    ),
  );
});

const write = (operation: () => void) =>
  Effect.try({
    try: operation,
    catch: () => new RunError({ message: "Could not write comparison results." }),
  });

const caseDirectory = (pair: Pair) => join("cases", pair.task + "-" + pair.trial + "-" + pair.seed);

/** Keep only this bench's own observation, once per pair, for later inspection of real misreads. */
export const saveEvidence = (directory: string, pair: Pair, sample: Quote.QuoteCase) =>
  write(() => {
    const target = join(directory, caseDirectory(pair));

    mkdirSync(target, { recursive: true });

    const frames = sample.moment.frames.map((frame, index) => {
      const file = "native-" + index + ".jpg";

      writeFileSync(join(target, file), frame.data, { flag: "wx" });

      return {
        file,
        sha256: digest(frame.data),
        bytes: frame.data.length,
        width: frame.width,
        height: frame.height,
        timing: frame.timing,
        receivedAt: frame.receivedAt,
      };
    });

    writeFileSync(join(target, "baseline.jpg"), sample.baseline.data, { flag: "wx" });
    writeFileSync(
      join(target, "evidence.json"),
      JSON.stringify(
        {
          task: pair.task,
          trial: pair.trial,
          seed: pair.seed,
          question: sample.question,
          snapshot: { ...sample.moment.snapshot, rendered: sample.moment.snapshot.rendered },
          timeline: sample.moment.timeline,
          visibleText: sample.baseline.text,
          visibleTextBytes: new TextEncoder().encode(sample.baseline.text).length,
          facts: sample.facts,
          // This separate grading branch is never used to build a model request.
          grading: { expected: sample.expected },
          frames,
          baseline: {
            file: "baseline.jpg",
            sha256: digest(sample.baseline.data),
            bytes: sample.baseline.data.length,
            width: sample.baseline.width,
            height: sample.baseline.height,
            resize: sample.baseline.resize,
          },
        },
        null,
        2,
      ) + "\n",
      { flag: "wx" },
    );
  });

export const main = Effect.fnUntraced(function* (args: ReadonlyArray<string>, live: boolean) {
  const configuration = yield* options(args, live);

  if (configuration.help) {
    yield* Console.log(help);

    return true;
  }

  const createdAt = DateTime.formatIso(yield* DateTime.now);
  const plan = manifest(configuration, createdAt);

  const directory =
    configuration.out ??
    fileURLToPath(
      new URL("../.work/understand/" + createdAt.replace(/[:.]/g, "-") + "/", import.meta.url),
    );

  // Exclusive creation makes an existing paid run directory immutable and prevents replay.
  yield* write(() => {
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, "results.jsonl"), "", { flag: "wx" });
  });

  const setup =
    configuration.model === undefined
      ? undefined
      : yield* modelRunner({
          model: configuration.model,
          rates: undefined,
          maxUsd: configuration.maxUsd,
          maxOutputTokens: configuration.maxOutputTokens,
          needs: { tools: false, structuredOutput: true },
        }).pipe(Effect.exit);

  // The pinned endpoint and the source revision are part of the plan, written before any call.
  const recorded = {
    ...plan,
    revision: yield* revision,
    endpoint: setup !== undefined && Exit.isSuccess(setup) ? setup.value.endpoint : null,
  };

  yield* write(() =>
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(recorded, null, 2) + "\n", {
      flag: "wx",
    }),
  );

  if (setup !== undefined && Exit.isFailure(setup)) {
    const records = plan.pairs.flatMap((pair) =>
      pair.order.map((arm): Record => ({
        task: pair.task,
        trial: pair.trial,
        seed: pair.seed,
        arm,
        mode: plan.mode,
        status: "infrastructure-failed",
        reason: "model-setup-failed",
        pass: null,
        matches: null,
        periodSwap: null,
        answer: null,
        diagnostic: Diagnostics.failure(setup.cause),
        lastResponse: null,
        evidence: null,
        accounting: emptyAccounting,
        seconds: 0,
      })),
    );

    yield* write(() => {
      appendFileSync(
        join(directory, "results.jsonl"),
        records.map((record) => JSON.stringify(record) + "\n").join(""),
      );
      writeFileSync(
        join(directory, "summary.json"),
        JSON.stringify(
          {
            ...summarize(plan, records),
            accounting: { knownUsd: 0, reservedUsd: 0 },
          },
          null,
          2,
        ) + "\n",
        { flag: "wx" },
      );
    });
    yield* Console.log(
      "Model setup failed before any request; all unrun arms are recorded in " + directory,
    );

    return false;
  }

  const liveRunner = setup === undefined ? undefined : setup.value;

  const budget = liveRunner ?? (yield* ledger(configuration.maxUsd, 0));
  const browser = Chromium.layer({ frameHistory: 1200 });

  const records = yield* compare(plan, budget, {
    prepare: (pair) =>
      isolatedTrial(Quote.prepare(pair), browser).pipe(
        Effect.timeout(plan.captureTimeoutMillis),
        Effect.tap((sample) => saveEvidence(directory, pair, sample)),
      ),
    describe: (sample, arm, account) =>
      liveRunner === undefined
        ? Effect.gen(function* () {
            const model = yield* scriptedModel(account, JSON.stringify(sample.facts.conclusions));

            return yield* Quote.describe(sample, arm).pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
            );
          })
        : liveRunner.withModel(Quote.describe(sample, arm), "none", account),
    record: (record) =>
      write(() => appendFileSync(join(directory, "results.jsonl"), JSON.stringify(record) + "\n")),
  });

  const summary = { ...summarize(plan, records), accounting: yield* budget.snapshot };

  yield* write(() =>
    writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
      flag: "wx",
    }),
  );
  yield* Console.log(plan.interpretation);
  yield* Console.log(records.length + " arm records saved in " + directory);
  yield* Console.log(
    "$" +
      summary.accounting.knownUsd.toFixed(6) +
      " known + $" +
      summary.accounting.reservedUsd.toFixed(6) +
      " unresolved.",
  );

  // The same rule as the bench: every arm graded with settled charges, and in a dry run, passed.
  return records.every(
    (record) =>
      record.status === "graded" &&
      record.accounting.uncertainCalls === 0 &&
      (plan.mode === "paid" || record.pass === true),
  );
});

if (import.meta.main) {
  const interrupt = new AbortController();

  process.once("SIGINT", () => interrupt.abort());

  const exit = await Effect.runPromiseExit(
    main(process.argv.slice(2), process.env.EFFECT_BROWSER_BENCH_LIVE === "1"),
    { signal: interrupt.signal },
  );

  if (Exit.isFailure(exit)) {
    if (!Cause.hasInterruptsOnly(exit.cause)) {
      const error = Cause.squash(exit.cause);

      console.error(
        Schema.is(RunError)(error)
          ? error.message
          : "Comparison failed; inspect the recorded diagnostics.",
      );
    }

    process.exitCode = 1;
  } else if (!exit.value) {
    process.exitCode = 1;
  }
}
