import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { reelOutcome } from "../fixtures/GameCore.ts";
import { enterGame, waitForGame } from "../fixtures/GameDriver.ts";
import { gameSite } from "../fixtures/GameSite.ts";

const chromium = Chromium.layer({
  launch: {
    ...(process.env.BROWSERBASE_CHROMIUM === undefined
      ? {}
      : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
    chromiumSandbox: false,
    startupTimeoutMillis: 25000,
  },
  viewport: { width: 1100, height: 800 },
}).pipe(Layer.provide(NodeCrypto.layer));

for (const kind of ["reels", "reels-dom"] as const) {
  it.live(
    `real Chromium: ${kind} keeps canvas focus through both walls and reports one exact keyboard spin`,
    () =>
      Effect.scoped(
        Effect.gen(function* () {
          const site = yield* gameSite();

          yield* Browser.scoped(
            Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 })),
            (browser) =>
              Effect.gen(function* () {
                const page = browser.initialPage;

                yield* page.navigate({ url: site.playUrl(kind) });
                expect((yield* page.observe()).controls.map((control) => control.label)).toEqual([
                  "Accept",
                  "Reject",
                ]);
                const frame = yield* enterGame(page, site, kind);

                expect(
                  (yield* page.listFrames()).some(
                    (info) => new URL(info.url).hostname === "localhost",
                  ),
                ).toBe(true);
                expect(new URL((yield* page.describe()).url).hostname).toBe("127.0.0.1");
                const observation = yield* frame.observe();

                expect(observation.controls.map((control) => control.label)).toEqual(
                  kind === "reels" ? [] : ["Decrease bet", "Increase bet", "SPIN"],
                );
                expect((yield* page.observe()).controls).toEqual([]);
                yield* frame.press({ key: " ", into: "#game-canvas" });
                yield* waitForGame(
                  site,
                  kind,
                  (state) => state.spin === 1 && state.phase === "idle",
                  "first spin complete",
                );
                const expected = reelOutcome(site.seed, 1, 10);
                const events = site.events().filter((receipt) => receipt.kind === kind);

                expect(events.filter((receipt) => receipt.event.tag === "spinStart")).toHaveLength(
                  1,
                );
                expect(
                  events
                    .filter((receipt) => receipt.event.tag === "reelStop")
                    .map((receipt) => (receipt.event.tag === "reelStop" ? receipt.event.reel : -1)),
                ).toEqual([0, 1, 2, 3, 4]);
                expect(
                  events.find((receipt) => receipt.event.tag === "result")?.event,
                ).toMatchObject({
                  spin: 1,
                  grid: expected.grid,
                  win: expected.win,
                  balanceAfter: 990,
                  moment: expected.moment,
                });
                expect(site.state(kind)).toMatchObject({
                  ready: true,
                  focused: true,
                  spin: 1,
                  balance: 990,
                });
                expect(site.failures()).toEqual([]);
                expect(
                  (yield* frame.readText({ selector: "body" })).text.includes(
                    "Balance: 990 demo credits",
                  ),
                ).toBe(kind === "reels-dom");
              }),
          ).pipe(Effect.provide(chromium));
        }),
      ),
  );
}
