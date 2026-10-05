/** The paired experiment is inert by default. Model and hosted gates precede every resource. */
import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";

import {
  Cause,
  Console,
  DateTime,
  Effect,
  Exit,
  Layer,
  Option,
  Redacted,
  Ref,
  Schema,
  Semaphore,
} from "effect";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { FetchHttpClient } from "effect/http";

import * as Diagnostics from "./Diagnostics.ts";
import * as Hosted from "./HostedBudget.ts";
import * as ModelBroker from "./ModelBroker.ts";
import * as NativeClient from "./NativeClient.ts";
import * as Pairing from "./Pairing.ts";
import { Perception, type Status as PerceptionStatus } from "./Perception.ts";
import { type Accounting, modelRunner } from "./run.ts";
import * as Worker from "./Worker.ts";

const repository = fileURLToPath(new URL("..", import.meta.url));

const help = `Usage: bun run paired -- [options]

Without --model or --scripted, writes only an immutable experiment manifest.
  --provider <local|browserbase|both> Defaults to both; local runs precede hosted.
  --local-trials <n>       Defaults to 5 for each of 11 paired tasks.
  --hosted-trials <n>      Defaults to 3. Hosted arms are 1,2,5,6.
  --arms <1,2,3,4,5,6>     Explicit subset; defaults to the full planned matrix.
  --tasks <name,...>       Explicit subset; defaults to 7 primary + 4 extensions.
  --seed <integer>        Defaults to 1, independent of dispatch order.
  --concurrency <n>       Local trial workers. Defaults to 4.
  --model <id>            Paid model; requires EFFECT_BROWSER_BENCH_LIVE=1.
  --max-usd <amount>      Shared model cap; defaults to 8.
  --max-output-tokens <n> Defaults to 4096, including reasoning.
  --hosted-concurrency <n> Required for paid hosted runs; verified available plan capacity.
  --browser-hourly-usd <n> Required for paid hosted runs; verified maximum account rate.
  --max-browser-hours <n> Defaults to 5, reserved before allocation.
  --max-browser-usd <n>   Defaults to 1; also bounds hours at the supplied rate.
  --parse-origin <url>    Explicit local perception server in parse mode.
  --ground-origin <url>   Explicit local perception server in ground mode.
  --native-confirmed     Only after separately confirming the exact native route.
  --scripted             Free fixture plumbing only; requires --provider local.
  --out <dir>            New directory; existing output is never overwritten.
  --help                 Show this help.

Hosted paid runs also require EFFECT_BROWSER_BENCH_HOSTED=1.
Arm 6 is prerequisite-blocked unless explicitly confirmed. Missing local models block arms 3/4.
Scripted results do not measure any arm's model performance.`;

export class PairedError extends Schema.TaggedError<PairedError>()("PairedRunError", {
  code: Schema.Literals([
    "Options",
    "LiveRequired",
    "HostedRequired",
    "Output",
    "Setup",
    "SourceDirty",
  ]),
}) {}

export interface Options extends Pairing.Configuration {
  readonly concurrency: number;
  readonly hostedConcurrency: number | undefined;
  readonly model: string | undefined;
  readonly maxUsd: number;
  readonly maxOutputTokens: number;
  readonly browserHourlyUsd: number | undefined;
  readonly maxBrowserHours: number;
  readonly maxBrowserUsd: number;
  readonly parseOrigin: string | undefined;
  readonly groundOrigin: string | undefined;
  readonly nativeConfirmed: boolean;
  readonly scripted: boolean;
  readonly out: string | undefined;
  readonly help: boolean;
}

const invalid = () => new PairedError({ code: "Options" });

