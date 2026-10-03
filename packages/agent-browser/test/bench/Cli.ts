import { execFile } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { promisify } from "node:util";

import { Clock, Config, Console, Effect, Exit, Option, Schema } from "effect";
import { Argument, Command, Flag } from "effect/cli";
import { FetchHttpClient } from "effect/http";

import { gameSite } from "../fixtures/GameSite.ts";
import * as Backends from "./Backends.ts";
import { Ledger, Sessions } from "./Budget.ts";
import { CursorSample, renderClip } from "./Clip.ts";
import { segmentCallCaps } from "./GameSegment.ts";
import { prepareHostedGames } from "./HostedGames.ts";
import { InputEvent, makeInputLog } from "./InputLog.ts";
import { measured } from "./Models.ts";
import { compareMotion, motionStats } from "./Motion.ts";
import { Arm, loadPanelReport, preparePanel, servePanel } from "./Panel.ts";
import { BenchError, Journal, load, save, tagOf, Subject, json } from "./Records.ts";
import { scenes, execute } from "./Scenes.ts";
import { busyVariants, prepareStage, stageScenes } from "./StageScenes.ts";
import { conditions, scenes as understandingScenes } from "./Understanding.ts";

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
      !Number.isSafeInteger(Math.round(options.maxUsd * 1000000)) ||
      Math.round(options.maxUsd * 1000000) <= 0)
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

/** Reject unsupported cells before allocating a paid session or exposing a fixture. */
export const validateSelection = (options: {
  readonly scene: string;
  readonly backend: "chromium" | "browserbase";
  readonly driver: string;
  readonly condition: string;
  readonly matrix: boolean;
  readonly subject?: Subject;
  readonly fixtureTunnels?: string;
}) => {
  const narration = understandingScenes.some((scene) => scene === options.scene);
  const game = options.scene === "games-operability" || options.scene === "game-segment";

  const message =
    options.matrix && (!narration || options.backend !== "chromium")
      ? "The understanding matrix requires a local understanding scene."
      : options.backend === "browserbase" &&
          !stageScenes.some((scene) => scene === options.scene) &&
          !game
        ? "This fixture scene is supported only by local Chromium."
        : options.backend === "browserbase" && game && options.fixtureTunnels === undefined
          ? "Hosted games require an explicitly approved --fixture-tunnels executable."
          : options.fixtureTunnels !== undefined && (options.backend !== "browserbase" || !game)
            ? "Fixture tunnels apply only to hosted game scenes."
            : options.subject !== undefined && !narration && options.scene !== "game-segment"
              ? "This scripted scene accepts no model subject."
              : options.scene === "game-segment" && options.condition === "text"
                ? "Game segments support picture or digest context."
                : options.scene === "games-operability"
                  ? ["scripted", "dom-twin", "canvas-keys", "canvas-click", "agent-tools"].includes(
                      options.driver,
                    )
                    ? undefined
                    : "Unknown game operability driver."
                  : options.driver !== "scripted"
                    ? "This scene selects its driver through the optional model subject."
                    : undefined;

  return message === undefined
    ? Effect.void
    : Effect.fail(new BenchError({ operation: "selection", message }));
};

