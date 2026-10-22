/**
 * Bounded input replies owned by the page, including after an action is interrupted.
 * Canceling a caller cannot cancel a protocol command already sent. The next action waits for
 * those replies, while a stopped run releases only held keys or buttons whose release was never submitted.
 */
import { Context, Data, Effect, type Scope } from "effect";

import { maximumSamples } from "../../Geometry.ts";

export const capacity = 64;

export class InputFailure extends Data.TaggedError("InputFailure")<{
  readonly cause: unknown;
}> {}

export interface Run {
  /** A native call made by this operation: cancellation cannot cancel its actual reply. */
  readonly track: <A>(reply: Promise<A>) => Promise<A>;
  /** End ownership after the record and all this operation's native replies have settled. */
  readonly afterIdle: (ended: () => void) => void;
  /** Retain authority through scoped cleanup after the replies already submitted. */
  readonly recover: (cleanup: Effect.Effect<void>, scope: Scope.Scope) => Effect.Effect<void>;
  /** Reserve a complete stroke, including its releases, before sending its first event. */
  readonly reserve: (commands: number) => Effect.Effect<void, InputFailure>;
  /** Admit every sample before a motion starts its published clock; ordinary input stays bounded separately. */
  readonly reserveMotion: (commands: number) => Effect.Effect<void, InputFailure>;
  readonly send: (command: () => Promise<unknown>) => Effect.Effect<void, InputFailure>;
  readonly down: (
    key: string,
    press: () => Promise<unknown>,
    release: () => Promise<unknown>,
  ) => Effect.Effect<void, InputFailure>;
  readonly up: (key: string) => Effect.Effect<void, InputFailure>;
  readonly drain: Effect.Effect<void, InputFailure>;
  /** Stop future input and submit missing releases without waiting indefinitely for replies. */
  readonly close: Effect.Effect<void>;
}

/** Native page calls join their operation's reply ownership, including script mutations. */
export const Current = Context.Reference<Run | undefined>("effect-browser/internal/input/Current", {
  defaultValue: () => undefined,
});

export const make = () => {
  const outstanding = new Set<Promise<void>>();

  // A timed-out action keeps capacity until its real replies arrive. Waiting for them sends
  // nothing, so cancellation here cannot leave a detached continuation that later types.
  const idle = Effect.gen(function* () {
    while (outstanding.size > 0) yield* Effect.promise(() => Promise.all(outstanding));
  });

  const begin = Effect.gen(function* () {
    yield* idle;
    const pending = new Set<Promise<void>>();
    const held: Array<{ readonly key: string; readonly release: () => Promise<unknown> }> = [];
    let failure: InputFailure | undefined;
    let reserved = 0;
    let closed = false;
    const observed = new WeakMap<Promise<unknown>, { input: boolean }>();
    const endings = new Set<() => void>();

    const track = <A>(response: Promise<A>, input = false): Promise<A> => {
      const existing = observed.get(response);

      if (existing !== undefined) {
        existing.input ||= input;

        return response;
      }
      const entry = { input };

      observed.set(response, entry);

      const reply = response
        .then(
          () => undefined,
          (cause: unknown) => {
            if (entry.input) failure ??= new InputFailure({ cause });
          },
        )
        .then(() => {
          pending.delete(reply);
          outstanding.delete(reply);
          if (pending.size === 0) {
            for (const end of endings) end();
            endings.clear();
          }
        });

      pending.add(reply);
      outstanding.add(reply);

      return response;
    };

    const requireOpen = Effect.suspend(() =>
      closed
        ? Effect.fail(new InputFailure({ cause: new Error("the input run has stopped") }))
        : Effect.void,
    );

    const requireSuccess = Effect.suspend(() =>
      failure === undefined ? Effect.void : Effect.fail(failure),
    );

    const submit = (command: () => Promise<unknown>) => {
      if (reserved < 1) throw new Error("input must reserve capacity before dispatch");
      reserved--;
      try {
        void track(command(), true);
      } catch (cause) {
        failure ??= new InputFailure({ cause });
      }
    };

    const reserve = (commands: number, maximum: number, limit: number) =>
      Effect.gen(function* () {
        yield* requireOpen;
        yield* requireSuccess;
        if (!Number.isInteger(commands) || commands < 1 || commands > maximum)
          return yield* Effect.die(new Error("invalid input reservation"));
        while (outstanding.size + reserved + commands > limit) {
          yield* Effect.promise(() => Promise.race(outstanding));
          yield* requireOpen;
          yield* requireSuccess;
        }
        reserved += commands;
      });

    const run: Run = {
      track,
      afterIdle: (end) => {
        if (pending.size === 0) end();
        else endings.add(end);
      },
      recover: (cleanup, scope) =>
        Effect.gen(function* () {
          const replies = [...pending];
          const done = Promise.withResolvers<void>();

          // This reservation prevents a new action or suspension from overtaking cleanup.
          void track(done.promise);
          yield* Effect.promise(() => Promise.all(replies)).pipe(
            Effect.andThen(cleanup),
            Effect.ensuring(Effect.sync(() => done.resolve())),
            Effect.provideService(Current, run),
            Effect.interruptible,
            Effect.forkIn(scope),
          );
        }),
      reserve: (commands) => reserve(commands, capacity, capacity),
      // A dense stroke cannot wait for replies midway without changing its published timing.
      // Its finite reservation also leaves room for the ordinary pool's already-owned releases.
      reserveMotion: (commands) => reserve(commands, maximumSamples, capacity + maximumSamples),
      send: (command) =>
        Effect.gen(function* () {
          yield* requireOpen;
          yield* requireSuccess;
          yield* Effect.sync(() => submit(command));
          yield* requireSuccess;
        }),
      down: (key, press, release) =>
        Effect.gen(function* () {
          yield* requireOpen;
          yield* requireSuccess;
          yield* Effect.sync(() => {
            held.push({ key, release });
            submit(press);
          });
          yield* requireSuccess;
        }),
      up: (key) =>
        Effect.gen(function* () {
          yield* requireOpen;
          yield* Effect.sync(() => {
            const index = held.findLastIndex((entry) => entry.key === key);
            const entry = held[index];

            if (entry === undefined) return;
            // Submission owns the release, even if its reply fails. Retrying an uncertain
            // release could run page handlers twice, so cleanup never sends it again.
            held.splice(index, 1);
            submit(entry.release);
          });
          yield* requireSuccess;
        }),
      drain: Effect.gen(function* () {
        while (pending.size > 0) yield* Effect.promise(() => Promise.all(pending));
        yield* requireSuccess;
      }),
      close: Effect.sync(() => {
        if (closed) return;
        closed = true;
        for (const entry of held.toReversed()) submit(entry.release);
        held.length = 0;
        reserved = 0;
      }),
    };

    return run;
  });

  /** `idle` lets an action wait, in its page's turn, for the page's earlier replies. */
  return { idle, begin };
};
