import assert from "node:assert/strict";

import { NodeCrypto } from "@effect/platform-node";
import { Effect, Layer, Stream } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium, type ChromiumCleanupResult } from "effect-browser/chromium";
import * as PageControl from "effect-browser/page-control";
import * as Plan from "effect-browser/plan";
import { FetchHttpClient } from "effect/unstable/http";

import { localSite } from "../fixtures/StandaloneBrowser.ts";

const cleanup: ChromiumCleanupResult[] = [];
let providerCalls = 0;

const result = await Effect.runPromise(
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;

      return yield* Browser.scoped(
        Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 })),
        (session) =>
          Effect.gen(function* () {
            assert.equal(session.reference.provider, "chromium");
            assert.equal(session.implementation, "chromium-playwright-cdp");
            yield* session.initialPage.navigate({ url: site.url });
            assert.match((yield* session.initialPage.observe()).text, /ownership fixture/);

            const copied = yield* Capture.start({ ...session.initialPage }).pipe(Effect.result);

            assert.equal(copied._tag, "Failure", "copying the Page cannot copy capture authority");

            const interval = yield* Capture.start(session.initialPage, {
              lifetime: "page",
              maxDurationMillis: 10000,
            });

            const frames = yield* interval.frames.pipe(Stream.take(1), Stream.runCollect);

            assert.equal(frames.length, 1);
            assert.ok(frames[0] !== undefined && frames[0].bytes.length > 0);
            const snapshot = yield* interval.snapshot;
            const page = (yield* session.listPages()).find((candidate) => candidate.selected);

            assert.ok(page);
            const held = yield* PageControl.suspend(yield* session.page(page));

            assert.equal((yield* PageControl.state(yield* session.page(page))).state, "suspended");
            yield* PageControl.resume(session.initialPage, held);
            const issuedPage = yield* session.page(page);

            const ran = yield* issuedPage.run(
              {
                version: 1,
                steps: [
                  {
                    id: "increment",
                    action: {
                      _tag: "Click",
                      target: {
                        _tag: "Descriptor",
                        descriptor: { kind: "button", label: "Increment", matchScope: "document" },
                      },
                    },
                  },
                ],
              },
              { style: "plain" },
            );

            assert.equal((yield* session.initialPage.readText({ selector: "#count" })).text, "1");
            assert.equal(ran.completion._tag, "Complete");
            assert.equal(ran.steps[0]?.recorded._tag, "Complete");
            const recorded = yield* Plan.recorded(ran);
            const durable = yield* Plan.decode(yield* Plan.encode(recorded));

            yield* issuedPage.run(durable, { style: "plain" });
            assert.equal((yield* session.initialPage.readText({ selector: "#count" })).text, "2");
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
      }).pipe(Layer.provide(NodeCrypto.layer)),
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
