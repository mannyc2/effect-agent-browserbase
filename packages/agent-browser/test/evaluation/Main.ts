import { dirname } from "node:path";

import { NodeRuntime, NodeServices } from "@effect/platform-node";
import { Cause, Console, Effect, Exit, FileSystem, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import { EvidenceError, Journal, grade, load, manifest, save } from "./Evidence.ts";

const trials = Flag.Int("trials").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 10 }))),
  Flag.withDefault(1),
);

const plan = (count: number) =>
  Array.from({ length: count }, (_, trial) => [
    manifest("signup", "base", "unavailable", trial),
    manifest("signup", "observed", "unavailable", trial),
    manifest("cancelled-mutation", "base", "unavailable", trial),
  ]).flat();

const preview = Command.make("preview", { trials }, ({ trials }) =>
  Console.log(
    JSON.stringify(
      {
        version: 1,
        mode: "unpaid-plan",
        concurrency: 1,
        maxRuns: 30,
        runs: plan(trials),
        paidExecution:
          "unavailable; model/browser budgets and adapters are pending separate authorization",
        heldOut: "none; these development fixtures are tuning cases",
        judges: "disabled",
      },
      null,
      2,
    ),
  ),
);

const directory = Argument.String("directory");

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
    const fs = yield* FileSystem.FileSystem;

    // Refuse an existing campaign before importing runners or acquiring a browser.
    yield* fs.makeDirectory(dirname(directory), { recursive: true });
    yield* fs.makeDirectory(directory);
    const { signup, cancelledMutation } = yield* Effect.promise(() => import("./Tasks.ts"));

    for (const entry of plan(trials)) {
      const journal = new Journal({ ...entry, sourceRevision: source });

      yield* Effect.gen(function* () {
        if (entry.task === "signup") yield* signup(journal);
        else yield* cancelledMutation(journal);
      }).pipe(
        Effect.onExit((exit) =>
          Effect.gen(function* () {
            if (Exit.isFailure(exit) && journal.facts.terminal === "missing") {
              const interrupted = Cause.hasInterrupts(exit.cause);

              journal.facts = {
                ...journal.facts,
                terminal: interrupted ? "cancelled" : "failed",
                failure: interrupted ? "interrupted" : "infrastructure",
              };
            }
            yield* save(journal.snapshot(), `${directory}/${entry.runId}`).pipe(Effect.orDie);
          }),
        ),
      );
      yield* Console.log(JSON.stringify({ run: entry.runId, ...grade(journal.snapshot()) }));
    }
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
  Command.run({ version: "1.0.0" }),
  Effect.provide(NodeServices.layer),
  NodeRuntime.runMain,
);
