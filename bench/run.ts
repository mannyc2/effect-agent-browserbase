// The `run` command. Without a model it runs the free scripted solutions; model calls and hosted
// browsers cost money, so each needs its opt-in. Each trial owns its browser, random seed and
// accounting; only the admission budget is shared.
import { OpenRouterLanguageModel } from "@effect/ai-openrouter";
import {
  Cause,
  Clock,
  Console,
  DateTime,
  Duration,
  Effect,
  Exit,
  FileSystem,
  Layer,
  Option,
  Path,
  Random,
  Ref,
  Schema,
  Tracer,
} from "effect";
import * as Chromium from "effect-browser/Chromium";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import * as ContextLease from "effect-browserbase/ContextLease";
import { Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { type Arm, armNames, arms } from "./Arms.ts";
import { BenchError, efforts, modelRunner, noCalls, noTiming, optedIn, refuse } from "./Budget.ts";
import { tasks } from "./Catalog.ts";
import * as Diagnostics from "./Diagnostics.ts";
import * as Latency from "./Latency.ts";
import * as Recorder from "./Recorder.ts";
import * as Relay from "./Relay.ts";
import * as Report from "./Report.ts";
import * as Results from "./Results.ts";
import { frameHistory } from "./Tasks.ts";
import * as Trace from "./Trace.ts";
import {
  type Classification,
  classify,
  isolatedTrial,
  journal,
  notAdmitted,
  revision,
  type RunInfo,
  Split,
  trialSeed,
  uncertainAllocation,
  workDeadline,
} from "./Trial.ts";

// A hosted session outlives the trial that owns it only until Browserbase's own timeout, which
// bounds a session the bench could not release.
export const trialTimeout = Duration.minutes(10);
// The trial deadline excludes time queued for the budget, so a session also allows for queueing;
// one that outlives even this fails its trial as infrastructure.
export const hostedSessionSeconds = 30 * 60;

/**
 * Each hosted trial's browser: a new 1280×720 session that ends at least by its own timeout, with
 * `userMetadata` for Browserbase to show with it. It saves to no stored context, so each trial can
 * have a lease of its own.
 */
export const hostedBrowser = (userMetadata?: Readonly<Record<string, string>>) =>
  Browserbase.layer({
    frameHistory,
    session: {
      timeout: hostedSessionSeconds,
      browserSettings: { viewport: { width: 1280, height: 720 } },
      userMetadata,
    },
  }).pipe(Layer.provide(ContextLease.layer));

/** A failure as the bench may print or record it: provider errors can embed URLs or ids. */
export const errorText = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  if (Schema.is(BenchError)(error)) return error.message;
  if (Cause.hasInterruptsOnly(cause)) return "Interrupted";

  return error instanceof Error ? error.name : "Trial failed";
};

const atLeast = (minimum: number) => Schema.Finite.check(Schema.isGreaterThanOrEqualTo(minimum));

