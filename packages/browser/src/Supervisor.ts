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
 * too, unless the supervisor `keep`s: then it leaves the serving generation running, `Kept`. `states`
 * publishes each generation's changes, with the provider's release outcome last.
 *
 * Providers supply the specifics: `Browserbase.supervise` opens hosted sessions this way.
 *
 * @since 0.3.0
 */
import {
  Cause,
  Clock,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  FiberHandle,
  FiberMap,
  Option,
  Predicate,
  PubSub,
  Schedule,
  Schema,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
  type Take,
} from "effect";

import type * as Browser from "./Browser.ts";
import * as Lifecycle from "./internal/supervisor/lifecycle.ts";

export {
  Closed,
  Down,
  Draining,
  GenerationState,
  Kept,
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
  hostTime: Schema.Finite,
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
export interface Opened<A = void> {
  readonly value: A;
  readonly browser: Browser.Service;
  /**
   * End the generation, and say whether the provider confirmed its end. The supervisor asks it
   * before it closes the generation's scope; without it, closing the scope ends the generation,
   * which counts as `Settled`.
   */
  readonly release?: Effect.Effect<Lifecycle.Released> | undefined;
}

export interface Options<E, R, A = void> {
  /** Opens one generation in the scope it is given. */
  readonly open: Effect.Effect<Opened<A>, E, R>;
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
  /** Finite, nonnegative time outgoing holds may finish; defaults to 30 seconds. */
  readonly handover?: Duration.Input | undefined;
  /**
   * Closing the scope leaves the serving generation running, `Kept`: it closes the generation's
   * scope but never asks `release`. For providers whose scope only disconnects, such as
   * `Browserbase.supervise` with `keep`. `retire` still releases it.
   */
  readonly keep?: boolean | undefined;
  /** How long `browser` and `rotate` wait for a generation to open. Defaults to 2 minutes. */
  readonly waitTimeout?: Duration.Input | undefined;
}

/** Work whose generation was revoked; input receipts still determine whether input reached a site. */
export class Superseded extends Schema.TaggedError<Superseded>()("Superseded", {
  generation: Schema.Int,
  reason: Schema.Literals(["rotated", "lost", "retired"]),
  revokeAt: Schema.Finite,
}) {}

export interface Lease<A> {
  readonly generation: number;
  readonly browser: Browser.Service;
  readonly value: A;
  /** First notice that serving ended; loss or retirement may revoke before its deadline. */
  readonly ending: Effect.Effect<Superseded>;
  /** An independent scope; its resources close before provider release. Fails once revoked. */
  readonly retain: Effect.Effect<Scope.Closeable, Superseded>;
}

export interface UseOptions {
  /** Finite, nonnegative wait for a serving generation. Zero makes an immediate attempt. */
  readonly wait?: Duration.Input | undefined;
}

export interface Supervisor<A = void> {
  /** Scoped work on the current generation. Revocation interrupts it and waits for its cleanup. */
  readonly use: <B, E, R>(
    work: (lease: Lease<A>) => Effect.Effect<B, E, R>,
    options?: UseOptions,
  ) => Effect.Effect<B, E | Unavailable | Superseded, Exclude<R, Scope.Scope>>;
  /** The current generation's browser, waiting up to `waitTimeout` while none is open. */
  readonly browser: Effect.Effect<Browser.Service, Unavailable>;
  /** Each generation's changes, in order. A new reader first gets the latest 64; ends on retiring. */
  readonly states: Stream.Stream<Generation>;
  /** Open the next generation now, or join the one opening, and wait for it. */
  readonly rotate: Effect.Effect<Browser.Service, Unavailable>;
  /** Stop opening at once, release every generation, and wait until each release has finished. */
  readonly retire: Effect.Effect<void>;
}

type Hold =
  | { readonly _tag: "Use" }
  | { readonly _tag: "Retained"; readonly scope: Scope.Closeable };

interface Held<A> {
  readonly opened: Opened<A>;
  readonly ending: Deferred.Deferred<Superseded>;
  readonly revoked: Deferred.Deferred<Superseded>;
  readonly scope: Scope.Closeable;
}

type State<A> = Lifecycle.State<Held<A>, Hold>;
type Apply<A> = (
  input: Lifecycle.Input<Held<A>, Hold>,
) => Effect.Effect<Lifecycle.Step<Held<A>, Hold>>;

const retired = () => new Unavailable({ reason: "retired", detail: "the supervisor was retired" });

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  return Predicate.isError(error) ? error.message : String(error);
};

