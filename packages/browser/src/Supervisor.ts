/**
 * A browser kept open across losses and session ends, as a series of generations, each a new
 * browser from the same provider. Pages don't carry over from one generation to the next.
 *
 * `make` opens the first generation at once with the provider's `open`, in a scope of its own, so
 * a caller that stops waiting never interrupts a half-open browser. `browser` gives the current
 * generation; callers wait, bounded, and share one open. A loss is published at once and the next
 * generation opens on the `reopen` schedule, which also retries a failed open, unless the provider
 * deems its failure `definite`: that goes `Down` at once, with its cause. `rotate` opens the
 * next generation now, and so does the time `rotateBefore` ahead of a generation's `expiresAt`. A
 * rotation makes the next generation before it breaks the current one, unless generations are
 * `exclusive`, as sessions saving to one stored context must be: then the current one is released
 * first. `retire` stops reopening at once and releases what is open; the scope's close retires
 * too. `states` publishes each generation's changes, with the provider's release outcome last.
 *
 * Providers supply the specifics: `Browserbase.supervise` opens hosted sessions this way.
 *
 * @since 0.3.0
 */
import {
  Cause,
  Clock,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FiberHandle,
  FiberMap,
  Option,
  Predicate,
  PubSub,
  Schedule,
  Schema,
  Scope,
  Stream,
  SubscriptionRef,
  type Take,
} from "effect";

import type * as Browser from "./Browser.ts";
import * as Lifecycle from "./internal/supervisor/lifecycle.ts";

export {
  Closed,
  Down,
  GenerationState,
  Lost,
  Open,
  Opening,
  Released,
  Reopening,
  Settled,
  Unconfirmed,
} from "./internal/supervisor/lifecycle.ts";

/** One change in a generation's life. `at` is wall-clock epoch milliseconds from the Effect `Clock`. */
export class Generation extends Schema.Class<Generation>("effect-browser/Generation")({
  number: Schema.Int.check(Schema.isGreaterThan(0)),
  at: Schema.Finite,
  state: Lifecycle.GenerationState,
}) {}

/**
 * No browser to give: none opened within `waitTimeout` (`opening`), the latest generation failed
 * to open (`down`, with what it failed with as `cause`), or the supervisor was retired.
 */
export class Unavailable extends Schema.TaggedError<Unavailable>()("Unavailable", {
  reason: Schema.Literals(["opening", "down", "retired"]),
  detail: Schema.String,
  cause: Schema.optional(Schema.Defect()),
}) {
  override get message() {
    return `no browser: ${this.detail}`;
  }
}

/** One generation, as a provider opened it in the scope the supervisor gave it. */
export interface Opened {
  readonly browser: Browser.Service;
  /** When the provider ends it on its own, such as a hosted session's timeout. */
  readonly expiresAt?: DateTime.Utc | undefined;
  /**
   * Whether the provider confirmed its end. The supervisor asks once it has closed the
   * generation's scope; without it, a closed scope counts as `Settled`.
   */
  readonly release?: Effect.Effect<Lifecycle.Released> | undefined;
}

export interface Options<E, R> {
  /** Opens one generation in the scope it is given. */
  readonly open: Effect.Effect<Opened, E, R>;
  /** When to try a failed open again. Defaults to exponential from 1 second, for 5 minutes. */
  readonly reopen?: Schedule.Schedule<unknown, E> | undefined;
  /**
   * Failures no new try mends, such as a refused key: an open that fails so is `Down` at once.
   * Defaults to none.
   */
  readonly definite?: ((error: E) => boolean) | undefined;
  /**
   * Rotate this long ahead of a generation's `expiresAt`, but no sooner than halfway through its
   * life. Without it, a generation's end is a loss.
   */
  readonly rotateBefore?: Duration.Input | undefined;
  /** Generations must not overlap: a rotation releases the current one before it opens the next. */
  readonly exclusive?: boolean | undefined;
  /** How long `browser` and `rotate` wait for a generation to open. Defaults to 2 minutes. */
  readonly waitTimeout?: Duration.Input | undefined;
}

