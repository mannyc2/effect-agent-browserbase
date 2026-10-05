// Runs the free scripted bench by default. Paid model/provider runs need the explicit opt-ins below.
// Each trial owns its browser, random seed and accounting; only the admission budget is shared.
import { appendFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  Cause,
  Clock,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Ref,
  Schema,
} from "effect";
import * as Chromium from "effect-browser/Chromium";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { FetchHttpClient } from "effect/http";

import {
  type Accounting,
  BenchError,
  efforts,
  modelRunner,
  noCalls,
  noTiming,
  refuse,
  type Timing,
} from "./Budget.ts";
import * as Diagnostics from "./Diagnostics.ts";
import { type Task, tasks } from "./Tasks.ts";
import {
  type Classification,
  classify,
  isolatedTrial,
  type Reason,
  revision,
  type RunInfo,
  type Status,
  tally,
  trialSeed,
  uncertainAllocation,
} from "./Trial.ts";

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

// A hosted session outlives the trial that owns it only until Browserbase's own timeout, which
// bounds a session the bench could not release.
export const trialTimeout = Duration.minutes(10);
export const hostedSessionSeconds = Duration.toSeconds(trialTimeout) + 5 * 60;

/** Each hosted trial's browser: a new 1280×720 session that ends at least by its own timeout. */
export const hostedBrowser = (humanize: boolean) =>
  Browserbase.layer({
    humanize,
    frameHistory: 1200,
    session: {
      timeout: hostedSessionSeconds,
      browserSettings: { viewport: { width: 1280, height: 720 } },
    },
  });

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

interface TrialRecord {
  readonly task: string;
  readonly kind: Task["kind"];
  readonly trial: number;
  readonly baseSeed: number;
  readonly seed: number;
  readonly startedAt: string;
  readonly run: RunInfo;
  readonly reasoning: string | null;
  readonly status: Status;
  readonly reason: Reason;
  /** Null unless the trial was graded. */
  readonly pass: boolean | null;
  readonly detail: string;
  readonly error: string | null;
  readonly diagnostic: Diagnostics.Failure | null;
  readonly lastResponse: Diagnostics.LastResponse | null;
  readonly answer: unknown;
  readonly accounting: Accounting;
  /** Admission queueing and provider request time within `seconds`. */
  readonly timing: Timing;
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

  const hosted = options.browser === "browserbase";

  const browser = hosted
    ? hostedBrowser(options.humanize).pipe(
        Layer.provide(BrowserbaseClient.layerConfig()),
        Layer.provide(FetchHttpClient.layer),
      )
    : Chromium.layer({ humanize: options.humanize, frameHistory: 1200 });

  // After a create whose outcome is unknown, no further hosted session is requested.
  const hostedHalt = yield* Ref.make(false);

  const selected = tasks.filter((candidate) => names.includes(candidate.name));

  const runner =
    model === undefined
      ? undefined
      : yield* modelRunner({
          model,
          rates: options.rates,
          maxUsd,
          maxOutputTokens,
          needs: {
            tools: selected.some((task) => task.kind === "operate"),
            structuredOutput: selected.some((task) => task.kind === "understand"),
          },
        });

  const run: RunInfo = {
    revision: yield* revision,
    model: model ?? null,
    endpoint: runner?.endpoint ?? null,
    browser: options.browser,
    humanize: options.humanize,
    maxOutputTokens,
    maxUsd,
    concurrency,
  };

  const label = model?.replace(/[^\w.-]+/g, "_") ?? "scripted";
  const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");
  const directory = options.out ?? fileURLToPath(new URL("../.work/bench/", import.meta.url));
  const file = join(directory, `${stamp}-${label}.jsonl`);

  const jobs = selected.flatMap((task) =>
    Array.from({ length: trials }, (_, index) => ({ task, trial: index + 1 })),
  );

  yield* write(() => mkdirSync(directory, { recursive: true }));

