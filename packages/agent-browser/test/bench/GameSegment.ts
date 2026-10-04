import { createHash } from "node:crypto";

import * as Agent from "@yielded/agent/agent";
import * as AgentRuntime from "@yielded/agent/agent-runtime";
import { Deferred, Effect, Fiber, Layer, Option, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import type * as Browser from "effect-browser/browser";
import { AiError, Prompt, Tool, Toolkit } from "effect/ai";

import { waitForGame } from "../fixtures/GameDriver.ts";
import { gameSite, type GameSite, type TruthReceipt } from "../fixtures/GameSite.ts";
import { inspectionObservation, inspectionReference } from "../fixtures/Inspection.ts";
import { filming } from "./Backends.ts";
import { ModelRequestAdmission } from "./Budget.ts";
import { answer, call, picture, scripted, type Driver, type Turn } from "./Drivers.ts";
import { executionStyle, type StyleOptions } from "./ExecutionStyle.ts";
import { gameKeyboardToolkit, makeGameKeyboard } from "./GameKeyboard.ts";
import { cadence, freezes, measurement, recordingCutoff, type Interval } from "./Picture.ts";
import { BenchError, json, type Journal, type RecordingFrame, type Usage } from "./Records.ts";
import * as StepDigest from "./StepDigest.ts";
import { grade, Narration, type Truth } from "./Understanding.ts";

export interface SegmentCaption {
  readonly atMillis: number;
  readonly kind: "lobby" | "announce" | "action" | "result";
  readonly output: Narration;
  readonly truth: Truth | null;
  readonly grade: ReturnType<typeof grade> | null;
  readonly resultQualification?:
    | "validated-before-caption"
    | "no-validated-result-before-caption"
    | "truth-delivery-incomplete";
}

export interface GameSegmentOptions extends StyleOptions {
  readonly durationMillis?: number;
  /** Settlement only; never extends capture, model admission or browser input. At most 30 s. */
  readonly settlementDrainMillis?: number;
  readonly condition?: "picture" | "digest";
  readonly announceThenSpin?: boolean;
  readonly airDelayMillis?: number;
  readonly maxSpins?: number;
  readonly pictureScale?: 0.5 | 1;
  readonly driver?: Driver;
  /** Prepare this before acquiring a hosted browser, with two separately reachable origins. */
  readonly site?: GameSite;
}

const maxSettlementDrainMillis = 30000;

const Options = Schema.Struct({
  durationMillis: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900000 })),
  settlementDrainMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: maxSettlementDrainMillis }),
  ),
  style: Schema.Literals(["plain", "performed"]),
  condition: Schema.Literals(["picture", "digest"]),
  announceThenSpin: Schema.Boolean,
  airDelayMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 })),
  maxSpins: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 })),
  pictureScale: Schema.Literals([0.5, 1]),
});

class SegmentDeadline extends Schema.TaggedError<SegmentDeadline>()("SegmentDeadline", {}) {}

const pauseToolkit = Toolkit.make(
  Tool.make("bench_pause", {
    description:
      "Wait for the requested number of milliseconds before the next current-screen picture. This wait has no knowledge of game state; choose it from visual evidence.",
    parameters: Schema.Struct({
      millis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 5000 })),
    }),
    success: Schema.Struct({ waitedMillis: Schema.Int }),
  }).annotate(Tool.Readonly, true),
);

const pauseHandlers = pauseToolkit.toLayer({
  bench_pause: (request) =>
    Effect.sleep(request.millis).pipe(Effect.as({ waitedMillis: request.millis })),
});

export const segmentCallCaps = (maxSpins = 400, announceThenSpin = false) => ({
  lobbyModelCalls: 12,
  lobbyToolCalls: 10,
  episodeModelCalls: 6,
  episodeToolCalls: 5,
  episodeDurationMillis: 30000,
  maxSettlementDrainMillis,
  announcementModelCalls: announceThenSpin ? 1 : 0,
  episodes: maxSpins,
  inputAttemptsPerEpisode: 1,
  inputTool: "browser_click_at",
  keyboardTool: "bench_game_press",
  keyboardKeys: [" ", "ArrowUp", "ArrowDown"],
  keyboardExecution: "plain",
  actualSpinCap: maxSpins,
  totalModelCalls: 12 + maxSpins * (6 + (announceThenSpin ? 1 : 0)),
});

