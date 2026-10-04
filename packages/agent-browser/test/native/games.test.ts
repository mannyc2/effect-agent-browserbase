import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import type { Browser as PlaywrightBrowser } from "playwright-core";

import {
  agentPolicy,
  localAgentBrowser,
  openAgentBrowser,
  withGenericAgentBrowser,
} from "../fixtures/AgentBrowser.ts";
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
                const idlePicture = yield* frame.screenshot({ fullPage: false });

                yield* Effect.sleep(250);
                expect((yield* frame.screenshot({ fullPage: false })).bytes).toEqual(
                  idlePicture.bytes,
                );
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
                ).toEqual([0, 1, 2, 3, 4, 5]);
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
                expect((yield* frame.observe({ scope: "viewport" })).text).toContain(
                  "Notable: near-miss",
                );
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

it.live(
  "real Chromium: one lost truth POST never retries and later independent events remain observable",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* gameSite();
        const fixture = yield* localAgentBrowser;

        yield* withGenericAgentBrowser(
          fixture,
          Browser.scoped(openAgentBrowser(agentPolicy), (browser) =>
            Effect.gen(function* () {
              const frame = yield* enterGame(browser.initialPage, site, "reels");
              const native = fixture.nativeConnection() as PlaywrightBrowser | undefined;
              const context = native?.contexts()[0];

              if (context === undefined)
                return yield* Effect.die("Original native connection missing");
              const attempted: number[] = [];
              let dropped: number | undefined;

              yield* Effect.promise(() =>
                context.route("**/truth", async (route) => {
                  const receipt = JSON.parse(route.request().postData() ?? "{}") as {
                    sequence: number;
                    event: { tag: string };
                  };

                  attempted.push(receipt.sequence);
                  if (receipt.event.tag === "spinStart" && dropped === undefined) {
                    dropped = receipt.sequence;
                    await route.abort("failed");
                  } else await route.continue();
                }),
              );
              yield* frame.press({ key: " ", into: "#game-canvas" });
              yield* Effect.sleep(5000);
              expect(dropped).toBeDefined();
              expect(attempted.filter((sequence) => sequence === dropped)).toHaveLength(1);
              expect(attempted.some((sequence) => sequence > (dropped ?? Infinity))).toBe(true);
              expect(site.events().some((receipt) => receipt.event.tag === "result")).toBe(false);
              expect(site.receivedEvents().some((receipt) => receipt.event.tag === "result")).toBe(
                true,
              );
              expect(
                site.failures().some((failure) => failure.includes("Truth sequence mismatch")),
              ).toBe(true);
            }),
          ),
        );
        expect(fixture.releaseIds).toEqual(["session-1"]);
      }),
    ),
);

it.live(
  "real Chromium: seeded notable outcomes are visible and a winning result is never painted SPINNING",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localAgentBrowser;

        yield* withGenericAgentBrowser(
          fixture,
          Browser.scoped(openAgentBrowser(agentPolicy), (browser) =>
            Effect.gen(function* () {
              const native = fixture.nativeConnection() as PlaywrightBrowser | undefined;
              const context = native?.contexts()[0];

              if (context === undefined)
                return yield* Effect.die("Original native connection missing");
              // Record actual painted labels on this connection and delegate every call to native canvas.
              yield* Effect.promise(() =>
                context.addInitScript(() => {
                  const labels: string[] = [];

                  const original: unknown = Reflect.get(
                    CanvasRenderingContext2D.prototype,
                    "fillText",
                  );

                  if (typeof original !== "function")
                    throw new Error("Native canvas painter missing");

                  Object.assign(window, { __paintLabels: labels });
                  CanvasRenderingContext2D.prototype.fillText = function (text, x, y, maxWidth) {
                    labels.push(text);
                    if (labels.length > 64) labels.shift();
                    Reflect.apply(
                      original,
                      this,
                      maxWidth === undefined ? [text, x, y] : [text, x, y, maxWidth],
                    );
                  };
                }),
              );
              for (const seed of [6, 2]) {
                const site = yield* gameSite({ seed });

                yield* Effect.promise(() => context.clearCookies());
                const frame = yield* enterGame(browser.initialPage, site, "reels");

                yield* frame.press({ key: " ", into: "#game-canvas" });
                yield* waitForGame(
                  site,
                  "reels",
                  (state) => state.spin === 1 && state.phase !== "spinning",
                  "visible result",
                );
                expect
                  .soft((yield* frame.observe({ scope: "viewport" })).text)
                  .toContain(seed === 6 ? "Notable: losing-streak" : "Notable: big-win");
                if (seed === 2) {
                  const nativeFrame = context
                    .pages()[0]
                    ?.frames()
                    .find((candidate) => candidate.url().includes("/frame/reels?"));

                  if (nativeFrame === undefined)
                    return yield* Effect.die("Original child frame missing");

                  const labels = yield* Effect.promise(() =>
                    nativeFrame.evaluate(() => Reflect.get(window, "__paintLabels")),
                  );

                  const painted = yield* Schema.decodeUnknownEffect(Schema.Array(Schema.String))(
                    labels,
                  );

                  expect.soft(painted).toContain("RESULT");
                  expect
                    .soft(
                      painted
                        .filter(
                          (label) => label === "SPIN" || label === "SPINNING" || label === "RESULT",
                        )
                        .at(-1),
                    )
                    .toBe("RESULT");
                }
              }
            }),
          ),
        );
        expect(fixture.releaseIds).toEqual(["session-1"]);
      }),
    ),
);
