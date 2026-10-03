import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { run } from "../bench/Backends.ts";
import { answer, call, scripted, type Driver, type Turn } from "../bench/Drivers.ts";
import { gameSegment } from "../bench/GameSegment.ts";
import { Journal } from "../bench/Records.ts";
import { gameSite } from "../fixtures/GameSite.ts";
import { inspectionObservation, inspectionReference } from "../fixtures/Inspection.ts";

const Metrics = Schema.Struct({
  spinsStarted: Schema.Int,
  spinsCompleted: Schema.Int,
  moneyFactAccuracy: Schema.Finite,
  pictureCalls: Schema.Int,
  stopReason: Schema.String,
  captions: Schema.Array(
    Schema.Struct({
      atMillis: Schema.Finite,
      kind: Schema.String,
      output: Schema.Struct({ caption: Schema.String, facts: Schema.Json }),
    }),
  ),
  resultCaptions: Schema.Array(
    Schema.Struct({
      latencyMillis: Schema.Finite,
      eligibleToAir: Schema.Null,
      withinReceiptAirDelay: Schema.Boolean,
    }),
  ),
  measured: Schema.String,
  costMicrousd: Schema.Null,
});

const lobbyTurns = (url: string): ReadonlyArray<Turn> => [
  () => call("navigate", "browser_navigate", { url }),
  () => call("cookies", "browser_inspect", {}),
  (request) => call("accept", "browser_click", inspectionReference(request, "Accept")),
  () => call("age", "browser_inspect", {}),
  (request) => call("confirm", "browser_click", inspectionReference(request, "I am 18 or older")),
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
  () => answer({ caption: "The canvas game is open.", facts: {} }),
];