const unavailable = (
  resolution: Extract<Lifecycle.Resolution<unknown>, { readonly _tag: "Unavailable" }>,
) =>
  new Unavailable({
    reason: resolution.reason,
    detail: resolution.detail,
    cause: resolution.cause,
  });

const timedOut = () =>
  new Unavailable({ reason: "opening", detail: "no generation opened within the wait" });

const bounded = (input: Duration.Input, name: string) =>
  Effect.suspend(() => {
    const duration = Duration.fromInput(input);

    return Option.isSome(duration) &&
      Duration.isFinite(duration.value) &&
      !Duration.isNegative(duration.value)
      ? Effect.succeed(duration.value)
      : Effect.die(new RangeError(`${name} must be a finite nonnegative duration`));
  });

/** Resolve immediately before starting a bounded wait, including when its duration is zero. */
const waitFor = <A, H>(
  state: SubscriptionRef.SubscriptionRef<Lifecycle.State<A, H>>,
  wait: Duration.Duration,
  target?: number,
) => {
  const result = (resolution: Lifecycle.Resolution<A>) =>
    resolution._tag === "Serve"
      ? Effect.succeed(resolution.live)
      : Effect.fail(unavailable(resolution));

  return Effect.suspend(() => {
    const current = Lifecycle.resolve(state.value, target);

    return current === undefined
      ? SubscriptionRef.changes(state).pipe(
          Stream.map((state) => Lifecycle.resolve(state, target)),
          Stream.filter(Predicate.isNotUndefined),
          Stream.runHead,
          Effect.flatMap(Option.match({ onNone: () => Effect.fail(retired()), onSome: result })),
          Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(timedOut()) }),
        )
      : result(current);
  });
};

/** Sleep until `before` ahead of `expiresAt`, but no sooner than halfway there from now. */
const untilRotation = (expiresAt: DateTime.Utc, before: Duration.Duration) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const left = DateTime.toEpochMillis(expiresAt) - now;

      return Effect.sleep(Duration.millis(Math.max(left - Duration.toMillis(before), left / 2, 0)));
    }),
  );

/** Borrowed work and transferred scopes hold a generation until cleanup lets it go. */
const leasing = <A>(
  state: SubscriptionRef.SubscriptionRef<State<A>>,
  apply: Apply<A>,
  waitTimeout: Duration.Duration,
  now: () => number,
) => {
  const borrow = (hold: Hold, wait: Duration.Duration) =>
    Effect.gen(function* () {
      const until = now() + Duration.toMillis(wait);

      for (;;) {
        const step = yield* apply({ _tag: "Hold", hold });

        if (step.borrowed !== undefined) return step.borrowed;
        yield* waitFor(state, Duration.millis(Math.max(0, until - now()))).pipe(
          Effect.interruptible,
        );
        if (now() >= until) return yield* timedOut();
      }
    });

  const leaseOf = (live: Lifecycle.Live<Held<A>>): Lease<A> => ({
    generation: live.number,
    browser: live.value.opened.browser,
    value: live.value.opened.value,
    ending: Deferred.await(live.value.ending),
    retain: Effect.uninterruptible(
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const hold: Hold = { _tag: "Retained", scope };
        const step = yield* apply({ _tag: "Hold", number: live.number, hold });

        if (step.borrowed === undefined) {
          yield* Scope.close(scope, Exit.void);

          return yield* yield* Deferred.await(live.value.ending);
        }
        yield* Scope.addFinalizer(
          scope,
          apply({ _tag: "Let", number: live.number, hold }).pipe(Effect.asVoid),
        );

        return scope;
      }),
    ),
  });

  const use: Supervisor<A>["use"] = (work, options = {}) =>
    Effect.scoped(
      Effect.gen(function* () {
        const hold: Hold = { _tag: "Use" };
        const wait = yield* bounded(options.wait ?? waitTimeout, "wait");

        const live = yield* Effect.acquireRelease(borrow(hold, wait), (live) =>
          apply({ _tag: "Let", number: live.number, hold }).pipe(Effect.asVoid),
        );

        return yield* Effect.raceFirst(
          work(leaseOf(live)),
          Deferred.await(live.value.revoked).pipe(Effect.flatMap(Effect.fail)),
        );
      }),
    );

  return use;
};

type Provider = Omit<Opened, "value">;
type MakeOptions<E, R, A> = Omit<Options<E, R, A>, "open"> & {
  readonly open: Effect.Effect<Opened<A> | Provider, E, R>;
};