export const printedPlan = (options: {
  readonly scene: string;
  readonly backend: string;
  readonly trials: number;
  readonly maxUsd: number;
  readonly durationMillis: number;
  readonly driver?: string;
  readonly variant?: string;
  readonly style?: string;
  readonly subject?: Subject;
  readonly matrix?: boolean;
  readonly maxSpins?: number;
  readonly condition?: string;
  readonly announceThenSpin?: boolean;
  readonly airDelayMillis?: number;
  readonly fixtureTunnels?: string;
}) => ({
  scene: options.scene,
  backend: options.backend,
  trials: options.trials,
  durationMillis: options.durationMillis,
  variant: options.variant ?? "created-after",
  style: options.style ?? "plain",
  condition: options.condition ?? "picture",
  maxSpins: options.scene === "game-segment" ? (options.maxSpins ?? 400) : null,
  gameSegment:
    options.scene === "game-segment"
      ? {
          perRun: segmentCallCaps(options.maxSpins, options.announceThenSpin),
          modelCallsMaximum:
            options.trials *
            segmentCallCaps(options.maxSpins, options.announceThenSpin).totalModelCalls,
        }
      : null,
  announceThenSpin: options.announceThenSpin ?? false,
  airDelayMillis: options.airDelayMillis ?? 1000,
  fixtureExposure:
    options.fixtureTunnels === undefined
      ? null
      : "Two scoped public game fixture tunnels; no deployment.",
  runs: options.trials * (options.matrix === true ? 9 : 1),
  matrix:
    options.matrix === true
      ? {
          scenes: understandingScenes,
          conditions,
          captions: options.trials * 24,
          modelCallsMaximum: options.trials * 36,
        }
      : null,
  sessions:
    options.backend === "browserbase" ? options.trials * (options.matrix === true ? 9 : 1) : 0,
  maximumBrowserMinutes:
    options.backend === "browserbase"
      ? (options.trials *
          (options.matrix === true ? 9 : 1) *
          Math.ceil((Math.min(900000, options.durationMillis + 30000) + 60000) / 1000)) /
        60
      : 0,
  modelSpendCapUsd: options.maxUsd,
  modelWorstCaseUsd:
    options.subject === undefined
      ? 0
      : options.subject.exposure === undefined
        ? null
        : options.maxUsd +
          (options.subject.exposure.maximumInputTokens * options.subject.exposure.inputRateCeiling +
            options.subject.settings.maxOutputTokens * options.subject.exposure.outputRateCeiling) /
            1000000000000,
  finalRequest:
    options.subject === undefined
      ? null
      : {
          maxOutputTokens: options.subject.settings.maxOutputTokens,
          inputCost:
            "depends on the bounded context; the reported-spend cap can be exceeded by the final request",
        },
  subject: options.subject ?? null,
  driver: options.subject === undefined ? (options.driver ?? "scripted") : "model",
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
  Flag.optional,
);

const maxUsd = Flag.String("max-usd").pipe(
  Flag.withSchema(Schema.FiniteFromString),
  Flag.withSchema(Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0))),
  Flag.withSchema(
    Schema.Finite.check(Schema.isLessThanOrEqualTo((Number.MAX_SAFE_INTEGER - 1) / 1000000)),
  ),
  Flag.withDefault(0),
);

const settings = {
  scene,
  backend,
  trials,
  durationMillis,
  maxUsd,
  driver: Flag.String("driver").pipe(Flag.withDefault("scripted")),
  variant: Flag.Literals("variant", busyVariants).pipe(Flag.withDefault("created-after")),
  style: Flag.Literals("style", ["plain", "performed"]).pipe(Flag.withDefault("plain")),
  spins: Flag.Int("spins").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    Flag.withDefault(10),
  ),
  condition: Flag.Literals("condition", conditions).pipe(Flag.withDefault("picture")),
  moments: Flag.Int("moments").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 }))),
    Flag.withDefault(3),
  ),
  maxSpins: Flag.Int("max-spins").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 }))),
    Flag.withDefault(400),
  ),
  announceThenSpin: Flag.Boolean("announce-then-spin").pipe(Flag.withDefault(false)),
  airDelayMillis: Flag.Int("air-delay-ms").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30000 }))),
    Flag.withDefault(1000),
  ),
  pictureScale: Flag.Literals("picture-scale", ["half", "full"]).pipe(Flag.withDefault("half")),
  captureQuality: Flag.Int("capture-quality").pipe(
    Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 }))),
    Flag.optional,
  ),
  fixtureTunnels: Flag.String("fixture-tunnels").pipe(
    Flag.withSchema(Schema.NonEmptyString.check(Schema.isMaxLength(4096))),
    Flag.optional,
  ),
  subjectFile: Flag.String("subject").pipe(Flag.optional),
  matrix: Flag.Boolean("matrix").pipe(Flag.withDefault(false)),
};

