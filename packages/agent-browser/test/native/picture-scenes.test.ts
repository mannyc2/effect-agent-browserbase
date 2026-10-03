import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { localBrowserbase, run } from "../bench/Backends.ts";
import { Journal } from "../bench/Records.ts";
import { prepareStage, stageScene } from "../bench/StageScenes.ts";
import { localAgentBrowser } from "../fixtures/AgentBrowser.ts";

const Metrics = Schema.Struct({
  frames: Schema.Natural,
  fps: Schema.Finite,
  freezes: Schema.Struct({ count: Schema.Natural }),
  windows: Schema.Record(
    Schema.String,
    Schema.Struct({
      cadence: Schema.NullOr(Schema.Struct({ frames: Schema.Natural })),
      measurement: Schema.Struct({
        status: Schema.Literals(["complete", "partial", "unmeasured"]),
      }),
    }),
  ),
});

for (const scene of ["animation", "busy"] as const)
  it.live(`picture scene ${scene} measures the actual on-air Page`, () =>
    Effect.gen(function* () {
      const journal = new Journal({
        version: 1,
        runId: `native-${scene}`,
        scene,
        backend: "chromium",
        driver: "scripted",
        sourceRevision: "native-test-fixture",
        sourceDirty: false,
        trial: 0,
        seed: 0,
        viewport: { width: 1280, height: 720 },
        settings: {},
        capture: {
          maxFrames: 1800,
          maxBytes: 64 * 1024 * 1024,
          quality: 60,
          maxDurationMillis: 30000,
        },
      });

      yield* run(journal, (browser) => stageScene(journal, browser, { durationMillis: 1000 }));
      const metrics = yield* Schema.decodeUnknownEffect(Metrics)(journal.metrics);

      expect(metrics.frames).toBeGreaterThan(0);
      expect(metrics.fps).toBeGreaterThan(0);
      if (scene === "busy")
        expect(Object.keys(metrics.windows)).toEqual(["before", "during", "after"]);
      expect(journal.cleanup).toBe("confirmed");
      expect(journal.ownerClose).toBe("confirmed");
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

it.live("hosted stage bootstrap reports independent truth through the real provider owner", () =>
  Effect.gen(function* () {
    const fixture = yield* localAgentBrowser;

    const journal = new Journal({
      version: 1,
      runId: "native-injected-typing",
      scene: "typing",
      backend: "browserbase",
      driver: "scripted",
      sourceRevision: "native-test-fixture",
      sourceDirty: false,
      trial: 0,
      seed: 0,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: {
        maxFrames: 300,
        maxBytes: 24 * 1024 * 1024,
        quality: 15,
        maxDurationMillis: 15000,
      },
    });

    const stage = yield* prepareStage(journal, new URL(fixture.url).origin);

    // The bb97eaf fixed 100 ms snapshot misses delayed final input callbacks.
    const delayedStage = {
      ...stage,
      events: () => stage.events().filter((event) => journal.elapsedMillis() - event.at >= 500),
    };

    yield* run(
      journal,
      (browser) => stageScene(journal, browser, { stage: delayedStage, durationMillis: 1000 }),
      undefined,
      localBrowserbase(fixture),
      stage.bootstrap,
    );

    const metrics = yield* Schema.decodeUnknownEffect(
      Schema.Struct({
        typing: Schema.Struct({ exactValue: Schema.Boolean, characters: Schema.Natural }),
      }),
    )(journal.metrics);

    expect(metrics.typing.exactValue).toBe(true);
    expect(metrics.typing.characters).toBe(60);
    expect(stage.lost()).toBe(0);
    expect(stage.events().length).toBeGreaterThan(0);
    expect(journal.cleanup).toBe("confirmed");
    expect(journal.ownerClose).toBe("confirmed");
    expect(fixture.releaseIds).toHaveLength(1);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
