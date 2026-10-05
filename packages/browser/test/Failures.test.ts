// Failures that come from Playwright itself, as callers and models receive them.
import { createServer, type Server } from "node:net";

import { assert, it } from "@effect/vitest";
import { Effect } from "effect";

import type { BrowserError } from "../src/BrowserError.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Chromium from "../src/Chromium.ts";

const timeoutOf = (error: BrowserError) =>
  error.reason._tag === "Timeout" ? error.reason.millis : error.reason._tag;

/** A loopback port that accepts connections and never answers them. */
const silentPort = Effect.acquireRelease(
  Effect.callback<Server>((resume) => {
    const server = createServer(() => undefined);

    server.listen(0, "127.0.0.1", () => resume(Effect.succeed(server)));
  }),
  (server) => Effect.sync(() => server.close()),
).pipe(
  Effect.map((server) => {
    const address = server.address();

    return typeof address === "object" && address !== null ? address.port : 0;
  }),
);

it.live("a connect timeout reports the bound the caller gave", () =>
  Effect.gen(function* () {
    const port = yield* silentPort;

    const error = yield* Effect.flip(
      Cdp.open({ endpoint: `http://127.0.0.1:${port}`, connectTimeoutMillis: 700 }),
    );

    assert.deepStrictEqual(
      [error.operation, timeoutOf(error), error.dispatched],
      ["connect", 700, false],
    );
    assert.strictEqual(error.message, "connect failed: timed out after 700 ms");
  }).pipe(Effect.scoped),
);

it.live("a screenshot timeout reports the action timeout", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open({ actionTimeout: "1 second" });
    const page = yield* browser.newPage("data:text/html,<h1>Busy</h1>");

    // A renderer stuck in script cannot produce the frame a screenshot waits for.
    yield* Effect.promise(() =>
      page.playwright.evaluate(() => {
        setTimeout(() => {
          const end = Date.now() + 5000;

          while (Date.now() < end);
        }, 0);
      }),
    );

    const error = yield* Effect.flip(page.screenshot({ fresh: true }));

    assert.deepStrictEqual([error.operation, timeoutOf(error)], ["screenshot", 1000]);
  }).pipe(Effect.scoped),
);
