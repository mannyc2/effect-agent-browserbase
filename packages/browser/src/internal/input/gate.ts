/**
 * A browser's input authority: stop admitting writes, drain admitted operations through their
 * records and native replies, then retain the stop for its scopes. Reads never enter this gate.
 */
import { Clock, Deferred, Duration, Effect, Exit, Option, type Scope } from "effect";

import { BrowserError, Busy, Closed, InvalidRequest, Suspended } from "../../BrowserError.ts";
import type { DisconnectCause } from "../../BrowserEvent.ts";

interface Stopped {
  readonly since: number;
  readonly at: number;
}

type State =
  | { readonly _tag: "Open"; readonly inputs: ReadonlySet<number> }
  | {
      readonly _tag: "Draining";
      readonly inputs: ReadonlySet<number>;
      readonly claims: ReadonlySet<number>;
      readonly startedAt: number;
      readonly deadline: number;
    }
  | { readonly _tag: "Held"; readonly claims: ReadonlySet<number>; readonly stopped: Stopped };

type Input =
  | { readonly _tag: "Enter" | "End" | "Leave"; readonly id: number }
  | { readonly _tag: "Suspend"; readonly id: number; readonly drain: number }
  | { readonly _tag: "Expire" };

const without = (set: ReadonlySet<number>, id: number) =>
  new Set([...set].filter((each) => each !== id));

const step = (state: State, input: Input, stopped: Stopped): State => {
  switch (input._tag) {
    case "Enter":
      return state._tag === "Open"
        ? { ...state, inputs: new Set([...state.inputs, input.id]) }
        : state;
    case "End": {
      if (state._tag === "Held") return state;
      const inputs = without(state.inputs, input.id);

      return state._tag === "Draining" && inputs.size === 0
        ? { _tag: "Held", claims: state.claims, stopped }
        : { ...state, inputs };
    }
    case "Suspend":
      if (state._tag !== "Open") return { ...state, claims: new Set([...state.claims, input.id]) };

      return state.inputs.size === 0
        ? { _tag: "Held", claims: new Set([input.id]), stopped }
        : {
            _tag: "Draining",
            inputs: state.inputs,
            claims: new Set([input.id]),
            startedAt: stopped.at,
            deadline: stopped.at + input.drain,
          };
    case "Leave": {
      if (state._tag === "Open" || !state.claims.has(input.id)) return state;
      const claims = without(state.claims, input.id);

      return claims.size > 0
        ? { ...state, claims }
        : { _tag: "Open", inputs: state._tag === "Draining" ? state.inputs : new Set() };
    }
    case "Expire":
      return state._tag === "Draining" && stopped.at >= state.deadline
        ? { _tag: "Open", inputs: state.inputs }
        : state;
  }
};

