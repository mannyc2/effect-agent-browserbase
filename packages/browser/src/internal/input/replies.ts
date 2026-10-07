/**
 * Bounded input replies owned by the page, including after an action is interrupted.
 * Canceling a caller cannot cancel a protocol command already sent. The next action waits for
 * those replies, while a stopped run releases only held keys or buttons whose release was never submitted.
 */
import { Data, Effect } from "effect";

import { maximumSamples } from "../../Motion.ts";

export const capacity = 64;

export class InputFailure extends Data.TaggedError("InputFailure")<{
  readonly cause: unknown;
}> {}

export interface Run {
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
      let response: Promise<unknown>;

      try {
        response = command();
      } catch (cause) {
        failure ??= new InputFailure({ cause });

        return;
      }

      // Every rejection is observed immediately; a failure does not abandon later replies.
      const reply = response.then(
        () => {
          pending.delete(reply);
          outstanding.delete(reply);
        },
        (cause: unknown) => {
          failure ??= new InputFailure({ cause });
          pending.delete(reply);
          outstanding.delete(reply);
        },
      );

      pending.add(reply);
      outstanding.add(reply);
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

  /** `idle` lets a caller wait for this page's replies before taking a browser-wide lock. */
  return { idle, begin };
};
