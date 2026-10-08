/**
 * Expectations: what an action is for, checked on the page, so that an action whose outcome is
 * uncertain is sent again only where it did not take effect. An action that failed after its input
 * went, a `Timeout` or a `Closed` with `dispatched`, may have done what it was for; repeating it
 * blindly may do it twice, such as placing an order twice.
 *
 * An attempt takes its expectation's baseline from the page once, as it begins. Each `run` then
 * checks first: where the expectation holds already, it sends nothing and is `AlreadyDone`.
 * Otherwise it acts, and waits for the expectation: `Done`, or `NotDone` when it did not come in
 * time. An action that fails after its input went is checked too, `Done` if its effect came, and
 * otherwise fails as it did, so a later `run` of the same attempt checks before it acts again,
 * on the same page or on the one a reconnect finds by its id.
 *
 * ```ts
 * const placing = yield* Expect.attempt(page, Expect.appeared({ text: "Order placed" }))
 * const outcome = yield* placing.run(page, (page) => page.click("e12"))
 * // After a Timeout that left `dispatched`, the same call clicks again only if no order shows.
 * ```
 *
 * A query is `Page.find`'s, over the whole document unless it says otherwise, and each check is one
 * call to the page, a wait included; `navigated` reads the page's address and document, at no
 * call. What `changed` compares stays in the page: text, field values and states, focus aside.
 *
 * @since 0.3.0
 */
import { Cause, Duration, Effect, Exit, Option, Schedule } from "effect";

import { BrowserError, InvalidRequest } from "./BrowserError.ts";
import { type Internals, internalsOf } from "./internal/page/page.ts";
import type { FindQuery, Page } from "./Page.ts";

/** What an action is for, as the page can tell it. */
export type Expectation =
  | { readonly _tag: "Appeared"; readonly query: FindQuery }
  | { readonly _tag: "Gone"; readonly query: FindQuery }
  | { readonly _tag: "Changed"; readonly query: FindQuery }
  | { readonly _tag: "Navigated"; readonly url: string | RegExp | undefined };

/** Something the query finds. */
export const appeared = (query: FindQuery): Expectation => ({ _tag: "Appeared", query });

/** Nothing the query finds. */
export const gone = (query: FindQuery): Expectation => ({ _tag: "Gone", query });

/**
 * What the query finds shows something other than it did as the attempt began: other elements, or
 * their text, values or states.
 */
export const changed = (query: FindQuery): Expectation => ({ _tag: "Changed", query });

/**
 * The page is at `url`, the whole address or a pattern; without one, at an address or in a
 * document other than the attempt's first.
 */
export const navigated = (url?: string | RegExp): Expectation => ({ _tag: "Navigated", url });

/**
 * `Done`: the action ran, and what it was for came. `AlreadyDone`: it held before the action was
 * sent, so it was not. `NotDone`: the action ran, and it did not come within the attempt's wait.
 */
export type Outcome = "Done" | "AlreadyDone" | "NotDone";

export interface Options {
  /** How long an action's effect may take to show. Defaults to 5 seconds. */
  readonly wait?: Duration.Input | undefined;
}

export interface Attempt {
  readonly expectation: Expectation;
  /** Whether the expectation holds on `page` now. */
  readonly holds: (page: Page) => Effect.Effect<boolean, BrowserError>;
  /**
   * `act` on `page`, unless the expectation holds there already: see the module's comment. A
   * failure before its input went is the action's own, and nothing is checked.
   */
  readonly run: (
    page: Page,
    act: (page: Page) => Effect.Effect<unknown, BrowserError>,
  ) => Effect.Effect<Outcome, BrowserError>;
}

const refused = (detail: string) =>
  new BrowserError({
    operation: "expect",
    reason: new InvalidRequest({ detail }),
    dispatched: false,
  });

const internalsFor = (page: Page): Effect.Effect<Internals, BrowserError> => {
  const internals = internalsOf(page);

  return internals === undefined
    ? Effect.fail(
        refused("only a page a Browser opened, or a presenter's view of one, can be checked"),
      )
    : Effect.succeed(internals);
};

const atUrl = (url: string, wanted: string | RegExp) =>
  typeof wanted === "string" ? url === wanted : new RegExp(wanted.source, wanted.flags).test(url);

/** Begin an attempt at `expectation` on `page`, which takes its baseline from the page now. */
export const attempt = Effect.fn("Expect.attempt")(function* (
  page: Page,
  expectation: Expectation,
  options: Options = {},
) {
  const wait = Duration.fromInput(options.wait ?? Duration.seconds(5));

  if (Option.isNone(wait) || Duration.isNegative(wait.value))
    return yield* refused("wait must be a duration, not negative");
  const waitMillis = Duration.toMillis(wait.value);
  const first = yield* page.state;
  const internals = yield* internalsFor(page);

  // What `changed` compares with: the mark of what the query found as the attempt began.
  const from =
    expectation._tag === "Changed"
      ? (yield* internals.until(expectation.query, "some", 0)).mark
      : undefined;

  // Navigated: at the address asked, or, without one, somewhere other than the attempt's first,
  // where a document counts only on the page that counted it, not on one a reconnect found.
  const navigatedOn = (target: Page, url: string | RegExp | undefined) =>
    Effect.map(target.state, (now) =>
      url !== undefined
        ? atUrl(now.url, url)
        : now.url !== first.url ||
          (internalsOf(target) === internals && now.document !== first.document),
    );

  const holdsWithin = (target: Page, millis: number): Effect.Effect<boolean, BrowserError> => {
    if (expectation._tag === "Navigated") {
      const look = navigatedOn(target, expectation.url);

      return look.pipe(
        Effect.repeat({
          until: (held) => held,
          schedule: Schedule.spaced(Duration.millis(50)),
        }),
        Effect.timeoutOrElse({ duration: Duration.millis(millis), orElse: () => look }),
      );
    }

    const want =
      expectation._tag === "Appeared"
        ? "some"
        : expectation._tag === "Gone"
          ? "none"
          : { other: from ?? "" };

    return internalsFor(target).pipe(
      Effect.flatMap((own) => own.until(expectation.query, want, millis)),
      Effect.map(({ met }) => met),
    );
  };

  const run = Effect.fn("Expect.run")(
    function* (target: Page, act: (page: Page) => Effect.Effect<unknown, BrowserError>) {
      if (yield* holdsWithin(target, 0)) return "AlreadyDone" as const;
      const acted = yield* Effect.exit(act(target));

      if (Exit.isSuccess(acted))
        return (yield* holdsWithin(target, waitMillis)) ? ("Done" as const) : ("NotDone" as const);
      const error = Cause.findErrorOption(acted.cause);

      // A failure before the input went did nothing; one after it may have done what it was for.
      if (Option.isNone(error) || !error.value.dispatched)
        return yield* Effect.failCause(acted.cause);
      const held = yield* Effect.exit(holdsWithin(target, waitMillis));

      return Exit.isSuccess(held) && held.value
        ? ("Done" as const)
        : yield* Effect.failCause(acted.cause);
    },
    Effect.tap((outcome) => Effect.annotateCurrentSpan({ expectation: expectation._tag, outcome })),
  );

  return {
    expectation,
    holds: (target) => holdsWithin(target, 0),
    run,
  } satisfies Attempt;
});
