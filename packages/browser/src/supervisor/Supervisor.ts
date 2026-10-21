/**
 * A resource kept serving through typed acquisition failures, loss and rotation.
 * `make` adds its finalizer directly to its caller's scope. Each generation has its own scope;
 * its loss signal remains watched until that scope closes, after release. Optional policies
 * compose by wrapping `open`, `release` and the public generation stream.
 */
import {
  Clock,
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

import { type Generation, type Options, type Supervisor, Unavailable } from "./contract.ts";
import * as Lifecycle from "./lifecycle.ts";
import { type Apply, type Hold, type Runtime, leasing, opening, releasing } from "./runtime.ts";

export {
  type Generation,
  InvalidWait,
  type Lease,
  type Opened,
  type Options,
  type State,
  type Supervisor,
  Superseded,
  Unavailable,
  type UseOptions,
  Why,
} from "./contract.ts";

export const make = Effect.fn("Supervisor.make")(function* <A, E, R>(
  options: Options<A, E, R>,
): Effect.fn.Return<Supervisor<A, E>, never, Scope.Scope | Exclude<R, Scope.Scope>> {
  const clock = yield* Clock.Clock;
  const context = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const parent = yield* Effect.serviceOption(Tracer.ParentSpan);
  const links = Option.isSome(parent) ? [{ span: parent.value, attributes: {} }] : [];
  const own = yield* Scope.fork(yield* Effect.scope);
  const started = Lifecycle.start<Runtime<A>, Hold, E>();
  const state = yield* SubscriptionRef.make(started.state);
  const permit = yield* Semaphore.make(1);
  const events = yield* PubSub.unbounded<Take.Take<Generation<E>>>({ replay: 64 });
  const fibers = yield* FiberSet.make().pipe(Scope.provide(own));
  const run = yield* FiberSet.runtime(fibers)<never>();
  const retiring = Deferred.makeUnsafe<void>();
  const stopped = Deferred.makeUnsafe<void>();
  let stopping = false;

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

  const openGeneration = opening(options, context, own, retiring, apply, links);
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
        return Effect.asVoid(Deferred.succeed(retiring, undefined));
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
    yield* apply({ _tag: "Retire" });
    yield* Stream.runHead(
      Stream.filter(
        SubscriptionRef.changes(state),
        (s) => s._tag === "Retired" && s.opening === undefined && s.ended.size === 0,
      ),
    );
    yield* PubSub.publish(events, Exit.void);
  }).pipe(Effect.ensuring(Deferred.succeed(stopped, undefined)));

  const retire = Effect.suspend(() => {
    if (!stopping) {
      stopping = true;
      run(stop);
    }

    return Deferred.await(stopped);
  });

  yield* Effect.addFinalizer(() => retire);
  yield* Effect.forEach(started.commands, perform, { discard: true });

  return {
    use: leasing(state, apply, clock),
    states: Stream.fromPubSubTake(events),
    rotate,
    retire,
  };
});
