import assert from "node:assert/strict";

import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Stream } from "effect";
import { PageSuspension, ClickRequest, NavigateRequest } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import * as PageControl from "effect-browser/page-control";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import type { Page } from "playwright-core";

import {
  localBrowser,
  localLaunch,
  policy,
  settle,
  withProvider,
} from "../fixtures/LocalBrowser.ts";

const Counters = Schema.Struct({
  ticks: Schema.Natural,
  rafs: Schema.Natural,
  animation: Schema.Finite,
  paused: Schema.Finite,
});

const Clocks = Schema.Struct({
  ...Counters.fields,
  clicks: Schema.Natural,
  freezes: Schema.Array(Counters),
  resumes: Schema.Array(Counters),
});

const read = (page: Page) =>
  Effect.promise<unknown>(() => page.evaluate("window.read()")).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(Clocks)),
  );

for (const capture of [false, true])
  it.live(`real CDP: explicit hold/resume with scout progress (capture=${capture})`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* session.bind().navigate(NavigateRequest.make({ url: `${f.url}clocks` }));
            const stage = (yield* session.pages)[0];

            assert.ok(stage);
            const secondId = yield* session.createPage;
            const scoutHandle = yield* session.selectPage(secondId);

            // The fragment never reaches the fixture server, so both pages load the
            // same document while staying individually identifiable. Selecting the
            // native pages positionally would silently pick up any stray tab the
            // browser happens to expose, which surfaces far from its cause.
            yield* scoutHandle.navigate(NavigateRequest.make({ url: `${f.url}clocks#scout` }));
            const nativePages = f.nativePages(session.reference.sessionId);

            expect(nativePages.map((page) => page.url())).toHaveLength(2);

            const stageNative = nativePages.find((page) => !page.url().endsWith("#scout")),
              scoutNative = nativePages.find((page) => page.url().endsWith("#scout"));

            assert.ok(stageNative);
            assert.ok(scoutNative);

            const cdp = yield* Effect.acquireRelease(
              Effect.promise(() => stageNative.context().newCDPSession(stageNative)),
              (cdp) => Effect.promise(() => cdp.detach().catch(() => {})),
            );

            yield* Effect.promise(() =>
              cdp.send("Animation.setPlaybackRate", { playbackRate: 0.5 }),
            );
            const first = yield* read(stageNative);
            let count = 0;
            let scoutCount = 0;

            const interval = capture
              ? yield* Capture.start(session, { target: stage, maxDurationMillis: 5000 })
              : undefined;

            const consumer =
              interval === undefined
                ? undefined
                : yield* Stream.runForEach(interval.frames, () =>
                    Effect.sync(() => {
                      count++;
                    }),
                  ).pipe(Effect.forkScoped);

            const scout = (yield* session.pages).find((page) => page.pageId === secondId);

            assert.ok(scout);

            const scoutInterval = capture
              ? yield* Capture.start(session, { target: scout, maxDurationMillis: 5000 })
              : undefined;

            const scoutConsumer =
              scoutInterval === undefined
                ? undefined
                : yield* Stream.runForEach(scoutInterval.frames, () =>
                    Effect.sync(() => {
                      scoutCount++;
                    }),
                  ).pipe(Effect.forkScoped);

            yield* Effect.sleep(250);
            // A started screencast is not yet a flowing one. Pinned Playwright's
            // `Screencast.addClient` does not await `_startScreencast`, so a
            // resolved `Capture.start` means the client is registered, not that
            // Chromium has produced a frame. Wait for the baseline frames rather
            // than assuming this sleep covers native startup.
            if (capture) {
              yield* settle(
                Effect.sync(() => count),
                (frames) => frames > 0,
              );
              yield* settle(
                Effect.sync(() => scoutCount),
                (frames) => frames > 0,
              );
            }

            const before = yield* settle(read(stageNative), (clocks) => clocks.rafs > first.rafs);
            const scoutBefore = yield* read(scoutNative);

            const framesBefore = count;
            const scoutFramesBefore = scoutCount;
            const receipt = yield* PageControl.suspend(session, stage);

            expect((yield* PageControl.state(session, stage)).state).toBe("suspended");
            const heldHandle = yield* session.selectPage(stage.pageId);

            expect(
              (yield* heldHandle
                .click(ClickRequest.make({ selector: "#click" }))
                .pipe(Effect.result))._tag,
            ).toBe("Failure");
            const resumedScout = yield* session.selectPage(secondId);

            yield* Effect.sleep(350);
            yield* resumedScout.click(ClickRequest.make({ selector: "#click" }));

            const scoutDuring = yield* settle(
              read(scoutNative),
              (clocks) => clocks.rafs > scoutBefore.rafs,
            );

            expect(scoutDuring.ticks).toBeGreaterThan(scoutBefore.ticks);
            expect(scoutDuring.rafs).toBeGreaterThan(scoutBefore.rafs);
            expect(scoutDuring.clicks).toBe(1);
            if (capture) {
              const scoutDelivered = yield* settle(
                Effect.sync(() => scoutCount),
                (frames) => frames > scoutFramesBefore,
              );

              expect(scoutFramesBefore).toBeGreaterThan(0);
              expect(scoutDelivered).toBeGreaterThan(scoutFramesBefore);
            }
            const stale = PageSuspension.make({ ...receipt, suspensionId: "foreign" });
            const refused = yield* PageControl.resume(session, stale).pipe(Effect.result);

            expect(refused._tag).toBe("Failure");
            if (refused._tag === "Failure") expect(refused.failure.outcome).toBe("undispatched");
            const framesHeld = count;

            yield* PageControl.resume(session, receipt);
            const after = yield* read(stageNative);

            const freeze = after.freezes[0],
              resume = after.resumes[0];

            assert.ok(freeze);
            assert.ok(resume);
            expect(resume).toEqual(freeze);
            expect(after.animation - freeze.animation).toBeLessThan(80);
            const resumedAt = performance.now();

            yield* Effect.sleep(250);
            const advanced = yield* settle(read(stageNative), (clocks) => clocks.rafs > after.rafs);
            // A CSS animation's currentTime advances on the same frames rAF does,
            // so the band has to be taken against the elapsed wall time actually
            // spent, not against the sleep alone. The ratios are the original
            // 60ms and 210ms over 250ms: wide enough for scheduling noise, still
            // narrow enough that a rate left at 0 or restored to 1 fails.
            const elapsed = performance.now() - resumedAt;

            expect(before.ticks).toBeGreaterThan(first.ticks);
            expect(before.rafs).toBeGreaterThan(first.rafs);
            expect(advanced.ticks).toBeGreaterThan(after.ticks);
            expect(advanced.rafs).toBeGreaterThan(after.rafs);
            expect(advanced.animation - after.animation).toBeGreaterThan(elapsed * 0.24);
            expect(advanced.animation - after.animation).toBeLessThan(elapsed * 0.84);
            expect(advanced.paused).toBe(before.paused);
            expect(
              (yield* Effect.promise(() => cdp.send("Animation.getPlaybackRate"))).playbackRate,
            ).toBe(0.5);
            expect((yield* PageControl.state(session, stage)).state).toBe("running");
            expect((yield* session.pages).find((page) => page.selected)?.pageId).toBe(secondId);
            expect((yield* PageControl.resume(session, receipt).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            if (interval !== undefined && consumer !== undefined) {
              const delivered = yield* settle(
                Effect.sync(() => count),
                (frames) => frames > framesHeld,
              );

              expect(framesBefore).toBeGreaterThan(0);
              expect(delivered).toBeGreaterThan(framesHeld);
              yield* interval.stop;
              yield* Fiber.join(consumer);
              expect((yield* interval.completed).nativeStop).toBe("confirmed");
            }
            if (scoutInterval !== undefined && scoutConsumer !== undefined) {
              yield* scoutInterval.stop;
              yield* Fiber.join(scoutConsumer);
              expect((yield* scoutInterval.completed).nativeStop).toBe("confirmed");
            }
            yield* PageControl.suspend(session, stage);
            yield* session.closePage(stage.pageId);
            expect((yield* PageControl.state(session, stage).pipe(Effect.result))._tag).toBe(
              "Failure",
            );
            const remaining = (yield* session.pages).find((page) => page.pageId === secondId);

            assert.ok(remaining);
            expect((yield* PageControl.state(session, remaining)).state).toBe("running");
            yield* resumedScout.click(ClickRequest.make({ selector: "#click" }));
            expect((yield* read(scoutNative)).clicks).toBe(2);
            yield* session.close;
          }),
          { pageControl: true },
        );
      }),
    ),
  );
it.live("real CDP: control is opt-in and rejects keep-alive before allocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* localBrowser;

      const invalid = yield* withProvider(
        f,
        Effect.gen(function* () {
          return yield* (yield* BrowserbaseBrowser).open(policy);
        }),
        { pageControl: true, launch: { ...localLaunch, keepAlive: true } },
      ).pipe(Effect.result);

      expect(invalid._tag).toBe("Failure");
      expect(f.createBodies).toHaveLength(0);
      yield* withProvider(
        f,
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser).open(policy),
            page = (yield* session.pages)[0];

          assert.ok(page);
          const unsupported = yield* PageControl.suspend(session, page).pipe(Effect.result);

          expect(unsupported._tag).toBe("Failure");
          if (unsupported._tag === "Failure")
            expect(unsupported.failure.reason).toBe("unsupported");
          yield* session.close;
        }),
      );
    }),
  ),
);
