import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Console, Effect, Exit, FileSystem, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { cases, maxRuns, plan, type Entry } from "./Cases.ts";
import { EvidenceError, Journal, load, manifest, save, tagOf } from "./Evidence.ts";
import { grade } from "./Grading.ts";

const trials = Flag.Int("trials").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  Flag.withDefault(1),
);

/** The whole matrix is known before anything runs; a larger plan is refused, not truncated. */
const bounded = (count: number) =>
  plan(count).length > maxRuns
    ? Effect.fail(new EvidenceError({ operation: `plan exceeds ${maxRuns} runs` }))
    : Effect.succeed(plan(count));

const preview = Command.make(
  "preview",
  { trials },
  Effect.fn(function* ({ trials }) {
    const runs = yield* bounded(trials);

    yield* Console.log(
      JSON.stringify(
        {
          version: 2,
          mode: "unpaid-plan",
          concurrency: 1,
          maxRuns,
          cases: Object.fromEntries(
            Object.entries(cases).map(([task, declared]) => [
              task,
              {
                family: declared.family,
                goal: declared.goal,
                initialState: declared.initialState,
                backend: declared.backend,
                bounds: declared.bounds,
                policies: declared.policies,
              },
            ]),
          ),
          runs: runs.map((entry) => manifest(entry, "unavailable")),
          paidExecution:
            "unavailable; model/browser budgets and adapters are pending separate authorization",
          heldOut: "none; these development fixtures are tuning cases",
          calibration:
            "deterministic oracles only: every known-bad policy must be graded as declared",
          judges: "disabled",
        },
        null,
        2,
      ),
    );
  }),
);

const directory = Argument.String("directory");

const Outcome = Schema.Struct({
  runId: Schema.String,
  recorded: Schema.Boolean,
  harness: Schema.NullOr(Schema.String),
  calibrated: Schema.NullOr(Schema.Boolean),
});

const run = Command.make(
  "run",
  {
    directory,
    trials,
    source: Flag.String("source-revision").pipe(
      Flag.withSchema(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
    ),
    backend: Flag.Literals("backend", ["chromium", "browserbase"]).pipe(
      Flag.withDefault("chromium"),
    ),
    provider: Flag.Literals("provider", ["scripted", "real-model"]).pipe(
      Flag.withDefault("scripted"),
    ),
  },
  Effect.fn(function* ({ directory, trials, source, backend, provider }) {
    if (backend !== "chromium" || provider !== "scripted")
      return yield* new EvidenceError({
        operation: "paid execution unavailable; no browser or model allocated",
      });
    const runs = yield* bounded(trials);
    const fs = yield* FileSystem.FileSystem;

    // Refuse an existing campaign before importing runners or acquiring a browser.
    yield* fs.makeDirectory(dirname(directory), { recursive: true });
    yield* fs.makeDirectory(directory);
    const { run: execute } = yield* Effect.promise(() => import("./Tasks.ts"));
    const outcomes: Array<typeof Outcome.Type> = [];

    // Evidence is saved when a run ends, on failure or interruption too, before the next starts.
    const record = (entry: Entry, journal: Journal, exit: Exit.Exit<void, unknown>) =>
      Effect.gen(function* () {
        const harness = Exit.isFailure(exit) ? tagOf(exit.cause) : null;

        if (harness !== null && journal.facts.terminal === "missing")
          journal.facts = {
            ...journal.facts,
            terminal: harness === "Interrupt" ? "cancelled" : "failed",
            failure: {
              category: harness === "Interrupt" ? "interrupted" : "infrastructure",
              tag: harness,
            },
          };
        const evidence = journal.snapshot();
        const report = grade(evidence);

        const saved = yield* save(evidence, report, `${directory}/${entry.runId}`).pipe(
          Effect.exit,
        );

        outcomes.push({
          runId: entry.runId,
          recorded: Exit.isSuccess(saved),
          harness,
          calibrated: harness === null ? report.calibration.agrees : null,
        });
        yield* Console.log(JSON.stringify({ run: entry.runId, ...report }));
      });

    // Serial and exhaustive: a failed run is retained and counted, and the next run still starts.
    const campaign = Effect.forEach(
      runs,
      (entry) => {
        const journal = new Journal(manifest(entry, source));

        return execute(journal).pipe(
          Effect.onExit((exit) => record(entry, journal, exit)),
          Effect.exit,
        );
      },
      { discard: true },
    );

    const summarize = Effect.suspend(() => {
      const summary = {
        version: 2,
        sourceRevision: source,
        planned: runs.length,
        recorded: outcomes.filter((outcome) => outcome.recorded).length,
        harnessFailures: outcomes.filter((outcome) => outcome.harness !== null).length,
        calibrationDisagreements: outcomes.filter((outcome) => outcome.calibrated === false).length,
        outcomes,
      };

      return Effect.tryPromise({
        try: () =>
          writeFile(`${directory}/campaign.json`, JSON.stringify(summary, null, 2), {
            flag: "wx",
          }),
        catch: () => new EvidenceError({ operation: "save campaign summary" }),
      }).pipe(Effect.as(summary));
    });

    // The summary is written even when the campaign itself is interrupted.
    yield* campaign.pipe(Effect.onInterrupt(() => Effect.ignore(summarize)));
    const summary = yield* summarize;

    yield* Console.log(JSON.stringify({ campaign: directory, ...summary, outcomes: undefined }));
    if (
      summary.recorded !== summary.planned ||
      summary.harnessFailures > 0 ||
      summary.calibrationDisagreements > 0
    )
      return yield* new EvidenceError({ operation: "campaign incomplete or miscalibrated" });
  }),
);

const regrade = Command.make(
  "grade",
  { directory },
  Effect.fn(function* ({ directory }) {
    yield* Console.log(JSON.stringify(grade(yield* load(directory)), null, 2));
  }),
);

const replayCommand = Command.make(
  "replay",
  { directory },
  Effect.fn(function* ({ directory }) {
    const evidence = yield* load(directory);
    const { replay } = yield* Effect.promise(() => import("./Replay.ts"));
    const result = yield* replay(evidence);

    yield* Console.log(
      JSON.stringify({
        mode: "offline-scripted-actions",
        toolkit: evidence.manifest.toolkit,
        output: result.output,
      }),
    );
  }),
);

Command.make("browser-evaluation").pipe(
  Command.withSubcommands([preview, run, regrade, replayCommand]),
  Command.run({ version: "2.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
