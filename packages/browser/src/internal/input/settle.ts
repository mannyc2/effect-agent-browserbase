/**
 * The wait after input: one task and one frame in the page, in one call, and then a document only
 * if the input asked the main frame for one. The page's own session says when a navigation is
 * asked for, by a link, a form or a script, and when it ends: committed, which the bridge counts,
 * and parsed, or stopped without a document, as a 204 answer does. `pushState` asks for none, and
 * `frameStartedLoading`, which it also fires, is never taken for a navigation.
 */
import { Deferred, Duration, Effect, Exit } from "effect";

import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, type PageContext } from "../page/context.ts";

/** Where a page's documents stand before input, which `settle` measures from. */
export interface Mark {
  readonly asked: number;
  readonly document: number;
}

// A document still loading after this, or a closed page, is the next look's to show.
const settling = Duration.seconds(5);

export const make = (page: PageContext, bridge: Bridge) => {
  const { id, cdp, span } = page;
  const document = () => bridge.frameTag().document;
  // The navigations asked for; the document then current at the latest; the count asked when the
  // latest stopped; and the document whose DOMContentLoaded came last. Each wakes the waits.
  const navigation = { asked: 0, from: 0, stopped: 0, parsed: -1 };
  let changed = Deferred.makeUnsafe<void>();

  const note = (update: () => void) => {
    update();
    Deferred.doneUnsafe(changed, Exit.void);
    changed = Deferred.makeUnsafe<void>();
  };

  const asked = () =>
    note(() => {
      navigation.asked++;
      navigation.from = document();
    });

  // Asked for in this tab: a link to another tab or a download leaves its document be.
  cdp.on("Page.frameRequestedNavigation", (request) => {
    if (request.frameId === id && request.disposition === "currentTab") asked();
  });
  cdp.on("Page.frameStartedNavigating", (started) => {
    if (started.frameId === id && !/sameDocument/i.test(started.navigationType)) asked();
  });
  cdp.on("Page.frameStoppedLoading", ({ frameId }) => {
    if (frameId === id)
      note(() => {
        navigation.stopped = navigation.asked;
      });
  });
  cdp.on("Page.domContentEventFired", () =>
    note(() => {
      navigation.parsed = document();
    }),
  );

  const mark = (): Mark => ({ asked: navigation.asked, document: document() });

  // A navigation asked for since `before` that has neither committed nor stopped, or a document
  // committed since then that is not yet parsed.
  const pending = (before: Mark) =>
    (navigation.asked > before.asked &&
      navigation.stopped < navigation.asked &&
      document() === navigation.from) ||
    (document() > before.document && navigation.parsed < document());

  /** Wait for the page to settle after input sent since `before`. */
  const settle = (operation: string, before: Mark) =>
    Effect.gen(function* () {
      // A commit ends the call's world; the loop then waits for that document.
      yield* bridge
        .evaluate(operation, scriptCall("settle"))
        .pipe(Effect.catchIf(contextGone, () => Effect.void));
      while (pending(before)) yield* Deferred.await(changed);
    }).pipe(
      Effect.timeoutOrElse({ duration: settling, orElse: () => Effect.fail("unsettled") }),
      Effect.catch(() => Effect.annotateCurrentSpan("settled", false)),
      span("Page.settle", {}, "Debug"),
    );

  return { mark, settle };
};

export type Settle = ReturnType<typeof make>;
