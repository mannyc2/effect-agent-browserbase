import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { run } from "../bench/Backends.ts";
import { gameSegment } from "../bench/GameSegment.ts";
import { Journal } from "../bench/Records.ts";

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
    Schema.Struct({ latencyMillis: Schema.Finite, eligibleToAir: Schema.Boolean }),
  ),
  measured: Schema.String,
  costMicrousd: Schema.Null,
});

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
          expect(metrics.resultCaptions[0]?.eligibleToAir).toBe(true);
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