const acquireGeneration = <A, E, R>(
  open: Effect.Effect<Opened<A> | Provider, E, R>,
  own: Scope.Scope,
) =>
  Effect.uninterruptibleMask((restore) =>
    Effect.flatMap(Scope.fork(own), (scope) =>
      restore(open.pipe(Scope.provide(scope))).pipe(
        Effect.onError((cause) => Scope.close(scope, Exit.failCause(cause))),
        Effect.map((opened): Held<A | void> => ({
          opened: { ...opened, value: "value" in opened ? opened.value : undefined },
          scope,
          ending: Deferred.makeUnsafe<Superseded>(),
          revoked: Deferred.makeUnsafe<Superseded>(),
        })),
      ),
    ),
  );

const changedUntil = <A>(
  state: SubscriptionRef.SubscriptionRef<State<A>>,
  predicate: (current: State<A>) => boolean,
) => SubscriptionRef.changes(state).pipe(Stream.filter(predicate), Stream.runHead, Effect.asVoid);

const watchGeneration = <A>(
  live: Lifecycle.Live<Held<A>>,
  rotateBefore: Duration.Duration | undefined,
  apply: Apply<A>,
) => {
  const { browser } = live.value.opened;

  const loss = browser.disconnected.pipe(
    Effect.flatMap((cause) => apply({ _tag: "Lost", number: live.number, cause })),
  );

  const rotation =
    browser.expiresAt === undefined || rotateBefore === undefined
      ? Effect.void
      : untilRotation(browser.expiresAt, rotateBefore).pipe(
          Effect.andThen(apply({ _tag: "Rotate", due: live.number })),
        );

  return Effect.all([loss, rotation], { concurrency: 2, discard: true });
};

// Revocation stops use work; retained resources and use finalizers let go before the provider.
const releaseGeneration = <A>(
  command: Extract<Lifecycle.Command<Held<A>>, { readonly _tag: "Release" | "Leave" }>,
  state: SubscriptionRef.SubscriptionRef<State<A>>,
  apply: Apply<A>,
) =>
  Effect.gen(function* () {
    const { live, ending } = command;

    yield* Deferred.succeed(
      live.value.revoked,
      new Superseded({
        generation: live.number,
        reason: ending.reason,
        revokeAt: ending.revokeAt,
      }),
    );
    const holds = Lifecycle.lookup(state.value, live.number)?.holds ?? [];

    const cleaned = yield* Effect.forEach(
      holds,
      (hold) =>
        Effect.exit(hold._tag === "Retained" ? Scope.close(hold.scope, Exit.void) : Effect.void),
      { concurrency: 8 },
    );

    yield* changedUntil(
      state,
      (current) => (Lifecycle.lookup(current, live.number)?.holds.size ?? 0) === 0,
    );

    const released =
      command._tag === "Leave"
        ? undefined
        : yield* (live.value.opened.release ?? Effect.succeed(new Lifecycle.Settled())).pipe(
            Effect.catchCause((cause) =>
              Effect.succeed(
                new Lifecycle.Unconfirmed({ detail: `the release failed: ${describe(cause)}` }),
              ),
            ),
          );

    const closed = yield* Effect.exit(Scope.close(live.value.scope, Exit.void));

    yield* apply({ _tag: "Released", number: live.number, released });
    yield* Exit.asVoidAll([...cleaned, closed]);
  });

