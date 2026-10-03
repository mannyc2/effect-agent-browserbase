import { Cause, Effect, Exit, Option, Stream } from "effect";
import * as Tools from "effect-agent-browser/tools";
import type * as Browser from "effect-browser/browser";
import * as Plan from "effect-browser/plan";
import type {
  RecordedActionEncoded as ActionEncoded,
  LivePlanEncoded,
  Plan as DurablePlan,
  StepAttempt,
} from "effect-browser/plan-data";
import { Toolkit } from "effect/unstable/ai";

import {
  driftSite,
  operators,
  type DriftOperator,
  type DriftSite,
  type DriftTruth,
} from "../fixtures/DriftSite.ts";
import { BenchError, type Journal, json } from "./Records.ts";

export const recordingPaths = ["page", "tools"] as const;
export type RecordingPath = (typeof recordingPaths)[number];

const clicked = (label: string, kind: "link" | "button" = "link"): ActionEncoded => ({
  _tag: "Click",
  target: { _tag: "Descriptor", descriptor: { kind, label } },
});

const hovered = (label: string): ActionEncoded => ({
  _tag: "Hover",
  target: { _tag: "Descriptor", descriptor: { kind: "link", label } },
});

const settled: ActionEncoded = {
  _tag: "Wait",
  mode: { _tag: "Settled", quietMillis: 50, withinMillis: 3000 },
};

export const walks = [
  {
    id: "overview-article",
    scope: "viewport",
    actions: [clicked("Markets"), clicked("Overview", "button"), clicked("Alpha article")],
    truth: { page: "article", tab: "Overview", item: "Alpha", query: "" },
  },
  {
    id: "prices-hover",
    scope: "document",
    actions: [
      clicked("Markets"),
      clicked("Prices", "button"),
      { _tag: "Scroll", mode: { _tag: "By", deltaX: 0, deltaY: 120 } },
      hovered("Beta article"),
      clicked("Beta article"),
    ],
    truth: { page: "article", tab: "Prices", item: "Beta", query: "" },
  },
  {
    id: "research-table",
    scope: "document",
    actions: [clicked("Markets"), clicked("Research", "button"), clicked("Open Gamma", "button")],
    truth: { page: "article", tab: "Research", item: "Gamma", query: "" },
  },
  {
    id: "search-form",
    scope: "document",
    actions: [
      clicked("Markets"),
      {
        _tag: "Fill",
        target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Search query" } },
        value: { _tag: "Literal", value: "Alpha" },
      },
      clicked("Search", "button"),
    ],
    truth: { page: "search", tab: "Overview", item: "", query: "Alpha" },
  },
  {
    id: "pagination",
    scope: "document",
    actions: [
      clicked("Markets"),
      clicked("Next page", "button"),
      hovered("Beta article"),
      clicked("Beta article"),
    ],
    truth: { page: "article", tab: "Overview", item: "Beta", query: "" },
  },
  {
    id: "article-index",
    scope: "document",
    actions: [
      clicked("Markets"),
      clicked("Articles"),
      hovered("Gamma article"),
      clicked("Gamma article"),
    ],
    truth: { page: "article", tab: "Overview", item: "Gamma", query: "" },
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly scope: "viewport" | "document";
  readonly actions: ReadonlyArray<ActionEncoded>;
  readonly truth: DriftTruth;
}>;

export type WalkId = (typeof walks)[number]["id"];

export interface ReplayOptions {
  readonly walkIds?: ReadonlyArray<WalkId>;
  readonly operators?: ReadonlyArray<DriftOperator>;
  readonly seeds?: ReadonlyArray<number>;
  readonly paths?: ReadonlyArray<RecordingPath>;
  readonly site?: DriftSite;
  readonly withinMillis?: number;
}

export interface ReplayCell {
  readonly walk: WalkId;
  readonly path: RecordingPath;
  readonly operator: DriftOperator;
  readonly seed: number;
  readonly outcome: "replayed" | "failed-typed" | "wrong-place";
  readonly reason: string | null;
  readonly stepId: string | null;
  readonly expected: DriftTruth;
  readonly truth: DriftTruth | null;
  readonly completed: number;
  readonly total: number;
  readonly stepMillis: ReadonlyArray<number>;
  readonly phaseMillis: ReadonlyArray<number>;
}

const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);

  return {
    p50: sorted[Math.max(0, Math.ceil(sorted.length * 0.5) - 1)] ?? 0,
    p95: sorted[Math.max(0, Math.ceil(sorted.length * 0.95) - 1)] ?? 0,
  };
};