const quantile = (values: ReadonlyArray<number>, fraction: number) => {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);

  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)] ?? null;
};

const spanSeconds = (intervals: ReadonlyArray<Interval>) =>
  intervals.reduce((total, interval) => total + Math.max(0, interval.end - interval.start), 0) /
  1000;

/** A moving bounded window must be anchored by identity, never by its current length. */
export const receiptWindow = <A extends { readonly invocationId: string }>(
  receipts: ReadonlyArray<A>,
  dropped: number,
  anchor: string | null,
) => {
  const index =
    anchor === null ? -1 : receipts.findIndex((receipt) => receipt.invocationId === anchor);

  const complete = anchor === null ? dropped === 0 : index >= 0;

  return {
    receipts: anchor === null || index < 0 ? receipts : receipts.slice(index + 1),
    dropped: complete ? 0 : Math.max(1, dropped),
    anchor: anchor === null ? "initial" : index < 0 ? "evicted" : "present",
  };
};

/** Host receipt times and caption publication times share the journal's monotonic clock. */
export const segmentMetrics = (input: {
  readonly window: Interval;
  readonly events: ReadonlyArray<TruthReceipt>;
  readonly captions: ReadonlyArray<SegmentCaption>;
  readonly frames: ReadonlyArray<RecordingFrame>;
  readonly airDelayMillis: number;
  readonly interstitials: ReadonlyArray<Interval>;
  readonly usage: Usage | null;
  readonly measuredThroughMillis?: number;
}) => {
  const coverage = measurement(input.window, input.measuredThroughMillis);
  const measured = coverage.window;
  const unmeasuredSeconds = coverage.unmeasuredMillis / 1000;

  const receipts = input.events.filter(
    (receipt) =>
      receipt.kind === "reels" &&
      receipt.receivedAtMillis >= input.window.start &&
      receipt.receivedAtMillis <= input.window.end,
  );

  const results = receipts.filter((receipt) => receipt.event.tag === "result");
  const starts = receipts.filter((receipt) => receipt.event.tag === "spinStart");

  const changing = starts.map((receipt): Interval => ({
    start: receipt.receivedAtMillis,
    end:
      results.find((result) => result.event.spin === receipt.event.spin)?.receivedAtMillis ??
      input.window.end,
  }));

  const reactions = results.map((receipt) => {
    const caption = input.captions.find(
      (candidate) =>
        candidate.resultQualification !== "no-validated-result-before-caption" &&
        candidate.resultQualification !== "truth-delivery-incomplete" &&
        candidate.atMillis >= receipt.receivedAtMillis &&
        candidate.output.caption.length > 0 &&
        candidate.output.facts.spin === receipt.event.spin,
    );

    const latencyMillis =
      caption === undefined ? null : caption.atMillis - receipt.receivedAtMillis;

    return {
      spin: receipt.event.spin,
      resultAtMillis: receipt.receivedAtMillis,
      captionAtMillis: caption?.atMillis ?? null,
      latencyMillis,
      resultClock: "host-receipt",
      withinReceiptAirDelay: latencyMillis !== null && latencyMillis <= input.airDelayMillis,
      presentationLatencyMillis: null,
      eligibleToAir: null,
    };
  });

  const latencies = reactions.flatMap((reaction) =>
    reaction.latencyMillis === null ? [] : [reaction.latencyMillis],
  );

  const graded = input.captions.flatMap((caption) =>
    caption.grade === null ? [] : [caption.grade],
  );

  const moneyCorrect = graded.reduce((sum, checked) => sum + checked.moneyCorrect, 0);
  const moneyTotal = graded.reduce((sum, checked) => sum + checked.moneyTotal, 0);

  const activity = input.captions
    .filter((caption) => caption.output.caption.length > 0)
    .map((caption) => caption.atMillis);

  let previous: string | undefined;

  for (const frame of input.frames) {
    const fingerprint = createHash("sha256").update(frame.bytes).digest("hex");

    if (fingerprint !== previous) activity.push(frame.receivedAt);
    previous = fingerprint;
  }

  const ordered = [...new Set(activity)]
    .filter((at) => at >= measured.start && at <= measured.end)
    .sort((a, b) => a - b);

  const boundaries = [measured.start, ...ordered, measured.end];
  const gaps: Interval[] = [];

  for (let index = 1; index < boundaries.length; index++) {
    const start = boundaries[index - 1];
    const end = boundaries[index];

    if (start !== undefined && end !== undefined && end - start >= 1000) gaps.push({ start, end });
  }
  const durationMillis = Math.max(0, input.window.end - input.window.start);

  return {
    durationMillis,
    spinsStarted: starts.length,
    spinsCompleted: results.length,
    spinsPerMinute: durationMillis === 0 ? null : (results.length * 60000) / durationMillis,
    lobbyToFirstSpinMillis:
      starts[0] === undefined ? null : starts[0].receivedAtMillis - input.window.start,
    deadAir: {
      seconds: spanSeconds(gaps),
      unmeasuredSeconds,
      intervals: gaps,
      thresholdMillis: 1000,
      qualification:
        "no changed JPEG encoding or published caption; encoding differences are a picture-change proxy",
    },
    picture: {
      ...cadence(input.frames, measured),
      measurement: coverage,
      measuredThroughMillis: measured.end,
      unmeasuredSeconds,
    },
    spinPicture: changing.map((window) => {
      const observed = measurement(window, measured.end);

      return { ...cadence(input.frames, observed.window), measurement: observed };
    }),
    spinFreezes: {
      ...freezes(input.frames, changing, measured),
      unmeasuredSeconds: spanSeconds(
        changing.map((window) => ({
          start: Math.max(window.start, measured.end),
          end: Math.min(window.end, input.window.end),
        })),
      ),
    },
    resultCaptions: reactions,
    resultToCaptionMillis: {
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      qualification:
        "host-validated receipt to published caption with matching structured spin fact; result painting and screen presentation are unmeasured",
    },
    airDelayMillis: input.airDelayMillis,
    eligibleToAirRate: null,
    airEligibilityQualification:
      "unmeasured; host receipt and browser display clocks have no measured bridge",
    withinReceiptAirDelayRate:
      results.length === 0
        ? null
        : reactions.filter((reaction) => reaction.withinReceiptAirDelay).length / results.length,
    moneyFactAccuracy: moneyTotal === 0 ? null : moneyCorrect / moneyTotal,
    moneyCorrect,
    moneyTotal,
    anyFalseFactRate:
      graded.length === 0
        ? null
        : graded.filter((checked) => checked.anyFalseFact).length / graded.length,
    unmatchedResultCaptions: input.captions.filter(
      (caption) => caption.resultQualification === "no-validated-result-before-caption",
    ).length,
    ungradedResultCaptions: input.captions.filter(
      (caption) => caption.resultQualification === "truth-delivery-incomplete",
    ).length,
    interstitialSeconds: spanSeconds(input.interstitials),
    interstitialHandling:
      "model tools dismiss cookie and age gates; host waits for the timed result banner",
    costMicrousd:
      input.usage?.status === "estimated-from-reported-usage" ? input.usage.costMicrousd : null,
    usageStatus: input.usage?.status ?? "scripted-unmeasured",
  };
};