export interface Supervisor {
  /** The current generation's browser, waiting up to `waitTimeout` while none is open. */
  readonly browser: Effect.Effect<Browser.Service, Unavailable>;
  /** Each generation's changes, in order. A new reader first gets the latest 64; ends on retiring. */
  readonly states: Stream.Stream<Generation>;
  /** Open the next generation now, or join the one opening, and wait for it. */
  readonly rotate: Effect.Effect<Browser.Service, Unavailable>;
  /** Stop opening at once, release every generation, and wait until each release has finished. */
  readonly retire: Effect.Effect<void>;
}

interface Held {
  readonly opened: Opened;
  readonly scope: Scope.Closeable;
}

/**
 * Completes when a browser is lost to its owner: its connection dropped, or the other side closed
 * it. Playwright reports both as the context closing, including when our own scope closes it.
 */
const lost = (browser: Browser.Service) =>
  Effect.callback<void>((resume) => {
    const done = () => resume(Effect.void);

    if (browser.context.browser()?.isConnected() === false) return done();
    browser.context.once("close", done);

    return Effect.sync(() => browser.context.off("close", done));
  });

const retired = () => new Unavailable({ reason: "retired", detail: "the supervisor was retired" });

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  return Predicate.isError(error) ? error.message : String(error);
};

/**
 * Wait up to `waitTimeout` for generation `target`, or for any when it is undefined, as `state`
 * changes.
 */
const waitFor = <A extends { readonly opened: Opened }>(
  state: SubscriptionRef.SubscriptionRef<Lifecycle.State<A>>,
  waitTimeout: Duration.Duration,
  target: number | undefined,
) =>
  SubscriptionRef.changes(state).pipe(
    Stream.map((current) => Lifecycle.resolve(current, target)),
    Stream.filter(Predicate.isNotUndefined),
    Stream.runHead,
    // The state's changes never end, so the first resolution always comes.
    Effect.flatMap(
      Option.match({
        onNone: () => Effect.fail(retired()),
        onSome: (resolution) =>
          resolution._tag === "Serve"
            ? Effect.succeed(resolution.live.value.opened.browser)
            : Effect.fail(
                new Unavailable({
                  reason: resolution.reason,
                  detail: resolution.detail,
                  cause: resolution.cause,
                }),
              ),
      }),
    ),
    Effect.timeoutOrElse({
      duration: waitTimeout,
      orElse: () =>
        Effect.fail(
          new Unavailable({
            reason: "opening",
            detail: `no generation opened within ${Duration.format(waitTimeout)}`,
          }),
        ),
    }),
  );

/** Sleep until `before` ahead of `expiresAt`, but no sooner than halfway there from now. */
const untilRotation = (expiresAt: DateTime.Utc, before: Duration.Duration) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const left = DateTime.toEpochMillis(expiresAt) - now;

      return Effect.sleep(Duration.millis(Math.max(left - Duration.toMillis(before), left / 2, 0)));
    }),
  );

