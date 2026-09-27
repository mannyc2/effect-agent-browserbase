import { writeFile } from "node:fs/promises";
import { dirname } from "node:path";

import { Console, Effect, Exit, FileSystem, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";
import { FetchHttpClient } from "effect/unstable/http";

import * as Campaign from "./Campaign.ts";
import { cases, maxRuns, plan, Split, Termination } from "./Cases.ts";
import { EvidenceError, Journal, load, manifest, save, tagOf } from "./Evidence.ts";
import { grade } from "./Grading.ts";
import { Ledger } from "./Spend.ts";

const trials = Flag.Int("trials").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  Flag.withDefault(1),
);

/** The whole matrix is known before anything runs; a larger plan is refused, not truncated. */
const bounded = (count: number) =>
  plan(count).length > maxRuns
    ? Effect.fail(new EvidenceError({ operation: `plan exceeds ${maxRuns} runs` }))
    : Effect.succeed(plan(count));

const heldOut =
  "held-out results must not inform Tool, instruction or prompt changes; one that does is re-declared tuning at a new revision";

const preview = Command.make(
  "preview",
  { trials },
  Effect.fn(function* ({ trials }) {
    const runs = yield* bounded(trials);

    yield* Console.log(
      JSON.stringify(
        {
          version: 4,
          mode: "unpaid-plan",
          concurrency: 1,
          maxRuns,
          cases: Object.fromEntries(
            Object.entries(cases).map(([task, declared]) => [
              task,
              {
                family: declared.family,
                revision: declared.revision,
                split: declared.split,
                attack: declared.attack,
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
            "a real model runs only through `campaign`, after `plan` and an approved digest",
          splits: Object.fromEntries(
            Split.literals.map((split) => [
              split,
              Object.entries(cases)
                .filter(([, declared]) => declared.split === split)
                .map(([task]) => task),
            ]),
          ),
          heldOut,
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

const source = Flag.String("source-revision").pipe(
  Flag.withSchema(Schema.String.check(Schema.isPattern(/^[a-f0-9]{40}$/))),
);

const nonnegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const Outcome = Schema.Struct({
  runId: Schema.String,
  split: Split,
  /** The campaign's model for a measured run; null for a script. */
  subject: Schema.NullOr(Schema.String),
  recorded: Schema.Boolean,
  harness: Schema.NullOr(Schema.String),
  evidence: Schema.Literals(["complete", "incomplete"]),
  calibrated: Schema.NullOr(Schema.Boolean),
  termination: Termination,
  costMicrousd: Schema.NullOr(nonnegative),
});

type Outcome = typeof Outcome.Type;

/** Evidence is saved when a run ends, on failure or interruption too, before the next starts. */
const recorder =
  (directory: string, outcomes: Array<Outcome>) =>
  (runId: string, journal: Journal, exit: Exit.Exit<void, unknown>) =>
    Effect.gen(function* () {
      const harness = Exit.isFailure(exit) ? tagOf(exit.cause) : null;

      if (harness !== null && journal.facts.terminal === "missing")
        journal.facts = {
          ...journal.facts,
          terminal: harness === "Interrupt" ? "cancelled" : "failed",
          // A browser fault that escaped the runner, such as a failed launch, is still a browser fault.
          failure: {
            category:
              harness === "Interrupt"
                ? "interrupted"
                : harness === "BrowserError" || harness === "InitializationError"
                  ? "browser"
                  : "infrastructure",
            tag: harness,
          },
        };
      const evidence = journal.snapshot();
      const report = grade(evidence);
      const saved = yield* save(evidence, report, `${directory}/${runId}`).pipe(Effect.exit);

      outcomes.push({
        runId,
        split: evidence.manifest.split,
        subject: evidence.manifest.subject,
        recorded: Exit.isSuccess(saved),
        harness,
        evidence: report.evidence,
        calibrated: harness === null ? report.calibration.agrees : null,
        termination: report.termination,
        costMicrousd: evidence.facts.usage?.costMicrousd ?? null,
      });
      yield* Console.log(JSON.stringify({ run: runId, ...report }));
    });

const summaryFile = (directory: string, summary: unknown) =>
  Effect.tryPromise({
    try: () =>
      writeFile(`${directory}/campaign.json`, JSON.stringify(summary, null, 2), { flag: "wx" }),
    catch: () => new EvidenceError({ operation: "save campaign summary" }),
  });

const splits = (
  planned: ReadonlyArray<{ readonly split: typeof Split.Type }>,
  outcomes: ReadonlyArray<Outcome>,
) =>
  Object.fromEntries(
    Split.literals.map((split) => [
      split,
      {
        planned: planned.filter((entry) => entry.split === split).length,
        recorded: outcomes.filter((outcome) => outcome.split === split && outcome.recorded).length,
      },
    ]),
  );

const run = Command.make(
  "run",
  { directory, trials, source },
  Effect.fn(function* ({ directory, trials, source }) {
    const runs = yield* bounded(trials);
    const fs = yield* FileSystem.FileSystem;

    // Refuse an existing campaign before importing runners or acquiring a browser.
    yield* fs.makeDirectory(dirname(directory), { recursive: true });
    yield* fs.makeDirectory(directory);
    const { run: execute } = yield* Effect.promise(() => import("./Tasks.ts"));
    const outcomes: Array<Outcome> = [];
    const record = recorder(directory, outcomes);

    // Serial and exhaustive: a failed run is retained and counted, and the next run still starts.
    const campaign = Effect.forEach(
      runs,
      (entry) => {
        const journal = new Journal(manifest(entry, source));

        return execute(journal).pipe(
          Effect.onExit((exit) => record(entry.runId, journal, exit)),
          Effect.exit,
        );
      },
      { discard: true },
    );

    const summarize = Effect.suspend(() => {
      const summary = {
        version: 4,
        sourceRevision: source,
        planned: runs.length,
        recorded: outcomes.filter((outcome) => outcome.recorded).length,
        // Held-out runs are counted apart, so a tuning result is never reported as held-out.
        splits: splits(
          runs.map((entry) => ({ split: cases[entry.task].split })),
          outcomes,
        ),
        harnessFailures: outcomes.filter((outcome) => outcome.harness !== null).length,
        incompleteEvidence: outcomes.filter((outcome) => outcome.evidence === "incomplete").length,
        calibrationDisagreements: outcomes.filter((outcome) => outcome.calibrated === false).length,
        outcomes,
      };

      return summaryFile(directory, summary).pipe(Effect.as(summary));
    });

    // The summary is written even when the campaign itself is interrupted.
    yield* campaign.pipe(Effect.onInterrupt(() => Effect.ignore(summarize)));
    const summary = yield* summarize;

    yield* Console.log(JSON.stringify({ campaign: directory, ...summary, outcomes: undefined }));
    if (
      summary.recorded !== summary.planned ||
      summary.harnessFailures > 0 ||
      summary.incompleteEvidence > 0 ||
      summary.calibrationDisagreements > 0
    )
      return yield* new EvidenceError({ operation: "campaign incomplete or miscalibrated" });
  }),
);

const specification = Argument.String("specification");

/** A bounded JSON file; anything else is refused as a specification. */
const read = (path: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const size = (yield* fs.stat(path)).size;

    if (size > 65536) return yield* Effect.fail(undefined);

    return JSON.parse(yield* fs.readFileString(path)) as unknown;
  }).pipe(
    Effect.catchCause(() =>
      Effect.fail(
        new Campaign.CampaignRefusal({
          reason: "specification",
          message: "The specification must be a JSON file of at most 64 KiB.",
        }),
      ),
    ),
  );

/** A dry run: the whole real-model matrix and its bounds. It reads no credential and spends nothing. */
const planCommand = Command.make(
  "plan",
  { specification },
  Effect.fn(function* ({ specification }) {
    const shown = yield* Campaign.plan(yield* read(specification));

    yield* Console.log(
      JSON.stringify(
        {
          ...shown,
          paidExecution: `campaign runs this plan only with ${shown.optIn}, --approve ${shown.digest} and ${shown.credentials.join(", ")}`,
        },
        null,
        2,
      ),
    );
  }),
);

/**
 * A live real-model campaign. The opt-in, the approved digest and every credential are checked
 * before its directory exists, a runner is loaded, a browser starts or a model is called.
 */
const campaignCommand = Command.make(
  "campaign",
  {
    specification,
    directory,
    source,
    approve: Flag.String("approve").pipe(Flag.optional),
  },
  Effect.fn(function* ({ specification, directory, source, approve }) {
    const { plan: shown, credentials } = yield* Campaign.authorize(
      yield* read(specification),
      Option.getOrUndefined(approve),
    );

    const fs = yield* FileSystem.FileSystem;

    yield* fs.makeDirectory(dirname(directory), { recursive: true });
    yield* fs.makeDirectory(directory);
    yield* fs.writeFileString(`${directory}/plan.json`, JSON.stringify(shown, null, 2));

    const [{ run: execute }, { measured }] = yield* Effect.promise(() =>
      Promise.all([import("./Tasks.ts"), import("./Provider.ts")]),
    );

    const ledger = new Ledger(shown.budget.campaignMicrousd);
    const outcomes: Array<Outcome> = [];
    const notStarted: Array<string> = [];
    const record = recorder(directory, outcomes);

    // Serial, in the approved order. A broken price contract stops admission, so the runs left
    // are listed as not started rather than refused one by one.
    const campaign = Effect.forEach(
      shown.runs,
      (entry) =>
        Effect.suspend(() => {
          const subject = shown.subjects.find((candidate) => candidate.id === entry.subject);
          const apiKey = subject === undefined ? undefined : credentials[subject.provider];

          if (ledger.closed !== null || subject === undefined || apiKey === undefined) {
            notStarted.push(entry.runId);

            return Effect.void;
          }
          const journal = new Journal(Campaign.measuredManifest(shown, entry, source));

          const driver = measured({
            subject,
            allowance: Campaign.allowance(ledger, shown, subject),
            apiKey,
            journal,
            transport: FetchHttpClient.layer,
          });

          return execute(journal, driver).pipe(
            Effect.onExit((exit) => record(entry.runId, journal, exit)),
            Effect.exit,
          );
        }),
      { discard: true },
    );

    const summarize = Effect.suspend(() => {
      const summary = {
        version: 1,
        mode: "real-model",
        name: shown.name,
        digest: shown.digest,
        sourceRevision: source,
        planned: shown.runs.length,
        recorded: outcomes.filter((outcome) => outcome.recorded).length,
        notStarted,
        splits: splits(
          shown.runs.map((entry) => ({ split: cases[entry.task].split })),
          outcomes,
        ),
        subjects: Object.fromEntries(
          shown.subjects.map((subject) => {
            const own = outcomes.filter((outcome) => outcome.subject === subject.id);

            return [
              subject.id,
              {
                planned: shown.runs.filter((entry) => entry.subject === subject.id).length,
                recorded: own.filter((outcome) => outcome.recorded).length,
                costMicrousd: own.reduce((sum, outcome) => sum + (outcome.costMicrousd ?? 0), 0),
              },
            ];
          }),
        ),
        spend: {
          spentMicrousd: ledger.spentMicrousd,
          limitMicrousd: ledger.limitMicrousd,
          closed: ledger.closed,
          estimate: "reported usage at the plan's dated rates; not an invoice",
        },
        spendRefused: outcomes.filter((outcome) => outcome.termination === "spend-refused").length,
        harnessFailures: outcomes.filter((outcome) => outcome.harness !== null).length,
        incompleteEvidence: outcomes.filter((outcome) => outcome.evidence === "incomplete").length,
        outcomes,
      };

      return summaryFile(directory, summary).pipe(Effect.as(summary));
    });

    yield* campaign.pipe(Effect.onInterrupt(() => Effect.ignore(summarize)));
    const summary = yield* summarize;

    yield* Console.log(JSON.stringify({ campaign: directory, ...summary, outcomes: undefined }));
    if (
      summary.recorded !== summary.planned ||
      summary.harnessFailures > 0 ||
      summary.incompleteEvidence > 0 ||
      ledger.closed !== null
    )
      return yield* new EvidenceError({ operation: "campaign incomplete or stopped" });
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

export const cli = Command.make("browser-evaluation").pipe(
  Command.withSubcommands([preview, run, planCommand, campaignCommand, regrade, replayCommand]),
);