const resultTruth = (site: GameSite, spin: number, window?: Interval): Truth | undefined => {
  const receipt = site
    .events()
    .findLast(
      (candidate) =>
        candidate.kind === "reels" &&
        candidate.event.tag === "result" &&
        candidate.event.spin === spin &&
        (window === undefined ||
          (candidate.receivedAtMillis >= window.start && candidate.receivedAtMillis <= window.end)),
    );

  if (receipt?.event.tag !== "result") return undefined;
  if (
    window !== undefined &&
    !site
      .events()
      .some(
        (candidate) =>
          candidate.kind === "reels" &&
          candidate.event.tag === "spinStart" &&
          candidate.event.spin === spin &&
          candidate.receivedAtMillis >= window.start &&
          candidate.receivedAtMillis <= window.end,
      )
  )
    return undefined;

  return {
    facts: {
      spin,
      balance: receipt.event.balanceAfter,
      bet: site.state("reels").bet,
      win: receipt.event.win,
      notable: receipt.event.moment,
    },
    money: ["balance", "bet", "win"],
  };
};

const metadata = Effect.fnUntraced(function* (
  browser: Browser.BrowserSession<unknown>,
  page: Browser.Page,
) {
  const first = Option.getOrUndefined(yield* Stream.runHead(browser.pages));

  return first !== undefined && "_tag" in first && first._tag === "Inventory"
    ? first.pages.find((candidate) => candidate.identity.pageId === page.identity.pageId)
    : undefined;
});

