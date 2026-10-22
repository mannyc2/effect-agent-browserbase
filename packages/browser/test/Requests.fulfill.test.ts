// Synthetic responses use the same bounded public request seam in Node and Workers.
import { assert, it } from "@effect/vitest";
import { Effect, Result } from "effect";
import { TestClock } from "effect/testing";
import { chromium } from "playwright-core";

import * as Browser from "../src/Browser.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

it.live("fulfills Unicode documents before opening pages and refuses invalid responses", () =>
  Effect.gen(function* () {
    const browser = yield* Chromium.open({
      requests: {
        patterns: ["https://synthetic.test/*"],
        decide: ({ url }) =>
          Effect.succeed({
            _tag: "Fulfilled",
            status: url.endsWith("/invalid") ? 0 : 200,
            contentType: "text/html; charset=utf-8",
            body: "<h1>Receipt ✓ 日本語</h1>",
          }),
      },
    });

    const page = yield* browser.newPage("https://synthetic.test/document");

    assert.include((yield* page.text()).text, "Receipt ✓ 日本語");
    const refused = yield* page.goto("https://synthetic.test/invalid").pipe(Effect.flip);

    assert.isTrue(refused.dispatched);
    assert.isTrue(
      (yield* browser.recentEvents).some(
        (event) => event._tag === "RequestRefused" && event.reason.includes("invalid"),
      ),
    );
  }).pipe(Effect.scoped),
);

it.live("bounds a provider that never answers request interception setup", () =>
  Effect.gen(function* () {
    const native = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch()),
      (browser) => Effect.promise(() => browser.close()),
    );

    const context = yield* Effect.promise(() => native.newContext());
    const faults = yield* TestCdp.make();

    faults.rule(
      { channel: "browser", method: "Fetch.enable" },
      { _tag: "Hold", gate: Effect.never },
    );

    const failed = yield* faults
      .provide(
        Browser.make(
          context,
          { provider: "owned-fault-fixture" },
          {
            requests: {
              patterns: ["https://synthetic.test/*"],
              timeout: "30 millis",
              decide: () => Effect.succeed({ _tag: "Allowed" }),
            },
          },
        ),
      )
      .pipe(Effect.timeout("500 millis"), Effect.flip);

    assert.strictEqual(failed._tag, "BrowserError");
    if (failed._tag === "BrowserError") assert.strictEqual(failed.reason._tag, "Timeout");
  }).pipe(Effect.scoped),
);

it.live("owns faults and temporary-page cleanup during request context discovery", () =>
  Effect.gen(function* () {
    const native = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch()),
      (browser) => Effect.promise(() => browser.close()),
    );

    const context = yield* Effect.promise(() => native.newContext());
    const faults = yield* TestCdp.make();

    faults.rule(
      { channel: "page", method: "Target.getTargetInfo" },
      { _tag: "Fail", error: new Error("request context discovery failed") },
    );

    const installed = yield* faults
      .provide(
        Browser.make(
          context,
          { provider: "owned-context-discovery-fixture" },
          {
            requests: {
              patterns: ["https://synthetic.test/*"],
              decide: () => Effect.succeed({ _tag: "Allowed" }),
            },
          },
        ),
      )
      .pipe(Effect.result);

    assert.isTrue(Result.isFailure(installed), "discovery must use the owned protocol seam");
    if (Result.isFailure(installed)) {
      assert.strictEqual(installed.failure.reason._tag, "Failed");
      if (installed.failure.reason._tag === "Failed")
        assert.include(installed.failure.reason.detail, "request context discovery failed");
    }
    assert.deepStrictEqual(context.pages(), [], "discovery must close its temporary blank page");
    assert.isTrue(native.isConnected());
  }).pipe(Effect.scoped),
);

it.effect("refuses an unprovable request and detaches its child ownership query", () =>
  Effect.gen(function* () {
    const native = yield* Effect.acquireRelease(
      Effect.promise(() => chromium.launch()),
      (browser) => Effect.promise(() => browser.close()),
    );

    const context = yield* Effect.promise(() => native.newContext());
    const faults = yield* TestCdp.make();
    let decisions = 0;

    const browser = yield* faults.provide(
      Browser.make(
        context,
        { provider: "owned-unknown-frame-fixture" },
        {
          requests: {
            patterns: ["https://synthetic.test/*"],
            timeout: "1 second",
            decide: () =>
              Effect.sync(() => {
                decisions++;

                return { _tag: "Allowed" as const };
              }),
          },
        },
      ),
    );

    const page = yield* browser.newPage("data:text/html,<body>Ownership query</body>");

    faults.rule(
      { channel: "browser", method: "Target.getTargetInfo", params: { targetId: page.id } },
      {
        _tag: "Fail",
        error: new Error("No target with given id found"),
      },
    );
    faults.rule(
      { channel: "browser", method: "Page.getFrameTree" },
      { _tag: "Hold", gate: Effect.never },
    );
    yield* page.goto("https://synthetic.test/unknown").pipe(Effect.result, Effect.forkScoped);
    yield* faults.waitUntil((calls) => calls.some(({ method }) => method === "Page.getFrameTree"));
    yield* TestClock.adjust("1 second");
    yield* faults.waitUntil((calls) => calls.some(({ method }) => method === "Fetch.failRequest"));
    yield* browser.newPage("about:blank");
    assert.strictEqual(decisions, 0);

    const detached = yield* faults
      .waitUntil((calls) => calls.some(({ method }) => method === "Target.detachFromTarget"))
      .pipe(Effect.forkScoped);

    yield* TestClock.adjust("1 milli");
    assert.isDefined(detached.pollUnsafe(), "ownership timeout must detach the child session");
  }).pipe(Effect.scoped),
);
