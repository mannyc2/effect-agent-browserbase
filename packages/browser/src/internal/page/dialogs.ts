/** Scoped dialog responses publish their actual outcome and invalidate their page after failed answers. */
import { Effect, Queue } from "effect";
import type { Dialog, Page as PlaywrightPage } from "playwright-core";

import type { BrowserError } from "../../BrowserError.ts";
import * as Events from "../../BrowserEvent.ts";

/**
 * What a page's own Playwright events publish, its close and crash aside, while its scope is
 * open. Dialogs are answered: alerts accepted, others dismissed. The page's own session tells its
 * documents' commits and loads.
 */
export const listen = Effect.fnUntraced(function* (
  playwright: PlaywrightPage,
  page: string,
  publish: (event: Events.BrowserEvent) => number,
  now: () => number,
  answer: (accept: boolean) => Effect.Effect<void, BrowserError>,
  on: { readonly close: () => void; readonly crash: () => void; readonly failed: () => void },
) {
  const dialogs = yield* Queue.bounded<Pick<Events.DialogShown, "kind" | "message">>(8);

  const dialog = (shown: Dialog) => {
    if (!Queue.offerUnsafe(dialogs, { kind: shown.type(), message: shown.message().slice(0, 500) }))
      on.failed();
  };

  yield* Queue.take(dialogs).pipe(
    Effect.flatMap(({ kind, message }) => {
      const accept = kind === "alert" || kind === "beforeunload";

      const record = (answer: Events.DialogShown["answer"]) =>
        Effect.sync(() => {
          publish(new Events.DialogShown({ at: now(), page, kind, message, answer }));
        });

      return answer(accept).pipe(
        Effect.tap(() => record(accept ? "accepted" : "dismissed")),
        Effect.tapError(() => record("failed").pipe(Effect.andThen(Effect.sync(on.failed)))),
      );
    }),
    Effect.forever,
    Effect.forkScoped,
  );
  yield* Effect.acquireRelease(
    Effect.sync(() => {
      playwright.on("close", on.close);
      playwright.on("crash", on.crash);
      playwright.on("dialog", dialog);
    }),
    () =>
      Effect.sync(() => {
        playwright.off("close", on.close);
        playwright.off("crash", on.crash);
        playwright.off("dialog", dialog);
      }),
  );
});
