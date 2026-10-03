import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { matrix } from "../bench/Replay.ts";

it.live(
  "fresh-page replay uses actual Page and ToolHost recordings and retains typed matching failures",
  () =>
    Browser.scoped(
      Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 500, maxElapsedMillis: 60000 })),
      (browser) =>
        Effect.gen(function* () {
          const result = yield* matrix(browser, {
            walkIds: ["prices-hover"],
            operators: ["reorder", "overlay"],
            seeds: [2],
          });

          expect(result.cells).toHaveLength(4);
          for (const cell of result.cells) {
            if (cell.operator === "reorder") expect(cell.outcome).toBe("replayed");
            else expect(cell.outcome).toBe("failed-typed");
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