export const make = (options: {
  readonly now: () => number;
  readonly sequence: () => number;
  readonly closedBy: () => DisconnectCause | undefined;
  readonly lost: Effect.Effect<DisconnectCause>;
  readonly clock: Clock.Clock;
  readonly drain: Duration.Duration;
}) => {
  let state: State = { _tag: "Open", inputs: new Set() };
  let next = 0;
  let refused = Deferred.makeUnsafe<void>();
  let ready = Deferred.makeUnsafe<Stopped, BrowserError>();

  const error = (operation: string) =>
    new BrowserError({
      operation,
      reason:
        options.closedBy() === undefined
          ? new Suspended()
          : new Closed({ cause: options.closedBy() ?? "connection" }),
      dispatched: false,
    });

  const stopped = (): Stopped => ({ since: options.sequence(), at: options.now() });

  // Every change to authority happens here, synchronously with its admission or scope closure.
  const apply = (input: Input): State => {
    if (input._tag !== "Expire" && state._tag === "Draining" && options.now() >= state.deadline)
      apply({ _tag: "Expire" });
    const before = state;

    state = step(state, input, stopped());
    if (input._tag === "Expire" && before._tag === "Draining" && state._tag === "Open")
      Deferred.doneUnsafe(
        ready,
        Exit.fail(
          new BrowserError({
            operation: "suspend",
            reason: new Busy({
              waitedMillis: Math.round(options.now() - before.startedAt),
              ahead: before.inputs.size,
            }),
            dispatched: false,
          }),
        ),
      );
    if (before._tag === "Open" && state._tag !== "Open") Deferred.doneUnsafe(refused, Exit.void);
    if (before._tag === "Draining" && state._tag === "Held")
      Deferred.doneUnsafe(ready, Exit.succeed(state.stopped));
    if (before._tag !== "Open" && state._tag === "Open") {
      refused = Deferred.makeUnsafe();
      ready = Deferred.makeUnsafe();
    }

    return state;
  };

  const check = (operation: string) =>
    Effect.suspend(() =>
      state._tag === "Open" && options.closedBy() === undefined
        ? Effect.void
        : Effect.fail(error(operation)),
    );

  const suspend = (
    drain: Duration.Input = options.drain,
  ): Effect.Effect<Stopped, BrowserError, Scope.Scope> =>
    Effect.suspend(() => {
      const duration = Duration.fromInput(drain);

      if (
        Option.isNone(duration) ||
        !Duration.isFinite(duration.value) ||
        Duration.toMillis(duration.value) < 0
      )
        return Effect.fail(
          new BrowserError({
            operation: "suspend",
            reason: new InvalidRequest({ detail: "drain must be a finite nonnegative duration" }),
            dispatched: false,
          }),
        );
      const id = ++next;
      const leave = Effect.sync(() => apply({ _tag: "Leave", id }));

      return Effect.acquireRelease(
        Effect.gen(function* () {
          if (options.closedBy() !== undefined) return yield* error("suspend");
          const current = apply({ _tag: "Suspend", id, drain: Duration.toMillis(duration.value) });

          if (current._tag === "Held") return current.stopped;
          if (current._tag !== "Draining")
            return yield* Effect.die("suspension did not retain authority");
          const pending = ready;

          // Native completion and timer callbacks both check the same monotonic deadline. A
          // timer may wake a fraction early, so it sleeps the remaining time instead of hanging.
          const expire: Effect.Effect<Stopped, BrowserError> = Effect.suspend(() => {
            const left = current.deadline - options.now();

            return left > 0
              ? Effect.sleep(Duration.millis(left)).pipe(Effect.andThen(expire))
              : Effect.sync(() => apply({ _tag: "Expire" })).pipe(
                  Effect.andThen(Deferred.await(pending)),
                );
          });

          const wait = Effect.raceFirst(Deferred.await(pending), expire);

          return yield* Effect.raceFirst(
            wait,
            options.lost.pipe(Effect.flatMap(() => Effect.fail(error("suspend")))),
          ).pipe(
            Effect.interruptible,
            Effect.filterOrFail(
              () => options.closedBy() === undefined,
              () => error("suspend"),
            ),
            Effect.onError(() => leave),
          );
        }),
        () => leave,
      );
    }).pipe(Effect.provideService(Clock.Clock, options.clock));

  return {
    check,
    suspend,
    refused: (operation: string): Effect.Effect<never, BrowserError> =>
      Effect.suspend(() =>
        state._tag === "Open"
          ? Deferred.await(refused).pipe(Effect.andThen(Effect.fail(error(operation))))
          : Effect.fail(error(operation)),
      ),
    enter: (operation: string): Effect.Effect<() => void, BrowserError> =>
      Effect.suspend(() => {
        if (state._tag !== "Open" || options.closedBy() !== undefined)
          return Effect.fail(error(operation));
        const id = ++next;

        apply({ _tag: "Enter", id });

        return Effect.succeed(() => {
          apply({ _tag: "End", id });
        });
      }),
  };
};

export type Gate = ReturnType<typeof make>;
