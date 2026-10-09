/**
 * The wait after input: one task and one frame in the page, in one call, then a document only if
 * one committed meanwhile, until it is parsed. Chromium answers a call to a page that a link, a form
 * or a script's timer has asked to navigate only once the new document commits, or the navigation
 * stops without one, as on a 204, so the call spans the navigation the input asked for. A
 * `pushState` asks for no document, and a navigation a handler starts after a fetch answers is the
 * next look's to see. A tab the input opened is the call's too, until the browser tracks it.
 */
import { Deferred, Duration, Effect, Exit, Schedule } from "effect";

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

  // The windows the page opened, which Chromium tells as it creates each, before the click is done.
  let windows = 0;

  page.cdp.on("Page.windowOpen", () => {
    windows += 1;
  });

  /** The page before input, which `settle` measures from: its document and the windows it opened. */
  const mark = () => ({ document: document(), windows, at: page.now() });

  /** Wait for the page to settle after input sent since `before`. */
  const settle = (operation: string, before: ReturnType<typeof mark>) =>
    Effect.gen(function* () {
      // A commit ends the call's world; the loop then waits for that document.
      yield* bridge
        .evaluate(operation, scriptCall("settle"))
        .pipe(Effect.catchIf(contextGone, () => Effect.void));
      while (document() > before.document && parsed < document()) yield* Deferred.await(changed);

      // A busy browser tracks a tab the input opened after the click is done, and never one that
      // closed as it opened, so this wait is a second at most.
      const opened = Effect.map(page.recentEvents, (events) =>
        events.filter((event) => event._tag === "PageOpened" && event.at >= before.at),
      );

      if (windows > before.windows)
        yield* opened.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(10)),
            until: (tabs) => tabs.length >= windows - before.windows,
          }),
          Effect.timeoutOrElse({ duration: Duration.seconds(1), orElse: () => Effect.void }),
        );
    }).pipe(
      Effect.timeoutOrElse({ duration: settling, orElse: () => Effect.fail("unsettled") }),
      Effect.catch(() => Effect.annotateCurrentSpan("settled", false)),
      page.span("Page.settle", {}, "Debug"),
    );

  return { mark, settle };
};

export type Settle = ReturnType<typeof make>;
