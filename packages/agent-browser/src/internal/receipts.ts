/**
 * What a model is told of a call: a failure, with what it leaves and what to do about it, and what
 * followed an action on its page while it ran, from the page's own record: a dialog and how the
 * browser answered it, a navigation, a tab it opened and what its input visibly changed.
 */
import { Effect, Option, Result, Schema } from "effect";
import { BrowserError, consequence, InvalidRequest } from "effect-browser/BrowserError";
import { DialogShown, Navigated, PageOpened } from "effect-browser/BrowserEvent";
import * as Change from "effect-browser/Change";
import type * as Page from "effect-browser/Page";

/** A failure as a model is told it: what happened, then what to do about it. */
export const told = (error: BrowserError): string => {
  const { lost, repeat } = consequence(error);

  return [
    `${error.message}.`,
    lost === "session" ? "The browser is gone." : lost === "page" ? "The tab is gone." : "",
    error.reason._tag === "StaleRef" ? "Observe the page again for current refs." : "",
    error.reason._tag === "Busy" && repeat === "safe"
      ? "Nothing was done while other work held the page: try it again."
      : "",
    repeat === "check" ? "It may have taken effect: look at the page before you repeat it." : "",
  ]
    .filter((sentence) => sentence !== "")
    .join(" ");
};

/** A refusal before anything reached the browser, as a page's own refusals are. */
const refused = (operation: string, detail: string) =>
  Effect.fail(
    new BrowserError({ operation, reason: new InvalidRequest({ detail }), dispatched: false }),
  );

/** Where a model may go: web addresses, inline data and a blank page, never local files. */
export const destination = (operation: string, input: string) => {
  const url = URL.parse(input);

  return url !== null &&
    (url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "data:" ||
      url.href === "about:blank")
    ? Effect.succeed(url.href)
    : refused(
        operation,
        `${JSON.stringify(input)} was not opened: the browser opens http and https addresses, data: URLs and about:blank`,
      );
};

/** At most this many of the changes an action caused are told. */
const maxChanges = 3;

const isDialog = Schema.is(DialogShown);
const isNavigated = Schema.is(Navigated);
const isOpened = Schema.is(PageOpened);

/**
 * What followed on `page` since host time `since`, a line each: the dialogs that opened and how
 * each was answered, where the page went, the tabs it opened, and up to three changes its input
 * caused, read in one call. What could not be read is told as such.
 */
export const followed = (page: Page.Page, since: number) =>
  Effect.gen(function* () {
    const events = (yield* page.recentEvents).filter((event) => event.at > since);
    const changes = yield* Effect.result(page.changes({ since }));
    const navigated = events.findLast(isNavigated);

    const caused = Option.match(Result.getSuccess(changes), {
      onNone: () => [],
      onSome: (read) => read.changes.filter((change) => change.cause !== undefined),
    });

    const more = caused.length - maxChanges;

    return [
      ...events
        .filter(isDialog)
        .map(
          ({ kind, message, answer }) =>
            `A ${kind} dialog said ${JSON.stringify(message)}, and it was ${answer}.`,
        ),
      ...(navigated === undefined ? [] : [`The page went to ${navigated.url}.`]),
      ...events.filter(isOpened).map(({ url }) => `A tab opened at ${url}.`),
      ...(caused.length === 0
        ? []
        : [
            `It changed: ${caused
              .slice(0, maxChanges)
              .map((change) => Change.describe(change))
              .join("; ")}${more > 0 ? `; and ${more} more` : ""}.`,
          ]),
      ...Option.match(Result.getFailure(changes), {
        onNone: () => [],
        onSome: (error) => [`What changed could not be read: ${error.reason.message}.`],
      }),
    ];
  });
