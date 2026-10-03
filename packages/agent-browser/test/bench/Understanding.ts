import * as Agent from "@yielded/agent/agent";
import * as AgentRuntime from "@yielded/agent/agent-runtime";
import { Effect, Option, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import type * as Browser from "effect-browser/browser";
import * as Plan from "effect-browser/plan";
import type { RanStep } from "effect-browser/plan-data";
import { Prompt, Toolkit } from "effect/ai";

import { driftSite } from "../fixtures/DriftSite.ts";
import { enterGame, waitForGame } from "../fixtures/GameDriver.ts";
import { gameSite } from "../fixtures/GameSite.ts";
import { tableSite } from "../fixtures/TableSite.ts";
import { filming } from "./Backends.ts";
import { answer, picture, scripted, type Driver } from "./Drivers.ts";
import { BenchError, type Journal, type Subject, type Usage, json } from "./Records.ts";
import { walks } from "./Replay.ts";
import * as StepDigest from "./StepDigest.ts";

export const scenes = ["read-table", "read-game", "narrate-walk"] as const;
export type Scene = (typeof scenes)[number];
export const conditions = ["picture", "text", "digest"] as const;
export type Condition = (typeof conditions)[number];

export const Narration = Schema.Struct({
  caption: Schema.String.check(Schema.isMaxLength(1024)),
  facts: Schema.Record(
    Schema.String.check(Schema.isMaxLength(64)),
    Schema.Union([Schema.String.check(Schema.isMaxLength(256)), Schema.Finite]),
  ).check(
    Schema.makeFilter((facts) => Object.keys(facts).length <= 32, { title: "at most 32 facts" }),
  ),
});

export type Narration = typeof Narration.Type;

export interface Truth {
  readonly facts: Readonly<Record<string, string | number>>;
  readonly precision?: Readonly<Record<string, number>>;
  /** A wrong value matching another displayed column is a distinct confusion. */
  readonly columns?: Readonly<Record<string, ReadonlyArray<string | number>>>;
  readonly money?: ReadonlyArray<string>;
}

const matches = (actual: string | number | undefined, expected: string | number, precision = 0) =>
  typeof actual === "number" && typeof expected === "number"
    ? Number.isFinite(actual) && Math.abs(actual - expected) <= precision + 1e-9
    : actual === expected;

/** Caption prose is retained, never graded. Missing facts reduce accuracy; extra claims are false. */
export const grade = (output: Narration, truth: Truth) => {
  const checked = Object.entries(truth.facts).map(([name, expected]) => ({
    name,
    expected,
    actual: output.facts[name] ?? null,
    correct: matches(output.facts[name], expected, truth.precision?.[name]),
    missing: output.facts[name] === undefined,
    money: truth.money?.includes(name) ?? false,
    columnConfusion:
      output.facts[name] !== undefined &&
      !matches(output.facts[name], expected, truth.precision?.[name]) &&
      (truth.columns?.[name]?.some((value) =>
        matches(output.facts[name], value, truth.precision?.[name]),
      ) ??
        false),
  }));

  const extra = Object.keys(output.facts).filter((name) => !(name in truth.facts));

  return {
    checked,
    extra,
    correct: checked.filter((fact) => fact.correct).length,
    total: checked.length + extra.length,
    anyFalseFact: extra.length > 0 || checked.some((fact) => !fact.correct && !fact.missing),
    columnConfusion: checked.some((fact) => fact.columnConfusion),
    moneyCorrect: checked.filter((fact) => fact.money && fact.correct).length,
    moneyTotal: checked.filter((fact) => fact.money).length,
  };
};

/** Two-sided 95% Wilson score interval; an empty group has no measured accuracy. */
export const wilson = (correct: number, total: number) => {
  if (total === 0) return null;
  const z = 1.959963984540054;
  const fraction = correct / total;
  const denominator = 1 + (z * z) / total;
  const center = (fraction + (z * z) / (2 * total)) / denominator;

  const radius =
    (z * Math.sqrt((fraction * (1 - fraction)) / total + (z * z) / (4 * total * total))) /
    denominator;

  return { lower: Math.max(0, center - radius), upper: Math.min(1, center + radius) };
};

export interface Sample {
  readonly scene: Scene;
  readonly condition: Condition;
  readonly index: number;
  readonly output: Narration;
  readonly truth: Truth;
  readonly grade: ReturnType<typeof grade>;
  readonly latencyMillis: number;
  readonly callLatencyMillis: ReadonlyArray<number>;
}

const quantile = (values: ReadonlyArray<number>, p: number) => {
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] ?? null;
};

