import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { Clock, Config, Console, Effect, Exit, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/unstable/cli";

import * as Backends from "./Backends.ts";
import { BenchError, Journal, load, save, tagOf } from "./Records.ts";
import { scenes, execute } from "./Scenes.ts";

export const authorize = (
  options: {
    readonly backend: "chromium" | "browserbase";
    readonly model: boolean;
    readonly maxUsd?: number;
  },
  environment: Readonly<Record<string, string | undefined>> = process.env,
) => {
  if (
    options.model &&
    (environment.EFFECT_AGENT_BROWSER_BENCH_LIVE !== "1" ||
      options.maxUsd === undefined ||
      options.maxUsd <= 0)
  )
    return Effect.fail(
      new BenchError({
        operation: "authorize",
        message:
          "Model runs require EFFECT_AGENT_BROWSER_BENCH_LIVE=1 and a positive --max-usd cap.",
      }),
    );
  if (options.backend === "browserbase" && environment.EFFECT_AGENT_BROWSERBASE_LIVE !== "1")
    return Effect.fail(
      new BenchError({
        operation: "authorize",
        message: "Browserbase runs require EFFECT_AGENT_BROWSERBASE_LIVE=1.",
      }),
    );

  return Effect.void;
};

export const printedPlan = (options: {
  readonly scene: string;
  readonly backend: string;
  readonly trials: number;
  readonly maxUsd: number;
  readonly durationMillis: number;
}) => ({
  ...options,
  runs: options.trials,
  sessions: options.backend === "browserbase" ? options.trials : 0,
  maximumBrowserMinutes:
    options.backend === "browserbase"
      ? (options.trials * (options.durationMillis + 60000)) / 60000
      : 0,
  modelSpendCapUsd: options.maxUsd,
  modelWorstCaseUsd: 0,
  driver: "scripted",
  approval: "The owner approves each paid run before execution.",
});

const scene = Argument.Literals("scene", scenes);

const backend = Flag.Literals("backend", ["chromium", "browserbase"]).pipe(
  Flag.withDefault("chromium"),
);

const trials = Flag.Int("trials").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 20 }))),
  Flag.withDefault(1),
);

const durationMillis = Flag.Int("duration-ms").pipe(
  Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900000 }))),
  Flag.withDefault(5000),
);

const maxUsd = Flag.String("max-usd").pipe(
  Flag.withSchema(Schema.FiniteFromString),
  Flag.withSchema(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  Flag.withDefault(0),
);

const settings = { scene, backend, trials, durationMillis, maxUsd };

const source = Effect.fn("Bench.source")(function* () {
  const call = promisify(execFile);

  return yield* Effect.tryPromise({
    try: async () => ({
      revision: (await call("git", ["rev-parse", "HEAD"])).stdout.trim(),
      dirty: (await call("git", ["status", "--porcelain"])).stdout.trim() !== "",
    }),
    catch: () =>
      new BenchError({ operation: "source", message: "Cannot record checkout source state." }),
  });
});

const plan = Command.make(
  "plan",
  settings,
  Effect.fn(function* (options) {
    yield* Console.log(JSON.stringify(printedPlan(options), null, 2));
  }),
);

const run = Command.make(
  "run",
  {
    ...settings,
    out: Flag.String("out").pipe(Flag.withDefault(".work/bench/runs")),
    fixtureOrigin: Flag.String("fixture-origin").pipe(Flag.optional),
  },
  Effect.fn(function* (options) {
    yield* authorize({ ...options, model: false });
    if (options.backend === "browserbase" && Option.isNone(options.fixtureOrigin))
      return yield* new BenchError({
        operation: "fixture",
        message: "Hosted smoke needs --fixture-origin for the reachable stage fixture.",
      });
    yield* Console.log(JSON.stringify(printedPlan(options)));
    const revision = yield* source();

    const credentials =
      options.backend === "chromium"
        ? undefined
        : {
            projectId: yield* Config.Redacted("BROWSERBASE_PROJECT_ID"),
            apiKey: yield* Config.Redacted("BROWSERBASE_API_KEY"),
          };

    for (let trial = 0; trial < options.trials; trial++) {
      const runId = `${options.scene}-${options.backend}-${yield* Clock.currentTimeMillis}-${trial}`;

      const journal = new Journal({
        version: 1,
        runId,
        scene: options.scene,
        backend: options.backend,
        driver: "scripted",
        sourceRevision: revision.revision,
        sourceDirty: revision.dirty,
        trial,
        seed: trial,
        viewport: { width: 1280, height: 720 },
        settings: { durationMillis: options.durationMillis },
        capture: {
          maxFrames: 1800,
          maxBytes: 64 * 1024 * 1024,
          quality: 70,
          maxDurationMillis: options.durationMillis + 30000,
        },
      });

      const result = yield* Backends.run(
        journal,
        (browser) =>
          execute(journal, browser, {
            durationMillis: options.durationMillis,
            ...Option.match(options.fixtureOrigin, {
              onNone: () => ({}),
              onSome: (fixtureOrigin) => ({ fixtureOrigin }),
            }),
          }),
        credentials,
      ).pipe(Effect.exit);

      if (Exit.isFailure(result)) journal.failure = tagOf(result.cause);
      yield* save(journal, `${options.out}/${runId}`);
      yield* Console.log(
        JSON.stringify({
          runId,
          path: `${options.out}/${runId}`,
          metrics: journal.metrics,
          cleanup: journal.cleanup,
          failure: journal.failure,
        }),
      );
      if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
      if (credentials !== undefined && journal.cleanup !== "confirmed")
        return yield* new BenchError({
          operation: "cleanup",
          message: "Unconfirmed release stops further sessions.",
        });
    }
  }),
);

const report = Command.make(
  "report",
  { directory: Argument.String("directory") },
  Effect.fn(function* ({ directory }) {
    const record = yield* load(directory);

    yield* Console.log(
      JSON.stringify(
        {
          metrics: record.metrics,
          cleanup: record.cleanup,
          failure: record.failure,
          usage: record.usage,
        },
        null,
        2,
      ),
    );
  }),
);

const film = Command.make(
  "film",
  { directory: Argument.String("directory") },
  Effect.fn(function* ({ directory }) {
    const { film: render } = yield* Effect.promise(() => import("./Film.ts"));

    yield* Console.log(JSON.stringify(yield* render(directory)));
  }),
);

export const cli = () =>
  Command.make("browser-bench").pipe(
    Command.withSubcommands([
      Command.make("scenes", {}, () => Console.log(scenes.join("\n"))),
      plan,
      run,
      report,
      film,
    ]),
  );