const elapsed = (attempt: StepAttempt): number => {
  const phases = attempt.phases;
  const first = phases[0]?.atMonotonicNanos;
  const last = phases.at(-1)?.atMonotonicNanos;

  return first === undefined || last === undefined ? 0 : Number(last - first) / 1e6;
};

const stepTimes = (attempts: ReadonlyArray<StepAttempt>, started: bigint, finished: bigint) => {
  let previous = started;

  return attempts.map((attempt) => {
    const terminal = attempt.phases.at(-1)?.atMonotonicNanos ?? finished;
    const millis = Number(terminal - previous) / 1e6;

    previous = terminal;

    return millis;
  });
};

const targetScope = (action: ActionEncoded, scope: "document" | "viewport"): ActionEncoded =>
  "target" in action && action.target?._tag === "Descriptor"
    ? {
        ...action,
        target: {
          _tag: "Descriptor",
          descriptor: { ...action.target.descriptor, matchScope: scope },
        },
      }
    : action;

const authored = (site: DriftSite, walk: (typeof walks)[number]): LivePlanEncoded => ({
  version: 1,
  steps: [
    {
      id: "navigate",
      action: { _tag: "Navigate", url: `${site.url}/portal`, timeoutMillis: 6000 },
    },
    ...walk.actions.map((action, index) => ({
      id: `step-${index}`,
      action: targetScope(action, walk.scope),
    })),
    { id: "settle", action: settled },
  ],
});

const observedReference = (
  page: Browser.Page,
  action: ActionEncoded,
  scope: "document" | "viewport",
) =>
  Effect.gen(function* () {
    if (!("target" in action) || action.target?._tag !== "Descriptor")
      return yield* new BenchError({
        operation: "record",
        message: "Tool action needs a descriptor.",
      });
    const descriptor = action.target.descriptor;
    const observation = yield* page.observe({ scope, match: descriptor.label });

    const candidates = observation.controls.filter(
      (item) => item.kind === descriptor.kind && item.label === descriptor.label,
    );

    const candidate = candidates[0];

    if (candidates.length !== 1 || candidate === undefined)
      return yield* new BenchError({
        operation: "record",
        message: "Fixture control must be unique.",
      });

    return { observationId: observation.observationId, elementId: candidate.elementId };
  });

const closePage = Effect.fnUntraced(function* (page: Browser.Page) {
  const status = yield* page.status;

  // A contained or retired page has already lost native authority. The original owner
  // still performs its checked final close; this never retries an unresolved mutation.
  if (status.phase === "closed" || status.phase === "stale") return;
  yield* page.close();
});