export const options = Effect.fnUntraced(function* (
  args: ReadonlyArray<string>,
  gates: { readonly live: boolean; readonly hosted: boolean },
) {
  const raw = yield* Effect.try({
    try: () =>
      parseArgs({
        args: [...args],
        options: {
          provider: { type: "string", default: "both" },
          "local-trials": { type: "string", default: "5" },
          "hosted-trials": { type: "string", default: "3" },
          arms: { type: "string", default: "1,2,3,4,5,6" },
          tasks: { type: "string", default: "" },
          seed: { type: "string", default: "1" },
          concurrency: { type: "string", default: "4" },
          "hosted-concurrency": { type: "string" },
          "browser-hourly-usd": { type: "string" },
          model: { type: "string" },
          "max-usd": { type: "string", default: "8" },
          "max-output-tokens": { type: "string", default: "4096" },
          "max-browser-hours": { type: "string", default: "5" },
          "max-browser-usd": { type: "string", default: "1" },
          "parse-origin": { type: "string" },
          "ground-origin": { type: "string" },
          "native-confirmed": { type: "boolean", default: false },
          scripted: { type: "boolean", default: false },
          out: { type: "string" },
          help: { type: "boolean", default: false },
        },
      }).values,
    catch: invalid,
  });

  const provider = yield* Schema.decodeUnknownEffect(
    Schema.Literals(["local", "browserbase", "both"]),
  )(raw.provider).pipe(Effect.mapError(invalid));

  const arms = yield* Schema.decodeUnknownEffect(Schema.Array(Pairing.Arm))(
    raw.arms.split(",").map(Number),
  ).pipe(Effect.mapError(invalid));

  const value: Options = {
    provider,
    arms,
    tasks: raw.tasks === "" ? [] : raw.tasks.split(","),
    localTrials: Number(raw["local-trials"]),
    hostedTrials: Number(raw["hosted-trials"]),
    seed: Number(raw.seed),
    concurrency: Number(raw.concurrency),
    hostedConcurrency:
      raw["hosted-concurrency"] === undefined ? undefined : Number(raw["hosted-concurrency"]),
    model: raw.model,
    maxUsd: Number(raw["max-usd"]),
    maxOutputTokens: Number(raw["max-output-tokens"]),
    browserHourlyUsd:
      raw["browser-hourly-usd"] === undefined ? undefined : Number(raw["browser-hourly-usd"]),
    maxBrowserHours: Number(raw["max-browser-hours"]),
    maxBrowserUsd: Number(raw["max-browser-usd"]),
    parseOrigin: raw["parse-origin"],
    groundOrigin: raw["ground-origin"],
    nativeConfirmed: raw["native-confirmed"],
    scripted: raw.scripted,
    out: raw.out,
    help: raw.help,
  };

  if (value.help) return value;
  if (
    ![value.localTrials, value.hostedTrials].every(
      (n) => Number.isSafeInteger(n) && n >= 0 && n <= 1000,
    ) ||
    !Number.isSafeInteger(value.seed) ||
    ![value.concurrency, value.maxOutputTokens].every((n) => Number.isSafeInteger(n) && n > 0) ||
    value.concurrency > 32 ||
    value.maxOutputTokens > 32768 ||
    ![value.maxUsd, value.maxBrowserHours, value.maxBrowserUsd].every(
      (n) => Number.isFinite(n) && n > 0,
    ) ||
    new Set(arms).size !== arms.length ||
    arms.length === 0 ||
    new Set(value.tasks).size !== value.tasks.length ||
    value.tasks.some(
      (name) => ![...Pairing.primary, ...Pairing.extension].some((task) => task === name),
    ) ||
    Pairing.pairs(value).every((pair) => pair.order.length === 0) ||
    (value.model !== undefined && value.model.trim().length === 0) ||
    (value.scripted && (value.model !== undefined || value.provider !== "local"))
  )
    return yield* invalid();
  if (value.model !== undefined && !gates.live)
    return yield* new PairedError({ code: "LiveRequired" });
  if (value.model !== undefined && value.provider !== "local") {
    if (!gates.hosted) return yield* new PairedError({ code: "HostedRequired" });
    if (
      value.hostedConcurrency === undefined ||
      !Number.isSafeInteger(value.hostedConcurrency) ||
      value.hostedConcurrency < 1 ||
      value.hostedConcurrency > 32 ||
      value.browserHourlyUsd === undefined ||
      !Number.isFinite(value.browserHourlyUsd) ||
      value.browserHourlyUsd <= 0 ||
      Math.floor(
        Math.min(
          value.maxBrowserHours,
          value.browserHourlyUsd === 0
            ? value.maxBrowserHours
            : value.maxBrowserUsd / value.browserHourlyUsd,
        ) * 3600,
      ) < Hosted.sessionSeconds
    )
      return yield* invalid();
  }

  return value;
});

