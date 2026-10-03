import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect } from "effect";

import { run } from "../bench/Backends.ts";
import { Journal, load, save } from "../bench/Records.ts";
import { execute } from "../bench/Scenes.ts";

it.live("smoke captures a moving page and saves cadence with checked cleanup", () =>
  Effect.gen(function* () {
    const journal = new Journal({
      version: 1,
      runId: "native-smoke",
      scene: "smoke",
      backend: "chromium",
      driver: "scripted",
      sourceRevision: "native-test-fixture",
      sourceDirty: false,
      trial: 0,
      seed: 0,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: { maxFrames: 120, maxBytes: 16 * 1024 * 1024, quality: 60, maxDurationMillis: 5000 },
    });

    yield* run(journal, (browser) => execute(journal, browser, { durationMillis: 700 }));
    expect(journal.cleanup).toBe("confirmed");
    expect(journal.ownerClose).toBe("confirmed");

    const metrics = journal.metrics as {
      frames: number;
      fps: number;
      gapMillis: { p50: number; p95: number; max: number };
    };

    expect(metrics.frames).toBeGreaterThan(0);
    expect(metrics.fps).toBeGreaterThan(0);
    expect(metrics.gapMillis.p95).toBeGreaterThanOrEqual(metrics.gapMillis.p50);

    const root =
      process.env.BENCH_OUT_DIR ??
      (yield* Effect.promise(() => mkdtemp(join(tmpdir(), "browser-bench-"))));

    const directory = join(root, `smoke-${yield* Clock.currentTimeMillis}`);

    yield* save(journal, directory);
    expect((yield* load(directory)).metrics).toEqual(journal.metrics);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
