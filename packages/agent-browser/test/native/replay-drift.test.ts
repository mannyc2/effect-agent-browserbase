import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { Journal } from "../bench/Records.ts";
import { matrix } from "../bench/Replay.ts";
import { replayContention } from "../bench/ReplayScenes.ts";

it.live(
  "fresh-page replay uses actual Page and ToolHost recordings and retains typed drift failures and complete navigation readiness timing",
  () =>
    Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          const result = yield* matrix(browser, {
            walkIds: ["prices-hover"],
            operators: ["reorder", "overlay", "slow"],
            seeds: [2],
          });

          expect(result.cells).toHaveLength(6);
          for (const cell of result.cells) {
            if (cell.operator === "overlay") expect(cell.outcome).toBe("failed-typed");
            else expect(cell.outcome).toBe("replayed");
            if (cell.operator === "slow")
              expect(
                cell.stepMillis.slice(0, 2).reduce((sum, millis) => sum + millis, 0),
              ).toBeGreaterThanOrEqual(1000);
          }
          expect(result.cells.every((cell) => cell.outcome !== "wrong-place")).toBe(true);
          expect(result.lostTruthEvents).toBe(0);
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          actionTimeoutMillis: 5000,
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
          },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    ),
  60000,
);

it.live(
  "replay contention retains the exact on-air interval and independent host truth",
  () => {
    const journal = new Journal({
      version: 1,
      runId: "native-replay-contention",
      scene: "replay-contention",
      backend: "chromium",
      driver: "scripted",
      sourceRevision: "native",
      sourceDirty: false,
      trial: 0,
      seed: 2,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: {
        maxFrames: 2000,
        maxBytes: 16 * 1024 * 1024,
        quality: 30,
        maxDurationMillis: 30000,
      },
    });

    return Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          const result = yield* replayContention(journal, browser, {
            walkIds: ["overview-article"],
            operators: ["reorder"],
            seeds: [2],
            beforeAfterMillis: 500,
          });

          expect(result.cells).toHaveLength(2);
          expect(result.cells.every((cell) => cell.outcome === "replayed")).toBe(true);
          expect(journal.recording?.summary).toMatchObject({
            target: { pageId: browser.initialPage.identity.pageId },
          });
          expect(journal.recording?.nativeStop).toBe("confirmed");
          expect(journal.recording?.limitReached).toBeNull();
          expect(journal.metrics).toMatchObject({
            replay: { lostSteps: 0, additionalLostSteps: null },
            picture: [{ phase: "before" }, { phase: "during" }, { phase: "after" }],
          });
          expect(result.lostTruthEvents).toBe(0);
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          actionTimeoutMillis: 5000,
          viewport: journal.manifest.viewport,
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
          },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    );
  },
  60000,
);

it.live(
  "retention cutoff leaves later contention windows unmeasured",
  () => {
    const journal = new Journal({
      version: 1,
      runId: "native-replay-retention",
      scene: "replay-contention",
      backend: "chromium",
      driver: "scripted",
      sourceRevision: "native",
      sourceDirty: false,
      trial: 0,
      seed: 2,
      viewport: { width: 1280, height: 720 },
      settings: {},
      capture: { maxFrames: 10, maxBytes: 16 * 1024 * 1024, quality: 30, maxDurationMillis: 30000 },
    });

    return Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          yield* replayContention(journal, browser, {
            walkIds: ["overview-article"],
            operators: ["reorder"],
            seeds: [2],
            paths: ["page"],
            beforeAfterMillis: 1000,
          });

          expect(journal.recording?.limitReached).toBe("frames");
          expect(journal.recording?.frames).toHaveLength(10);
          expect(journal.metrics).toMatchObject({
            picture: [
              { phase: "before" },
              { phase: "during" },
              { phase: "after", measurement: "unmeasured", cadence: null, freezes: null },
            ],
          });
        }),
    ).pipe(
      Effect.provide(
        Chromium.layer({
          actionTimeoutMillis: 5000,
          viewport: journal.manifest.viewport,
          launch: {
            ...(process.env.BROWSERBASE_CHROMIUM === undefined
              ? {}
              : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
            chromiumSandbox: false,
          },
        }).pipe(Layer.provide(NodeCrypto.layer)),
      ),
    );
  },
  60000,
);