export const manifest = (configuration: Options, revision: string, createdAt: string) => ({
  version: 1,
  revision,
  createdAt,
  mode: configuration.scripted
    ? "scripted"
    : configuration.model === undefined
      ? "preview"
      : "paid",
  interpretation: configuration.scripted
    ? "Fixture plumbing only; no arm quality or speed claims."
    : "Paired experiment; failures remain in denominators.",
  // Local service origins and capabilities are runtime inputs, not durable experiment evidence.
  configuration: {
    provider: configuration.provider,
    arms: configuration.arms,
    tasks: configuration.tasks,
    localTrials: configuration.localTrials,
    hostedTrials: configuration.hostedTrials,
    seed: configuration.seed,
    concurrency: configuration.concurrency,
    hostedConcurrency: configuration.hostedConcurrency ?? null,
    model: configuration.model ?? null,
    maxUsd: configuration.maxUsd,
    maxOutputTokens: configuration.maxOutputTokens,
    maxBrowserHours: configuration.maxBrowserHours,
    maxBrowserUsd: configuration.maxBrowserUsd,
    browserHourlyUsd: configuration.browserHourlyUsd ?? null,
    nativeConfirmed: configuration.nativeConfirmed,
  },
  design: Pairing.design,
  reasoning: { operate: "medium", understand: "none", native: "medium" },
  workerTimeoutMillis: 540000,
  requestTimeoutMillis: 120000,
  sessionTimeoutSeconds: Hosted.sessionSeconds,
  pairs: Pairing.pairs(configuration),
});

export type Manifest = ReturnType<typeof manifest>;
type Reason =
  | "graded"
  | "worker-failed"
  | "preview"
  | "prerequisite-blocked"
  | "setup-failed"
  | "budget-stopped"
  | "infrastructure-stopped";

export interface Record extends Pairing.Observation {
  readonly reason: Reason;
  readonly wallMillis: number | null;
  readonly admissionMillis: number | null;
  readonly worker: Worker.Result | null;
  readonly process: Worker.Execution["process"] | null;
  readonly protocol: Awaited<Effect.Success<ReturnType<typeof Worker.run>>>["protocol"] | null;
  readonly accounting: Accounting;
  readonly tokenDetails: { readonly image: number | null; readonly reasoning: number | null };
  readonly modelMetrics: ModelBroker.Metrics | null;
  readonly diagnostic: Diagnostics.Failure | null;
  readonly lastResponse: Diagnostics.LastResponse | null;
}

const emptyAccounting: Accounting = {
  calls: 0,
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  knownUsd: 0,
  reservedUsd: 0,
  uncertainCalls: 0,
};

const row = (pair: Pairing.Pair, arm: Pairing.Arm, reason: Reason): Record => ({
  provider: pair.provider,
  stratum: pair.stratum,
  kind: pair.kind,
  task: pair.task,
  trial: pair.trial,
  seed: pair.seed,
  arm,
  status: "unrun",
  pass: null,
  millis: null,
  wallMillis: null,
  admissionMillis: null,
  knownUsd: 0,
  reservedUsd: 0,
  reason,
  worker: null,
  process: null,
  protocol: null,
  accounting: emptyAccounting,
  tokenDetails: { image: 0, reasoning: 0 },
  modelMetrics: null,
  diagnostic: null,
  lastResponse: null,
});

const output = <A>(operation: () => A) =>
  Effect.try({ try: operation, catch: () => new PairedError({ code: "Output" }) });

const prerequisite = (origin: string | undefined, mode: "parse" | "ground") =>
  origin === undefined
    ? Effect.succeed<PerceptionStatus | null>(null)
    : Effect.gen(function* () {
        const service = yield* Perception;
        const status = yield* service.status;

        return status.mode === mode ? status : null;
      }).pipe(
        Effect.provide(Perception.layer({ origin })),
        Effect.orElseSucceed(() => null),
      );

