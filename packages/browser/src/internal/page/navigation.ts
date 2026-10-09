/**
 * Moving a page between documents: going to an address, back through its history, or reloading.
 * Each move is an action, so it takes the page's turn, goes through the input guard and is
 * recorded, but it sends no input.
 */
import { Deferred, Duration, Effect, Schedule } from "effect";

import {
  BrowserError,
  InvalidRequest,
  NavigationFailed,
  NotActionable,
  NotFound,
} from "../../BrowserError.ts";
import type { Guard } from "../input/guard.ts";
import type { InputMarks, Perform } from "../input/perform.ts";
import { failWith, type PageContext } from "./context.ts";
import * as Url from "./url.ts";

export const make = (
  page: PageContext,
  perform: Perform,
  preparePolicy: Guard["preparePolicy"],
) => {
  const { playwright, settings, native } = page;
  const { send } = page.protocol;

  // `address` is where `run` goes, as the action, the guard and a failure report it.
  const navigation = (name: string, run: () => Promise<unknown>, address: string) => {
    const url = Url.redact(address);

    return perform(
      name,
      { target: url, input: false },
      settings.navigationTimeout,
      preparePolicy(name, { target: url }, [], { destination: url }),
      (marks) =>
        marks.sent.pipe(
          Effect.andThen(native(name, run)),
          Effect.mapError((error) =>
            error.reason._tag === "Failed" &&
            /net::|NS_ERROR|Cannot navigate/i.test(error.reason.detail)
              ? new BrowserError({
                  operation: name,
                  reason: new NavigationFailed({ url, detail: error.reason.detail }),
                  dispatched: true,
                })
              : error,
          ),
          Effect.asVoid,
        ),
    );
  };

  const history = native("back", () => send("Page.getNavigationHistory"));

  // While a traversal swaps documents, Chromium can briefly route this session to the outgoing
  // document, which has become inactive (for instance after it entered the back-forward cache),
  // so a read during the traversal is retried until the session reaches the active document.
  const traversingHistory = history.pipe(
    Effect.retry({
      schedule: Schedule.spaced(Duration.millis(50)),
      while: (error) =>
        error.reason._tag === "Failed" &&
        /not attached to an active page/i.test(error.reason.detail),
    }),
  );

  // The current entry's title is the one the page last set, and empty where it set none, so no
  // address stands in for it. The browser answers it, whatever the page's script is doing.
  const title = native("title", () => send("Page.getNavigationHistory")).pipe(
    Effect.map(({ entries, currentIndex }) => entries[currentIndex]?.title ?? ""),
  );

  const noPrevious = failWith("back", new NotFound({ target: "a previous page in this tab" }));

  const prepareBack = Effect.gen(function* () {
    const before = yield* history;
    const current = before.entries[before.currentIndex];
    const previous = before.entries[before.currentIndex - 1];

    if (previous === undefined) return yield* noPrevious;
    const plan = yield* preparePolicy("back", {}, [], { destination: Url.redact(previous.url) });

    return {
      request: plan.request,
      validate: Effect.gen(function* () {
        const approval = yield* plan.validate;
        const latest = yield* history;

        if (
          latest.currentIndex !== before.currentIndex ||
          latest.entries[latest.currentIndex]?.id !== current?.id ||
          latest.entries[latest.currentIndex - 1]?.id !== previous.id ||
          latest.entries[latest.currentIndex - 1]?.url !== previous.url
        )
          return yield* failWith(
            "back",
            new NotActionable({
              detail: "the navigation history changed while input policy was pending",
            }),
          );

        return approval;
      }),
    };
  });

  // One protocol traversal on every path. It has committed once the tab leaves its entry, which
  // also covers entries that only an iframe created, where the main frame never navigates, and
  // entries sharing a URL. A frame navigation then shows Playwright has caught up before the
  // main document's readiness is read.
  const goBack = (marks: InputMarks) =>
    Effect.gen(function* () {
      const before = yield* history;
      const current = before.entries[before.currentIndex];
      const previous = before.entries[before.currentIndex - 1];

      if (current === undefined || previous === undefined) return yield* noPrevious;
      const navigated = yield* Deferred.make<void>();

      const onNavigation = () => {
        Deferred.doneUnsafe(navigated, Effect.void);
      };

      yield* Effect.acquireUseRelease(
        Effect.sync(() => playwright.on("framenavigated", onNavigation)),
        () =>
          Effect.gen(function* () {
            yield* marks.sent;
            yield* native("back", () =>
              send("Page.navigateToHistoryEntry", { entryId: previous.id }),
            );
            yield* traversingHistory.pipe(
              Effect.repeat({
                schedule: Schedule.spaced(Duration.millis(50)),
                until: (latest) => latest.entries[latest.currentIndex]?.id !== current.id,
              }),
            );
            yield* Deferred.await(navigated);
          }),
        () => Effect.sync(() => playwright.off("framenavigated", onNavigation)),
      );
      yield* native("back", () => playwright.waitForLoadState("domcontentloaded", { timeout: 0 }));
    });

  const goto = (url: string) => {
    const parsed = Url.parse(url);

    if (
      parsed === null ||
      !["http:", "https:", "about:", "data:", "file:"].includes(parsed.protocol)
    )
      return failWith(
        "navigate",
        new InvalidRequest({ detail: `"${Url.redact(url)}" is not a URL` }),
      );

    return navigation(
      "navigate",
      () => playwright.goto(parsed.href, { waitUntil: "domcontentloaded", timeout: 0 }),
      parsed.href,
    );
  };

  const back = perform(
    "back",
    { target: "back", input: false },
    settings.navigationTimeout,
    prepareBack,
    goBack,
  );

  const reload = Effect.suspend(() =>
    navigation(
      "reload",
      () => playwright.reload({ waitUntil: "domcontentloaded", timeout: 0 }),
      playwright.url(),
    ),
  );

  return { goto, back, reload, title };
};