const record = Effect.fnUntraced(function* <OwnerError>(
  browser: Browser.BrowserSession<OwnerError>,
  site: DriftSite,
  walk: (typeof walks)[number],
  path: RecordingPath,
) {
  const page = yield* browser.createPage();

  return yield* Effect.gen(function* () {
    if (path === "page")
      return yield* page
        .run(authored(site, walk), { within: 15000 })
        .pipe(Effect.flatMap(Plan.recorded));

    const host = yield* Tools.makeHost(browser, page, {
      observationScope: walk.scope,
      maxControls: 64,
    });

    const toolset = Toolkit.merge(Tools.toolkit, Tools.nativeToolkit);

    yield* host.run(
      Effect.gen(function* () {
        const tools = yield* toolset;

        yield* Stream.runCollect(
          yield* tools.handle("browser_navigate", { url: `${site.url}/portal` }, "navigate"),
        );
        for (const [index, action] of walk.actions.entries()) {
          const id = `step-${index}`;

          if (action._tag === "Click") {
            const reference = yield* observedReference(page, action, walk.scope);

            yield* Stream.runCollect(yield* tools.handle("browser_click", reference, id));
          } else if (action._tag === "Hover") {
            const reference = yield* observedReference(page, action, walk.scope);

            yield* Stream.runCollect(yield* tools.handle("browser_hover", reference, id));
          } else if (action._tag === "Fill" && action.value._tag === "Literal") {
            const reference = yield* observedReference(page, action, walk.scope);

            yield* Stream.runCollect(
              yield* tools.handle("browser_fill", { reference, value: action.value.value }, id),
            );
          } else if (action._tag === "Scroll" && action.mode._tag === "By") {
            yield* Stream.runCollect(
              yield* tools.handle(
                "browser_scroll",
                { deltaX: action.mode.deltaX, deltaY: action.mode.deltaY },
                id,
              ),
            );
          } else
            return yield* new BenchError({
              operation: "record",
              message: "Unsupported fixture action.",
            });
        }
      }),
    );
    const snapshot = yield* host.receipts;

    if (snapshot.dropped > 0 || snapshot.receipts.length !== walk.actions.length + 1)
      return yield* new BenchError({
        operation: "record",
        message: "Every action needs its original receipt.",
      });

    const parts = yield* Effect.forEach(snapshot.receipts, (receipt) =>
      Effect.gen(function* () {
        if (receipt._tag === "Navigation") return yield* Plan.recordedNavigation(receipt.operation);
        if (receipt._tag === "Run")
          return yield* receipt.operation.completed.pipe(Effect.flatMap(Plan.recorded));

        return yield* new BenchError({
          operation: "record",
          message: "Tool refused the baseline action.",
        });
      }),
    );

    // No settled Tool exists: this one host-authored step is also a real recorded Page run.
    const final = yield* page
      .run({ version: 1, steps: [{ id: "settle", action: settled }] })
      .pipe(Effect.flatMap(Plan.recorded));

    return yield* Plan.decode({
      version: 1,
      steps: [...parts.flatMap((part) => part.steps), ...final.steps].map((step, index) => ({
        ...step,
        id: `recorded-${index}`,
      })),
    });
  }).pipe(Effect.ensuring(closePage(page).pipe(Effect.orDie)));
});

const truthMatches = (actual: DriftTruth | undefined, expected: DriftTruth) =>
  actual !== undefined &&
  actual.page === expected.page &&
  actual.tab === expected.tab &&
  actual.item === expected.item &&
  actual.query === expected.query;

const waitTruth = Effect.fnUntraced(function* (site: DriftSite, run: string, expected: DriftTruth) {
  for (let attempt = 0; attempt < 100; attempt++) {
    const truth = site.truth(run);

    if (truthMatches(truth, expected)) return truth;
    yield* Effect.sleep(10);
  }

  return site.truth(run);
});

const replay = Effect.fnUntraced(function* <OwnerError>(
  browser: Browser.BrowserSession<OwnerError>,
  site: DriftSite,
  walk: (typeof walks)[number],
  path: RecordingPath,
  operator: DriftOperator,
  seed: number,
  recorded: DurablePlan,
  withinMillis: number,
) {
  const run = `${walk.id}-${path}-${operator}-${seed}`;

  site.configure(operator, seed, run);
  const page = yield* browser.createPage();

  return yield* Effect.gen(function* () {
    // Encode/decode is part of every fresh-page replay, not a bypass through the live Ran.
    const decoded = yield* Plan.decode(yield* Plan.encode(recorded));
    const inputs = Object.fromEntries(Plan.inputSlots(decoded).map((slot) => [slot.name, "Alpha"]));

    const started = yield* browser.monotonicTimeNanos;

    const result = yield* page
      .run(decoded, { inputs, within: withinMillis, style: "plain" })
      .pipe(Effect.exit);

    const finished = yield* browser.monotonicTimeNanos;
    const truth = yield* waitTruth(site, run, walk.truth);

    if (Exit.isSuccess(result))
      return {
        walk: walk.id,
        path,
        operator,
        seed,
        outcome: truthMatches(truth, walk.truth) ? ("replayed" as const) : ("wrong-place" as const),
        reason: null,
        stepId: null,
        expected: walk.truth,
        truth: truth ?? null,
        completed: result.value.steps.length,
        total: decoded.steps.length,
        stepMillis: stepTimes(
          result.value.steps.map((step) => step.attempt),
          started,
          finished,
        ),
        phaseMillis: result.value.steps.map((step) => elapsed(step.attempt)),
      };
    const error = Option.getOrUndefined(Cause.findErrorOption(result.cause));

    if (error?._tag !== "StepFailed") return yield* Effect.failCause(result.cause);

    return {
      walk: walk.id,
      path,
      operator,
      seed,
      outcome: "failed-typed" as const,
      reason: error.error.reason._tag,
      stepId: error.stepId ?? null,
      expected: walk.truth,
      truth: truth ?? null,
      completed: error.completed.length,
      total: decoded.steps.length,
      stepMillis: stepTimes(
        [
          ...error.completed.map((step) => step.attempt),
          ...(error.attempt === undefined ? [] : [error.attempt]),
        ],
        started,
        finished,
      ),
      phaseMillis: [
        ...error.completed.map((step) => elapsed(step.attempt)),
        ...(error.attempt === undefined ? [] : [elapsed(error.attempt)]),
      ],
    };
  }).pipe(Effect.ensuring(closePage(page).pipe(Effect.orDie)));
});

