import assert from "node:assert/strict";

import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { ClickRequest, NavigateRequest } from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { localBrowser, policy, settle, withProvider } from "../fixtures/LocalBrowser.ts";

it.live("real CDP: pinned captures survive tab selection and isolate page close", () =>
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
          // Reading the list immediately left `popup` undefined, and the non-null
          // assertion turned that into a TypeError about `pageId` far from its
          // cause. Reproduced once in 25 rounds of the full native suite on two
          // loaded cores. The budget still bounds the wait, so a popup that is
          // never registered fails below with the same count as before.
          const initialPages = yield* settle(session.pages, (open) => open.length === 2);
          const original = initialPages.find((page) => page.selected);
          const popup = initialPages.find((page) => !page.selected);

          assert.ok(original, "the fixture page must still be selected");
          assert.ok(popup, "the popup must be registered as a second page");
          const popupHandle = yield* session.selectPage(popup.pageId);

          yield* popupHandle.navigate(NavigateRequest.make({ url: f.url }));
          const pages = yield* session.pages;
          const pinnedOriginal = pages.find((page) => page.pageId === original.pageId)!;
          const pinnedPopup = pages.find((page) => page.pageId === popup.pageId)!;

          const originalCapture = yield* Capture.start(session, {
            target: pinnedOriginal,
            maxFrames: 8,
            maxDurationMillis: 5000,
          });

          const popupCapture = yield* Capture.start(session, {
            target: pinnedPopup,
            maxFrames: 8,
            maxDurationMillis: 5000,
          });

          // The selected page is the popup, but the original page keeps recording independently.
          yield* popupHandle.click(ClickRequest.make({ selector: "#increment" }));
          yield* Effect.sleep(250);
          const firstSummary = yield* originalCapture.stop;

          expect(firstSummary.target.pageId).toBe(original.pageId);
          expect(firstSummary.received).toBeGreaterThan(0);

          // Stopping A must not stop B. B receives later frames while the agent remains on B.
          yield* popupHandle.click(ClickRequest.make({ selector: "#increment" }));
          yield* Effect.sleep(250);
          const popupAfterFirstStop = yield* popupCapture.stop;

          expect(popupAfterFirstStop.target.pageId).toBe(popup.pageId);
          expect(popupAfterFirstStop.received).toBeGreaterThan(0);
          expect(popupAfterFirstStop.sourceLastMillis ?? 0).toBeGreaterThan(
            firstSummary.sourceLastMillis ?? 0,
          );

          // Restart A, close only A, and prove B remains usable and recordable.
          const closingCapture = yield* Capture.start(session, {
            target: pinnedOriginal,
            maxDurationMillis: 5000,
          });

          const survivingCapture = yield* Capture.start(session, {
            target: pinnedPopup,
            maxDurationMillis: 5000,
          });

          yield* session.closePage(original.pageId);
          const closed = yield* closingCapture.completed;

          expect(closed.error?.reason).toBe("target-changed");
          expect(closed.nativeStop).toBe("confirmed");

          // B plus three replacements fills both the four-interval and 64 MiB budgets.
          // A dead-page quarantine would reject the last admission even though A is gone.
          const replacements: Array<Capture.CaptureInterval> = [];

          for (let index = 0; index < 3; index++) {
            const pageId = yield* session.createPage;
            const replacementPage = (yield* session.pages).find((page) => page.pageId === pageId)!;

            replacements.push(
              yield* Capture.start(session, { target: replacementPage, maxDurationMillis: 5000 }),
            );
          }
          for (const replacement of replacements) {
            expect((yield* replacement.stop).nativeStop).toBe("confirmed");
          }
          yield* popupHandle.click(ClickRequest.make({ selector: "#increment" }));
          yield* Effect.sleep(250);
          const survivor = yield* survivingCapture.stop;

          expect(survivor.target.pageId).toBe(popup.pageId);
          expect(survivor.received).toBeGreaterThan(0);
          expect((yield* session.currentTarget.pipe(Effect.result))._tag).toBe("Success");
          yield* session.close;
        }),
      );
    }),
  ),
);