const flags = {
  task: Flag.Literals(
    "task",
    tasks.map((task) => task.name),
  ).pipe(Flag.atLeast(0), Flag.withDescription("Run this task; repeat for more. Defaults to all.")),
  trials: Flag.Int("trials").pipe(
    Flag.withSchema(atLeast(1)),
    Flag.withDefault(1),
    Flag.withDescription("Trials per task. Defaults to 1."),
  ),
  concurrency: Flag.Int("concurrency").pipe(
    Flag.withSchema(atLeast(1)),
    Flag.withDefault(4),
    Flag.withDescription("Independent trials in flight. Defaults to 4."),
  ),
  seed: Flag.Int("seed").pipe(
    Flag.withDefault(1),
    Flag.withDescription("Base seed for each trial's page data and randomness. Defaults to 1."),
  ),
  split: Flag.Literals("split", Split.literals).pipe(
    Flag.withDefault("dev"),
    Flag.withDescription(
      "The family of seeds: dev to work on prompts and tools, eval, held out, to compare arms. Defaults to dev.",
    ),
  ),
  model: Flag.String("model").pipe(
    Flag.optional,
    Flag.withDescription("OpenRouter model; omit for the free scripted solutions."),
  ),
  arm: Flag.ChoiceWithValue(
    "arm",
    arms.map((arm) => [String(arm), arm] as const),
  ).pipe(
    Flag.atLeast(0),
    Flag.withDescription(
      `With a model, how it sees and acts on the page; repeat to compare arms on the same seeds. Defaults to 5. ${arms.map((arm) => `${arm}: ${armNames[arm]}`).join("; ")}.`,
    ),
  ),
  reasoning: Flag.Literals("reasoning", efforts).pipe(
    Flag.optional,
    Flag.withDescription(
      "Reasoning effort. Defaults to medium for operate and none for understand.",
    ),
  ),
  maxUsd: Flag.Finite("max-usd").pipe(
    Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0))),
    Flag.withDefault(2),
    Flag.withDescription("Shared token/provider admission budget, in USD. Defaults to 2."),
  ),
  maxOutputTokens: Flag.Int("max-output-tokens").pipe(
    Flag.withSchema(atLeast(16)),
    Flag.withDefault(4096),
    Flag.withDescription("Completion ceiling per call, including reasoning. Defaults to 4096."),
  ),
  rates: Flag.String("rates").pipe(
    Flag.optional,
    Flag.withDescription(
      "Provider price ceilings as in,out, in USD per million tokens; defaults to listed prices.",
    ),
  ),
  browser: Flag.Literals("browser", ["chromium", "browserbase"]).pipe(
    Flag.withDefault("chromium"),
    Flag.withDescription("Where each trial's browser runs. Defaults to chromium."),
  ),
  latency: Flag.Finite("latency").pipe(
    Flag.withSchema(Schema.Finite.check(Schema.isGreaterThan(0), Schema.isLessThanOrEqualTo(5000))),
    Flag.optional,
    Flag.withDescription(
      "With chromium, add this many milliseconds to every round trip between the bench and the browser, as a remote one has.",
    ),
  ),
  humanize: Flag.Boolean("humanize").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Perform the input for viewers, through a presenter: the pointer glides, keys go at a person's pace.",
    ),
  ),
  record: Flag.Boolean("record").pipe(
    Flag.withDefault(false),
    Flag.withDescription(
      "Record each trial's frames, events and turns for replay, in a directory beside the results file.",
    ),
  ),
  narrate: Flag.Finite("narrate").pipe(
    Flag.withSchema(atLeast(1)),
    Flag.optional,
    Flag.withDescription(
      "With a model, caption operate tasks' pages this often, in seconds, while the agent works, with reasoning off; captions are recorded.",
    ),
  ),
  out: Flag.String("out").pipe(
    Flag.optional,
    Flag.withDescription("Results directory. Defaults to .work/bench in the repository."),
  ),
};