/** Group actual captions; script latency and cost are labelled separately from model evidence. */
export const aggregate = (samples: ReadonlyArray<Sample>, usage: Usage | null) => {
  const scene = samples[0]?.scene;
  const condition = samples[0]?.condition;
  const correct = samples.reduce((sum, sample) => sum + sample.grade.correct, 0);
  const total = samples.reduce((sum, sample) => sum + sample.grade.total, 0);
  const moneyCorrect = samples.reduce((sum, sample) => sum + sample.grade.moneyCorrect, 0);
  const moneyTotal = samples.reduce((sum, sample) => sum + sample.grade.moneyTotal, 0);

  return {
    scene: scene ?? null,
    condition: condition ?? null,
    captions: samples.length,
    factAccuracy: total === 0 ? null : correct / total,
    factAccuracyInterval: wilson(correct, total),
    anyFalseFactRate:
      samples.length === 0
        ? null
        : samples.filter((sample) => sample.grade.anyFalseFact).length / samples.length,
    columnConfusionRate:
      scene !== "read-table" || samples.length === 0
        ? null
        : samples.filter((sample) => sample.grade.columnConfusion).length / samples.length,
    moneyFactAccuracy: moneyTotal === 0 ? null : moneyCorrect / moneyTotal,
    moneyFactAccuracyInterval: wilson(moneyCorrect, moneyTotal),
    callLatencyMillis: {
      p50: quantile(
        samples.flatMap((sample) => sample.callLatencyMillis),
        0.5,
      ),
      p95: quantile(
        samples.flatMap((sample) => sample.callLatencyMillis),
        0.95,
      ),
      qualification: "language-model-span",
    },
    captionLatencyMillis: {
      p50: quantile(
        samples.map((sample) => sample.latencyMillis),
        0.5,
      ),
      p95: quantile(
        samples.map((sample) => sample.latencyMillis),
        0.95,
      ),
      qualification: "agent-run-including-transient-context",
    },
    costMicrousd: usage?.status === "estimated-from-reported-usage" ? usage.costMicrousd : null,
    usageStatus: usage?.status ?? "scripted-unmeasured",
  };
};

/** Truncate UTF-8 without splitting a code point; this bounds bytes, not JavaScript characters. */
export const visibleText = (text: string, limit: number) => {
  const bytes = new TextEncoder().encode(text);

  return new TextDecoder("utf-8", { fatal: false })
    .decode(bytes.subarray(0, limit))
    .replace(/\uFFFD$/u, "");
};

export interface UnderstandingOptions {
  readonly scene?: Scene;
  readonly condition?: Condition;
  readonly driver?: Driver;
  readonly scriptedAnswer?: "correct" | "wrong";
  readonly pictureScale?: 0.5 | 1;
  readonly maxTextBytes?: number;
  readonly moments?: number;
}

const Options = Schema.Struct({
  scene: Schema.Literals(scenes),
  condition: Schema.Literals(conditions),
  scriptedAnswer: Schema.Literals(["correct", "wrong"]),
  pictureScale: Schema.Literals([0.5, 1]),
  maxTextBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 4000 })),
  moments: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
});

const wrong = (truth: Truth): Narration => ({
  caption: "An intentionally incorrect fixture answer.",
  facts: Object.fromEntries(
    Object.entries(truth.facts).map(([key, value]) => [
      key,
      truth.columns?.[key]?.[0] ?? (typeof value === "number" ? value + 999 : `wrong ${value}`),
    ]),
  ),
});

const metadata = Effect.fnUntraced(function* (
  browser: Browser.BrowserSession<unknown>,
  page: Browser.Page,
) {
  const first = Option.getOrUndefined(yield* Stream.runHead(browser.pages));

  return first !== undefined && "_tag" in first && first._tag === "Inventory"
    ? first.pages.find((candidate) => candidate.identity.pageId === page.identity.pageId)
    : undefined;
});