export const run = Effect.fnUntraced(function* (configuration: Options) {
  if (configuration.model !== undefined)
    yield* Effect.try({
      try: () => {
        if (
          execFileSync("git", ["status", "--porcelain"], {
            encoding: "utf8",
            cwd: repository,
          }).trim() !== ""
        )
          throw new PairedError({ code: "SourceDirty" });
      },
      catch: (error) =>
        Schema.is(PairedError)(error) ? error : new PairedError({ code: "Setup" }),
    });
  const createdAt = DateTime.formatIso(yield* DateTime.now);

  const revision = yield* Effect.try({
    try: () =>
      execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", cwd: repository }).trim(),
    catch: () => new PairedError({ code: "Setup" }),
  });

  const frozen = manifest(configuration, revision, createdAt);

  const directory =
    configuration.out ?? join(repository, ".work", "paired", createdAt.replaceAll(":", "-"));

  yield* output(() => {
    const within = relative(repository, resolve(directory));

    if (
      within === "" ||
      (within !== ".." && !within.startsWith(".." + sep) && !isAbsolute(within))
    ) {
      execFileSync("git", ["check-ignore", "--quiet", "--no-index", "--", within + "/"], {
        cwd: repository,
        stdio: "ignore",
      });
    }
    mkdirSync(dirname(directory), { recursive: true });
    mkdirSync(directory, { recursive: false });
    writeFileSync(join(directory, "manifest.json"), JSON.stringify(frozen, null, 2) + "\n", {
      flag: "wx",
    });
  });
  const rows = yield* Ref.make<ReadonlyArray<Record>>([]);

  const save = (value: Record) =>
    output(() =>
      appendFileSync(join(directory, "results.jsonl"), JSON.stringify(value) + "\n"),
    ).pipe(
      Effect.andThen(Ref.update(rows, (values) => [...values, value])),
      Effect.uninterruptible,
    );

  const finalized = yield* Ref.make(false);

  const finish = (extra: unknown) =>
    Effect.gen(function* () {
      const values = yield* Ref.get(rows);

      if (yield* Ref.getAndSet(finalized, true)) return values;

      const summary = {
        mode: frozen.mode,
        planned: frozen.pairs.reduce((sum, pair) => sum + pair.order.length, 0),
        recorded: values.length,
        ...Pairing.summarize(values),
        evidence: extra,
      };

      yield* output(() =>
        writeFileSync(join(directory, "summary.json"), JSON.stringify(summary, null, 2) + "\n", {
          flag: "wx",
        }),
      );
      yield* Console.log(
        JSON.stringify({
          directory,
          mode: frozen.mode,
          planned: summary.planned,
          recorded: summary.recorded,
        }),
      );

      return values;
    });

  yield* Effect.addFinalizer(() =>
    Effect.gen(function* () {
      if (yield* Ref.get(finalized)) return;
      const recorded = yield* Ref.get(rows);

      for (const pair of frozen.pairs)
        for (const arm of pair.order) {
          if (
            recorded.some(
              (value) =>
                value.provider === pair.provider &&
                value.task === pair.task &&
                value.trial === pair.trial &&
                value.arm === arm,
            )
          )
            continue;
          yield* save(row(pair, arm, "infrastructure-stopped"));
        }
      yield* finish({ interrupted: true, accountingMayBeIncomplete: true });
    }).pipe(Effect.ignore),
  );
  if (frozen.mode === "preview") {
    yield* Effect.forEach(frozen.pairs, (pair) =>
      Effect.forEach(pair.order, (arm) => save(row(pair, arm, "preview"))),
    );
    yield* finish({ paidCalls: 0, hostedAllocations: 0 });

    return;
  }

  const [parse, ground] = yield* Effect.all(
    [
      prerequisite(configuration.parseOrigin, "parse"),
      prerequisite(configuration.groundOrigin, "ground"),
    ],
    { concurrency: 2 },
  );

  yield* output(() =>
    writeFileSync(
      join(directory, "prerequisites.json"),
      JSON.stringify({ parse, ground, nativeConfirmed: configuration.nativeConfirmed }, null, 2) +
        "\n",
      { flag: "wx" },
    ),
  );

  const ready = (arm: Pairing.Arm, kind: Pairing.Pair["kind"]) =>
    configuration.scripted ||
    (arm === 3
      ? parse?.ready === true
      : arm === 4
        ? kind === "understand" || ground?.ready === true
        : arm === 6
          ? configuration.nativeConfirmed
          : true);

  const gpu = yield* Semaphore.make(1);

  if (configuration.scripted) {
    yield* Effect.forEach(
      frozen.pairs,
      (pair) =>
        Effect.forEach(pair.order, (arm) =>
          Effect.gen(function* () {
            const started = performance.now();

            const result = yield* Worker.run(
              {
                task: pair.task,
                arm,
                seed: pair.seed,
                provider: "local",
                apiUrl: "http://127.0.0.1:1/" + "0".repeat(48),
                model: "scripted",
                reasoning: "none",
                maxOutputTokens: configuration.maxOutputTokens,
                endpoint: null,
                perceptionOrigin: null,
                scripted: true,
              },
              { timeoutMillis: 540000 },
            );

            yield* save({
              ...row(pair, arm, "graded"),
              status: result.result.status === "completed" ? "completed" : "failed",
              reason: result.result.status === "completed" ? "graded" : "worker-failed",
              pass: result.result.status === "completed" ? result.result.pass : null,
              millis: performance.now() - started,
              wallMillis: performance.now() - started,
              admissionMillis: 0,
              worker: result.result,
              process: result.process,
              protocol: result.protocol,
            });
          }),
        ),
      { concurrency: configuration.concurrency },
    );
    const values = yield* finish({ paidCalls: 0, hostedAllocations: 0 });

    if (values.some((value) => value.status !== "completed" || value.pass !== true))
      process.exitCode = 1;

    return;
  }
  if (configuration.model === undefined) return yield* new PairedError({ code: "Setup" });
  const model = configuration.model;

  const setup = yield* modelRunner({
    model,
    rates: undefined,
    maxUsd: configuration.maxUsd,
    maxOutputTokens: configuration.maxOutputTokens,
  }).pipe(Effect.exit);

  if (Exit.isFailure(setup)) {
    yield* Effect.forEach(frozen.pairs, (pair) =>
      Effect.forEach(pair.order, (arm) =>
        save(row(pair, arm, ready(arm, pair.kind) ? "setup-failed" : "prerequisite-blocked")),
      ),
    );
    yield* finish({
      diagnostic: Diagnostics.failure(setup.cause),
      paidCalls: 0,
      hostedAllocations: 0,
    });
    process.exitCode = 1;

    return;
  }
  const budget = setup.value;
  const broker = yield* ModelBroker.make;
  const hourly = configuration.browserHourlyUsd ?? 0;

  const maximumSeconds = Math.floor(
    Math.min(
      configuration.maxBrowserHours,
      hourly === 0 ? configuration.maxBrowserHours : configuration.maxBrowserUsd / hourly,
    ) * 3600,
  );

  const hosted = yield* Hosted.make(Math.max(Hosted.sessionSeconds, maximumSeconds));
  const stopped = yield* Ref.make(false);

  const stop = Ref.set(stopped, true).pipe(
    Effect.andThen(budget.stop),
    Effect.andThen(hosted.stop),
  );

  const withHosted = <A, E, R>(
    effect: Effect.Effect<A, E, R | BrowserbaseClient.BrowserbaseClient>,
  ) =>
    effect.pipe(
      Effect.provide(BrowserbaseClient.layerConfig().pipe(Layer.provide(FetchHttpClient.layer))),
    );

  const one = (pair: Pairing.Pair, arm: Pairing.Arm) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        if (!ready(arm, pair.kind)) {
          yield* save(row(pair, arm, "prerequisite-blocked"));

          return;
        }
        if (yield* Ref.get(stopped)) {
          yield* save(row(pair, arm, "infrastructure-stopped"));

          return;
        }
        if (yield* budget.exhausted) {
          yield* save(row(pair, arm, "budget-stopped"));

          return;
        }
        const started = performance.now();
        let admitted: number | null = null;
        const account = yield* budget.account;
        const reasoning = arm === 6 || pair.kind === "operate" ? "medium" : "none";
        let metrics: ModelBroker.Metrics | null = null;

        const execution = yield* restore(
          Effect.gen(function* () {
            // Model admission precedes any hosted allocation; unused setup reservations are scoped.
            yield* account.reserve;
            admitted = performance.now();
            const client = yield* budget.client(account);

            const native =
              arm === 6
                ? yield* NativeClient.makeLive({
                    account,
                    model,
                    reasoning,
                    maxOutputTokens: configuration.maxOutputTokens,
                    bounds: budget.bounds,
                  })
                : undefined;

            const registration = yield* broker.register({
              model,
              reasoning,
              account,
              client,
              native,
              timeoutMillis: 120000,
            });

            const endpoint =
              pair.provider === "local"
                ? null
                : yield* withHosted(
                    Effect.gen(function* () {
                      const provider = yield* BrowserbaseClient.BrowserbaseClient;

                      return yield* hosted.open(provider);
                    }),
                  ).pipe(Effect.map(Redacted.value));

            const result = yield* Worker.run(
              {
                task: pair.task,
                arm,
                seed: pair.seed,
                provider: pair.provider,
                apiUrl: registration.apiUrl,
                model,
                reasoning,
                maxOutputTokens: configuration.maxOutputTokens,
                endpoint,
                perceptionOrigin:
                  (arm === 3
                    ? configuration.parseOrigin
                    : arm === 4
                      ? configuration.groundOrigin
                      : undefined) ?? null,
                scripted: false,
              },
              { timeoutMillis: 540000 },
            );

            yield* registration.close;
            metrics = yield* registration.metrics;

            return result;
          }).pipe(Effect.scoped),
        ).pipe(Effect.exit);

        const accounting = yield* account.snapshot;
        const failed = Exit.isFailure(execution) || execution.value.result.status !== "completed";
        const result = Exit.isSuccess(execution) ? execution.value : null;

        if (failed || accounting.uncertainCalls > 0 || (yield* hosted.snapshot).stopped)
          yield* stop;
        yield* save({
          ...row(pair, arm, failed ? "worker-failed" : "graded"),
          status: failed ? "failed" : "completed",
          pass: failed ? null : (result?.result.pass ?? null),
          millis: admitted === null ? null : performance.now() - admitted,
          wallMillis: performance.now() - started,
          admissionMillis: admitted === null ? null : admitted - started,
          worker: result?.result ?? null,
          process: result?.process ?? null,
          protocol: result?.protocol ?? null,
          accounting,
          knownUsd: accounting.knownUsd,
          reservedUsd: accounting.reservedUsd,
          tokenDetails: yield* account.tokens,
          modelMetrics: metrics,
          diagnostic: Exit.isFailure(execution) ? Diagnostics.failure(execution.cause) : null,
          lastResponse: yield* account.lastResponse,
        });
      }),
    ).pipe(Effect.onError(() => stop));

  // The report stages local first, then hosted. One GPU service permit covers each whole trial.
  for (const provider of ["local", "browserbase"] as const) {
    yield* Effect.forEach(
      frozen.pairs.filter((pair) => pair.provider === provider),
      (pair) =>
        Effect.forEach(pair.order, (arm) =>
          arm === 3 || arm === 4 ? gpu.withPermits(1)(one(pair, arm)) : one(pair, arm),
        ),
      {
        concurrency:
          provider === "local" ? configuration.concurrency : (configuration.hostedConcurrency ?? 1),
      },
    );
  }

  const values = yield* finish({
    model: yield* budget.snapshot,
    hosted: yield* hosted.snapshot,
    modelRequestBoundUsd: budget.requestUsd,
    hostedCostIsEstimate: true,
    hourlyRateUsd: configuration.browserHourlyUsd ?? null,
  });

  if (
    values.some((value) => value.status !== "completed") ||
    (yield* budget.snapshot).reservedUsd > 0
  )
    process.exitCode = 1;
}, Effect.scoped);

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const program = Effect.gen(function* () {
    const configuration = yield* options(process.argv.slice(2), {
      live: process.env.EFFECT_BROWSER_BENCH_LIVE === "1",
      hosted: process.env.EFFECT_BROWSER_BENCH_HOSTED === "1",
    });

    if (configuration.help) {
      yield* Console.log(help);

      return;
    }
    yield* run(configuration);
  });

  const controller = new AbortController();
  const abort = () => controller.abort();

  process.once("SIGINT", abort);
  process.once("SIGTERM", abort);
  const result = await Effect.runPromiseExit(program, { signal: controller.signal });

  process.off("SIGINT", abort);
  process.off("SIGTERM", abort);
  if (Exit.isFailure(result)) {
    // Error objects may contain provider material; only the closed projection leaves this process.
    const error = Cause.findErrorOption(result.cause);

    console.error(
      JSON.stringify({
        status: "failed",
        code:
          Option.isSome(error) && Schema.is(PairedError)(error.value) ? error.value.code : "Other",
        diagnostic: Diagnostics.failure(result.cause),
      }),
    );
    process.exitCode = 1;
  }
}