export const command = Command.make(
  "run",
  flags,
  Effect.fnUntraced(function* (options) {
    const model = Option.getOrUndefined(options.model);
    const reasoning = Option.getOrUndefined(options.reasoning);
    const latency = Option.getOrUndefined(options.latency);
    const narrateSeconds = Option.getOrUndefined(options.narrate);
    const hosted = options.browser === "browserbase";

    if (narrateSeconds !== undefined && model === undefined)
      return yield* refuse("--narrate needs --model: captions are model calls");
    if (options.arm.length > 0 && model === undefined)
      return yield* refuse("--arm needs --model: the scripted solutions have no arms");
    if (latency !== undefined && hosted)
      return yield* refuse("--latency slows a local chromium; a hosted browser has its own");
    if (model !== undefined && !(yield* optedIn("EFFECT_BROWSER_BENCH_LIVE")))
      return yield* refuse("model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them");
    if (hosted && !(yield* optedIn("EFFECT_BROWSER_BENCH_HOSTED")))
      return yield* refuse("Browserbase sessions cost money: set EFFECT_BROWSER_BENCH_HOSTED=1");

    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;

    const browserbaseClient = BrowserbaseClient.layerConfig().pipe(
      Layer.provide(FetchHttpClient.layer),
    );

    // A trial's browser. A latency or hosted run's records the DevTools commands the trial sends,
    // and a hosted run's session carries the trial's `metadata`.
    const browser = (trial: {
      readonly record: (command: Latency.Command) => void;
      readonly metadata: Readonly<Record<string, string>>;
    }) => {
      return hosted
        ? hostedBrowser(trial.metadata).pipe(
            Layer.provide(Relay.client(trial.record).pipe(Layer.provide(browserbaseClient))),
          )
        : latency !== undefined
          ? Latency.layer(latency, { frameHistory }, trial.record)
          : Chromium.layer({ frameHistory });
    };

    // After a create whose outcome is unknown, no further hosted session is requested.
    const hostedHalt = yield* Ref.make(false);

    const selected =
      options.task.length === 0
        ? tasks
        : tasks.filter((candidate) => options.task.includes(candidate.name));

    const runner =
      model === undefined
        ? undefined
        : yield* modelRunner({
            model,
            rates: Option.getOrUndefined(options.rates),
            maxUsd: options.maxUsd,
            maxOutputTokens: options.maxOutputTokens,
            needs: {
              tools: selected.some((task) => task.kind === "operate"),
              // Captions are structured too.
              structuredOutput:
                narrateSeconds !== undefined || selected.some((task) => task.kind === "understand"),
            },
          });

    const run: RunInfo = {
      revision: yield* revision,
      model: model ?? null,
      endpoint: runner?.endpoint ?? null,
      browser: options.browser,
      latencyMillis: latency ?? null,
      humanize: options.humanize,
      maxOutputTokens: options.maxOutputTokens,
      maxUsd: options.maxUsd,
      concurrency: options.concurrency,
      record: options.record,
      narrateSeconds: narrateSeconds ?? null,
      split: options.split,
    };

    const label = model?.replace(/[^\w.-]+/g, "_") ?? "scripted";
    const stamp = DateTime.formatIso(yield* DateTime.now).replace(/[:.]/g, "-");

    const directory = Option.getOrElse(options.out, () =>
      path.join(import.meta.dirname, "..", ".work", "bench"),
    );

    const file = path.join(directory, `${stamp}-${label}.jsonl`);
    const recordings = path.join(directory, `${stamp}-${label}`);

    // Every arm runs the same seeds, so its trials pair with the other arms' by task and number.
    const jobArms: ReadonlyArray<Arm | null> =
      model === undefined
        ? [null]
        : options.arm.length === 0
          ? [5]
          : arms.filter((arm) => options.arm.includes(arm));

    const jobs = selected.flatMap((task) =>
      Array.from({ length: options.trials }, (_, index) =>
        jobArms.map((arm) => ({ task, arm, trial: index + 1 })),
      ).flat(),
    );

    yield* fs
      .makeDirectory(directory, { recursive: true })
      .pipe(
        Effect.mapError(
          (error) => new BenchError({ message: `could not write bench results: ${error.message}` }),
        ),
      );

    const units = yield* journal(jobs.map((_, index) => index));

    const ledgerSnapshot = (interrupted: boolean) =>
      Effect.gen(function* () {
        const accounting =
          runner === undefined ? { knownUsd: 0, reservedUsd: 0 } : yield* runner.snapshot;

        yield* Results.writeLedger(path.join(directory, `${stamp}-${label}.ledger.json`), {
          ...accounting,
          maxUsd: options.maxUsd,
          interrupted,
        });

        return accounting;
      });

    // An interrupted run still records every trial it scheduled, with what its calls already
    // spent or reserved, and the ledger as it stands.
    const interrupted = Effect.gen(function* () {
      const at = DateTime.formatIso(yield* DateTime.now);

      for (const { key, calls, timing } of yield* units.drain) {
        const job = jobs[key];

        if (job === undefined) continue;
        yield* Results.append(
          file,
          new Results.TrialRecord({
            version: 2,
            task: job.task.name,
            kind: job.task.kind,
            arm: job.arm,
            trial: job.trial,
            baseSeed: options.seed,
            seed: trialSeed(options.seed, job.task.name, job.trial, options.split),
            startedAt: at,
            run,
            reasoning: null,
            status: "unrun",
            reason: "interrupted",
            pass: null,
            onPage: null,
            detail: "Interrupted before an outcome.",
            error: null,
            diagnostic: null,
            lastResponse: calls.lastResponse,
            answer: null,
            steps: null,
            actions: null,
            accounting: calls.accounting,
            timing,
            phases: Trace.noPhases,
            protocol: null,
            roundTripMillis: null,
            region: null,
            traceId: null,
            seconds: 0,
          }),
        );
      }
      yield* ledgerSnapshot(true);
    }).pipe(Effect.ignore({ log: "Error", message: "could not record the interrupted run" }));

    yield* Console.log(
      `Running ${jobs.length} trials, ${options.concurrency} at a time; results in ${file}`,
    );

    const records = yield* Effect.forEach(
      jobs,
      ({ task, arm, trial }, index) =>
        Effect.gen(function* () {
          // A denied or unstarted trial is a durable result too, but must not provision a browser.
          const halted = hosted && (yield* Ref.get(hostedHalt));
          const denied = !halted && runner !== undefined && (yield* runner.exhausted);
          const seed = trialSeed(options.seed, task.name, trial, options.split);
          const effectiveReasoning = reasoning ?? (task.kind === "operate" ? "medium" : "none");
          const started = yield* DateTime.now;
          const startedNanos = yield* Clock.monotonicTimeNanos;

          const account =
            halted || denied || runner === undefined ? undefined : yield* runner.account;

          if (account !== undefined) yield* units.begin(index, account);

          // Arms share trial numbers, so each arm's recording keeps its own directory.
          const recorder = options.record
            ? yield* Recorder.make(
                path.join(recordings, `${task.name}${arm === null ? "" : `-arm${arm}`}-${trial}`),
              )
            : undefined;

          const trace = recorder?.trace;

          const unrecorded =
            runner !== undefined && account !== undefined
              ? runner.withModel(
                  task.withModel({
                    seed,
                    humanize: options.humanize,
                    arm: arm ?? undefined,
                    onUsage: () => Effect.void,
                    trace,
                    narrate:
                      narrateSeconds === undefined ? undefined : Duration.seconds(narrateSeconds),
                    captionCall: OpenRouterLanguageModel.withConfigOverride({
                      reasoning: { effort: "none" },
                    }),
                  }),
                  effectiveReasoning,
                  account,
                )
              : task.scripted({ seed, trace, humanize: options.humanize });

          const work = recorder === undefined ? unrecorded : recorder.around(unrecorded);
          const traced = yield* Trace.collect;
          const commands: Array<Latency.Command> = [];

          // Each trial is a trace of its own, from opening its browser to closing it.
          const exit =
            halted || denied
              ? undefined
              : yield* Effect.option(Effect.currentSpan).pipe(
                  Effect.flatMap((span) =>
                    isolatedTrial(
                      work,
                      browser({
                        record: (command) => commands.push(command),
                        // Browserbase shows these with the session, to find its trial and trace.
                        metadata: {
                          run: stamp,
                          task: task.name,
                          trial: String(trial),
                          ...(arm === null ? {} : { arm: String(arm) }),
                          ...(Option.isSome(span) ? { traceId: span.value.traceId } : {}),
                        },
                      }),
                    ),
                  ),
                  // Pointer paths and typing pace draw from it, so a trial's seed replays them.
                  Random.withSeed(seed),
                  Effect.raceFirst(
                    workDeadline(trialTimeout, account?.queued ?? Effect.succeed(0)),
                  ),
                  // A span's status cannot tell a wrong answer from a broken run; its outcome can.
                  Effect.onExit((ended) =>
                    Effect.flatMap(account?.calls ?? Effect.succeed(noCalls), (calls) => {
                      const { status, reason, pass } = classify(ended, calls);

                      return Effect.annotateCurrentSpan({
                        status,
                        reason,
                        ...(pass === null ? {} : { pass }),
                      });
                    }),
                  ),
                  Effect.withSpan(
                    "bench.trial",
                    {
                      root: true,
                      attributes: {
                        task: task.name,
                        kind: task.kind,
                        ...(arm === null ? {} : { arm }),
                        trial,
                        seed,
                        browser: options.browser,
                        ...(latency === undefined ? {} : { latencyMillis: latency }),
                        humanize: options.humanize,
                        ...(model === undefined
                          ? {}
                          : { "gen_ai.request.model": model, reasoning: effectiveReasoning }),
                        ...(run.revision.commit === null ? {} : { commit: run.revision.commit }),
                      },
                    },
                    { captureStackTrace: false },
                  ),
                  Effect.exit,
                  Effect.provideService(Tracer.Tracer, traced.tracer),
                );

          if (
            hosted &&
            exit !== undefined &&
            Exit.isFailure(exit) &&
            uncertainAllocation(exit.cause)
          )
            yield* Ref.set(hostedHalt, true);

          const seconds =
            exit === undefined ? 0 : Number((yield* Clock.monotonicTimeNanos) - startedNanos) / 1e9;

          // Before the spans are read, so the commands' own spans are among them.
          const protocol =
            (latency === undefined && !hosted) || exit === undefined
              ? null
              : Trace.protocol(traced, commands);

          const calls = account === undefined ? noCalls : yield* account.calls;

          const outcome: Classification =
            exit !== undefined
              ? classify(exit, calls)
              : halted
                ? { status: "unrun", reason: "stopped-after-uncertain-session", pass: null }
                : notAdmitted(runner === undefined ? null : yield* runner.halted);

          const value = exit !== undefined && Exit.isSuccess(exit) ? exit.value : undefined;

          const record = new Results.TrialRecord({
            version: 2,
            task: task.name,
            kind: task.kind,
            arm,
            trial,
            baseSeed: options.seed,
            seed,
            startedAt: DateTime.formatIso(started),
            run,
            reasoning: model === undefined ? null : effectiveReasoning,
            ...outcome,
            onPage: outcome.status === "graded" ? (value?.onPage ?? null) : null,
            detail:
              exit !== undefined
                ? (value?.detail ?? "")
                : halted
                  ? "Unrun: an earlier hosted session create had an unknown outcome."
                  : outcome.status === "denied"
                    ? "Denied: the remaining model budget cannot reserve another call."
                    : "Unrun: model admission had stopped.",
            error: exit !== undefined && Exit.isFailure(exit) ? errorText(exit.cause) : null,
            diagnostic:
              exit !== undefined && Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null,
            lastResponse: calls.lastResponse,
            answer: value?.answer ?? null,
            steps: value?.steps ?? null,
            actions: value?.actions ?? null,
            accounting: calls.accounting,
            timing: account === undefined ? noTiming : yield* account.timing,
            phases: exit === undefined ? Trace.noPhases : Trace.phases(traced.spans),
            protocol,
            roundTripMillis: Trace.roundTripOf(traced.spans),
            region: Trace.regionOf(traced.spans),
            traceId: exit === undefined ? null : Trace.traceOf(traced.spans),
            seconds,
          });

          yield* units.settle(index, Results.append(file, record));
          if (recorder !== undefined)
            yield* recorder
              .finish({
                task: {
                  name: task.name,
                  kind: task.kind,
                  summary: task.summary,
                  prompt: task.prompt,
                },
                run: {
                  trial,
                  seed,
                  model: record.run.model,
                  reasoning: record.reasoning,
                  browser: record.run.browser,
                  humanize: record.run.humanize,
                  commit: record.run.revision.commit,
                  dirty: record.run.revision.dirty,
                },
                outcome: {
                  status: record.status,
                  reason: record.reason,
                  pass: record.pass,
                  detail: record.detail,
                  answer: record.answer,
                  calls: record.accounting.calls,
                  knownUsd: record.accounting.knownUsd,
                  seconds,
                },
                spans: traced.spans,
              })
              .pipe(
                // A recording that cannot be written loses the replay, not the run's other trials.
                Effect.catchTag("BenchError", (error) =>
                  Console.error(`${task.name} #${trial}: recording not written: ${error.message}`),
                ),
              );
          yield* Console.log(
            `${task.name.padEnd(14)}${arm === null ? "" : ` arm ${arm}`} #${trial}  ${record.status === "graded" ? (record.pass === true ? "pass" : "FAIL") : record.status}  ${record.reason}  ${seconds.toFixed(1)}s  ${record.accounting.calls} calls  $${record.accounting.knownUsd.toFixed(4)} known + $${record.accounting.reservedUsd.toFixed(4)} unresolved  ${record.error ?? record.detail}`,
          );

          return record;
        }),
      { concurrency: options.concurrency },
    ).pipe(Effect.onInterrupt(() => interrupted));

    const accounting = yield* ledgerSnapshot(false);

    for (const line of Report.summary(records)) yield* Console.log(line);
    yield* Console.log(
      `\n${Report.totals(records, `$${accounting.knownUsd.toFixed(4)} known + $${accounting.reservedUsd.toFixed(4)} unresolved of $${options.maxUsd}; results in ${file}`)}`,
    );

    // Every trial must reach a graded result with settled charges. A failing scripted solution
    // is a broken bench; a failing model is a result.
    if (
      records.some((record) => record.status !== "graded" || record.accounting.uncertainCalls > 0)
    )
      return yield* refuse("not every trial was graded with settled charges");
    if (model === undefined && records.some((record) => record.pass !== true))
      return yield* refuse("a scripted solution failed, so the bench itself is broken");
  }, Effect.provide(Trace.layer)),
).pipe(
  Command.withDescription(
    "Run tasks: the scripted solutions in local Chromium at no cost, or a model, or a hosted browser, behind their opt-ins.",
  ),
);
