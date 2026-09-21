import assert from "node:assert/strict";

import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import {
  PageSuspension,
  ClickRequest,
  NavigateRequest,
} from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import * as PageControl from "@effect-agent/browserbase/page-control";
import { expect, it } from "@effect/vitest";
import { Effect, Fiber, Schema, Stream } from "effect";
import type { Page } from "playwright-core";

import { localBrowser, localLaunch, policy, withProvider } from "../fixtures/LocalBrowser.ts";

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

            yield* scoutHandle.navigate(NavigateRequest.make({ url: `${f.url}clocks` }));
            const nativePages = f.nativePages(session.reference.sessionId);

            const stageNative = nativePages[0],
              scoutNative = nativePages[1];

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

            const before = yield* read(stageNative),
              scoutBefore = yield* read(scoutNative);

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
            const scoutDuring = yield* read(scoutNative);

            expect(scoutDuring.ticks).toBeGreaterThan(scoutBefore.ticks);
            expect(scoutDuring.rafs).toBeGreaterThan(scoutBefore.rafs);
            expect(scoutDuring.clicks).toBe(1);
            if (capture) {
              expect(scoutFramesBefore).toBeGreaterThan(0);
              expect(scoutCount).toBeGreaterThan(scoutFramesBefore);
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
            yield* Effect.sleep(250);
            const advanced = yield* read(stageNative);

            expect(before.ticks).toBeGreaterThan(first.ticks);
            expect(before.rafs).toBeGreaterThan(first.rafs);
            expect(advanced.ticks).toBeGreaterThan(after.ticks);
            expect(advanced.rafs).toBeGreaterThan(after.rafs);
            expect(advanced.animation - after.animation).toBeGreaterThan(60);
            expect(advanced.animation - after.animation).toBeLessThan(210);
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
              expect(framesBefore).toBeGreaterThan(0);
              expect(count).toBeGreaterThan(framesHeld);
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
