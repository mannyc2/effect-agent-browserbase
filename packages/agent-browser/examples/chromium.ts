import { Effect } from "effect";
import { fromSession } from "effect-agent-browser/adapter";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

import { turns } from "./BrowserAgent.ts";

const policy = BrowserPolicy.unrestricted({
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

/** The same agent and tools as the Browserbase example, on self-managed Chromium. */
export const runChromiumAgent = (request: string) =>
  Effect.gen(function* () {
    const chromium = yield* Chromium;

    return yield* chromium.withBrowser(policy, {}, (browser) =>
      Effect.gen(function* () {
        const run = yield* turns(fromSession(browser), request);
        const seen = yield* browser.observe({ scope: "viewport" });

        return { ...run.output, url: seen.url, turns: run.turns };
      }),
    );
  }).pipe(
    Effect.provide(
      Chromium.layer({
        viewport: { width: 1280, height: 720 },
        launch: { chromiumSandbox: true },
      }),
    ),
  );
