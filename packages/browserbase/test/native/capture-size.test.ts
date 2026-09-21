import { expect, it } from "@effect/vitest";
import { Effect, Schema, Stream } from "effect";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { Viewport, ClickRequest, NavigateRequest } from "effect-browserbase/browser-data";
import * as Capture from "effect-browserbase/capture";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";

it.live(
  "real CDP: independent source-size requests fit JPEGs without resizing either viewport",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const f = yield* localBrowser;

        yield* withProvider(
          f,
          Effect.gen(function* () {
            const session = yield* (yield* BrowserbaseBrowser).open(policy);

            yield* session.bind().navigate(NavigateRequest.make({ url: f.url }));
            yield* session.bind().click(ClickRequest.make({ selector: "#popup" }));
            // A dispatched click is not a registered target: the popup reaches this
            // session only once Chromium reports it and the owner registers it.
            // Reading the list immediately failed once in 30 loaded rounds with the
            // popup still missing. A popup never registered fails on the same finds.
            const initial = yield* settle(session.pages, (open) => open.length === 2);
            const original = initial.find((page) => page.selected)!;
            const popup = initial.find((page) => !page.selected)!;
            const scout = yield* session.selectPage(popup.pageId);

            yield* scout.navigate(NavigateRequest.make({ url: f.url }));
            yield* session.resizeViewport(Viewport.make({ width: 640, height: 480 }));
            const pages = yield* session.pages;
            const stagePage = pages.find((page) => page.pageId === original.pageId)!;
            const scoutPage = pages.find((page) => page.pageId === popup.pageId)!;

            const copiedSession = { ...session };

            const denied = yield* Capture.start(copiedSession, { target: stagePage }).pipe(
              Effect.result,
            );

            expect(denied._tag).toBe("Failure");
            if (denied._tag === "Failure") expect(denied.failure.reason).toBe("closed");

            const stage = yield* Capture.start(session, {
              target: stagePage,
              size: { width: 320, height: 240 },
              maxDurationMillis: 5000,
            });

            const researching = yield* Capture.start(session, {
              target: scoutPage,
              size: { width: 160, height: 120 },
              maxDurationMillis: 5000,
            });

            const firstStage = yield* Stream.runCollect(stage.frames.pipe(Stream.take(1)));
            const firstScout = yield* Stream.runCollect(researching.frames.pipe(Stream.take(1)));

            expect(firstStage).toHaveLength(1);
            expect(firstScout).toHaveLength(1);
            const a = firstStage[0]!;
            const b = firstScout[0]!;

            expect(Schema.is(Capture.CapturedFrame)(a)).toBe(true);
            expect(Schema.is(Capture.CapturedFrame)(b)).toBe(true);
            expect(a.width).toBeLessThanOrEqual(320);
            expect(a.height).toBeLessThanOrEqual(240);
            expect(b.width).toBeLessThanOrEqual(160);
            expect(b.height).toBeLessThanOrEqual(120);
            expect(a.width).toBeGreaterThan(b.width);
            expect(a.target.pageId).toBe(stagePage.pageId);
            expect(b.target.pageId).toBe(scoutPage.pageId);
            expect(a.viewportWidth).toBe(b.viewportWidth);
            expect(a.viewportHeight).toBe(b.viewportHeight);
            expect(a.viewportWidth).toBeGreaterThan(a.width);
            expect((yield* stage.completed).nativeStop).toBe("confirmed");
            expect((yield* researching.completed).nativeStop).toBe("confirmed");
            expect((yield* session.pages).find((page) => page.selected)?.pageId).toBe(popup.pageId);
            yield* session.close;
          }),
        );
      }),
    ),
);
