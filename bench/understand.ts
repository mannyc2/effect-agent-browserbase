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
  noTiming,
  type Timing,
} from "./Budget.ts";
import * as Diagnostics from "./Diagnostics.ts";
import * as Quote from "./QuoteComparison.ts";
import {
  classify,
  isolatedTrial,
  journal,
  notAdmitted,
  onSigint,
  type Reason,
  revision,
  type Status,
  tally,
  trialSeed,
  workDeadline,
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
Each pair shares one capture across A, B and facts, in a counterbalanced order.`;

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

const permutations: ReadonlyArray<ReadonlyArray<Quote.Arm>> = [
  ["A", "B", "facts"],
  ["A", "facts", "B"],
  ["B", "A", "facts"],
  ["B", "facts", "A"],
  ["facts", "A", "B"],
  ["facts", "B", "A"],
];

/**
 * Counterbalanced: each complete block of six consecutive pairs of a task uses every order once,
 * so within it each arm runs first, second and third equally often. The base seed rotates the
 * sequence; worker scheduling and provider draws never change it.
 */
const armOrder = (base: number, task: string, index: number): ReadonlyArray<Quote.Arm> =>
  permutations[(index + (trialSeed(base, task, 0) % permutations.length)) % permutations.length] ??
  arms;

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

export const manifest = (configuration: Options, createdAt: string) => {
  const pairs = [
    ...Array.from({ length: configuration.hardTrials }, (_, index): Pair => {
      const seed = trialSeed(configuration.seed, "quote-dense", index + 1);

      return {
        task: "quote-dense",
        dense: true,
        trial: index + 1,
        seed,
        order: armOrder(configuration.seed, "quote-dense", index),
      };
    }),
    ...Array.from({ length: configuration.controlTrials }, (_, index): Pair => {
      const seed = trialSeed(configuration.seed, "quote-table", index + 1);

      return {
        task: "quote-table",
        dense: false,
        trial: index + 1,
        seed,
        order: armOrder(configuration.seed, "quote-table", index),
      };
    }),
  ];

  return {
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
      facts:
        "Identical Moment plus conclusions from every visible quote table, keyed by caption, asset and header",
    },
    baselineResize: "chromium-canvas-high",
    requestTimeoutMillis: 600_000,
    captureTimeoutMillis: 30_000,
    prerequisitesForConsideringFacts,
    orderBalance: orderBalance(pairs),
    pairs,
  };
};

/**
 * How often each arm runs at each position, per task. Only complete blocks of six pairs are
 * balanced; a task whose pair count is not a multiple of six has an unbalanced remainder.
 */
const orderBalance = (pairs: ReadonlyArray<Pair>) =>
  (["quote-dense", "quote-table"] as const).map((task) => {
    const orders = pairs.filter((pair) => pair.task === task).map((pair) => pair.order);

    return {
      task,
      pairs: orders.length,
      completeBlocks: Math.floor(orders.length / permutations.length),
      positions: Object.fromEntries(
        arms.map((arm) => [
          arm,
          [0, 1, 2].map((position) => orders.filter((order) => order[position] === arm).length),
        ]),
      ),
    };
  });

export type Manifest = ReturnType<typeof manifest>;

type Matches = { readonly [Field in (typeof fields)[number]]: boolean };

export interface Record {
  readonly task: Pair["task"];
  readonly trial: number;
  readonly seed: number;
  readonly arm: Quote.Arm;
  /** The arm's place in its case's counterbalanced order, from 0. */
  readonly position: number;
  readonly mode: Manifest["mode"];
  readonly status: Status;
  readonly reason: Reason;
  /** Null unless the arm was graded. */
  readonly pass: boolean | null;
  readonly matches: Matches | null;
  /** Which table, row and period a graded answer's values came from. */
  readonly binding: Quote.Binding | null;
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
  /** Admission queueing and provider request time; latency targets use the request time. */
  readonly timing: Timing;
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

// One journal key per scheduled arm: its pair's index and the arm's place in `arms`.
const unitKey = (index: number, arm: Quote.Arm) => index * arms.length + arms.indexOf(arm);

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
  const outputFailure = yield* Ref.make<Cause.Cause<RunError> | null>(null);

  // The ledger keeps the first reason to stop, so every unit refused afterwards reports it.
  const stop = budget.stop;

  const save = (record: Record) =>
    operations.record(record).pipe(
      Effect.catchCause((cause) =>
        Ref.update(outputFailure, (current) => current ?? cause).pipe(
          Effect.andThen(stop("output-failed")),
        ),
      ),
      Effect.as(record),
    );

  const units = yield* journal(
    plan.pairs.flatMap((_, index) => arms.map((arm) => unitKey(index, arm))),
  );

  const settle = (index: number, record: Record) =>
    units.settle(unitKey(index, record.arm), save(record)).pipe(Effect.as(record));

  // Interruption still leaves one record per scheduled arm, keeping what dispatched calls spent.
  const interrupted = Effect.gen(function* () {
    for (const { key, calls, timing } of yield* units.drain) {
      const pair = plan.pairs[Math.floor(key / arms.length)];
      const arm = arms[key % arms.length];

      if (pair === undefined || arm === undefined) continue;
      yield* save({
        task: pair.task,
        trial: pair.trial,
        seed: pair.seed,
        arm,
        position: pair.order.indexOf(arm),
        mode: plan.mode,
        evidence: null,
        status: "unrun",
        reason: "interrupted",
        pass: null,
        matches: null,
        binding: null,
        answer: null,
        diagnostic: null,
        lastResponse: calls.lastResponse,
        accounting: calls.accounting,
        timing,
        seconds: 0,
      });
    }
  });

  yield* onSigint(interrupted);

  const groups = yield* Effect.forEach(
    plan.pairs,
    (pair, index) =>
      Effect.gen(function* () {
        const skipped = yield* budget.exhausted;
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

        return yield* Effect.forEach(pair.order, (arm, position) =>
          Effect.gen(function* () {
            const base = {
              task: pair.task,
              trial: pair.trial,
              seed: pair.seed,
              arm,
              position,
              mode: plan.mode,
              evidence,
            };

            const unanswered = {
              pass: null,
              matches: null,
              binding: null,
              answer: null,
              lastResponse: null,
              accounting: emptyAccounting,
              timing: noTiming,
              seconds: 0,
            };

            if (prepared !== undefined && Exit.isFailure(prepared))
              return yield* settle(index, {
                ...base,
                ...unanswered,
                status: "infrastructure-failed",
                reason: "preparation-failed",
                diagnostic: Diagnostics.failure(prepared.cause),
              });

            if (sample === undefined || (yield* budget.exhausted))
              return yield* settle(index, {
                ...base,
                ...unanswered,
                ...notAdmitted(yield* budget.halted),
                diagnostic: null,
              });

            const account = yield* budget.account;

            yield* units.begin(unitKey(index, arm), account);
            const started = yield* Clock.monotonicTimeNanos;

            const exit = yield* operations
              .describe(sample, arm, account)
              .pipe(
                Effect.raceFirst(workDeadline(plan.requestTimeoutMillis, account.queued)),
                Effect.exit,
              );

            const seconds = Number((yield* Clock.monotonicTimeNanos) - started) / 1e9;
            const calls = yield* account.calls;
            const outcome = classify(exit, calls);

            if (outcome.status === "infrastructure-failed") yield* stop("infrastructure");
            if (calls.accounting.uncertainCalls > 0) yield* stop("uncertain-charge");

            const answer = Exit.isSuccess(exit) ? exit.value.answer : null;

            return yield* settle(index, {
              ...base,
              ...outcome,
              matches: answer === null ? null : matches(answer, sample.expected),
              binding: answer === null ? null : Quote.binding(answer, sample.expected, sample.rows),
              answer,
              diagnostic: Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null,
              lastResponse: calls.lastResponse,
              accounting: calls.accounting,
              timing: yield* account.timing,
              seconds,
            });
          }),
        );
      }),
    { concurrency: plan.configuration.concurrency },
  ).pipe(Effect.onInterrupt(() => interrupted));

  // A broken result sink stops admission but cannot interrupt requests that already cost money.
  const failure = yield* Ref.get(outputFailure);

  if (failure !== null) return yield* Effect.failCause(failure);

  return groups.flat();
}, Effect.scoped);

const percentile = (values: ReadonlyArray<number>, fraction: number): number | null => {
  const ordered = [...values].sort((left, right) => left - right);

  return ordered.length === 0 ? null : (ordered[Math.ceil(ordered.length * fraction) - 1] ?? null);
};

const summarizeArms = (records: ReadonlyArray<Record>, scheduled: number) =>
  arms.map((arm) => {
    const rows = records.filter((record) => record.arm === arm);
    const graded = rows.filter((record) => record.status === "graded");
    const times = graded.map((record) => record.timing.requestSeconds);
    const queued = graded.map((record) => record.timing.queueSeconds);
    const knownUsd = rows.reduce((sum, record) => sum + record.accounting.knownUsd, 0);
    const uncertainCalls = rows.reduce((sum, record) => sum + record.accounting.uncertainCalls, 0);

    const counts = tally(rows);

    const errorsIn = (field: (typeof fields)[number]) =>
      graded.filter((record) => record.matches?.[field] === false).length;

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
      fieldErrors: {
        ticker: errorsIn("ticker"),
        price: errorsIn("price"),
        change1h: errorsIn("change1h"),
        change24h: errorsIn("change24h"),
        column: errorsIn("column"),
        table: errorsIn("table"),
      },
      // Values read from the wrong table, row or period, classified from the displayed cells.
      bindingErrors: graded.filter(
        (record) =>
          record.binding?.wrongTable === true ||
          record.binding?.wrongRow === true ||
          record.binding?.wrongPeriod === true,
      ).length,
      wrongTable: graded.filter((record) => record.binding?.wrongTable === true).length,
      wrongRow: graded.filter((record) => record.binding?.wrongRow === true).length,
      wrongPeriod: graded.filter((record) => record.binding?.wrongPeriod === true).length,
      unsourced: graded.filter((record) => record.binding?.unsourced === true).length,
      // The requested ticker, table and header are text the answer must copy, not values it binds.
      labelErrors: graded.filter(
        (record) =>
          record.matches?.ticker === false ||
          record.matches?.table === false ||
          record.matches?.column === false,
      ).length,
      // Answers, each counted once, with a wrong ticker, row or period: the pre-registered rule.
      wrongTickerOrPeriod: graded.filter(
        (record) =>
          record.matches?.ticker === false ||
          record.binding?.wrongRow === true ||
          record.binding?.wrongPeriod === true,
      ).length,
      // Provider latency excludes time spent waiting for budget admission.
      requestSeconds: { p50: percentile(times, 0.5), p95: percentile(times, 0.95) },
      queueSeconds: { p50: percentile(queued, 0.5), p95: percentile(queued, 0.95) },
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

const byTask = (plan: Manifest, records: ReadonlyArray<Record>) =>
  (["quote-dense", "quote-table"] as const).map((task) => {
    const pairs = plan.pairs.filter((pair) => pair.task === task);
    const rows = records.filter((record) => record.task === task);

    return {
      task,
      scheduled: pairs.length * 3,
      arms: summarizeArms(rows, pairs.length),
      paired: summarizePairs(pairs, rows),
    };
  });

/**
 * The pre-registered rules read on the dense fixtures. `met` is null without graded evidence;
 * nothing here decides on an API.
 */
const prerequisites = (plan: Manifest, dense: ReturnType<typeof byTask>[number] | undefined) => {
  const targets = plan.prerequisitesForConsideringFacts;
  const arm = (name: Quote.Arm) => dense?.arms.find((candidate) => candidate.arm === name);
  const a = arm("A");
  const b = arm("B");
  const facts = arm("facts");
  const versusA = dense?.paired.find((pair) => pair.comparison === "facts vs A");
  const exact = facts === undefined || facts.graded === 0 ? null : facts.passed / facts.graded;

  const wrongTickerOrPeriod =
    facts === undefined || facts.graded === 0 ? null : facts.wrongTickerOrPeriod;

  return {
    baselineReproducesBindingMistakes: {
      observed: b?.bindingErrors ?? null,
      met: b === undefined || b.graded === 0 ? null : b.bindingErrors > 0,
    },
    factsImprovesOverA: {
      observed: versusA === undefined ? null : { wins: versusA.wins, losses: versusA.losses },
      met:
        versusA === undefined || versusA.completePairs === 0 ? null : versusA.wins > versusA.losses,
    },
    hardQuoteExact: {
      target: targets.hardQuoteExactTarget,
      observed: exact,
      met: exact === null ? null : exact >= targets.hardQuoteExactTarget,
    },
    wrongTickerOrPeriod: {
      target: targets.wrongTickerOrPeriodTarget,
      observed: wrongTickerOrPeriod,
      met:
        wrongTickerOrPeriod === null
          ? null
          : wrongTickerOrPeriod <= targets.wrongTickerOrPeriodTarget,
    },
    meanCostNoGreaterThanA: {
      observed: { facts: facts?.meanGradedUsd ?? null, A: a?.meanGradedUsd ?? null },
      met:
        facts?.meanGradedUsd === null ||
        facts?.meanGradedUsd === undefined ||
        a?.meanGradedUsd === null ||
        a?.meanGradedUsd === undefined
          ? null
          : facts.meanGradedUsd <= a.meanGradedUsd,
    },
    p95RequestSeconds: {
      target: targets.p95SecondsTarget,
      observed: facts?.requestSeconds.p95 ?? null,
      met:
        facts?.requestSeconds.p95 === null || facts?.requestSeconds.p95 === undefined
          ? null
          : facts.requestSeconds.p95 <= targets.p95SecondsTarget,
    },
    interpretation: targets.interpretation,
  };
};

/** Hard fixtures and controls retain their own denominators; incomplete pairs are explicit. */
export const summarize = (plan: Manifest, records: ReadonlyArray<Record>) => {
  const tasks = byTask(plan, records);

  return {
    mode: plan.mode,
    interpretation: plan.interpretation,
    scheduled: plan.pairs.length * 3,
    recorded: records.length,
    arms: summarizeArms(records, plan.pairs.length),
    paired: summarizePairs(plan.pairs, records),
    byTask: tasks,
    orderBalance: plan.orderBalance,
    prerequisitesForConsideringFacts: prerequisites(
      plan,
      tasks.find((group) => group.task === "quote-dense"),
    ),
  };
};

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
      pair.order.map((arm, position): Record => ({
        task: pair.task,
        trial: pair.trial,
        seed: pair.seed,
        arm,
        position,
        mode: plan.mode,
        status: "infrastructure-failed",
        reason: "model-setup-failed",
        pass: null,
        matches: null,
        binding: null,
        answer: null,
        diagnostic: Diagnostics.failure(setup.cause),
        lastResponse: null,
        evidence: null,
        accounting: emptyAccounting,
        timing: noTiming,
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

  const saved = yield* Ref.make<ReadonlyArray<Record>>([]);

  const summarized = yield* Ref.make(false);

  // Written once: a SIGINT records it before the run's own interruption tries again.
  const writeSummary = (records: ReadonlyArray<Record>, interrupted: boolean) =>
    Effect.gen(function* () {
      const summary = {
        ...summarize(plan, records),
        interrupted,
        accounting: yield* budget.snapshot,
      };

      if (yield* Ref.getAndSet(summarized, true)) return summary;
      yield* write(() =>
        writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
          flag: "wx",
        }),
      );

      return summary;
    });

  const interruptedSummary = Ref.get(saved).pipe(
    Effect.flatMap((records) => writeSummary(records, true)),
    Effect.ignore({ log: "Error", message: "could not summarize the interrupted comparison" }),
  );

  yield* onSigint(interruptedSummary);

  const records = yield* compare(plan, budget, {
    prepare: (pair) =>
      isolatedTrial(Quote.prepare(pair), browser).pipe(
        Effect.timeout(plan.captureTimeoutMillis),
        Effect.tap((sample) => saveEvidence(directory, pair, sample)),
      ),
    describe: (sample, arm, account) =>
      liveRunner === undefined
        ? Effect.gen(function* () {
            // The rehearsal answers as a reader of the visible facts would, never from grading.
            const model = yield* scriptedModel(
              account,
              JSON.stringify(Quote.answerFrom(sample.facts) ?? null),
            );

            return yield* Quote.describe(sample, arm).pipe(
              Effect.provideService(LanguageModel.LanguageModel, model),
            );
          })
        : liveRunner.withModel(Quote.describe(sample, arm), "none", account),
    record: (record) =>
      write(() =>
        appendFileSync(join(directory, "results.jsonl"), JSON.stringify(record) + "\n"),
      ).pipe(Effect.andThen(Ref.update(saved, (records) => [...records, record]))),
  }).pipe(Effect.onInterrupt(() => interruptedSummary));

  const summary = yield* writeSummary(records, false);

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
}, Effect.scoped);

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