for (const style of ["plain", "performed"] as const) {
  it.live(
    `real Chromium: ${style} game segment sees per-call PNGs and grades independent spin truth`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const journal = new Journal({
            version: 1,
            runId: `segment-${style}`,
            scene: "game-segment",
            backend: "chromium",
            driver: "scripted",
            sourceRevision: "native-test",
            sourceDirty: false,
            trial: 0,
            seed: 2,
            viewport: { width: 1280, height: 720 },
            settings: { style },
            capture: {
              maxFrames: 1200,
              maxBytes: 32 * 1024 * 1024,
              quality: 35,
              maxDurationMillis: 20000,
            },
          });

          yield* run(journal, (browser) =>
            gameSegment(journal, browser, {
              durationMillis: 15000,
              maxSpins: 1,
              style,
              condition: style === "plain" ? "picture" : "digest",
              announceThenSpin: true,
              airDelayMillis: 5000,
            }),
          );
          const metrics = yield* Schema.decodeUnknownEffect(Metrics)(journal.metrics);
          const requests = journal.snapshot().events.filter((event) => event.kind === "request");

          expect(metrics.spinsStarted).toBe(1);
          expect(metrics.spinsCompleted).toBe(1);
          expect(metrics.stopReason).toBe("spin-cap");
          expect(metrics.moneyFactAccuracy).toBe(1);
          expect(metrics.measured).toBe("scripted-plumbing");
          expect(metrics.costMicrousd).toBeNull();
          expect(metrics.pictureCalls).toBe(requests.length);
          expect(requests.length).toBeGreaterThanOrEqual(12);
          for (const request of requests)
            expect(JSON.stringify(request.value)).toContain("image/png");
          if (style === "performed")
            expect(JSON.stringify(requests[0]?.value)).toContain("Step digest:");
          expect(metrics.captions.map((caption) => caption.kind)).toEqual([
            "lobby",
            "announce",
            "action",
            "result",
          ]);
          expect(metrics.resultCaptions).toHaveLength(1);
          expect(metrics.resultCaptions[0]?.eligibleToAir).toBeNull();
          expect(metrics.resultCaptions[0]?.withinReceiptAirDelay).toBe(true);
          expect(journal.recording?.nativeStop).toBe("confirmed");
          expect(journal.recording?.limitReached).toBeNull();
          expect(journal.cleanup).toBe("confirmed");
          expect(journal.ownerClose).toBe("confirmed");
          expect(journal.snapshot().loss.events).toBe(0);
        }),
      ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live("real Chromium: segment duration stops new work and retains checked cleanup", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const journal = new Journal({
        version: 1,
        runId: "segment-duration",
        scene: "game-segment",
        backend: "chromium",
        driver: "scripted",
        sourceRevision: "native-test",
        sourceDirty: false,
        trial: 0,
        seed: 2,
        viewport: { width: 1280, height: 720 },
        settings: { durationMillis: 1000 },
        capture: {
          maxFrames: 200,
          maxBytes: 8 * 1024 * 1024,
          quality: 25,
          maxDurationMillis: 3000,
        },
      });

      yield* run(journal, (browser) => gameSegment(journal, browser, { durationMillis: 1000 }));

      const metrics = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          durationMillis: Schema.Finite,
          stopReason: Schema.String,
          durationOverrunMillis: Schema.Finite,
        }),
      )(journal.metrics);

      expect(metrics.stopReason).toBe("duration");
      expect(metrics.durationMillis).toBeGreaterThanOrEqual(950);
      expect(metrics.durationMillis).toBeLessThan(2500);
      expect(metrics.durationOverrunMillis).toBeLessThan(1500);
      expect(journal.recording?.nativeStop).toBe("confirmed");
      expect(journal.ownerClose).toBe("confirmed");
      expect(journal.cleanup).toBe("confirmed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("real Chromium: retained-frame cap qualifies the later game picture as unmeasured", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const journal = new Journal({
        version: 1,
        runId: "segment-frame-cap",
        scene: "game-segment",
        backend: "chromium",
        driver: "scripted",
        sourceRevision: "native-test",
        sourceDirty: false,
        trial: 0,
        seed: 2,
        viewport: { width: 1280, height: 720 },
        settings: { maxFrames: 2 },
        capture: { maxFrames: 2, maxBytes: 8 * 1024 * 1024, quality: 25, maxDurationMillis: 15000 },
      });

      yield* run(journal, (browser) =>
        gameSegment(journal, browser, { durationMillis: 12000, maxSpins: 1 }),
      );

      const metrics = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          deadAir: Schema.Struct({ seconds: Schema.Finite, unmeasuredSeconds: Schema.Finite }),
          spinFreezes: Schema.Struct({ seconds: Schema.Finite, unmeasuredSeconds: Schema.Finite }),
          picture: Schema.Struct({ measurement: Schema.Struct({ status: Schema.String }) }),
        }),
      )(journal.metrics);

      expect(journal.recording?.limitReached).toBe("frames");
      expect(metrics.deadAir.seconds).toBe(0);
      expect(metrics.deadAir.unmeasuredSeconds).toBeGreaterThan(1);
      expect(metrics.spinFreezes.seconds).toBe(0);
      expect(metrics.spinFreezes.unmeasuredSeconds).toBeGreaterThan(1);
      expect(metrics.picture.measurement.status).toBe("partial");
      expect(journal.cleanup).toBe("confirmed");
      expect(journal.ownerClose).toBe("confirmed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "real Chromium: supplied driver chooses waits, owns one click, and reads host truth only for later grading",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* gameSite({ seed: 2 });
        let gradingAllowed = false;

        const guardedSite = {
          ...site,
          state: (kind: Parameters<typeof site.state>[0]) => {
            if (!gradingAllowed) throw new Error("Game state read before model episode finished");

            return site.state(kind);
          },
          events: () => {
            if (!gradingAllowed) throw new Error("Game ledger read before model episode finished");

            return site.events();
          },
        };

        const journal = new Journal({
          version: 1,
          runId: "segment-autonomous",
          scene: "game-segment",
          backend: "chromium",
          driver: "scripted-injected",
          sourceRevision: "native-test",
          sourceDirty: false,
          trial: 0,
          seed: 2,
          viewport: { width: 1280, height: 720 },
          settings: { autonomous: true },
          capture: {
            maxFrames: 1200,
            maxBytes: 32 * 1024 * 1024,
            quality: 35,
            maxDurationMillis: 15000,
          },
        });

        const turns: ReadonlyArray<Turn> = [
          (request) => {
            expect(request.tools.map((tool) => tool.name)).not.toContain("browser_click_at");
            expect(request.tools.map((tool) => tool.name)).not.toContain("browser_press");

            return call("navigate", "browser_navigate", { url: site.url });
          },
          ...lobbyTurns(site.url).slice(1),
          (request) => {
            expect(request.tools.map((tool) => tool.name)).toContain("browser_click_at");
            expect(request.tools.map((tool) => tool.name)).toContain("browser_inspect");
            expect(request.tools.map((tool) => tool.name)).not.toContain("browser_press");
            expect(request.tools.map((tool) => tool.name)).not.toContain("browser_type");

            return call("episode-inspect", "browser_inspect", {});
          },
          () => call("spin", "browser_click_at", { x: 975, y: 570 }),
          () => call("chosen-pause", "bench_pause", { millis: 5000 }),
          () => {
            gradingAllowed = true;

            return answer({
              caption: "Spin one won 500 demo credits.",
              facts: { spin: 1, balance: 1490, bet: 10, win: 500, notable: "big-win" },
            });
          },
        ];

        let invocation = 0;

        const driver: Driver = {
          ...scripted(journal, turns),
          provide: (effect) =>
            scripted(journal, invocation++ === 0 ? turns.slice(0, 8) : turns.slice(8)).provide(
              effect,
            ),
        };

        yield* run(journal, (browser) =>
          gameSegment(journal, browser, {
            driver,
            site: guardedSite,
            durationMillis: 12000,
            maxSpins: 1,
          }),
        );

        const metrics = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            spinsStarted: Schema.Int,
            spinsCompleted: Schema.Int,
            episodes: Schema.Int,
            stopReason: Schema.String,
            moneyFactAccuracy: Schema.Finite,
            measured: Schema.String,
            decisionSource: Schema.String,
            resultToCaptionMillis: Schema.Struct({ p50: Schema.Finite }),
            eligibleToAirRate: Schema.Null,
            withinReceiptAirDelayRate: Schema.Finite,
          }),
        )(journal.metrics);

        expect(metrics.spinsStarted).toBe(1);
        expect(metrics.spinsCompleted).toBe(1);
        expect(metrics.episodes).toBe(1);
        expect(metrics.stopReason).toBe("episode-cap");
        expect(metrics.moneyFactAccuracy).toBe(1);
        expect(metrics.measured).toBe("supplied-driver-plumbing");
        expect(metrics.decisionSource).toBe("model-pictures-and-chosen-pauses");
        expect(metrics.resultToCaptionMillis.p50).toBeGreaterThan(1000);
        expect(metrics.eligibleToAirRate).toBeNull();
        expect(metrics.withinReceiptAirDelayRate).toBe(0);
        expect(journal.snapshot().events.filter((event) => event.kind === "request")).toHaveLength(
          12,
        );
        expect(site.failures()).toEqual([]);
        expect(journal.ownerClose).toBe("confirmed");
        expect(journal.cleanup).toBe("confirmed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

it.live("real Chromium: autonomous episode refuses model calls beyond its terminal-call cap", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const journal = new Journal({
        version: 1,
        runId: "segment-model-cap",
        scene: "game-segment",
        backend: "chromium",
        driver: "scripted-injected",
        sourceRevision: "native-test",
        sourceDirty: false,
        trial: 0,
        seed: 2,
        viewport: { width: 1280, height: 720 },
        settings: { modelCallCap: 6 },
        capture: {
          maxFrames: 600,
          maxBytes: 16 * 1024 * 1024,
          quality: 25,
          maxDurationMillis: 12000,
        },
      });

      let invocation = 0;
      let finalCallAdmitted = false;

      const driver: Driver = {
        ...scripted(journal, []),
        provide: (effect) =>
          scripted(
            journal,
            invocation++ === 0
              ? [
                  () =>
                    answer({
                      caption: "No navigation is needed for this call-cap test.",
                      facts: {},
                    }),
                ]
              : [
                  ...Array.from(
                    { length: 6 },
                    (_, index): Turn =>
                      () =>
                        call(`pause-${index}`, "bench_pause", { millis: 1 }),
                  ),
                  () => {
                    finalCallAdmitted = true;

                    return answer({
                      caption: "This seventh episode call must not run.",
                      facts: {},
                    });
                  },
                ],
          ).provide(effect),
      };

      const exit = yield* run(journal, (browser) =>
        gameSegment(journal, browser, {
          driver,
          durationMillis: 10000,
          maxSpins: 1,
        }),
      ).pipe(Effect.exit);

      expect(exit._tag).toBe("Failure");
      expect(journal.failure).toBe("AgentPolicyError");
      expect(finalCallAdmitted).toBe(false);
      // One lobby call plus at most six episode calls, including its possible terminal call.
      expect(
        journal.snapshot().events.filter((event) => event.kind === "request").length,
      ).toBeLessThanOrEqual(7);
      expect(journal.recording?.nativeStop).toBe("confirmed");
      expect(journal.ownerClose).toBe("confirmed");
      expect(journal.cleanup).toBe("confirmed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);

it.live(
  "real Chromium: the game AgentRuntime invokes the priced native finish estimator on each model call",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const journal = new Journal({
          version: 1,
          runId: "segment-priced-finishes",
          scene: "game-segment",
          backend: "chromium",
          driver: "scripted-injected",
          sourceRevision: "native-test",
          sourceDirty: false,
          trial: 0,
          seed: 2,
          viewport: { width: 1280, height: 720 },
          settings: { pricedFinishFixture: true },
          capture: {
            maxFrames: 1200,
            maxBytes: 32 * 1024 * 1024,
            quality: 25,
            maxDurationMillis: 15000,
          },
        });

        let estimates = 0;
        let costMicrousd = 0;

        const turns: ReadonlyArray<Turn> = [
          () =>
            answer({ caption: "Pricing hook fixture.", facts: {} }).map((part) =>
              part.type === "finish"
                ? { ...part, usage: { inputTokens: { total: 1000 }, outputTokens: { total: 100 } } }
                : part,
            ),
        ];

        const driver: Driver = {
          ...scripted(journal, turns),
          estimate: (usage) =>
            Effect.sync(() => {
              expect(usage.inputTokens.total).toBe(1000);
              expect(usage.outputTokens.total).toBe(100);
              estimates++;
              costMicrousd += 25;

              return 25;
            }),
          provide: (effect) => scripted(journal, turns).provide(effect),
        };

        yield* run(journal, (browser) =>
          gameSegment(journal, browser, { driver, durationMillis: 12000, maxSpins: 1 }),
        );
        expect(journal.snapshot().events.filter((event) => event.kind === "request")).toHaveLength(
          2,
        );
        expect(estimates).toBe(2);
        expect(costMicrousd).toBe(50);
        expect(journal.cleanup).toBe("confirmed");
        expect(journal.ownerClose).toBe("confirmed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
);

for (const point of ["first-point-refused", "second-point-refused"] as const) {
  it.live(`real Chromium: ${point} consumes one attempt without replay`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* gameSite({ seed: 2 });

        const journal = new Journal({
          version: 1,
          runId: `segment-input-${point}`,
          scene: "game-segment",
          backend: "chromium",
          driver: "scripted-injected",
          sourceRevision: "native-test",
          sourceDirty: false,
          trial: 0,
          seed: 2,
          viewport: { width: 1280, height: 720 },
          settings: { point },
          capture: {
            maxFrames: 1200,
            maxBytes: 32 * 1024 * 1024,
            quality: 25,
            maxDurationMillis: 15000,
          },
        });

        let invocation = 0;
        let finalCallAdmitted = false;

        const driver: Driver = {
          ...scripted(journal, []),
          provide: (effect) =>
            scripted(
              journal,
              invocation++ === 0
                ? point === "second-point-refused"
                  ? lobbyTurns(site.url)
                  : [() => answer({ caption: "Input-admission test.", facts: {} })]
                : point === "second-point-refused"
                  ? [
                      () => call("point-first", "browser_click_at", { x: 975, y: 570 }),
                      () => call("chosen-pause", "bench_pause", { millis: 5000 }),
                      () => call("second-point", "browser_click_at", { x: 975, y: 570 }),
                    ]
                  : [
                      () => call("refused-point", "browser_click_at", { x: 5000, y: 5000 }),
                      () => call("point-after-key", "browser_click_at", { x: 975, y: 570 }),
                      () => {
                        finalCallAdmitted = true;

                        return answer({ caption: "This call must not run.", facts: {} });
                      },
                    ],
            ).provide(effect),
        };

        const exit = yield* run(journal, (browser) =>
          gameSegment(journal, browser, { driver, site, durationMillis: 12000, maxSpins: 1 }),
        ).pipe(Effect.exit);

        const metrics = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            spinsStarted: Schema.Int,
            spinsCompleted: Schema.Int,
          }),
        )(journal.metrics);

        expect(exit._tag).toBe("Failure");
        expect(journal.failure).toBe("AgentToolAuthorizationDenied");
        expect(finalCallAdmitted).toBe(false);
        expect(metrics.spinsStarted).toBe(point === "second-point-refused" ? 1 : 0);
        expect(metrics.spinsCompleted).toBe(point === "second-point-refused" ? 1 : 0);
        expect(site.failures()).toEqual([]);
        expect(journal.ownerClose).toBe("confirmed");
        expect(journal.cleanup).toBe("confirmed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
}

it.live("real Chromium: early and later unowned captions cannot acquire a settled result", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* gameSite({ seed: 2 });

      const journal = new Journal({
        version: 1,
        runId: "segment-before-result",
        scene: "game-segment",
        backend: "chromium",
        driver: "scripted-injected",
        sourceRevision: "native-test",
        sourceDirty: false,
        trial: 0,
        seed: 2,
        viewport: { width: 1280, height: 720 },
        settings: { earlyCaption: true },
        capture: {
          maxFrames: 600,
          maxBytes: 16 * 1024 * 1024,
          quality: 25,
          maxDurationMillis: 12000,
        },
      });

      let invocation = 0;

      const driver: Driver = {
        ...scripted(journal, []),
        provide: (effect) =>
          scripted(
            journal,
            invocation++ === 0
              ? lobbyTurns(site.url)
              : invocation === 2
                ? [
                    () => call("spin", "browser_click_at", { x: 975, y: 570 }),
                    () =>
                      answer({
                        caption: "This result was claimed before the reels stopped.",
                        facts: { spin: 1, balance: 990, bet: 10, win: 0, notable: "ordinary" },
                      }),
                  ]
                : [
                    () => call("chosen-pause", "bench_pause", { millis: 5000 }),
                    () =>
                      answer({
                        caption: "A later caption repeats the previous spin's actual result.",
                        facts: { spin: 1, balance: 1490, bet: 10, win: 500, notable: "big-win" },
                      }),
                  ],
          ).provide(effect),
      };

      yield* run(journal, (browser) =>
        gameSegment(journal, browser, { driver, site, durationMillis: 10000, maxSpins: 2 }),
      );

      const metrics = yield* Schema.decodeUnknownEffect(
        Schema.Struct({
          spinsStarted: Schema.Int,
          spinsCompleted: Schema.Int,
          unmatchedResultCaptions: Schema.Int,
          anyFalseFactRate: Schema.Finite,
          resultToCaptionMillis: Schema.Struct({ p50: Schema.Null }),
          captions: Schema.Array(
            Schema.Struct({ resultQualification: Schema.optionalKey(Schema.String) }),
          ),
        }),
      )(journal.metrics);

      expect(metrics.spinsStarted).toBe(1);
      expect(metrics.spinsCompleted).toBe(1);
      expect(metrics.unmatchedResultCaptions).toBe(2);
      expect(metrics.anyFalseFactRate).toBe(1);
      expect(metrics.captions.at(-1)?.resultQualification).toBe(
        "no-validated-result-before-caption",
      );
      expect(journal.ownerClose).toBe("confirmed");
      expect(journal.cleanup).toBe("confirmed");
    }),
  ).pipe(Effect.provide(NodeServices.layer)),
);