const defaultDuration = (scene: string) =>
  scene.startsWith("replay-")
    ? 900000
    : scene === "game-segment"
      ? 600000
      : scene === "games-operability"
        ? 90000
        : scene === "typing"
          ? 15000
          : scene === "smoke"
            ? 5000
            : 10000;

const readSubject = (path: Option.Option<string>) =>
  Option.match(path, {
    onNone: () => Effect.void,
    onSome: (file) =>
      Effect.tryPromise({
        try: async () => {
          if ((await stat(file)).size > 65536) throw new Error("Subject bound exceeded");

          return readFile(file, "utf8");
        },
        catch: () =>
          new BenchError({ operation: "subject", message: "Cannot read a bounded model subject." }),
      }).pipe(Effect.flatMap(Schema.decodeEffect(Schema.fromJsonString(Subject)))),
  });

const readJson = (file: string) =>
  Effect.tryPromise({
    try: async () => {
      if ((await stat(file)).size > 16 * 1024 * 1024)
        throw new Error("Specification bound exceeded");
      const value: unknown = JSON.parse(await readFile(file, "utf8"));

      return value;
    },
    catch: () =>
      new BenchError({
        operation: "specification",
        message: "Cannot read bounded JSON specification.",
      }),
  });

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
  Effect.fn(function* (rawOptions) {
    const subject = yield* readSubject(rawOptions.subjectFile);

    const options = {
      ...rawOptions,
      durationMillis: Option.getOrElse(rawOptions.durationMillis, () =>
        defaultDuration(rawOptions.scene),
      ),
      ...(subject === undefined ? {} : { subject }),
      fixtureTunnels: Option.getOrUndefined(rawOptions.fixtureTunnels),
    };

    yield* validateSelection(options);
    yield* Console.log(JSON.stringify(printedPlan(options), null, 2));
  }),
);

