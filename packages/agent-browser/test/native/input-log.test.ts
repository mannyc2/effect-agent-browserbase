import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { makeInputLog } from "../bench/InputLog.ts";
import { enterGame } from "../fixtures/GameDriver.ts";
import { gameSite, GameSiteError } from "../fixtures/GameSite.ts";

it.live(
  "native input logging maps cross-site canvas events into main viewport coordinates and opaque key holds",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* gameSite();

        const log = yield* makeInputLog({
          origins: [new URL(site.url).origin, site.frameOrigin],
          maxEvents: 128,
        });

        yield* Browser.scoped(
          Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 30000 }), {
            bootstrap: log.bootstrap,
          }),
          (browser) =>
            Effect.gen(function* () {
              const frame = yield* enterGame(browser.initialPage, site, "reels");

              // Match model turns: wait for the current on-air PNG before the first native input.
              yield* browser.initialPage.screenshot({ fullPage: false });

              yield* frame.pointerMove({ to: { x: 600, y: 400 } });
              yield* frame.press({ key: " ", into: "#game-canvas" });
              for (let attempt = 0; attempt < 100; attempt++) {
                if (
                  log
                    .snapshot()
                    .events.some(
                      (event) => event.sourceOrigin === site.frameOrigin && event.kind === "keyup",
                    )
                )
                  break;
                if (attempt === 99)
                  return yield* GameSiteError.make({ operation: "input log deadline" });
                yield* Effect.sleep("25 millis");
              }

              const events = log
                .snapshot()
                .events.filter((event) => event.sourceOrigin === site.frameOrigin);

              const move = events.find((event) => event.kind === "pointermove");

              expect(Math.abs((move?.point?.x ?? 0) - 600)).toBeLessThanOrEqual(1);
              expect(Math.abs((move?.point?.y ?? 0) - 400)).toBeLessThanOrEqual(1);
              expect(
                events.every((event) => event.coordinateSpace === "main-viewport" && event.trusted),
              ).toBe(true);
              expect(
                events
                  .filter((event) => event.kind === "keydown" || event.kind === "keyup")
                  .map((event) => event.code),
              ).toEqual(["key-1", "key-1"]);
              expect(
                events.every(
                  (event) =>
                    Math.abs(
                      event.sourceTimeMillis - event.documentTimeOriginMillis - event.atMillis,
                    ) < 0.001,
                ),
              ).toBe(true);
              expect(log.snapshot().completeness).toBe("navigation-tail-unverified");
            }),
        ).pipe(
          Effect.provide(
            Chromium.layer({
              launch: {
                ...(process.env.BROWSERBASE_CHROMIUM === undefined
                  ? {}
                  : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
                chromiumSandbox: false,
                startupTimeoutMillis: 25000,
              },
              viewport: { width: 1280, height: 720 },
            }).pipe(Layer.provide(NodeCrypto.layer)),
          ),
        );
      }),
    ),
);
