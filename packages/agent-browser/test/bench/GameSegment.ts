import { createHash } from "node:crypto";

import { Effect, Option, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import type * as Browser from "effect-browser/browser";
import { Prompt, Toolkit } from "effect/unstable/ai";

import { waitForGame } from "../fixtures/GameDriver.ts";
import { gameSite, type GameSite, type TruthReceipt } from "../fixtures/GameSite.ts";
import { inspectionObservation, inspectionReference } from "../fixtures/Inspection.ts";
import { filming } from "./Backends.ts";
import { answer, call, picture, scripted, type Driver, type Turn } from "./Drivers.ts";
import { cadence, freezes, type Interval } from "./Picture.ts";
import { BenchError, json, type Journal, type RecordingFrame, type Usage } from "./Records.ts";
import * as StepDigest from "./StepDigest.ts";
import { grade, Narration, type Truth } from "./Understanding.ts";

export interface SegmentCaption {
  readonly atMillis: number;
  readonly kind: "lobby" | "announce" | "action" | "result";
  readonly output: Narration;
  readonly truth: Truth | null;
  readonly grade: ReturnType<typeof grade> | null;
}

export interface GameSegmentOptions {
  readonly durationMillis?: number;
  readonly style?: "plain" | "performed";
  readonly condition?: "picture" | "digest";
  readonly announceThenSpin?: boolean;
  readonly airDelayMillis?: number;
  readonly maxSpins?: number;
  readonly pictureScale?: 0.5 | 1;
  readonly driver?: Driver;
  /** Prepare this before acquiring a hosted browser, with two separately reachable origins. */
  readonly site?: GameSite;
}

const Options = Schema.Struct({
  durationMillis: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 900000 })),
  style: Schema.Literals(["plain", "performed"]),
  condition: Schema.Literals(["picture", "digest"]),
  announceThenSpin: Schema.Boolean,
  airDelayMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60000 })),
  maxSpins: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 400 })),
  pictureScale: Schema.Literals([0.5, 1]),
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
}) => {
  const receipts = input.events.filter((receipt) => receipt.kind === "reels");
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
      eligibleToAir: latencyMillis !== null && latencyMillis <= input.airDelayMillis,
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
    .filter((at) => at >= input.window.start && at <= input.window.end)
    .sort((a, b) => a - b);

  const boundaries = [input.window.start, ...ordered, input.window.end];
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
      intervals: gaps,
      thresholdMillis: 1000,
      qualification:
        "no changed JPEG encoding or published caption; encoding differences are a picture-change proxy",
    },
    picture: cadence(input.frames, input.window),
    spinPicture: changing.map((window) => cadence(input.frames, window)),
    spinFreezes: freezes(input.frames, changing, input.window),
    resultCaptions: reactions,
    resultToCaptionMillis: {
      p50: quantile(latencies, 0.5),
      p95: quantile(latencies, 0.95),
      qualification:
        "host-validated result to published caption with matching structured spin fact",
    },
    airDelayMillis: input.airDelayMillis,
    eligibleToAirRate:
      results.length === 0
        ? null
        : reactions.filter((reaction) => reaction.eligibleToAir).length / results.length,
    moneyFactAccuracy: moneyTotal === 0 ? null : moneyCorrect / moneyTotal,
    moneyCorrect,
    moneyTotal,
    anyFalseFactRate:
      graded.length === 0
        ? null
        : graded.filter((checked) => checked.anyFalseFact).length / graded.length,
    interstitialSeconds: spanSeconds(input.interstitials),
    interstitialHandling:
      "model tools dismiss cookie and age gates; host waits for the timed result banner",
    costMicrousd:
      input.usage?.status === "estimated-from-reported-usage" ? input.usage.costMicrousd : null,
    usageStatus: input.usage?.status ?? "scripted-unmeasured",
  };
};

