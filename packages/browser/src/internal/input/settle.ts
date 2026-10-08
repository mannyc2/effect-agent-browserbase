/**
 * The wait after input: one task and one frame in the page, in one call, then a document only if
 * one committed meanwhile, until it is parsed. Chromium answers a call to a page that a link, a form
 * or a script's timer has asked to navigate only once the new document commits, or the navigation
 * stops without one, as on a 204, so the call spans the navigation the input asked for. A
 * `pushState` asks for no document, and a navigation a handler starts after a fetch answers is the
 * next look's to see.
 */
import { Deferred, Duration, Effect, Exit } from "effect";

import { type Bridge, scriptCall } from "../page/bridge.ts";
import { contextGone, type PageContext } from "../page/context.ts";

// A document still loading after this, or a closed page, is the next look's to show.
const settling = Duration.seconds(5);

export const make = (page: PageContext, bridge: Bridge) => {
  const document = () => bridge.frameTag().document;
  // The latest document whose DOMContentLoaded came, and what wakes a wait for the next.
  let parsed = -1;
  let changed = Deferred.makeUnsafe<void>();

  page.cdp.on("Page.domContentEventFired", () => {
    parsed = document();
    Deferred.doneUnsafe(changed, Exit.void);
    changed = Deferred.makeUnsafe<void>();
  });

  /** The page's document before input, which `settle` measures from. */
  const mark = document;

  /** Wait for the page to settle after input sent since `before`. */
  const settle = (operation: string, before: number) =>
    Effect.gen(function* () {
      // A commit ends the call's world; the loop then waits for that document.
      yield* bridge
        .evaluate(operation, scriptCall("settle"))
        .pipe(Effect.catchIf(contextGone, () => Effect.void));
      while (document() > before && parsed < document()) yield* Deferred.await(changed);
    }).pipe(
      Effect.timeoutOrElse({ duration: settling, orElse: () => Effect.fail("unsettled") }),
      Effect.catch(() => Effect.annotateCurrentSpan("settled", false)),
      page.span("Page.settle", {}, "Debug"),
    );

  return { mark, settle };
};

export type Settle = ReturnType<typeof make>;
