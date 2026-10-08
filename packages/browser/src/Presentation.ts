/**
 * Input performed for viewers. A presenter owns one drawn pointer and a pace, and `view(page)` is
 * the page with its actions performed: the pointer glides along the motion planner's paths from
 * where viewers last saw it, on whichever page that was; a field is clicked before it is typed
 * into; keys go at the pace's words per minute with overlapping holds; the wheel turns in notches
 * and bursts, and scrolls to a target out of view; and each action first waits as long as a person
 * reacts. The page itself stays plain, so its timing never depends on whether something presents
 * it, and plain input on another page never waits for a view.
 *
 * One view acts at a time, as one hand moves one pointer. The time a view spends showing an action
 * has a budget of its own: the browser's `actionTimeout` bounds only the rest.
 *
 * ```ts
 * const presenter = yield* Presentation.make({ motion: yield* HumanStrokes.motion })
 * const performed = presenter.view(page)
 * yield* performed.aim("e12")    // as the target appears in a streamed tool call
 * yield* performed.click("e12")  // completes the glide, then clicks
 * ```
 *
 * @since 0.3.0
 */
import { Clock, Duration, Effect, Fiber, MutableRef, Option, Semaphore } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import * as Style from "./internal/input/style.ts";
import { type Internals, internalsOf } from "./internal/page/page.ts";
import * as Motion from "./Motion.ts";
import type { Page, Point, Target } from "./Page.ts";

/** How long a person waits before acting, and how fast they type. */
export interface Pacing {
  /** The usual wait before an action that follows an expected change, as the next field of a form. */
  readonly expected: Duration.Input;
  /** The usual wait after the page moved to a new document. */
  readonly surprise: Duration.Input;
  /** The usual wait before a page's first action, or one after an action on another page. */
  readonly unrelated: Duration.Input;
  /** Typing speed, a word being five characters. */
  readonly wordsPerMinute: number;
}

/**
 * The research's medians: 280 ms to react to an expected change, 600 ms to a surprise and 1 second
 * between unrelated actions, each drawn around its median, and typing at 70 words per minute.
 */
export const human: Pacing = {
  expected: "280 millis",
  surprise: "600 millis",
  unrelated: "1 second",
  wordsPerMinute: 70,
};

export interface Options {
  /** Defaults to `human`. */
  readonly pacing?: Pacing | undefined;
  /** The pointer's paths. Defaults to `Motion.lognormal`. */
  readonly motion?: Motion.Service | undefined;
}

/** A page whose actions are performed, which can also start the pointer toward a target early. */
export interface View extends Page {
  /**
   * Start the pointer's glide toward `target` as soon as it is known, as when it appears in a
   * model's streamed tool-call arguments. The view's next action completes the glide: it waits for
   * it when it acts on the same target, and otherwise stops it where it is. An aim presses nothing
   * and records no action; on a page with an input guard it does nothing, as input there waits for
   * approval.
   */
  readonly aim: (target: Target) => Effect.Effect<void>;
}

export interface Presenter {
  /** `page`, a page a `Browser` opened, with its actions performed: the same view for the same page. */
  readonly view: (page: Page) => View;
}

// Reactions spread as the research measured them: an expected change least.
const spread = { expected: 0.3, surprise: 0.4, unrelated: 0.4 };

const sameTarget = (left: Target, right: Target | undefined) =>
  typeof left === "string" || typeof right !== "object"
    ? left === right
    : left.x === right.x && left.y === right.y;

/** A presenter, for the scope: its pointer, its pace and the aims it has started. */
export const make = Effect.fn("Presentation.make")(function* (options: Options = {}) {
  const pacing = options.pacing ?? human;
  const clock = yield* Clock.Clock;
  const scope = yield* Effect.scope;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const pointer = MutableRef.make(Option.none<Point>());
  const hand = yield* Semaphore.make(1);

  const style = Style.performed({
    pointer,
    motion: options.motion ?? Motion.lognormal,
    wordsPerMinute: pacing.wordsPerMinute,
  });

  const medians = {
    expected: Duration.toMillis(Duration.fromInputUnsafe(pacing.expected)),
    surprise: Duration.toMillis(Duration.fromInputUnsafe(pacing.surprise)),
    unrelated: Duration.toMillis(Duration.fromInputUnsafe(pacing.unrelated)),
  };

  // The latest performed action: where, in which document, and when it ended.
  let last: { readonly page: string; readonly document: number; readonly at: number } | undefined;

  // A person reacts to what the last action left: an expected change, a new document, or another
  // page altogether. Time already spent since it ended counts toward the wait.
  const react = (page: Page, internals: Internals) =>
    Effect.gen(function* () {
      const kind =
        last === undefined || last.page !== page.id
          ? "unrelated"
          : last.document === internals.document()
            ? "expected"
            : "surprise";

      const left = (last?.at ?? now()) + (yield* Style.pause(medians[kind], spread[kind])) - now();

      if (left > 0) yield* Effect.sleep(Duration.millis(left));
    }).pipe(Effect.provideService(Clock.Clock, clock));

  const views = new WeakMap<Page, View>();

  const view = (page: Page): View => {
    const known = views.get(page);

    if (known !== undefined) return known;
    const internals = internalsOf(page);

    if (internals === undefined)
      throw new TypeError("only a page that a Browser opened can be presented");
    const { input } = internals;
    let aiming: { readonly target: Target; readonly fiber: Fiber.Fiber<void, BrowserError> } | undefined;

    // An aim at the action's own target is completed; any other is stopped where it is.
    const completeAim = (target: Target | undefined) =>
      Effect.suspend(() => {
        const current = aiming;

        aiming = undefined;
        if (current === undefined) return Effect.void;

        return sameTarget(current.target, target)
          ? Effect.asVoid(Fiber.await(current.fiber))
          : Fiber.interrupt(current.fiber);
      });

    const perform =
      (target: Target | undefined) =>
      <A, E>(action: Effect.Effect<A, E>): Effect.Effect<A, E> =>
        completeAim(target).pipe(
          Effect.andThen(
            hand.withPermits(1)(
              react(page, internals).pipe(
                Effect.andThen(action),
                Effect.ensuring(
                  Effect.sync(() => {
                    last = { page: page.id, document: internals.document(), at: now() };
                  }),
                ),
              ),
            ),
          ),
        );

    const performed: View = {
      ...page,
      click: (target, clickOptions) =>
        perform(target)(input.click(target, clickOptions, style)),
      hover: (target) => perform(target)(input.hover(target, style)),
      drag: (from, to) => perform(from)(input.drag(from, to, style)),
      type: (text, typeOptions) => perform(typeOptions?.into)(input.type(text, typeOptions, style)),
      press: (keys, pressOptions) => perform(undefined)(input.press(keys, pressOptions, style)),
      scroll: (scrollOptions) => perform(scrollOptions?.at)(input.scroll(scrollOptions, style)),
      select: (ref, values) => perform(ref)(input.select(ref, values)),
      aim: (target) =>
        Effect.gen(function* () {
          yield* completeAim(undefined);
          aiming = {
            target,
            fiber: yield* hand
              .withPermits(1)(input.aim(target, style))
              .pipe(Effect.forkIn(scope)),
          };
        }),
    };

    views.set(page, performed);

    return performed;
  };

  return { view } satisfies Presenter;
});
