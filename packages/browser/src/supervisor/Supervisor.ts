/**
 * A resource kept serving through typed acquisition failures, loss and rotation.
 * `make` adds its finalizer directly to its caller's scope. Each generation has its own scope;
 * its loss signal remains watched until that scope closes, after release. Optional policies
 * compose by wrapping `open`, `release` and the public generation stream.
 *
 * @stability stable
 * @since 0.3.0
 */
import {
  Clock,
  Context,
  Deferred,
  Effect,
  Exit,
  FiberSet,
  Option,
  PubSub,
  Scope,
  Semaphore,
  Stream,
  SubscriptionRef,
  type Take,
  Tracer,
} from "effect";

import {
  type Generation,
  type Options,
  type Supervisor,
  Unavailable,
} from "./internal/contract.ts";
import * as Lifecycle from "./internal/lifecycle.ts";
import {
  type Apply,
  type Hold,
  type Runtime,
  leasing,
  opening,
  releasing,
} from "./internal/runtime.ts";

export {
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  type Generation,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  InvalidWait,
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  type Lease,
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  type Opened,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  type Options,
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  type State,
  /**
   * @stability stable
   * @category models
   * @since 0.3.0
   */
  type Supervisor,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  Superseded,
  /**
   * @stability stable
   * @category errors
   * @since 0.3.0
   */
  Unavailable,
  /**
   * @stability stable
   * @category options
   * @since 0.3.0
   */
  type UseOptions,
  /**
   * @stability stable
   * @category schemas
   * @since 0.3.0
   */
  StopReason,
} from "./internal/contract.ts";

/**
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make = Effect.fn("Supervisor.make")(function* <A, E, R>(
  options: Options<A, E, R>,
): Effect.fn.Return<Supervisor<A, E>, never, Scope.Scope | Exclude<R, Scope.Scope>> {
  const clock = yield* Clock.Clock;
  // The caller span survives as a link, never as the parent of a later generation.
  const context = Context.omit(Tracer.ParentSpan)(yield* Effect.context<Exclude<R, Scope.Scope>>());
  const parent = yield* Effect.serviceOption(Tracer.ParentSpan);
  const links = Option.isSome(parent) ? [{ span: parent.value, attributes: {} }] : [];
  // A parallel caller scope must not close workers alongside retirement.
  const own = yield* Scope.make();
  const started = Lifecycle.start<Runtime<A>, Hold, E>();
  const state = yield* SubscriptionRef.make(started.state);
  const permit = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<Take.Take<Generation<E>>>({ replay: 64 });
  const fibers = yield* FiberSet.make().pipe(Scope.provide(own));

  const run = yield* FiberSet.runtime(fibers)<never>().pipe(
    Effect.updateContext<never, never>(() => context),
  );

  const retiring = Deferred.makeUnsafe<void>();
  const stopped = Deferred.makeUnsafe<void>();

  const apply: Apply<A, E> = (input) =>
    permit.withPermit(
      Effect.uninterruptible(
        Effect.gen(function* () {
          const step = Lifecycle.transition(state.value, input, options.exclusive ?? false);

          // SubscriptionRef.set wakes retirement's waiter immediately; publish its last outcome first.
          for (const [number, change] of step.events)
            PubSub.publishUnsafe(events, [
              {
                number,
                state: change,
                at: clock.currentTimeMillisUnsafe(),
                hostTime: Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
              },
            ]);
          if (step.state !== state.value) yield* SubscriptionRef.set(state, step.state);
          for (const command of step.commands) yield* perform(command);

          return step;
        }),
      ),
    );

  const openGeneration = opening<A, E, R>(options, context, own, retiring, apply, links);
  const releaseGeneration = releasing(apply, links);

  const perform = (command: Lifecycle.Command<Runtime<A>, Hold>): Effect.Effect<void> => {
    switch (command._tag) {
      case "Open":
        return Effect.sync(() => void run(openGeneration(command.number)));
      case "Watch": {
        const { number, value } = command.live;
        const { lost } = value.opened;

        return lost === undefined
          ? Effect.void
          : Effect.asVoid(
              Effect.forkIn(
                Effect.flatMap(lost, (detail) => apply({ _tag: "Lost", number, detail })),
                value.scope,
              ),
            );
      }
      case "End":
        return Effect.asVoid(Deferred.succeed(command.live.value.ending, command.why));
      case "Release":
        return Effect.sync(() => void run(releaseGeneration(command.live, command.why)));
      case "Stop":
        return Deferred.succeed(retiring, undefined).pipe(
          Effect.andThen(Effect.sync(() => void run(stop))),
        );
    }
  };

  const rotate = Effect.fnUntraced(function* (from?: number) {
    const step = yield* apply({ _tag: "Rotate", from });
    const target = step.reply;

    if (target === undefined)
      return step.state._tag === "Retired"
        ? yield* new Unavailable<E>({ reason: "retired", detail: "retired" })
        : undefined;

    const reached = (s: typeof step.state) =>
      s._tag === "Retired"
        ? new Unavailable<E>({ reason: "retired", detail: "retired" })
        : s._tag === "Down" && s.number >= target
          ? new Unavailable<E>({ reason: "down", error: s.error, detail: s.detail })
          : s._tag === "Open" && s.serving.number >= target
            ? ("served" as const)
            : undefined;

    const outcome = yield* Stream.runHead(
      Stream.filter(Stream.map(SubscriptionRef.changes(state), reached), (r) => r !== undefined),
    );

    if (Option.isSome(outcome) && outcome.value !== "served") return yield* outcome.value;
  });

  const stop = Effect.gen(function* () {
    yield* Stream.runHead(
      Stream.filter(
        SubscriptionRef.changes(state),
        (s) => s._tag === "Retired" && s.opening === undefined && s.ended.size === 0,
      ),
    );
    yield* PubSub.publish(events, Exit.void);
  }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)));

  // Commit the transition even if its caller is interrupted while waiting for the state lock.
  const retire = apply({ _tag: "Retire" }).pipe(
    Effect.uninterruptible,
    Effect.andThen(Deferred.await(stopped)),
  );

  yield* Effect.addFinalizer((exit) => retire.pipe(Effect.ensuring(Scope.close(own, exit))));
  yield* Effect.forEach(started.commands, perform, { discard: true });

  return {
    use: leasing(state, apply, clock),
    states: Stream.fromPubSubTake(events),
    rotate,
    retire,
  };
});
