import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { gameDrivers, gamesOperability } from "../bench/Games.ts";
import { Journal } from "../bench/Records.ts";

const Metrics = Schema.Struct({
  reachedGame: Schema.Boolean,
  spinsCompleted: Schema.Int,
  finalBalance: Schema.Int,
  blockedStep: Schema.NullOr(Schema.String),
  observedControls: Schema.Array(Schema.String),
  typedFailures: Schema.Array(Schema.Json),
});

const chromium = Chromium.layer({
  launch: {
    ...(process.env.BROWSERBASE_CHROMIUM === undefined
      ? {}
      : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
    chromiumSandbox: false,
    startupTimeoutMillis: 25000,
  },
  viewport: { width: 1280, height: 720 },
}).pipe(Layer.provide(NodeCrypto.layer));

for (const driver of gameDrivers) {
  it.live(`real Chromium: ${driver} operability is graded from independent game truth`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const journal = new Journal({
          version: 1,
          runId: driver,
          scene: "games-operability",
          backend: "chromium",
          driver,
          sourceRevision: "native-test",
          sourceDirty: false,
          trial: 0,
          seed: 2,
          viewport: { width: 1280, height: 720 },
          settings: { spins: 1 },
          capture: {
            maxFrames: 600,
            maxBytes: 32 * 1024 * 1024,
            quality: 60,
            maxDurationMillis: 15000,
          },
        });

        yield* Browser.scoped(
          Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 30000 })),
          (browser) => gamesOperability(journal, browser, { spins: 1 }),
        ).pipe(Effect.provide(chromium));
        const metrics = yield* Schema.decodeUnknownEffect(Metrics)(journal.metrics);
        const plays = driver !== "agent-tools";

        expect(metrics.reachedGame).toBe(true);
        expect(metrics.spinsCompleted).toBe(plays ? 1 : 0);
        expect(metrics.finalBalance).toBe(plays ? 1490 : 1000);
        expect(metrics.blockedStep).toBe(plays ? null : "top-page-observation");
        expect(metrics.observedControls).toEqual(
          driver === "dom-twin" ? ["Decrease bet", "Increase bet", "SPIN"] : [],
        );
        expect(metrics.typedFailures).toEqual([]);
        expect(journal.recording?.nativeStop).toBe("confirmed");
        expect(journal.recording?.frames.length).toBeGreaterThan(0);
        expect(journal.snapshot().truth).toEqual(journal.truth);
      }),
    ),
  );
}