const resultTruth = (site: GameSite, spin: number): Truth | undefined => {
  const receipt = site
    .events()
    .findLast(
      (candidate) =>
        candidate.kind === "reels" &&
        candidate.event.tag === "result" &&
        candidate.event.spin === spin,
    );

  if (receipt?.event.tag !== "result") return undefined;

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
  const start = journal.elapsedMillis();
  const deadline = start + config.durationMillis;
  const clockOffset = journal.elapsedMillis() - site.elapsedMillis();
  const captions: SegmentCaption[] = [];
  const interstitials: Interval[] = [];
  let stopReason: "duration" | "spin-cap" | "failure" = "duration";
  let permittedSpin = 0;
  let pictureCalls = 0;
  let lastSequence = 0n;
  let lastInvocationId: string | null = null;
  let lastSteps: ReadonlyArray<StepDigest.StepFact> = [];
  let segmentEnded = start;

  const host = yield* BrowserTools.makeHost(browser, page, {
    execution: {
      style: config.style === "plain" ? "plain" : { seed: journal.manifest.seed },
      within: 10000,
    },
    coordinatePolicy: {
      admit: () =>
        journal.elapsedMillis() < deadline &&
        site.state("reels").spin <= permittedSpin &&
        site.state("reels").spin < config.maxSpins,
    },
    lane: { maxOutstanding: 1 },
  });

  const playTools = Toolkit.merge(BrowserTools.nativeToolkit, BrowserTools.keyboardToolkit);
  const lobbyTools = Toolkit.merge(BrowserTools.toolkit, playTools);
  const image = picture(page, { every: "call", scale: config.pictureScale });

  const run = Effect.fnUntraced(function* (
    kind: SegmentCaption["kind"],
    question: string,
    turns: ReadonlyArray<Turn>,
    truth: Truth | null,
  ) {
    const driver = options.driver ?? scripted(journal, turns);
    const toolkit = kind === "lobby" ? lobbyTools : kind === "action" ? playTools : Toolkit.make();
    // The segment deadline cancels first; a simultaneous agent deadline would misreport failure.
    const remaining = Math.max(1, Math.min(30000, deadline - journal.elapsedMillis() + 1000));

    const agent = Agent.make("watched-game-segment", {
      input: Schema.String,
      output: Narration,
      toolkit,
      instructions: `${BrowserTools.instructions(toolkit)} Describe only supplied screen evidence. Captions are text. Facts use exactly the requested keys and demo credits. Start at most one spin per action run. A dispatched input does not prove a game result.`,
      policy: {
        maxTurns: kind === "lobby" ? 12 : 5,
        maxToolCalls: kind === "lobby" ? 10 : 4,
        maxDuration: remaining,
        onExhaustion: "fail",
      },
    });

    const result = yield* host.run(
      driver.provide(
        AgentRuntime.run(agent, question, {
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
          ...(driver.estimate === undefined ? {} : { costEstimator: driver.estimate }),
          transientContext: {
            load: () =>
              Effect.gen(function* () {
                const png = yield* image.load();

                pictureCalls++;
                if (config.condition === "picture") return png;
                const receipts = yield* host.receipts;
                const recent = receiptWindow(receipts.receipts, receipts.dropped, lastInvocationId);
                const projected = yield* StepDigest.fromReceipts(recent);

                if (projected.length > 0) lastSteps = projected;

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
      ),
    );

    const caption: SegmentCaption = {
      kind,
      atMillis: journal.elapsedMillis(),
      output: result.output,
      truth,
      grade: truth === null ? null : grade(result.output, truth),
    };

    captions.push(caption);
    journal.append({ kind: "host", turn: null, value: json({ caption }) });
    lastSequence = (yield* page.timeline.snapshot()).newest?.sequence ?? lastSequence;
    lastInvocationId = (yield* host.receipts).receipts.at(-1)?.invocationId ?? lastInvocationId;

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
    yield* waitForGame(site, "reels", (state) => state.ready, "segment reached game");
    interstitials.push({ start: lobbyStart, end: journal.elapsedMillis() });
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

  yield* filming(
    journal,
    page,
    Effect.suspend(() =>
      work.pipe(
        Effect.timeoutOption(Math.max(1, deadline - journal.elapsedMillis())),
        Effect.tap((result) =>
          Effect.sync(() => {
            if (Option.isNone(result)) stopReason = "duration";
          }),
        ),
        Effect.onError(() =>
          Effect.sync(() => {
            stopReason = "failure";
          }),
        ),
        Effect.ensuring(
          Effect.sync(() => {
            segmentEnded = journal.elapsedMillis();
          }),
        ),
      ),
    ),
  ).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        const end = segmentEnded;

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
          }),
          config,
          stopReason,
          pictureCalls,
          captions,
          measured: options.driver === undefined ? "scripted-plumbing" : "model",
          durationOverrunMillis: Math.max(0, end - deadline),
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