/** A finite watched segment uses native tools and fresh pictures through the actual AgentRuntime. */
export const gameSegment = Effect.fn("Bench.gameSegment")(function* <OwnerError>(
  journal: Journal,
  browser: Browser.BrowserSession<OwnerError>,
  options: GameSegmentOptions = {},
) {
  const config = yield* Schema.decodeEffect(Options)({
    durationMillis: options.durationMillis ?? 600000,
    settlementDrainMillis: options.settlementDrainMillis ?? maxSettlementDrainMillis,
    style: options.style ?? "plain",
    condition: options.condition ?? "picture",
    announceThenSpin: options.announceThenSpin ?? false,
    airDelayMillis: options.airDelayMillis ?? 1000,
    maxSpins: options.maxSpins ?? 400,
    pictureScale: options.pictureScale ?? 0.5,
  });

  if (journal.manifest.capture.maxDurationMillis < config.durationMillis)
    return yield* BenchError.make({
      operation: "segment capture",
      message: "Capture duration must cover the segment.",
    });
  const site = options.site ?? (yield* gameSite({ seed: journal.manifest.seed }));

  if (journal.manifest.backend === "browserbase" && site.url === site.localUrl)
    return yield* BenchError.make({
      operation: "segment fixture",
      message: "Hosted segments require two separately reachable fixture origins.",
    });
  const page = browser.initialPage;
  const callCaps = segmentCallCaps(config.maxSpins, config.announceThenSpin);
  const start = journal.elapsedMillis();
  const deadline = start + config.durationMillis;
  const clockOffset = journal.elapsedMillis() - site.elapsedMillis();
  const captions: SegmentCaption[] = [];
  const interstitials: Interval[] = [];
  let stopReason: "duration" | "spin-cap" | "episode-cap" | "failure" = "duration";
  let permittedSpin = 0;
  let pictureCalls = 0;
  let lastSequence = 0n;
  let lastInvocationId: string | null = null;
  let lastKeyboardReceipt = 0;
  let lastSteps: ReadonlyArray<StepDigest.StepFact> = [];
  let segmentEnded = start;
  let settlementEnded = start;
  let settlementDrain: "not-needed" | "completed" | "timed-out" = "not-needed";
  let cutoffInterrupted = false;
  let inputAttemptsRemaining = 0;
  let episodes = 0;

  const admit = Effect.suspend(() =>
    journal.elapsedMillis() < deadline ? Effect.void : Effect.fail(new SegmentDeadline({})),
  );

  const modelAdmission = admit.pipe(
    Effect.mapError(() =>
      AiError.make({
        module: "BenchSegment",
        method: "admit",
        reason: new AiError.InvalidRequestError({ description: "Segment deadline reached." }),
      }),
    ),
  );

  const host = yield* BrowserTools.makeHost(browser, page, {
    execution: {
      style: yield* executionStyle(options, journal.manifest.seed),
      within: 10000,
    },
    policy: { admit: () => journal.elapsedMillis() < deadline },
    coordinatePolicy: {
      admit: () => {
        if (journal.elapsedMillis() >= deadline) return false;
        if (options.driver === undefined)
          return (
            site.state("reels").spin <= permittedSpin && site.state("reels").spin < config.maxSpins
          );

        return true;
      },
    },
    lane: { maxOutstanding: 1 },
  });

  const keyboard = makeGameKeyboard(journal, page, site, deadline);

  const playTools = BrowserTools.pointToolkit;

  const episodeTools = Toolkit.merge(
    playTools,
    gameKeyboardToolkit,
    Toolkit.make(BrowserTools.toolkit.tools.browser_inspect),
    pauseToolkit,
  );

  const lobbyTools = BrowserTools.toolkit;
  const image = picture(page, { every: "call", scale: config.pictureScale });

  const run = Effect.fnUntraced(function* (
    kind: SegmentCaption["kind"],
    question: string,
    turns: ReadonlyArray<Turn>,
    truth: Truth | null | ((publishedAt: number) => Truth | undefined),
  ) {
    yield* admit;
    const driver = options.driver ?? scripted(journal, turns);
    const autonomous = kind === "result" && options.driver !== undefined;

    const toolkit =
      kind === "lobby"
        ? lobbyTools
        : kind === "action"
          ? playTools
          : autonomous
            ? episodeTools
            : Toolkit.make();

    // The enclosing drain cancels first; the per-episode rail remains at most 30 seconds.
    const remaining = Math.max(
      1,
      Math.min(
        callCaps.episodeDurationMillis,
        deadline - journal.elapsedMillis() + config.settlementDrainMillis + 1000,
      ),
    );

    const maxTurns =
      kind === "lobby"
        ? callCaps.lobbyModelCalls
        : kind === "announce"
          ? 1
          : autonomous
            ? callCaps.episodeModelCalls
            : 5;

    const agent = Agent.make("watched-game-segment", {
      input: Schema.String,
      output: Narration,
      toolkit,
      instructions: `${BrowserTools.instructions(toolkit)} Describe only supplied screen evidence. Captions are text. Facts use exactly the requested keys and demo credits. Start at most one spin per action run. A dispatched input does not prove a game result.`,
      policy: {
        maxTurns,
        maxToolCalls:
          kind === "lobby" ? callCaps.lobbyToolCalls : autonomous ? callCaps.episodeToolCalls : 4,
        maxDuration: remaining,
        onExhaustion: "fail",
      },
    });

    const result = yield* host.run(
      driver
        .provide(
          AgentRuntime.run(agent, question, {
            beforeTurn: () => admit,
            onHistory: (history) =>
              driver.history(history).pipe(
                Effect.asVoid,
                Effect.mapError(() =>
                  BenchError.make({
                    operation: "segment history",
                    message: "Cannot encode agent history.",
                  }),
                ),
              ),
            estimateCostMicrousd: driver.estimate,
            turnAllowance: maxTurns,
            toolAuthorization: {
              authorize: ({ call: requested }) =>
                admit.pipe(
                  Effect.andThen(
                    Effect.sync(() => {
                      const name = requested.toolName;

                      if (
                        options.driver === undefined ||
                        (name !== "browser_click_at" && name !== "bench_game_press")
                      )
                        return { _tag: "allowed" } as const;
                      if (inputAttemptsRemaining === 0)
                        return {
                          _tag: "denied",
                          reason: "This episode's single input attempt is unavailable.",
                        } as const;
                      inputAttemptsRemaining--;

                      return { _tag: "allowed" } as const;
                    }),
                  ),
                ),
            },
            transientContext: {
              load: () =>
                Effect.gen(function* () {
                  yield* admit;
                  const png = yield* image.load();

                  pictureCalls++;
                  yield* admit;
                  if (config.condition === "picture") return png;
                  const receipts = yield* host.receipts;

                  const recent = receiptWindow(
                    receipts.receipts,
                    receipts.dropped,
                    lastInvocationId,
                  );

                  const projected = yield* StepDigest.fromReceipts(recent);

                  const keys = keyboard.facts
                    .slice(lastKeyboardReceipt)
                    .flatMap((fact) => fact.steps);

                  if (projected.length > 0 || keys.length > 0) lastSteps = [...projected, ...keys];

                  const digest = StepDigest.build({
                    steps: lastSteps,
                    timeline: yield* page.timeline.snapshot(),
                    now: yield* page.timeline.now,
                    page: yield* metadata(browser, page),
                    sinceSequence: lastSequence,
                    droppedReceipts: recent.dropped,
                  });

                  return Prompt.fromMessages([
                    ...png.content,
                    Prompt.makeMessage("user", {
                      content: [
                        Prompt.makePart("text", {
                          text: `Step digest:\n${JSON.stringify({ ...digest, receiptAnchor: recent.anchor })}`,
                        }),
                      ],
                    }),
                  ]);
                }),
            },
          }),
        )
        .pipe(Effect.provide(Layer.merge(pauseHandlers, keyboard.layer))),
    );

    const publishedAt = journal.elapsedMillis();

    if (publishedAt >= deadline) return;
    const deliveryIncomplete = typeof truth === "function" && site.failures().length > 0;

    const checkedTruth = deliveryIncomplete
      ? null
      : typeof truth === "function"
        ? truth(publishedAt)
        : truth;

    const gradeTruth = checkedTruth === undefined ? { facts: {} } : checkedTruth;

    const caption: SegmentCaption = {
      kind,
      atMillis: publishedAt,
      output: result.output,
      truth: gradeTruth,
      grade: gradeTruth === null ? null : grade(result.output, gradeTruth),
      ...(typeof truth === "function"
        ? {
            resultQualification: deliveryIncomplete
              ? "truth-delivery-incomplete"
              : checkedTruth === undefined
                ? "no-validated-result-before-caption"
                : "validated-before-caption",
          }
        : {}),
    };

    captions.push(caption);
    journal.append({ kind: "host", turn: null, value: json({ caption }) });
    lastSequence = (yield* page.timeline.snapshot()).newest?.sequence ?? lastSequence;
    lastInvocationId = (yield* host.receipts).receipts.at(-1)?.invocationId ?? lastInvocationId;
    lastKeyboardReceipt = keyboard.facts.length;

    return caption;
  });

  const work = Effect.gen(function* () {
    const lobbyStart = journal.elapsedMillis();

    yield* run(
      "lobby",
      `Visit ${site.url}, dismiss the cookie and age gates, and enter the canvas reels demo. Finish with a short caption and empty facts.`,
      [
        () => call("navigate", "browser_navigate", { url: site.url }),
        () => call("cookies", "browser_inspect", {}),
        (request) => call("accept", "browser_click", inspectionReference(request, "Accept")),
        () => call("age", "browser_inspect", {}),
        (request) =>
          call("confirm", "browser_click", inspectionReference(request, "I am 18 or older")),
        () => call("lobby", "browser_inspect", {}),
        (request) => {
          const observation = inspectionObservation(request);
          const control = observation.controls[0];

          if (control === undefined) throw new Error("No observed game entry");

          return call("play", "browser_click", {
            observationId: observation.observationId,
            elementId: control.elementId,
          });
        },
        () => answer({ caption: "The canvas reels demo is open.", facts: {} }),
      ],
      null,
    );
    if (journal.elapsedMillis() >= deadline) return;
    if (options.driver === undefined)
      yield* waitForGame(site, "reels", (state) => state.ready, "segment reached game");
    interstitials.push({ start: lobbyStart, end: journal.elapsedMillis() });
    if (options.driver !== undefined) {
      while (journal.elapsedMillis() < deadline && episodes < config.maxSpins) {
        if (config.announceThenSpin)
          yield* run(
            "announce",
            "Announce the next spin before taking any action. Use empty facts.",
            [],
            null,
          );
        inputAttemptsRemaining = 1;
        episodes++;
        const episodeStart = journal.elapsedMillis();

        yield* run(
          "result",
          "Use the current pictures to play exactly one spin. If the game is busy, use bench_pause and browser_inspect for the next picture until SPIN is available. Click the rendered SPIN control once or send one space with bench_game_press to the already focused canvas, then choose pauses from the pictures until the reels stop. Keyboard input is plain even in a performed segment. ArrowUp and ArrowDown change the bet and consume the same attempt. Finish with a short result caption and facts spin (visible SPIN counter), balance, bet, win (LAST WIN), and notable (the visible Notable label: ordinary, near-miss, big-win, bonus, or losing-streak). This episode admits one input attempt shared by point-click and keyboard. An input acknowledgement does not prove a result.",
          [],
          (publishedAt) => {
            if (inputAttemptsRemaining !== 0) return undefined;
            const state = site.state("reels");

            return resultTruth(site, state.spin, {
              start: episodeStart - clockOffset,
              end: publishedAt - clockOffset,
            });
          },
        );
        inputAttemptsRemaining = 0;
      }
      stopReason = episodes >= config.maxSpins ? "episode-cap" : "duration";

      return;
    }
    while (journal.elapsedMillis() < deadline && site.state("reels").spin < config.maxSpins) {
      yield* waitForGame(
        site,
        "reels",
        (state) => state.phase === "idle",
        "segment ready for spin",
      );
      permittedSpin = site.state("reels").spin;
      const spin = permittedSpin + 1;

      if (config.announceThenSpin)
        yield* run(
          "announce",
          "Announce the next spin before taking any action. Use empty facts.",
          [() => answer({ caption: "I will spin the reels now.", facts: {} })],
          null,
        );
      yield* run(
        "action",
        "Start exactly one spin using the rendered SPIN control. Finish with a short action caption and empty facts. Do not claim a result before the reels stop.",
        [
          () =>
            call(`spin-${spin}`, "browser_click_at", {
              x: (journal.manifest.viewport.width - 960) / 2 + 815,
              y: 570,
            }),
          () => answer({ caption: "The reels are spinning.", facts: {} }),
        ],
        null,
      );
      yield* waitForGame(
        site,
        "reels",
        (state) => state.spin === spin && state.phase !== "spinning",
        "segment result",
      );
      const truth = resultTruth(site, spin);

      if (truth === undefined)
        return yield* BenchError.make({
          operation: "segment truth",
          message: "No independently validated result.",
        });
      yield* run(
        "result",
        "Describe the stopped reels. Report facts spin, balance, bet, win (LAST WIN), and notable (ordinary, near-miss, big-win, bonus, or losing-streak).",
        [
          () =>
            answer(
              json({
                caption: `Spin ${spin} finished with ${truth.facts.win} demo credits won.`,
                facts: truth.facts,
              }),
            ),
        ],
        truth,
      );
    }
    stopReason = site.state("reels").spin >= config.maxSpins ? "spin-cap" : "duration";
  });

  // The worker belongs to the enclosing browser scope, not Capture's shorter scope.
  const filmingStarted = yield* Deferred.make<void>();

  const worker = yield* Deferred.await(filmingStarted).pipe(
    Effect.andThen(work),
    Effect.catchTag("SegmentDeadline", () => Effect.void),
    Effect.catchIf(
      (error) =>
        AiError.isAiError(error) && error.module === "BenchSegment" && error.method === "admit",
      () => Effect.void,
    ),
    Effect.provideService(ModelRequestAdmission, modelAdmission),
    Effect.forkScoped,
  );

  yield* Effect.gen(function* () {
    const measured = yield* filming(
      journal,
      page,
      Deferred.succeed(filmingStarted, undefined).pipe(
        Effect.andThen(
          Effect.gen(function* () {
            // Timer delivery can precede the journal's monotonic deadline.
            while (true) {
              const result = yield* Fiber.await(worker).pipe(
                Effect.timeoutOption(Math.max(1, Math.ceil(deadline - journal.elapsedMillis()))),
              );

              if (Option.isSome(result) || journal.elapsedMillis() >= deadline) return result;
            }
          }),
        ),
        Effect.tap((result) =>
          Option.isNone(result) && options.driver?.hasPendingUsage?.() !== true
            ? Effect.sync(() => {
                cutoffInterrupted = true;
              }).pipe(Effect.andThen(Fiber.interrupt(worker)), Effect.asVoid)
            : Effect.void,
        ),
        Effect.ensuring(
          Effect.sync(() => {
            segmentEnded = Math.min(deadline, journal.elapsedMillis());
            if (journal.recording !== undefined)
              journal.recording.measurementEndedAt = segmentEnded;
          }),
        ),
      ),
    );

    if (Option.isSome(measured)) return yield* measured.value;
    stopReason = "duration";
    if (cutoffInterrupted) return;

    const settled = yield* Fiber.await(worker).pipe(
      Effect.timeoutOption(
        Math.max(1, Math.ceil(deadline + config.settlementDrainMillis - journal.elapsedMillis())),
      ),
    );

    settlementDrain = Option.isSome(settled) ? "completed" : "timed-out";
    if (Option.isSome(settled)) return yield* settled.value;
    yield* Fiber.interrupt(worker);
  }).pipe(
    Effect.onError(() =>
      Effect.sync(() => {
        stopReason = "failure";
      }),
    ),
    Effect.ensuring(Fiber.interrupt(worker)),
    Effect.ensuring(
      Effect.sync(() => {
        settlementEnded = journal.elapsedMillis();
        const end = segmentEnded;

        if (end >= deadline && stopReason !== "failure") stopReason = "duration";

        const events = site.events().map((receipt) => ({
          ...receipt,
          receivedAtMillis: receipt.receivedAtMillis + clockOffset,
        }));

        const banners = events
          .filter((receipt) => receipt.kind === "reels" && receipt.event.tag === "bannerShown")
          .map((receipt) => ({
            start: receipt.receivedAtMillis,
            end:
              events.find(
                (candidate) =>
                  candidate.kind === "reels" &&
                  candidate.event.tag === "bannerHidden" &&
                  candidate.receivedAtMillis >= receipt.receivedAtMillis,
              )?.receivedAtMillis ?? end,
          }));

        journal.usage = options.driver?.finish() ?? null;
        journal.truth = json({
          seed: site.seed,
          credits: site.credits,
          events,
          state: site.state("reels"),
          deliveryFailures: site.failures(),
          receivedEvents: site.receivedEvents().map((receipt) => ({
            ...receipt,
            receivedAtMillis: receipt.receivedAtMillis + clockOffset,
          })),
          truthQualification:
            site.failures().length === 0
              ? "validated receipts only; source delivery completeness is unmeasured"
              : "incomplete; rejected receipts are not grading truth",
          clock: "journal-monotonic-millis",
          clockOffsetMillis: clockOffset,
          originQualification: site.originQualification,
        });
        journal.metrics = json({
          ...segmentMetrics({
            window: { start, end },
            events,
            captions,
            frames: journal.recording?.frames ?? [],
            airDelayMillis: config.airDelayMillis,
            interstitials: [...interstitials, ...banners],
            usage: journal.usage,
            measuredThroughMillis: recordingCutoff(journal.recording, { start, end }),
          }),
          config,
          stopReason,
          pictureCalls,
          captions,
          measured:
            options.driver === undefined
              ? "scripted-plumbing"
              : journal.usage === null
                ? "supplied-driver-plumbing"
                : "model",
          episodes,
          callCaps,
          keyboardFacts: keyboard.facts,
          keyboardExecution: "plain",
          decisionSource:
            options.driver === undefined
              ? "fixture-scripted-scheduling"
              : "model-pictures-and-chosen-pauses",
          interstitialHandling:
            options.driver === undefined
              ? "model tools dismiss gates; fixture script schedules around the timed banner"
              : "model tools dismiss gates and choose pauses from current pictures",
          durationOverrunMillis: Math.max(0, end - deadline),
          settlementDrain: {
            status: settlementDrain,
            maxDurationMillis: config.settlementDrainMillis,
            endedAtMillis: settlementEnded,
            elapsedAfterMeasurementMillis: Math.max(0, settlementEnded - end),
          },
          deadlineQualification:
            "segment deadline seals capture and metrics and closes request/tool admission; only admitted work drains for bounded settlement; unavailable usage stops later paid trials",
          factsQualification:
            "requested result facts; caption prose is retained without semantic grading",
          capture: {
            nativeStop: journal.recording?.nativeStop ?? "missing",
            limitReached: journal.recording?.limitReached ?? null,
            discardedFrames: journal.recording?.discardedFrames ?? 0,
            error: journal.recording?.error ?? null,
          },
        });
      }),
    ),
  );

  return captions;
});
