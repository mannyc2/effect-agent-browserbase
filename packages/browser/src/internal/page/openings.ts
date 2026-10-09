/** A page's input waits for the actual tabs it opened to finish the browser's registration. */
import { Deferred, Effect, Exit } from "effect";
import type { CDPSession, Page as PlaywrightPage } from "playwright-core";

import { BrowserError, Closed } from "../../BrowserError.ts";

export interface Mark {
  windows: number;
  readonly registrations: Array<Effect.Effect<void, BrowserError>>;
  changed: Deferred.Deferred<void>;
}

export const make = Effect.fnUntraced(function* (
  playwright: PlaywrightPage,
  cdp: CDPSession,
  registered: (popup: PlaywrightPage) => Effect.Effect<void, BrowserError>,
  closedBy: () => Closed["cause"],
) {
  let active: Mark | undefined;
  const gone = Deferred.makeUnsafe<never, BrowserError>();

  const windowOpened = () => {
    if (active !== undefined) active.windows += 1;
  };

  const popup = (opened: PlaywrightPage) => {
    if (active === undefined) return;
    // Playwright emits the context's page event first, so its owner already has this exact
    // popup's registration. A window notification alone has no target id and cannot name it.
    active.registrations.push(registered(opened));
    Deferred.doneUnsafe(active.changed, Exit.void);
    active.changed = Deferred.makeUnsafe<void>();
  };

  const clear = Effect.sync(() => {
    active = undefined;
  });

  yield* Effect.acquireRelease(
    Effect.sync(() => {
      cdp.on("Page.windowOpen", windowOpened);
      playwright.on("popup", popup);
    }),
    () =>
      Effect.sync(() => {
        Deferred.doneUnsafe(
          gone,
          Effect.fail(
            new BrowserError({
              operation: "newPage",
              reason: new Closed({ cause: closedBy() }),
              dispatched: false,
            }),
          ),
        );
        active = undefined;
        cdp.off("Page.windowOpen", windowOpened);
        playwright.off("popup", popup);
      }),
  );

  return {
    mark: () => {
      const mark: Mark = { windows: 0, registrations: [], changed: Deferred.makeUnsafe<void>() };

      active = mark;

      return mark;
    },
    clear,
    settle: (mark: Mark) =>
      Effect.gen(function* () {
        // A blocked window or a tab that closes as it opens may never become a Playwright popup.
        // Discovery and registration both share the input's deadline, so an unresolved opening
        // fails with potentially dispatched input rather than claiming the tab has been tracked.
        while (mark.registrations.length < mark.windows) yield* Deferred.await(mark.changed);
        // A real popup has a known registration; its failure stays a failure, and its wait shares
        // the input's deadline rather than quietly returning before the browser tracks it.
        yield* Effect.forEach(mark.registrations, (registration) => registration);
      }).pipe(Effect.raceFirst(Deferred.await(gone)), Effect.ensuring(clear)),
  };
});

export type Openings = Effect.Success<ReturnType<typeof make>>;
