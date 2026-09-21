import assert from "node:assert/strict";

import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { NavigateRequest } from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import type { Page } from "playwright-core";

import {
  localBrowser,
  localLaunch,
  NativeFixtureError,
  policy,
  withProvider,
} from "../fixtures/LocalBrowser.ts";

const WindowGeometry = Schema.Struct({
  innerWidth: Schema.Natural,
  innerHeight: Schema.Natural,
  outerWidth: Schema.Natural,
  outerHeight: Schema.Natural,
  devicePixelRatio: Schema.Finite,
});

const CreateBody = Schema.Struct({
  browserSettings: Schema.Record(Schema.String, Schema.Unknown),
});

const native = <A>(operation: string, run: () => Promise<A>) =>
  Effect.tryPromise({
    try: run,
    catch: (cause) => NativeFixtureError.make({ operation, cause }),
  });

/** Passive measurements on the existing owner connection; no viewport or focus overrides. */
const geometry = Effect.fnUntraced(function* (page: Page) {
  const cdp = yield* Effect.acquireRelease(
    native("attach viewport observer", () => page.context().newCDPSession(page)),
    (cdp) => native("detach viewport observer", () => cdp.detach()).pipe(Effect.orDie),
  );

  const js = yield* native("read window dimensions", () =>
    page.evaluate<unknown>(() => ({
      innerWidth: window.innerWidth,
      innerHeight: window.innerHeight,
      outerWidth: window.outerWidth,
      outerHeight: window.outerHeight,
      devicePixelRatio: window.devicePixelRatio,
    })),
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(WindowGeometry)));

  const metrics = yield* native("read layout viewport", () => cdp.send("Page.getLayoutMetrics"));

  const nativeWindow = yield* native("read native window bounds", () =>
    cdp.send("Browser.getWindowForTarget"),
  );

  return {
    viewport: page.viewportSize(),
    js,
    layout: {
      width: metrics.cssLayoutViewport.clientWidth,
      height: metrics.cssLayoutViewport.clientHeight,
    },
    window: nativeWindow,
  };
}, Effect.scoped);

it.live("real CDP: ProviderManaged keeps the native viewport through passive observation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* localBrowser;

      yield* withProvider(
        fixture,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);
          const page = fixture.nativePages(session.reference.sessionId)[0];

          assert.ok(page);
          expect(page.viewportSize()).toBeNull();
          expect(fixture.createBodies).toHaveLength(1);
          const body = yield* Schema.decodeUnknownEffect(CreateBody)(fixture.createBodies[0]);

          expect(body.browserSettings).not.toHaveProperty("viewport");
          yield* session.bind().navigate(NavigateRequest.make({ url: `${fixture.url}clocks` }));
          const before = yield* geometry(page);

          expect(before.js.innerWidth).toBeGreaterThan(0);
          expect(before.js.innerHeight).toBeGreaterThan(0);
          expect((yield* session.observe()).url).toBe(`${fixture.url}clocks`);
          expect(yield* geometry(page)).toEqual(before);
          expect(page.viewportSize()).toBeNull();
        }),
        { launch: { ...localLaunch, viewport: { _tag: "ProviderManaged" } } },
      );
      expect(fixture.releaseIds).toEqual(["session-1"]);
    }),
  ),
);

it.live("real CDP: owned Fixed acquisition aligns emulated and native window contents", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const fixture = yield* localBrowser;
      const dimensions = { width: 640, height: 480 };

      yield* withProvider(
        fixture,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy);

          yield* session.bind().navigate(NavigateRequest.make({ url: `${fixture.url}clocks` }));
          const stage = (yield* session.pages).find((page) => page.selected);
          const stageNative = fixture.nativePages(session.reference.sessionId)[0];

          assert.ok(stage);
          assert.ok(stageNative);
          const before = yield* geometry(stageNative);

          expect(before.viewport).toEqual(dimensions);
          expect(before.layout).toEqual(dimensions);
          expect(before.js).toMatchObject({ innerWidth: 640, innerHeight: 480 });
          const body = yield* Schema.decodeUnknownEffect(CreateBody)(fixture.createBodies[0]);

          expect(body.browserSettings.viewport).toEqual(dimensions);

          const scoutId = yield* session.createPage;
          const scout = yield* session.selectPage(scoutId);

          yield* scout.navigate(NavigateRequest.make({ url: `${fixture.url}clocks` }));

          const scoutNative = fixture
            .nativePages(session.reference.sessionId)
            .find((page) => page !== stageNative);

          assert.ok(scoutNative);
          const actual = yield* geometry(scoutNative);

          expect(actual.viewport).toBeNull();
          expect(actual.window.windowId).toBe(before.window.windowId);
          expect(actual.js).toMatchObject({ innerWidth: 640, innerHeight: 480 });
          expect(actual.layout).toEqual(dimensions);
          expect(actual.window.bounds).toEqual(before.window.bounds);
          expect(yield* geometry(stageNative)).toEqual(before);

          const interval = yield* Capture.start(session, {
            target: stage,
            maxDurationMillis: 5000,
          });

          const frames = yield* Stream.runCollect(interval.frames.pipe(Stream.take(1)));

          expect(frames).toHaveLength(1);
          expect(frames[0]).toMatchObject({
            ...dimensions,
            viewportWidth: 640,
            viewportHeight: 480,
          });
          expect((yield* interval.stop).nativeStop).toBe("confirmed");
        }),
        { pageControl: true },
      );
      expect(fixture.releaseIds).toEqual(["session-1"]);
    }),
  ),
);

it.live(
  "real CDP: borrowed attachment ignores its own Fixed recipe and preserves native size",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const fixture = yield* localBrowser;

        yield* withProvider(
          fixture,
          Effect.gen(function* () {
            const owner = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* owner.bind().navigate(NavigateRequest.make({ url: `${fixture.url}clocks` }));
            const target = (yield* owner.pages).find((page) => page.selected);
            const ownerNative = fixture.nativePages(owner.reference.sessionId)[0];

            assert.ok(target);
            assert.ok(ownerNative);
            const before = yield* geometry(ownerNative);

            expect(before.js).toMatchObject({ innerWidth: 960, innerHeight: 640 });
            yield* withProvider(
              fixture,
              Effect.gen(function* () {
                const borrowed = yield* (yield* BrowserbaseBrowser).attach(owner.reference, {
                  policy,
                  target: { targetId: target.targetId },
                });

                const borrowedNative = fixture.nativePages(owner.reference.sessionId)[0];

                assert.ok(borrowedNative);
                expect(borrowedNative.viewportSize()).toBeNull();
                expect((yield* borrowed.observe()).url).toBe(`${fixture.url}clocks`);
                const after = yield* geometry(ownerNative);

                expect(after).toEqual(before);
                const borrowerView = yield* geometry(borrowedNative);

                expect(borrowerView.js).toEqual(before.js);
                expect(borrowerView.layout).toEqual(before.layout);
                expect(borrowerView.window).toEqual(before.window);
                const cleanup = yield* borrowed.close;

                expect(cleanup.remote).toBe("not-owned");
                expect(cleanup.releaseRequested).toBe(false);
              }),
            );
            expect(yield* geometry(ownerNative)).toEqual(before);
            expect(fixture.createBodies).toHaveLength(1);
            expect(fixture.releaseIds).toEqual([]);
          }),
          {
            launch: {
              ...localLaunch,
              viewport: { _tag: "Fixed", width: 960, height: 640 },
            },
          },
        );
        expect(fixture.releaseIds).toEqual(["session-1"]);
        expect(fixture.connections).toEqual(["session-1", "session-1"]);
      }),
    ),
);
