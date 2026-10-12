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
  Context,
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

/** Facts available before an acquisition attempt; awaiting `after` never changes release order. */
export interface Admission {
  readonly number: number;
  /**
   * Every earlier session that stopped serving, including failed attempts and older drains.
   * Waits for all pending releases; an Unconfirmed end remains visible to later attempts.
   * Undefined before any release. A still-serving nonexclusive predecessor is excluded.
   */
  readonly after: Effect.Effect<Lifecycle.Released> | undefined;
}

/**
 * Optional service supplied during `open`. Providers report failed-attempt cleanup here before
 * their scope closes; successful generations instead return `Opened.release`. Reporting does
 * not release resources or replace the original acquisition failure. Terminal `Down` and opening
 * `Closed` states publish the reported outcomes of their own generation's tries.
 */
export class Releasing extends Context.Service<
  Releasing,
  { readonly released: (outcome: Lifecycle.Released) => Effect.Effect<void> }
>()("effect-browser/Supervisor/Releasing") {}

export interface Options<E, R, A = void> {
  /** Opens one generation in the scope it is given. */
  readonly open: Effect.Effect<Opened<A>, E, R>;
  /** Runs before every open attempt, including the first; failures follow `reopen` and `definite`. */
  readonly admit?: ((opening: Admission) => Effect.Effect<void, E, R>) | undefined;
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
  /** Declare this serving generation unusable and revoke it now; stale declarations do nothing. */
  readonly lose: (detail: string) => Effect.Effect<void>;
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
  readonly released: Deferred.Deferred<Lifecycle.Released>;
  readonly scope: Scope.Closeable;
}

type State<A> = Lifecycle.State<Held<A>, Hold>;
type Input<A> = Lifecycle.Input<Held<A>, Hold>;
type Step<A> = Lifecycle.Step<Held<A>, Hold>;
type Apply<A> = (input: Input<A>) => Effect.Effect<Step<A>>;

const superseded = (generation: number, { reason, revokeAt }: Lifecycle.Draining) =>
  new Superseded({ generation, reason, revokeAt });

const retired = () => new Unavailable({ reason: "retired", detail: "the supervisor was retired" });

const describe = (cause: Cause.Cause<unknown>) => {
  const error = Cause.squash(cause);

  return Predicate.isError(error) ? error.message : String(error);
};

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
  clock: Clock.Clock,
  target?: number,
) => {
  const result = (resolution: Lifecycle.Resolution<A>) =>
    resolution._tag === "Serve"
      ? Effect.succeed(resolution.live)
      : Effect.fail(new Unavailable(resolution));

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
  }).pipe(Effect.provideService(Clock.Clock, clock));
};

/** Sleep until `before` ahead of `expiresAt`, but no sooner than halfway there from now. */
const untilRotation = (expiresAt: DateTime.Utc, before: Duration.Duration) =>
  Clock.currentTimeMillis.pipe(
    Effect.flatMap((now) => {
      const left = DateTime.toEpochMillis(expiresAt) - now;

      return Effect.sleep(Duration.millis(Math.max(left - Duration.toMillis(before), left / 2, 0)));
    }),
  );

/** Native timers may wake a fraction early; a revocation must reach its monotonic deadline. */
const until = (at: number, now: () => number): Effect.Effect<void> =>
  Effect.suspend(() =>
    now() >= at
      ? Effect.void
      : Effect.sleep(Duration.millis(Math.ceil(at - now()))).pipe(Effect.andThen(until(at, now))),
  );

/** Borrowed work and transferred scopes hold a generation until cleanup lets it go. */
const leasing = <A>(
  state: SubscriptionRef.SubscriptionRef<State<A>>,
  apply: Apply<A>,
  waitTimeout: Duration.Duration,
  now: () => number,
  clock: Clock.Clock,
) => {
  const borrow = Effect.fnUntraced(function* (hold: Hold, wait: Duration.Duration) {
    const until = now() + Duration.toMillis(wait);

    for (;;) {
      const step = yield* apply({ _tag: "Hold", hold });

      if (step.borrowed !== undefined) return step.borrowed;
      yield* waitFor(state, Duration.millis(Math.max(0, until - now())), clock).pipe(
        Effect.interruptible,
      );
      if (now() >= until) return yield* timedOut();
    }
  });

  const leaseOf = (live: Lifecycle.Live<Held<A>>): Lease<A> => ({
    generation: live.number,
    browser: live.value.opened.browser,
    value: live.value.opened.value,
    lose: (detail) =>
      apply({ _tag: "Lost", number: live.number, cause: "declared", detail }).pipe(Effect.asVoid),
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

        const revoked = Deferred.await(live.value.revoked).pipe(Effect.flatMap(Effect.fail));

        return yield* Effect.raceFirst(
          work(leaseOf(live)).pipe(
            // Declaring loss and returning can finish before the race's other fiber runs.
            Effect.tap(() =>
              Deferred.isDone(live.value.revoked).pipe(
                Effect.flatMap((done) => (done ? revoked : Effect.void)),
              ),
            ),
          ),
          revoked,
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
          released: Deferred.makeUnsafe<Lifecycle.Released>(),
        })),
      ),
    ),
  );

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

