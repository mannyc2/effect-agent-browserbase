/** Scoped acquisition, release and borrowing for the pure resource supervisor lifecycle. */
import {
  Cause,
  Clock,
  type Context,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Schedule,
  Scope,
  Stream,
  SubscriptionRef,
  type Tracer,
} from "effect";

import { Settled, Unconfirmed } from "../providers/Released.ts";
import {
  InvalidWait,
  type Lease,
  type Opened,
  type Options,
  type Supervisor,
  Superseded,
  Unavailable,
  type Why,
} from "./contract.ts";
import * as Lifecycle from "./lifecycle.ts";

export interface Runtime<A> {
  readonly opened: Opened<A>;
  readonly scope: Scope.Closeable;
  readonly ending: Deferred.Deferred<Why>;
}

export type Hold = object;
export type State<A, E> = Lifecycle.Core<Runtime<A>, Hold, E>;

export type Apply<A, E> = (
  input: Lifecycle.Input<Runtime<A>, Hold, E>,
) => Effect.Effect<Lifecycle.Step<Runtime<A>, Hold, E>>;

export const describe = (cause: Cause.Cause<unknown>) =>
  Cause.prettyErrors(cause)
    .map((error) => error.message)
    .join("; ");

export const opening =
  <A, E, R>(
    options: Options<A, E, R>,
    context: Context.Context<Exclude<Exclude<R, Scope.Scope>, Tracer.ParentSpan>>,
    own: Scope.Closeable,
    retiring: Deferred.Deferred<void>,
    apply: Apply<A, E>,
    links: ReadonlyArray<Tracer.SpanLink>,
  ) =>
  (number: number) => {
    let attempt = 0;
    let began = false;

    const once: Effect.Effect<boolean, E> = Effect.uninterruptible(
      Effect.gen(function* () {
        attempt += 1;
        const admitted = yield* apply({ _tag: "Try", number, attempt });

        if (admitted.reply === undefined) return false;
        began = true;
        const scope = yield* Scope.fork(own);

        const exit = yield* Effect.exit(
          options.open(number).pipe(
            Scope.provide(scope),
            Effect.withSpan("Supervisor.open", {
              root: true,
              links,
              attributes: { generation: number, attempt },
            }),
            Effect.provideContext(context),
          ),
        );

        if (Exit.isSuccess(exit)) {
          const ending = Deferred.makeUnsafe<Why>();

          yield* apply({ _tag: "Opened", number, value: { opened: exit.value, scope, ending } });

          return true;
        }
        const closed = yield* Effect.exit(Scope.close(scope, exit));

        const cause = Exit.isFailure(closed) ? Cause.combine(exit.cause, closed.cause) : exit.cause;
        const error = Cause.findErrorOption(cause);

        if (Option.isSome(error))
          yield* apply({ _tag: "Failed", number, attempt, error: error.value });

        return yield* Effect.failCause(cause);
      }),
    );

    return Effect.raceFirst(
      Effect.exit(
        Effect.retry(once, {
          schedule:
            options.reopen ??
            Schedule.exponential("1 second").pipe(Schedule.upTo({ duration: "5 minutes" })),
          while: (error) => options.definite?.(error) !== true,
        }),
      ),
      Effect.as(Deferred.await(retiring), undefined),
    ).pipe(
      Effect.flatMap((exit) =>
        exit !== undefined && Exit.isSuccess(exit) && exit.value
          ? Effect.void
          : exit !== undefined && Exit.isFailure(exit)
            ? apply({
                _tag: "GaveUp",
                number,
                error: Option.getOrUndefined(Cause.findErrorOption(exit.cause)),
                detail: describe(exit.cause),
              })
            : apply({ _tag: "Stopped", number, began }),
      ),
      Effect.asVoid,
    );
  };

/** A provider failure or a failed scope close always leaves an Unconfirmed outcome. */
export const releasing = <A, E>(apply: Apply<A, E>, links: ReadonlyArray<Tracer.SpanLink>) =>
  Effect.fnUntraced(
    function* (live: Lifecycle.Live<Runtime<A>, Hold>, why: Why) {
      const { opened, scope } = live.value;

      const outcome = yield* Effect.suspend(
        () => opened.release?.(why) ?? Effect.succeed(new Settled()),
      ).pipe(
        Effect.catchCause((cause) =>
          Effect.succeed(new Unconfirmed({ detail: `the release failed: ${describe(cause)}` })),
        ),
      );

      const closed = yield* Effect.exit(Scope.close(scope, Exit.void));

      const released =
        Exit.isSuccess(closed) || outcome._tag !== "Settled"
          ? outcome
          : new Unconfirmed({ detail: `its scope failed to close: ${describe(closed.cause)}` });

      yield* apply({ _tag: "Released", number: live.number, released });
    },
    Effect.uninterruptible,
    Effect.withSpan("Supervisor.release", { root: true, links }),
  );

const bounded = (input: Duration.Input) =>
  Effect.suspend(() => {
    const duration = Duration.fromInput(input);

    return Option.isSome(duration) &&
      Duration.isFinite(duration.value) &&
      !Duration.isNegative(duration.value)
      ? Effect.succeed(duration.value)
      : Effect.fail(new InvalidWait({ detail: "wait must be a finite nonnegative duration" }));
  });

export const leasing =
  <A, E>(
    state: SubscriptionRef.SubscriptionRef<State<A, E>>,
    apply: Apply<A, E>,
    clock: Clock.Clock,
  ): Supervisor<A, E>["use"] =>
  (work, options = {}) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const hold: Hold = {};
        const wait = options.wait === undefined ? undefined : yield* bounded(options.wait);
        const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
        const until = wait === undefined ? undefined : now() + Duration.toMillis(wait);
        let live: Lifecycle.Live<Runtime<A>, Hold> | undefined;

        while (live === undefined) {
          const step = yield* apply({ _tag: "Hold", hold });
          const resolved = Lifecycle.resolve(step.state);

          live = step.borrowed;
          if (live !== undefined) break;
          if (resolved?._tag === "Unavailable") return yield* new Unavailable<E>(resolved);
          const remaining = until === undefined ? undefined : Math.max(0, until - now());

          if (remaining === 0) return yield* new Cause.TimeoutError();

          const changed = SubscriptionRef.changes(state).pipe(
            Stream.filter((s) => Lifecycle.resolve(s) !== undefined),
            Stream.runHead,
          );

          yield* restore(
            (remaining === undefined ? changed : Effect.timeout(changed, remaining)).pipe(
              Effect.provideService(Clock.Clock, clock),
            ),
          );
          if (until !== undefined && now() >= until) return yield* new Cause.TimeoutError();
        }
        const { number } = live;
        const { ending, opened } = live.value;

        const superseded = Effect.flatMap(Deferred.await(ending), (reason) =>
          Effect.fail(new Superseded({ generation: number, reason })),
        );

        const lease: Lease<A> = {
          generation: number,
          value: opened.value,
          ending: Deferred.await(ending),
          lose: (detail) => Effect.asVoid(apply({ _tag: "Lost", number, detail })),
        };

        return yield* restore(
          Effect.scoped(
            Effect.raceFirst(
              Effect.tap(
                Effect.suspend(() => work(lease)),
                () =>
                  Effect.flatMap(Deferred.isDone(ending), (done) =>
                    done ? superseded : Effect.void,
                  ),
              ),
              superseded,
            ),
          ),
        ).pipe(Effect.ensuring(apply({ _tag: "Let", number, hold })));
      }),
    );
