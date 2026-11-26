/**
 * Input performed for viewers. A presenter owns one pointer and pace. Its public page view applies
 * a style to input after approval, so policy holds leave the hand free. Hand acquisition is bounded
 * by the page's action wait and honours failFast; reactions and input use the page owner's clock.
 * @stability stable
 * @since 0.3.0
 */
import { type Clock, Deferred, Duration, Effect, MutableRef, Option, Semaphore } from "effect";

import { Busy, refuse, undispatched } from "../BrowserError.ts";
import type { ActionAnnounced } from "../BrowserEvent.ts";
import * as InputStyle from "../InputStyle.ts";
import { methods } from "../internal/action-port.ts";
import { monotonicMillis } from "../internal/clock.ts";
import type { Page, Point } from "../Page.ts";
import * as Motion from "./Motion.ts";

/**
 * How long a person waits before acting, and how fast they type.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Pacing {
  readonly expected: Duration.Input;
  readonly surprise: Duration.Input;
  readonly unrelated: Duration.Input;
  /** A word is five characters. */
  readonly wordsPerMinute: number;
}

/**
 * @stability stable
 * @category constants
 * @since 0.3.0
 */
export const human: Pacing = {
  expected: "280 millis",
  surprise: "600 millis",
  unrelated: "1 second",
  wordsPerMinute: 70,
};

/**
 * @stability stable
 * @category options
 * @since 0.3.0
 */
export interface Options {
  readonly pacing?: Pacing | undefined;
  readonly motion?: Motion.Planner | undefined;
  /**
   * After a view's action has announced its target, and before its pointer travels there, wait
   * for this: time for whatever is shown performing the input, such as a character, to arrive. It
   * comes after the reaction's wait, holds the page's turn and spends the action's deadline.
   */
  readonly lead?: ((announced: ActionAnnounced) => Effect.Effect<void>) | undefined;
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type View = Page;

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Presenter {
  /** The same public page view for the same page. */
  readonly view: (page: Page) => View;
}

const spread = { expected: 0.3, surprise: 0.4, unrelated: 0.4 };

/**
 * One hand for the scope; input effects keep their page's authority and failure evidence.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
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
    InputStyle.keyGap(pacing.wordsPerMinute) < 0
  )
    return yield* refuse("presentation", "wordsPerMinute must be positive and at most 1200");

  const pointer = MutableRef.make(Option.none<Point>());
  const hand = yield* Semaphore.make(1);

  const planned = InputStyle.performed({
    pointer,
    motion: options.motion ?? Motion.lognormal,
    wordsPerMinute: pacing.wordsPerMinute,
  });

  const { lead } = options;

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
    const now = () => monotonicMillis(page.hostClock);

    const style: InputStyle.InputStyle = {
      ...planned,
      lead:
        lead === undefined
          ? undefined
          : (announced) => lead(announced).pipe(Effect.withSpan("Presentation.lead")),
      withInput:
        ({ operation, wait, failFast }) =>
        (effect) =>
          Effect.gen(function* () {
            const asked = now();
            const entered = yield* Deferred.make<void>();

            const busy = () =>
              undispatched(
                operation,
                new Busy({ waitedMillis: Math.round(now() - asked), ahead: 1 }),
              );

            const use = Effect.gen(function* () {
              yield* Deferred.succeed(entered, undefined);
              const document = (yield* page.state).document;

              const kind =
                last === undefined || last.page !== page.id || last.clock !== page.hostClock
                  ? "unrelated"
                  : last.document === document
                    ? "expected"
                    : "surprise";

              const left =
                (last?.clock === page.hostClock ? last.at : now()) +
                (yield* InputStyle.pause(medians[kind], spread[kind])) -
                now();

              if (left > 0)
                yield* Effect.sleep(Duration.millis(left)).pipe(
                  Effect.withSpan("Presentation.react"),
                );

              return yield* effect.pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    last = { page: page.id, document, clock: page.hostClock, at: now() };
                  }),
                ),
              );
            });

            if (failFast)
              return yield* hand
                .withPermitsIfAvailable(1)(use)
                .pipe(
                  Effect.flatMap((result) => Effect.fromOption(result).pipe(Effect.mapError(busy))),
                );

            // Only admission has a wait budget. Once admitted, the page owns input's deadline.
            return yield* Effect.raceFirst(
              hand.withPermits(1)(use),
              Deferred.await(entered).pipe(
                Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(busy()) }),
                Effect.andThen(Effect.never),
              ),
            );
          }).pipe(Effect.withSpan("Presentation.hand")),
    };

    const styled = InputStyle.provide(style);
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