const run = Command.make(
  "run",
  {
    ...settings,
    out: Flag.String("out").pipe(Flag.withDefault(".work/bench/runs")),
  },
  Effect.fn(function* (rawOptions) {
    const subject = yield* readSubject(rawOptions.subjectFile);

    const options = {
      ...rawOptions,
      durationMillis: Option.getOrElse(rawOptions.durationMillis, () =>
        defaultDuration(rawOptions.scene),
      ),
      ...(subject === undefined ? {} : { subject }),
      fixtureTunnels: Option.getOrUndefined(rawOptions.fixtureTunnels),
    };

    yield* validateSelection(options);
    yield* authorize({ ...options, model: subject !== undefined });
    yield* Console.log(JSON.stringify(printedPlan(options)));
    const revision = yield* source();
    const ledger = new Ledger(Math.round(options.maxUsd * 1000000));

    const cells = options.matrix
      ? understandingScenes.flatMap((scene) =>
          conditions.flatMap((condition) =>
            Array.from({ length: options.trials }, (_, trial) => ({ scene, condition, trial })),
          ),
        )
      : Array.from({ length: options.trials }, (_, trial) => ({
          scene: options.scene,
          condition: options.condition,
          trial,
        }));

    const sessions = new Sessions(cells.length);

    const apiKey =
      subject === undefined
        ? undefined
        : yield* Config.Redacted(
            subject.settings.gateway === "openrouter"
              ? "OPENROUTER_API_KEY"
              : subject.provider === "openai"
                ? "OPENAI_API_KEY"
                : "ANTHROPIC_API_KEY",
          );

    const credentials =
      options.backend === "chromium"
        ? undefined
        : {
            projectId: yield* Config.Redacted("BROWSERBASE_PROJECT_ID"),
            apiKey: yield* Config.Redacted("BROWSERBASE_API_KEY"),
          };

    for (const cell of cells) {
      const { trial } = cell;

      if (subject !== undefined && (ledger.halted || ledger.spentMicrousd >= ledger.limitMicrousd))
        return yield* new BenchError({
          operation: "budget",
          message: "Reported spend or unavailable usage stops further runs.",
        });
      if (options.backend === "browserbase" && !sessions.admit())
        return yield* new BenchError({
          operation: "sessions",
          message: "The approved session allowance is exhausted.",
        });
      const runId = `${cell.scene}-${cell.condition}-${options.backend}-${yield* Clock.currentTimeMillis}-${trial}`;

      const journal = new Journal(
        {
          version: 1,
          runId,
          scene: cell.scene,
          backend: options.backend,
          driver:
            subject !== undefined
              ? "model"
              : cell.scene === "games-operability" && options.driver === "scripted"
                ? "dom-twin"
                : options.driver,
          sourceRevision: revision.revision,
          sourceDirty: revision.dirty,
          trial,
          seed: trial,
          viewport: { width: 1280, height: 720 },
          settings: {
            durationMillis: options.durationMillis,
            variant: options.variant,
            style: options.style,
            spins: options.spins,
            condition: cell.condition,
            moments: options.moments,
            maxSpins: options.maxSpins,
            announceThenSpin: options.announceThenSpin,
            airDelayMillis: options.airDelayMillis,
            pictureScale: options.pictureScale,
            subject: subject ?? null,
          },
          capture: {
            maxFrames: Math.min(
              54000,
              Math.max(1800, Math.ceil(((options.durationMillis + 30000) * 60) / 1000)),
            ),
            maxBytes: options.durationMillis > 60000 ? 1024 * 1024 * 1024 : 64 * 1024 * 1024,
            quality: Option.getOrElse(options.captureQuality, () =>
              cell.scene === "game-segment" ? 15 : 70,
            ),
            maxDurationMillis: Math.min(900000, options.durationMillis + 30000),
          },
        },
        options.durationMillis > 60000 ? { events: 20000, bytes: 64 * 1024 * 1024 } : undefined,
      );

      const driver =
        subject === undefined || apiKey === undefined
          ? undefined
          : measured({
              subject,
              apiKey,
              journal,
              allowance: ledger.allowance({
                limitMicrousd: ledger.limitMicrousd,
                rates: subject.rates,
                maxOutputTokens: subject.settings.maxOutputTokens,
              }),
              transport: FetchHttpClient.layer,
            });

      const result = yield* Effect.scoped(
        Effect.gen(function* () {
          const stage = stageScenes.some((candidate) => candidate === cell.scene)
            ? yield* prepareStage(journal)
            : undefined;

          const site =
            cell.scene === "games-operability" || cell.scene === "game-segment"
              ? yield* gameSite({ seed: trial })
              : undefined;

          if (site !== undefined && options.fixtureTunnels !== undefined) {
            const hosted = yield* prepareHostedGames(site, { executable: options.fixtureTunnels });

            journal.append({
              kind: "host",
              turn: null,
              value: json({
                publicUrls: hosted.publicUrls,
                originQualification: hosted.originQualification,
              }),
            });
          }

          const inputLog =
            site === undefined
              ? undefined
              : yield* makeInputLog({
                  origins: [new URL(site.url).origin, site.frameOrigin],
                  maxEvents: 20000,
                });

          const bootstrap = stage?.bootstrap ?? inputLog?.bootstrap;

          return yield* Backends.run(
            journal,
            (browser) =>
              execute(journal, browser, {
                durationMillis: options.durationMillis,
                variant: options.variant,
                style: options.style,
                spins: options.spins,
                condition: cell.condition,
                moments: options.moments,
                maxSpins: options.maxSpins,
                announceThenSpin: options.announceThenSpin,
                airDelayMillis: options.airDelayMillis,
                pictureScale: options.pictureScale === "half" ? 0.5 : 1,
                ...(driver === undefined ? {} : { driver }),
                ...(stage === undefined ? {} : { stage }),
                ...(site === undefined ? {} : { site }),
              }),
            credentials,
            undefined,
            bootstrap,
          ).pipe(
            Effect.ensuring(
              Effect.sync(() => {
                if (inputLog !== undefined)
                  journal.append({
                    kind: "host",
                    turn: null,
                    value: json({ inputLog: inputLog.snapshot() }),
                  });
              }),
            ),
          );
        }),
      ).pipe(Effect.exit);

      if (Exit.isFailure(result)) journal.failure = tagOf(result.cause);
      if (driver !== undefined) journal.usage = driver.finish();
      if (options.backend === "browserbase") sessions.settle(journal.cleanup);
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

const clip = Command.make(
  "clip",
  {
    video: Argument.String("video"),
    samples: Flag.String("samples"),
    out: Flag.String("out"),
    width: Flag.Int("width").pipe(Flag.withDefault(1280)),
    height: Flag.Int("height").pipe(Flag.withDefault(720)),
    startMillis: Flag.Int("start-ms").pipe(Flag.withDefault(0)),
    durationMillis: Flag.Int("duration-ms").pipe(Flag.withDefault(15000)),
  },
  Effect.fn(function* (options) {
    const samples = yield* readJson(options.samples).pipe(
      Effect.flatMap(
        Schema.decodeUnknownEffect(Schema.Array(CursorSample).check(Schema.isMaxLength(65536))),
      ),
    );

    const result = yield* renderClip({
      inputVideo: options.video,
      outputDirectory: options.out,
      samples,
      viewport: { width: options.width, height: options.height },
      startMillis: options.startMillis,
      durationMillis: options.durationMillis,
    });

    yield* Console.log(JSON.stringify(result));
  }),
);

const panel = Command.make("panel").pipe(
  Command.withSubcommands([
    Command.make(
      "prepare",
      { specification: Argument.String("specification"), out: Flag.String("out") },
      Effect.fn(function* ({ specification, out }) {
        const config = yield* readJson(specification).pipe(
          Effect.flatMap(
            Schema.decodeUnknownEffect(
              Schema.Struct({
                seed: Schema.Int,
                clips: Schema.Array(Schema.Struct({ arm: Arm, path: Schema.NonEmptyString })).check(
                  Schema.isMaxLength(120),
                ),
              }),
            ),
          ),
        );

        yield* Console.log(
          JSON.stringify(yield* preparePanel({ ...config, outputDirectory: out })),
        );
      }),
    ),
    Command.make(
      "serve",
      {
        directory: Argument.String("directory"),
        port: Flag.Int("port").pipe(
          Flag.withSchema(Schema.Int.check(Schema.isBetween({ minimum: 1024, maximum: 32767 }))),
          Flag.withDefault(4112),
        ),
      },
      Effect.fn(function* ({ directory, port }) {
        return yield* Effect.scoped(
          Effect.gen(function* () {
            const server = yield* servePanel({ directory, port });
            const call = promisify(execFile);

            const url = yield* Effect.tryPromise({
              try: async () => (await call("dev-url", [String(server.port)])).stdout.trim(),
              catch: () =>
                new BenchError({
                  operation: "panel",
                  message: "Cannot resolve the mirrored panel URL.",
                }),
            });

            yield* Console.log(JSON.stringify({ url, port: server.port }));

            return yield* Effect.never;
          }),
        );
      }),
    ),
    Command.make(
      "report",
      { directory: Argument.String("directory") },
      Effect.fn(function* ({ directory }) {
        yield* Console.log(JSON.stringify(yield* loadPanelReport(directory), null, 2));
      }),
    ),
  ]),
);

const motion = Command.make(
  "motion",
  { input: Argument.String("input"), human: Flag.String("human").pipe(Flag.optional) },
  Effect.fn(function* ({ input, human }) {
    const events = Schema.Array(InputEvent).check(Schema.isMaxLength(65536));

    const candidate = yield* readJson(input).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(events)),
    );

    const reference = Option.isSome(human)
      ? yield* readJson(human.value).pipe(Effect.flatMap(Schema.decodeUnknownEffect(events)))
      : undefined;

    yield* Console.log(
      JSON.stringify(
        {
          statistics: motionStats(candidate),
          comparison:
            reference === undefined
              ? null
              : compareMotion(motionStats(reference), motionStats(candidate)),
        },
        null,
        2,
      ),
    );
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
      clip,
      panel,
      motion,
    ]),
  );