const makeScoped = Effect.fn("Supervisor.make")(function* <E, R, A>(
  options: MakeOptions<E, R, A>,
): Effect.fn.Return<Supervisor<A | void>, never, Scope.Scope | Exclude<R, Scope.Scope>> {
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const own = yield* Scope.fork(yield* Effect.scope);
  const exclusive = options.exclusive ?? false;
  const definite = options.definite ?? (() => false);

  const reopen: Schedule.Schedule<unknown, E> =
    options.reopen ??
    Schedule.exponential("1 second").pipe(Schedule.upTo({ duration: Duration.minutes(5) }));

  const rotateBefore =
    options.rotateBefore === undefined ? undefined : Duration.fromInputUnsafe(options.rotateBefore);

  const waitTimeout = yield* bounded(options.waitTimeout ?? Duration.minutes(2), "waitTimeout");

  const handover = Duration.toMillis(
    yield* bounded(options.handover ?? Duration.seconds(30), "handover"),
  );

  const started = Lifecycle.start<Held<A | void>, Hold>();
  const state = yield* SubscriptionRef.make(started.state);
  const applying = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<Take.Take<Generation>>({ replay: 64 });
  const opening = yield* FiberHandle.make<unknown, never>();
  const releases = yield* FiberMap.make<number, unknown, never>();
  const runOpen = yield* FiberHandle.runtime(opening)();
  const runRelease = yield* FiberMap.runtime(releases)();

  const apply = (
    input: Lifecycle.Input<Held<A | void>, Hold>,
  ): Effect.Effect<Lifecycle.Step<Held<A | void>, Hold>> =>
    applying
      .withPermit(
        Effect.gen(function* () {
          const current = state.value;
          const step = Lifecycle.transition(current, input, exclusive, now(), handover);

          if (step.state !== current) yield* SubscriptionRef.set(state, step.state);
          yield* perform(step);

          return step;
        }),
      )
      .pipe(Effect.uninterruptible);

  const perform = (step: Lifecycle.Step<Held<A | void>, Hold>): Effect.Effect<void> =>
    Effect.gen(function* () {
      for (const [number, generation] of step.events)
        PubSub.publishUnsafe(events, [
          new Generation({
            number,
            at: clock.currentTimeMillisUnsafe(),
            hostTime: now(),
            state: generation,
          }),
        ]);
      for (const command of step.commands)
        switch (command._tag) {
          case "Open":
            runOpen(openGeneration(command.number, command.after));
            break;
          case "Watch":
            yield* Effect.forkIn(
              Effect.provideContext(watchGeneration(command.live, rotateBefore, apply), context),
              command.live.value.scope,
            );
            break;
          case "Drain": {
            const ending = new Superseded({
              generation: command.live.number,
              reason: command.ending.reason,
              revokeAt: command.ending.revokeAt,
            });

            yield* Deferred.succeed(command.live.value.ending, ending);
            yield* Effect.forkIn(
              Effect.sleep(Duration.millis(Math.max(0, ending.revokeAt - now()))).pipe(
                Effect.andThen(
                  Effect.suspend(() => apply({ _tag: "Revoke", number: command.live.number })),
                ),
              ),
              command.live.value.scope,
            );
            break;
          }
          case "Release":
          case "Leave":
            runRelease(command.live.number, releaseGeneration(command, state, apply));
            break;
        }
    });

  const openOnce = acquireGeneration(options.open, own).pipe(Effect.provideContext(context));

  const openGeneration = (number: number, after: number | undefined) =>
    Effect.uninterruptibleMask((restore) =>
      restore(
        (after === undefined
          ? Effect.void
          : changedUntil(state, (current) => !current.draining.has(after))
        ).pipe(
          Effect.andThen(
            Effect.retry(openOnce, { schedule: reopen, while: (error) => !definite(error) }),
          ),
        ),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) =>
          Exit.isSuccess(exit)
            ? apply({ _tag: "Opened", live: { number, value: exit.value } })
            : Cause.hasInterruptsOnly(exit.cause)
              ? apply({ _tag: "Abandoned", number })
              : apply({
                  _tag: "Failed",
                  number,
                  detail: describe(exit.cause),
                  cause: Cause.squash(exit.cause),
                }),
        ),
      ),
    );

  const use = leasing(state, apply, waitTimeout, now);

  const end = yield* Effect.cached(PubSub.publish(events, Exit.void));

  const stop = (input: Lifecycle.Input<Held<A | void>, Hold>) =>
    apply(input).pipe(
      Effect.andThen(FiberHandle.clear(opening)),
      Effect.andThen(FiberMap.awaitEmpty(releases)),
      Effect.andThen(
        Effect.suspend(() =>
          Deferred.isDone(releases.deferred).pipe(
            Effect.flatMap((failed) => (failed ? FiberMap.join(releases) : Effect.void)),
          ),
        ),
      ),
      Effect.ensuring(end),
      Effect.asVoid,
    );

  const retire = yield* Effect.cached(stop({ _tag: "Retire" }));

  yield* Effect.addFinalizer(() => (options.keep === true ? stop({ _tag: "Keep" }) : retire));
  yield* perform(started);

  return {
    browser: Effect.map(waitFor(state, waitTimeout), (live) => live.value.opened.browser),
    use,
    states: Stream.fromPubSubTake(events),
    rotate: apply({ _tag: "Rotate" }).pipe(
      Effect.flatMap(({ reply }) =>
        reply === undefined
          ? Effect.fail(retired())
          : Effect.map(waitFor(state, waitTimeout, reply), (live) => live.value.opened.browser),
      ),
    ),
    retire,
  };
});

/** Supervise scoped generation values. Browser-only providers retain their existing void value. */
export function make<E, R, A = void>(
  options: Options<E, R, A>,
): Effect.Effect<Supervisor<A>, never, Scope.Scope | Exclude<R, Scope.Scope>>;

export function make<E, R>(
  options: MakeOptions<E, R, never>,
): Effect.Effect<Supervisor<void>, never, Scope.Scope | Exclude<R, Scope.Scope>>;

export function make<E, R, A>(options: MakeOptions<E, R, A>) {
  return makeScoped(options);
}