/** A finite scene uses the actual AgentRuntime output contract with a new transient picture per call. */
export const understanding = Effect.fn("Bench.understanding")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: UnderstandingOptions = {},
) {
  const config = yield* Schema.decodeUnknownEffect(Options)({
    scene: options.scene ?? journal.manifest.scene,
    condition: options.condition ?? "text",
    scriptedAnswer: options.scriptedAnswer ?? "correct",
    pictureScale: options.pictureScale ?? 0.5,
    maxTextBytes: options.maxTextBytes ?? 4000,
    moments: options.moments ?? 3,
  });

  const page = browser.initialPage;
  const samples: Sample[] = [];

  const maxCaptions =
    config.scene === "narrate-walk" ? 4 : config.scene === "read-game" ? config.moments : 1;

  const narrator = Agent.make("watched-browser-narrator", {
    input: Schema.String,
    output: Narration,
    toolkit: Toolkit.make(),
    instructions:
      "Describe the current screen and answer the requested facts. Use only supplied screen evidence. Today means 24h, week means 7d. Keep ticker names, signs and column names exact. Do not invent unsupported facts. Captions are prose; facts use the requested keys.",
    policy: { maxTurns: 4, maxToolCalls: 6, maxDuration: "30 seconds", onExhaustion: "fail" },
  });

  const narrate = Effect.fnUntraced(function* (
    truth: Truth,
    question: string,
    steps: ReadonlyArray<StepDigest.StepFact>,
    sinceSequence: bigint,
  ) {
    yield* page.describe();

    const digest = StepDigest.build({
      steps,
      timeline: yield* page.timeline.snapshot(),
      now: yield* page.timeline.now,
      page: yield* metadata(browser, page),
      sinceSequence,
    });

    const driver =
      options.driver ??
      scripted(journal, [
        () =>
          answer(
            json(
              config.scriptedAnswer === "correct"
                ? { caption: "Fixture screen described correctly.", facts: truth.facts }
                : wrong(truth),
            ),
          ),
      ]);

    const image = picture(page, { every: "call", scale: config.pictureScale });
    const started = performance.now();
    const previousCalls = driver.callLatencies?.().length ?? 0;

    const run = AgentRuntime.run(narrator, question, {
      onHistory: (history) =>
        driver.history(history).pipe(
          Effect.asVoid,
          Effect.mapError(() =>
            BenchError.make({ operation: "history", message: "Cannot encode narration history." }),
          ),
        ),
      ...(driver.estimate === undefined ? {} : { costEstimator: driver.estimate }),
      turnAllowance: Math.max(1, Math.floor(4 / maxCaptions)),
      transientContext: {
        load: () =>
          Effect.gen(function* () {
            const png = yield* image.load();

            if (config.condition === "picture") return png;

            const text = visibleText(
              (yield* page.readText({ selector: "body" })).text,
              config.maxTextBytes,
            );

            const extra = `Visible text (${Buffer.byteLength(text)} UTF-8 bytes):\n${text}${config.condition === "digest" ? `\nStep digest:\n${JSON.stringify(digest)}` : ""}`;

            return Prompt.fromMessages([
              ...png.content,
              Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text: extra })] }),
            ]);
          }),
      },
    });

    const result = yield* driver.provide(run);
    const callLatencyMillis = driver.callLatencies?.().slice(previousCalls) ?? [];

    const sample: Sample = {
      scene: config.scene,
      condition: config.condition,
      index: samples.length,
      output: result.output,
      truth,
      grade: grade(result.output, truth),
      latencyMillis: performance.now() - started,
      callLatencyMillis,
    };

    samples.push(sample);
    journal.append({ kind: "truth", turn: null, value: json({ index: sample.index, truth }) });
    journal.append({ kind: "host", turn: null, value: json(sample) });
  });

  const sequence = Effect.map(
    page.timeline.snapshot(),
    (snapshot) => snapshot.newest?.sequence ?? 0n,
  );

  const facts = (steps: ReadonlyArray<RanStep>) =>
    steps.map((step) => StepDigest.fromAttempt(step.attempt));

  yield* filming(
    journal,
    page,
    Effect.gen(function* () {
      if (config.scene === "read-table") {
        const site = yield* tableSite(journal.manifest.seed);
        const before = yield* sequence;

        const run = yield* page.run({
          version: 1,
          steps: [
            { id: "table", action: { _tag: "Navigate", url: site.url } },
            {
              id: "settle",
              action: {
                _tag: "Wait",
                mode: { _tag: "Settled", quietMillis: 50, withinMillis: 3000 },
              },
            },
          ],
        });

        const table = site.visits()[0];

        if (table === undefined)
          return yield* BenchError.make({ operation: "table", message: "Table truth missing." });
        const highlighted = table.rows.find((row) => row.ticker === table.facts.ticker);
        const hourWinner = table.rows.find((row) => row.hour === 18.75);

        if (highlighted === undefined || hourWinner === undefined)
          return yield* BenchError.make({ operation: "table", message: "Table row missing." });
        yield* narrate(
          {
            facts: table.facts,
            precision: { dailyChange: 0.005, weeklyChange: 0.005 },
            columns: {
              dailyWinner: [hourWinner.ticker],
              dailyChange: [18.75],
              weeklyChange: [highlighted.hour, highlighted.day],
            },
          },
          "Report facts ticker (highlighted ticker), dailyWinner (largest positive 24h move), dailyChange (its percent), weekDirection (up or down for the highlighted ticker), weeklyChange (its 7d percent).",
          facts(run.steps),
          before,
        );

        return;
      }
      if (config.scene === "read-game") {
        const site = yield* gameSite({ seed: journal.manifest.seed });
        const frame = yield* enterGame(page, site, "reels");
        const host = yield* BrowserTools.makeHost(browser, frame);

        for (let spin = 1; spin <= config.moments; spin++) {
          yield* waitForGame(
            site,
            "reels",
            (state) => state.phase === "idle",
            "ready for narration spin",
          );
          const before = yield* sequence;

          yield* host.run(
            Effect.gen(function* () {
              const tools = yield* BrowserTools.nativeToolkit;

              yield* Stream.runCollect(
                yield* tools.handle(
                  "browser_click_at",
                  {
                    x: (journal.manifest.viewport.width - 960) / 2 + 815,
                    y: 570,
                  },
                  `spin-${spin}`,
                ),
              );
            }),
          );

          const state = yield* waitForGame(
            site,
            "reels",
            (value) => value.spin === spin && value.phase !== "spinning",
            "narration result",
          );

          const result = site
            .events()
            .findLast(
              (event) =>
                event.kind === "reels" && event.event.tag === "result" && event.event.spin === spin,
            )?.event;

          if (result?.tag !== "result")
            return yield* BenchError.make({
              operation: "game",
              message: "Game result truth missing.",
            });
          const receipts = yield* host.receipts;

          yield* narrate(
            {
              facts: {
                balance: state.balance,
                bet: state.bet,
                win: state.lastWin,
                notable: result.moment,
              },
              money: ["balance", "bet", "win"],
            },
            "Report facts balance, bet, win (LAST WIN) and notable (ordinary, near-miss, big-win, bonus, or losing-streak). These are demo credits.",
            yield* StepDigest.fromReceipts({ ...receipts, receipts: receipts.receipts.slice(-1) }),
            before,
          );
        }

        return;
      }
      const site = yield* driftSite;
      const walk = walks[0];
      const baseline = yield* browser.createPage();

      site.configure("none", journal.manifest.seed, "narration-baseline");

      const recorded = yield* baseline
        .run({
          version: 1,
          steps: [
            { id: "navigate", action: { _tag: "Navigate", url: `${site.url}/portal` } },
            ...walk.actions.map((action, index) => ({ id: `walk-${index}`, action })),
          ],
        })
        .pipe(Effect.flatMap(Plan.recorded));

      yield* baseline.close();
      const decoded = yield* Plan.decode(yield* Plan.encode(recorded));
      const runId = `narration-${journal.manifest.seed}-${journal.manifest.trial}`;

      site.configure("none", journal.manifest.seed, runId);
      for (const step of decoded.steps) {
        const before = yield* sequence;
        const run = yield* page.run({ version: 1, steps: [step] }, { within: 5000 });

        yield* page.run({
          version: 1,
          steps: [
            {
              id: "settled",
              action: {
                _tag: "Wait",
                mode: { _tag: "Settled", quietMillis: 50, withinMillis: 3000 },
              },
            },
          ],
        });
        const truth = site.truth(runId);

        if (truth === undefined)
          return yield* BenchError.make({ operation: "walk", message: "Walk truth missing." });
        yield* narrate(
          { facts: { ...truth } },
          "Report facts page, tab, item (empty if none), and query (empty if none) for the current portal screen.",
          facts(run.steps),
          before,
        );
      }
    }),
  );
  journal.usage = options.driver?.finish() ?? null;
  journal.truth = json({
    samples: samples.map((sample) => ({ index: sample.index, truth: sample.truth })),
  });
  journal.metrics = json({
    ...aggregate(samples, journal.usage),
    samples,
    measured: options.driver === undefined ? "scripted-plumbing" : "model",
  });

  return samples;
});

/** Preparation only: owner approval and the existing paid-driver guard remain necessary. */
export const paidMatrix = (subject: Subject, maxUsd: number) => ({
  scenes,
  conditions,
  trials: 20,
  runs: 180,
  captions: 480,
  modelCallsMaximum: 720,
  model: subject,
  maxUsd,
  pictureScale: 0.5,
  maxTextBytes: 4000,
  maxTurnsPerTrial: 4,
  maxCallsPerTrial: 6,
  status: "prepared-not-run",
});