/** Supervise generations of a provider's browser for as long as the scope is open. */
export const make = Effect.fn("Supervisor.make")(function* <E, R>(
  options: Options<E, R>,
): Effect.fn.Return<Supervisor, never, Scope.Scope | Exclude<R, Scope.Scope>> {
  const clock = yield* Clock.Clock;
  const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const own = yield* Scope.fork(yield* Effect.scope);
  const exclusive = options.exclusive ?? false;
  const definite = options.definite ?? (() => false);

  const reopen: Schedule.Schedule<unknown, E> =
    options.reopen ??
    Schedule.exponential("1 second").pipe(Schedule.upTo({ duration: Duration.minutes(5) }));

  const rotateBefore =
    options.rotateBefore === undefined ? undefined : Duration.fromInputUnsafe(options.rotateBefore);

  const waitTimeout = Duration.fromInputUnsafe(options.waitTimeout ?? Duration.minutes(2));
  const started = Lifecycle.start<Held>();
  const state = yield* SubscriptionRef.make(started.state);
  const events = yield* PubSub.unbounded<Take.Take<Generation>>({ replay: 64 });
  const opening = yield* FiberHandle.make<unknown, never>();
  const releases = yield* FiberMap.make<number, unknown, never>();
  const runOpen = yield* FiberHandle.runtime(opening)();
  const runRelease = yield* FiberMap.runtime(releases)();

  // Each input changes the state under one lock, which also publishes its events and starts its
  // work, so neither can be reordered against another input's.
  const apply = (input: Lifecycle.Input<Held>): Effect.Effect<number | undefined> =>
    SubscriptionRef.modifyEffect(state, (current) => {
      const step = Lifecycle.transition(current, input, exclusive);

      return Effect.as(perform(step), [step.reply, step.state] as const);
    }).pipe(Effect.uninterruptible);

  const perform = (step: Lifecycle.Step<Held>) =>
    Effect.gen(function* () {
      for (const [number, generation] of step.events)
        PubSub.publishUnsafe(events, [
          new Generation({ number, at: clock.currentTimeMillisUnsafe(), state: generation }),
        ]);
      for (const command of step.commands)
        switch (command._tag) {
          case "Open":
            runOpen(openGeneration(command.number, command.after));
            break;
          case "Watch":
            yield* Effect.forkIn(
              Effect.provideContext(watch(command.live), context),
              command.live.value.scope,
            );
            break;
          case "Release":
            runRelease(command.live.number, release(command.live));
        }
    });

  const openOnce = Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Scope.fork(own), (scope) =>
      restore(options.open.pipe(Scope.provide(scope), Effect.provideContext(context))).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        Effect.map((opened): Held => ({ opened, scope })),
      ),
    ),
  );

  // Retiring interrupts the open between tries or during one; the provider releases what an
  // interrupted try had made, as its scope closes.
  const openGeneration = (number: number, after: number | undefined) =>
    Effect.uninterruptibleMask((restore) => {
      const previous =
        after === undefined
          ? Effect.void
          : FiberMap.get(releases, after).pipe(
              Effect.flatMap(Option.match({ onNone: () => Effect.void, onSome: Fiber.await })),
            );

      const tries = Effect.retry(openOnce, {
        schedule: reopen,
        while: (error) => !definite(error),
      });

      return restore(previous.pipe(Effect.andThen(tries))).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit))
            return apply({ _tag: "Opened", live: { number, value: exit.value } });

          return Cause.hasInterruptsOnly(exit.cause)
            ? apply({ _tag: "Abandoned", number })
            : apply({
                _tag: "Failed",
                number,
                detail: describe(exit.cause),
                cause: Cause.squash(exit.cause),
              });
        }),
      );
    });

  const watch = (live: Lifecycle.Live<Held>) => {
    const { browser, expiresAt } = live.value.opened;
    const loss = lost(browser).pipe(Effect.andThen(apply({ _tag: "Lost", number: live.number })));

    const rotation =
      expiresAt === undefined || rotateBefore === undefined
        ? Effect.void
        : untilRotation(expiresAt, rotateBefore).pipe(
            Effect.andThen(apply({ _tag: "Rotate", due: live.number })),
          );

    return Effect.all([loss, rotation], { concurrency: 2, discard: true });
  };

  const release = (live: Lifecycle.Live<Held>) =>
    Scope.close(live.value.scope, Exit.void).pipe(
      Effect.andThen(live.value.opened.release ?? Effect.succeed(new Lifecycle.Settled())),
      Effect.catchCause((cause) =>
        Effect.succeed(
          new Lifecycle.Unconfirmed({ detail: `the release failed: ${describe(cause)}` }),
        ),
      ),
      Effect.flatMap((released) => apply({ _tag: "Released", number: live.number, released })),
    );

  const retire = yield* Effect.cached(
    apply({ _tag: "Retire" }).pipe(
      Effect.andThen(FiberHandle.clear(opening)),
      Effect.andThen(FiberMap.awaitEmpty(releases)),
      Effect.andThen(PubSub.publish(events, Exit.void)),
      Effect.asVoid,
    ),
  );

  yield* Effect.addFinalizer(() => retire);
  yield* perform(started);

  return {
    browser: waitFor(state, waitTimeout, undefined),
    states: Stream.fromPubSubTake(events),
    rotate: apply({ _tag: "Rotate" }).pipe(
      Effect.flatMap((target) =>
        target === undefined ? Effect.fail(retired()) : waitFor(state, waitTimeout, target),
      ),
    ),
    retire,
  } satisfies Supervisor;
});
