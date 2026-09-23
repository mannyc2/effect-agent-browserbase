import { Effect } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { turns } from "./BrowserAgent.ts";

const policy = BrowserPolicy.unrestricted({
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

// The Chromium Layer takes Effect's `Crypto` from the caller's platform Layer, such as
// `NodeServices.layer`, so this composition still requires it.

/** The same agent and tools as the Browserbase example, on self-managed Chromium. */
export const runChromiumAgent = (request: string) =>
  Browser.scoped(Chromium.launch(policy), (browser) =>
    Effect.gen(function* () {
      const run = yield* turns(browser, request);
      const seen = yield* browser.observe({ scope: "viewport" });

      return { ...run.output, url: seen.url, turns: run.turns };
    }),
  ).pipe(
    Effect.provide(
      Chromium.layer({
        viewport: { width: 1280, height: 720 },
        launch: { chromiumSandbox: true },
      }),
    ),
  );
