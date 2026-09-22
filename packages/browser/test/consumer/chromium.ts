import assert from "node:assert/strict";

import { Effect, Stream } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium, type ChromiumCleanupResult } from "effect-browser/chromium";
import * as PageControl from "effect-browser/page-control";
import { FetchHttpClient } from "effect/unstable/http";

import { localSite } from "../fixtures/StandaloneBrowser.ts";

const cleanup: ChromiumCleanupResult[] = [];
let providerCalls = 0;

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;
      const browser = yield* Chromium;

      return yield* browser.withBrowser(
        BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 }),
        {},
        (session) =>
          Effect.gen(function* () {
            assert.equal(session.reference.provider, "chromium");
            assert.equal(session.implementation, "chromium-playwright-cdp");
            yield* session.bind().navigate({ url: site.url });
            assert.match((yield* session.observe()).text, /ownership fixture/);

            const copied = yield* Capture.start({ ...session }).pipe(Effect.result);

            assert.equal(
              copied._tag,
              "Failure",
              "copying the session cannot copy capture authority",
            );

            const interval = yield* Capture.start(session, {
              lifetime: "page",
              maxDurationMillis: 10000,
            });

            const frames = yield* interval.frames.pipe(Stream.take(1), Stream.runCollect);

            assert.equal(frames.length, 1);
            assert.ok(frames[0] !== undefined && frames[0].bytes.length > 0);
            const snapshot = yield* interval.snapshot;
            const page = (yield* session.pages).find((candidate) => candidate.selected);

            assert.ok(page);
            const held = yield* PageControl.suspend(session, page);

            assert.equal((yield* PageControl.state(session, page)).state, "suspended");
            yield* PageControl.resume(session, held);
            yield* session.bind().click({ selector: "#increment" });
            assert.equal((yield* session.bind().readText({ selector: "#count" })).text, "1");
            const summary = yield* interval.stop;

            assert.equal(summary.nativeStop, "confirmed");
            yield* session.closeChecked;

            return {
              id: session.reference.id,
              frames: frames.length,
              snapshot: snapshot !== undefined,
            };
          }),
      );
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
        pageControl: true,
        viewport: { width: 640, height: 480 },
        onCleanup: (value) =>
          Effect.sync(() => {
            cleanup.push(value);
          }),
      }),
    ),
    Effect.provideService(FetchHttpClient.Fetch, () => {
      providerCalls++;

      return Promise.reject(new Error("A Chromium-only consumer cannot call a provider"));
    }),
  ),
);

assert.equal(providerCalls, 0);
assert.equal(cleanup.length, 1);
assert.equal(cleanup[0]?.ownership, "owned");
assert.equal(cleanup[0]?.connection, "closed");
assert.equal(cleanup[0]?.process, "terminated");
assert.deepEqual(cleanup[0]?.issues, []);
console.log(JSON.stringify({ profile: "browser", ...result }));