// After revocation, retained resources and use finalizers let go before the provider.
const releaseGeneration = Effect.fnUntraced(function* <A>(
  command: Extract<Lifecycle.Command<Held<A>>, { readonly _tag: "Release" | "Leave" }>,
  state: SubscriptionRef.SubscriptionRef<State<A>>,
  apply: Apply<A>,
) {
  const { live } = command;

  const cleaned = yield* Effect.forEach(
    Lifecycle.lookup(state.value, live.number)?.holds ?? [],
    (hold) =>
      Effect.exit(hold._tag === "Retained" ? Scope.close(hold.scope, Exit.void) : Effect.void),
    { concurrency: 8 },
  );

  yield* SubscriptionRef.changes(state).pipe(
    Stream.filter((current) => (Lifecycle.lookup(current, live.number)?.holds.size ?? 0) === 0),
    Stream.runHead,
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
  if (released !== undefined) yield* Deferred.succeed(live.value.released, released);
  yield* Exit.asVoidAll([...cleaned, closed]);
});

const admissionAfter = <A>(state: State<A>) => {
  const released = state.released;

  const pending = [...state.draining.values()]
    .filter((drain) => drain._tag !== "Leaving")
    .map(({ live }) => live.value.released);

  return pending.length === 0 && released === undefined
    ? undefined
    : Effect.gen(function* () {
        let outcome = released;

        for (const release of pending)
          outcome = Lifecycle.combine(outcome, yield* Deferred.await(release));

        return outcome ?? new Lifecycle.Settled();
      });
};

const makeScoped = Effect.fn("Supervisor.make")(function* <E, R, A>(
  options: MakeOptions<E, R, A>,
): Effect.fn.Return<Supervisor<A | void>, never, Scope.Scope | Exclude<R, Scope.Scope>> {
  const clock = yield* Clock.Clock;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const own = yield* Scope.fork(yield* Effect.scope);
  const exclusive = options.exclusive ?? false;

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

  const apply: Apply<A | void> = Effect.fnUntraced(
    function* (input: Input<A | void>) {
      const current = state.value;
      const step = Lifecycle.transition(current, input, exclusive, now(), handover);

      if (step.state !== current) yield* SubscriptionRef.set(state, step.state);
      yield* perform(step);

      return step;
    },
    (effect) => applying.withPermit(effect),
    Effect.uninterruptible,
    Effect.provideService(Clock.Clock, clock),
  );

  const perform = Effect.fnUntraced(function* (step: Step<A | void>): Effect.fn.Return<void> {
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
          runOpen(openGeneration(command.number));
          break;
        case "Watch":
          yield* Effect.forkIn(
            Effect.provideContext(watchGeneration(command.live, rotateBefore, apply), context),
            command.live.value.scope,
          );
          break;
        case "Drain": {
          const ending = superseded(command.live.number, command.ending);

          yield* Deferred.succeed(command.live.value.ending, ending);
          yield* Effect.forkIn(
            until(ending.revokeAt, now).pipe(
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
          yield* Deferred.succeed(
            command.live.value.revoked,
            superseded(command.live.number, command.ending),
          );
          runRelease(command.live.number, releaseGeneration(command, state, apply));
          break;
      }
  });

  const openGeneration = (number: number) => {
    const openOnce = acquireGeneration(
      Effect.gen(function* () {
        const after = admissionAfter(state.value);

        if (exclusive && after !== undefined) yield* after;
        yield* options.admit?.({ number, after }) ?? Effect.void;

        return yield* options.open.pipe(
          Effect.provideService(Releasing, {
            released: (released) =>
              apply({ _tag: "AttemptReleased", number, released }).pipe(Effect.asVoid),
          }),
        );
      }),
      own,
    ).pipe(Effect.provideContext(context));

    return Effect.uninterruptibleMask((restore) =>
      restore(
        Effect.retry(openOnce, {
          schedule: reopen,
          while: (error) => !options.definite?.(error),
        }),
      ).pipe(
        Effect.exit,
        Effect.flatMap((exit) => {
          if (Exit.isSuccess(exit))
            return apply({ _tag: "Opened", live: { number, value: exit.value } });
          const cause = exit.cause;

          return apply(
            Cause.hasInterruptsOnly(cause)
              ? { _tag: "Abandoned", number }
              : { _tag: "Failed", number, detail: describe(cause), cause: Cause.squash(cause) },
          );
        }),
      ),
    );
  };

  const end = yield* Effect.cached(PubSub.publish(events, Exit.void));

  const stop = Effect.fnUntraced(function* (input: Input<A | void>) {
    yield* apply(input);
    yield* FiberHandle.clear(opening);
    yield* FiberMap.awaitEmpty(releases);
    if (yield* Deferred.isDone(releases.deferred)) yield* FiberMap.join(releases);
  }, Effect.ensuring(end));

  const retire = yield* Effect.cached(stop({ _tag: "Retire" }));

  // The browser of the generation serving, or of the one `target` names once it serves.
  const browserOf = (target?: number) =>
    Effect.map(waitFor(state, waitTimeout, clock, target), (live) => live.value.opened.browser);

  yield* Effect.addFinalizer(() => (options.keep === true ? stop({ _tag: "Keep" }) : retire));
  yield* perform(started);

  return {
    browser: browserOf(),
    use: leasing(state, apply, waitTimeout, now, clock),
    states: Stream.fromPubSubTake(events),
    rotate: apply({ _tag: "Rotate" }).pipe(
      Effect.flatMap(({ reply }) =>
        reply === undefined ? Effect.fail(retired()) : browserOf(reply),
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
