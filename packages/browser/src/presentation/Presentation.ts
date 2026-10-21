/**
 * Input performed for viewers. A presenter owns one pointer and pace. Its public page view applies
 * a style to input after approval, so policy holds leave the hand free. Hand acquisition is bounded
 * by the page's action wait and honours failFast; reactions and input use the page owner's clock.
 * @since 0.3.0
 */
import { type Clock, Duration, Effect, MutableRef, Option, Semaphore } from "effect";

import { methods } from "../ActionPort.ts";
import { Busy, refuse, undispatched } from "../BrowserError.ts";
import { monotonicMillis } from "../Clock.ts";
import type { Page, Point } from "../Page.ts";
import * as Style from "../Style.ts";
import * as Motion from "./Motion.ts";

/** How long a person waits before acting, and how fast they type. */
export interface Pacing {
  readonly expected: Duration.Input;
  readonly surprise: Duration.Input;
  readonly unrelated: Duration.Input;
  /** A word is five characters. */
  readonly wordsPerMinute: number;
}

export const human: Pacing = {
  expected: "280 millis",
  surprise: "600 millis",
  unrelated: "1 second",
  wordsPerMinute: 70,
};

export interface Options {
  readonly pacing?: Pacing | undefined;
  readonly motion?: Motion.Planner | undefined;
}

export type View = Page;

export interface Presenter {
  /** The same public page view for the same page. */
  readonly view: (page: Page) => View;
}

const spread = { expected: 0.3, surprise: 0.4, unrelated: 0.4 };

/** One hand for the scope; input effects keep their page's authority and failure evidence. */
export const make = Effect.fn("Presentation.make")(function* (options: Options = {}) {
  const pacing = options.pacing ?? human;
  const medians = { expected: 0, surprise: 0, unrelated: 0 };

  for (const key of ["expected", "surprise", "unrelated"] as const) {
    const duration = Duration.fromInput(pacing[key]);

    if (
      Option.isNone(duration) ||
      !Duration.isFinite(duration.value) ||
      Duration.isNegative(duration.value)
    )
      return yield* refuse("presentation", "reaction durations must be finite and nonnegative");
    medians[key] = Duration.toMillis(duration.value);
  }
  if (
    !Number.isFinite(pacing.wordsPerMinute) ||
    pacing.wordsPerMinute <= 0 ||
    Style.keyGap(pacing.wordsPerMinute) < 0
  )
    return yield* refuse("presentation", "wordsPerMinute must be positive and at most 1200");

  const pointer = MutableRef.make(Option.none<Point>());
  const hand = yield* Semaphore.make(1);

  const planned = Style.performed({
    pointer,
    motion: options.motion ?? Motion.lognormal,
    wordsPerMinute: pacing.wordsPerMinute,
  });

  const views = new WeakMap<Page, View>();

  let last:
    | {
        readonly page: string;
        readonly document: number;
        readonly clock: Clock.Clock;
        readonly at: number;
      }
    | undefined;

  const view = (page: Page): View => {
    const known = views.get(page);

    if (known !== undefined) return known;
    const now = () => monotonicMillis(page.clock);

    const style: Style.Style = {
      ...planned,
      withInput:
        ({ operation, wait, failFast }) =>
        (effect) =>
          Effect.acquireUseRelease(
            Effect.gen(function* () {
              const asked = now();

              const busy = () =>
                undispatched(
                  operation,
                  new Busy({ waitedMillis: Math.round(now() - asked), ahead: 1 }),
                );

              if (failFast) {
                if (!(yield* hand.takeIfAvailable(1))) return yield* busy();
              } else
                yield* hand
                  .take(1)
                  .pipe(
                    Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(busy()) }),
                  );
            }).pipe(Effect.withSpan("Presentation.hand")),
            () =>
              Effect.gen(function* () {
                const document = (yield* page.state).document;

                const kind =
                  last === undefined || last.page !== page.id || last.clock !== page.clock
                    ? "unrelated"
                    : last.document === document
                      ? "expected"
                      : "surprise";

                const left =
                  (last?.clock === page.clock ? last.at : now()) +
                  (yield* Style.pause(medians[kind], spread[kind])) -
                  now();

                if (left > 0)
                  yield* Effect.sleep(Duration.millis(left)).pipe(
                    Effect.withSpan("Presentation.react"),
                  );

                return yield* effect.pipe(
                  Effect.ensuring(
                    Effect.sync(() => {
                      last = { page: page.id, document, clock: page.clock, at: now() };
                    }),
                  ),
                );
              }),
            () => hand.release(1),
          ),
    };

    const styled = Style.provide(style);
    const perform: Page["perform"] = (action) => styled(page.perform(action));

    const performed: View = {
      ...page,
      ...methods(perform),
      perform,
      goto: page.goto,
      back: page.back,
      reload: page.reload,
    };

    views.set(page, performed);

    return performed;
  };

  return { view } satisfies Presenter;
});
