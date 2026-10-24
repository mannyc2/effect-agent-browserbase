/** H3: a person signs in through a private viewer while automated input remains suspended. */
import { Effect, Schema, Stream } from "effect";
import type * as Browser from "effect-browser/Browser";

import { refuse } from "./Budget.ts";
import * as Fixtures from "./FixtureRoutes.ts";

export const Settings = Schema.Struct({
  startUrl: Schema.String.check(
    Schema.makeFilter((value) => {
      try {
        const url = new URL(value);

        return url.protocol === "https:" && url.username === "" && url.password === "";
      } catch {
        return false;
      }
    }),
  ),
  signedIn: Schema.Struct({
    role: Schema.optional(Schema.String),
    name: Schema.optional(Schema.String),
    text: Schema.optional(Schema.String),
  }).check(Schema.makeFilter((value) => Boolean(value.name?.trim() || value.text?.trim()))),
});

export const make = <E, R>(
  browser: Browser.Service,
  settings: typeof Settings.Type,
  ready: Effect.Effect<void, E, R>,
) =>
  Effect.sync(() => {
    const pages = new Map<string, number>();
    const events: Array<{ sequence: number; at: number; kind: string; page: number }> = [];

    const checks = {
      refusals: 0,
      reads: 0,
      navigations: 0,
      opened: 0,
      dispatched: 0,
      signedIn: false,
      resumed: false,
    };

    let since: number | undefined;

    const run = Effect.gen(function* () {
      yield* Fixtures.serve("https://h3.browser.test/", () => ({
        _tag: "Fulfilled",
        status: 200,
        contentType: "text/html",
        body: '<title>H3 operator handoff</title><a target="_blank" rel="noopener">Open sign-in page</a><p>Sign in manually in the new tab. Automated browser input is suspended.</p>',
      }));
      const scratch = yield* browser.newPage("https://h3.browser.test/");
      const mark = yield* scratch.state;

      yield* scratch.act(
        (url) => {
          const link = document.querySelector("a");

          if (link !== null) link.href = url;
        },
        { arg: settings.startUrl, document: mark.document, result: Schema.Void },
      );

      yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* browser.suspend({ drain: "5 seconds" });

          since = held.since;
          yield* ready;

          const observe = browser.events({ after: held.since }).pipe(
            Stream.runForEach(({ sequence, event }) =>
              Effect.gen(function* () {
                if (event._tag === "Action" && event.dispatched) checks.dispatched++;
                if (event._tag !== "Navigated" && event._tag !== "PageOpened") return;
                if (events.length >= 2048)
                  return yield* refuse("H3 event evidence exceeded its bound");
                if (!pages.has(event.page)) pages.set(event.page, pages.size + 1);
                events.push({
                  sequence,
                  at: event.at,
                  kind: event._tag,
                  page: pages.get(event.page) ?? 0,
                });
                if (event._tag === "Navigated") checks.navigations++;
                else checks.opened++;
              }),
            ),
            Effect.andThen(refuse("H3 event observation ended during handoff")),
          );

          const wait = Effect.gen(function* () {
            for (;;) {
              yield* scratch.press("Tab").pipe(
                Effect.matchEffect({
                  onSuccess: () => refuse("H3 dispatched automated input while suspended"),
                  onFailure: (error) =>
                    error.reason._tag === "Suspended" && !error.dispatched
                      ? Effect.sync(() => {
                          checks.refusals++;
                        })
                      : Effect.fail(error),
                }),
              );
              yield* scratch.screenshot();
              checks.reads++;
              checks.signedIn = false;
              for (const page of yield* browser.pages) {
                if ((yield* page.find(settings.signedIn)).length > 0) checks.signedIn = true;
              }
              if (checks.dispatched !== 0)
                return yield* refuse("H3 observed dispatched library input during handoff");
              if (checks.signedIn && checks.navigations > 0 && checks.opened > 0) return;
              yield* Effect.sleep("1 second");
            }
          });

          yield* Effect.raceFirst(wait, observe).pipe(Effect.timeout("3 minutes"));
        }),
      );
      yield* scratch.press("Tab");
      checks.resumed = true;
    });

    return { run, report: () => ({ since, checks, events }) };
  });