  const records = yield* Effect.forEach(
    jobs,
    ({ task, trial }) =>
      Effect.gen(function* () {
        // A denied or unstarted trial is a durable result too, but must not provision a browser.
        const halted = hosted && (yield* Ref.get(hostedHalt));
        const denied = !halted && runner !== undefined && (yield* runner.exhausted);
        const seed = trialSeed(baseSeed, task.name, trial);
        const effectiveReasoning = reasoning ?? (task.kind === "operate" ? "medium" : "none");
        const started = yield* DateTime.now;
        const startedNanos = yield* Clock.monotonicTimeNanos;

        const account =
          halted || denied || runner === undefined ? undefined : yield* runner.account;

        const work =
          runner !== undefined && account !== undefined
            ? runner.withModel(
                task.withModel({ seed, onUsage: () => Effect.void }),
                effectiveReasoning,
                account,
              )
            : task.scripted({ seed });

        const exit =
          halted || denied
            ? undefined
            : yield* isolatedTrial(work, browser).pipe(Effect.timeout(trialTimeout), Effect.exit);

        if (hosted && exit !== undefined && Exit.isFailure(exit) && uncertainAllocation(exit.cause))
          yield* Ref.set(hostedHalt, true);

        const seconds =
          exit === undefined ? 0 : Number((yield* Clock.monotonicTimeNanos) - startedNanos) / 1e9;

        const calls = account === undefined ? noCalls : yield* account.calls;

        const outcome: Classification =
          exit !== undefined
            ? classify(exit, calls)
            : halted
              ? { status: "unrun", reason: "stopped-after-uncertain-session", pass: null }
              : { status: "denied", reason: "budget-exhausted", pass: null };

        const value = exit !== undefined && Exit.isSuccess(exit) ? exit.value : undefined;

        const record: TrialRecord = {
          task: task.name,
          kind: task.kind,
          trial,
          baseSeed,
          seed,
          startedAt: DateTime.formatIso(started),
          run,
          reasoning: model === undefined ? null : effectiveReasoning,
          ...outcome,
          detail:
            exit !== undefined
              ? (value?.detail ?? "")
              : halted
                ? "Unrun: an earlier hosted session create had an unknown outcome."
                : "Denied: the remaining model budget cannot reserve another call.",
          error: exit !== undefined && Exit.isFailure(exit) ? errorText(exit.cause) : null,
          diagnostic:
            exit !== undefined && Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null,
          lastResponse: calls.lastResponse,
          answer: value?.answer ?? null,
          accounting: calls.accounting,
          timing: account === undefined ? noTiming : yield* account.timing,
          seconds,
        };

        yield* write(() => appendFileSync(file, `${JSON.stringify(record)}\n`));
        yield* Console.log(
          `${task.name.padEnd(14)} #${trial}  ${record.status === "graded" ? (record.pass === true ? "pass" : "FAIL") : record.status}  ${record.reason}  ${seconds.toFixed(1)}s  ${record.accounting.calls} calls  $${record.accounting.knownUsd.toFixed(4)} known + $${record.accounting.reservedUsd.toFixed(4)} unresolved  ${record.error ?? record.detail}`,
        );

        return record;
      }),
    { concurrency },
  );

  const accounting =
    runner === undefined ? { knownUsd: 0, reservedUsd: 0 } : yield* runner.snapshot;

  for (const name of names) {
    const counts = tally(records.filter((record) => record.task === name));

    yield* Console.log(
      `${name.padEnd(14)} ${counts.passed} of ${counts.graded} graded passed; ${counts.infrastructureFailed} infrastructure-failed, ${counts.denied} denied, ${counts.unrun} unrun`,
    );
  }

  const counts = tally(records);

  yield* Console.log(
    `\n${counts.passed} of ${counts.graded} graded trials passed; ${counts.infrastructureFailed} infrastructure-failed, ${counts.denied} denied and ${counts.unrun} unrun of ${counts.scheduled} scheduled; $${accounting.knownUsd.toFixed(4)} known + $${accounting.reservedUsd.toFixed(4)} unresolved of $${maxUsd}; results in ${file}`,
  );

  // Every trial must reach a graded result with settled charges. A failing scripted solution is
  // a broken bench; a failing model is a result.
  return records.every(
    (record) =>
      record.status === "graded" &&
      record.accounting.uncertainCalls === 0 &&
      (model !== undefined || record.pass === true),
  );
});

// Run only from the command line, so free tests can import this module without running it.
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