export const matrix = Effect.fn("Bench.replayMatrix")(function* <OwnerError>(
  browser: Browser.BrowserSession<OwnerError>,
  options: ReplayOptions = {},
) {
  const site = options.site ?? (yield* driftSite);

  const selected = walks.filter(
    (walk) => options.walkIds === undefined || options.walkIds.includes(walk.id),
  );

  const seeds = options.seeds ?? [1, 2, 3, 4, 5];
  const drifts = options.operators ?? operators;
  const paths = options.paths ?? recordingPaths;
  const withinMillis = options.withinMillis ?? 5000;

  if (
    !Number.isSafeInteger(withinMillis) ||
    withinMillis < 1000 ||
    withinMillis > 15000 ||
    selected.length === 0 ||
    seeds.length === 0 ||
    seeds.length > 5 ||
    seeds.some((seed) => !Number.isSafeInteger(seed)) ||
    drifts.length === 0 ||
    drifts.length > 9 ||
    paths.length === 0 ||
    paths.length > 2
  )
    return yield* new BenchError({
      operation: "replay",
      message: "Replay matrix exceeds fixture bounds.",
    });
  const cells: ReplayCell[] = [];

  for (const walk of selected)
    for (const path of paths) {
      const baseline = `${walk.id}-${path}-baseline`;

      site.configure("none", 0, baseline);
      const recorded = yield* record(browser, site, walk, path);

      if (!truthMatches(yield* waitTruth(site, baseline, walk.truth), walk.truth))
        return yield* new BenchError({
          operation: "record",
          message: "Baseline truth did not match its walk.",
        });
      for (const operator of drifts)
        for (const seed of seeds)
          cells.push(
            yield* replay(browser, site, walk, path, operator, seed, recorded, withinMillis),
          );
    }

  const groups = paths.flatMap((path) =>
    drifts.map((operator) => {
      const group = cells.filter((cell) => cell.path === path && cell.operator === operator);

      return {
        path,
        operator,
        count: group.length,
        replayed: group.filter((cell) => cell.outcome === "replayed").length,
        failedTyped: group.filter((cell) => cell.outcome === "failed-typed").length,
        wrongPlace: group.filter((cell) => cell.outcome === "wrong-place").length,
        stepMillis: quantiles(group.flatMap((cell) => [...cell.stepMillis])),
      };
    }),
  );

  return {
    cells,
    groups,
    truthEvents: site.events(),
    lostTruthEvents: site.lost(),
    recording: {
      page: "Plan.recorded",
      tools: "original ToolHost receipts plus one host-authored recorded settled step",
      stepTiming:
        "owner monotonic time from run request or preceding terminal evidence to attempt terminal evidence",
      withinMillis,
    },
  };
});

export const replayDrift = Effect.fn("Bench.replayDrift")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: ReplayOptions = {},
) {
  const result = yield* matrix(browser, options);

  journal.truth = json({
    cells: result.cells,
    events: result.truthEvents,
    lost: result.lostTruthEvents,
  });
  journal.metrics = json({ groups: result.groups, recording: result.recording });

  return result;
});
