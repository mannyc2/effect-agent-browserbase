import { Cause, Effect, Exit, Option } from "effect";

import type { BrowserError, InitializationError } from "../../Errors.ts";

/** Evidence about this connection, independent of the lifetime of its browser process. */
export type ConnectionState = "closed" | "failed" | "not-connected" | "pending";

/** Captured teardown operations supplied to the lifetime which owns this connection. */
export interface ConnectionCleanup {
  readonly fence: Effect.Effect<void>;
  readonly capture: Effect.Effect<void, BrowserError>;
  readonly initialization: Effect.Effect<void, BrowserError | InitializationError>;
  readonly disconnect: Effect.Effect<ConnectionState, BrowserError>;
}

export const noConnection: ConnectionCleanup = {
  fence: Effect.void,
  capture: Effect.void,
  initialization: Effect.void,
  disconnect: Effect.succeed("not-connected"),
};

export type CleanupStep<A> =
  | { readonly _tag: "Success"; readonly value: A }
  | { readonly _tag: "Failure"; readonly reason: "timeout" | "interrupted" | "failed" };

const timedOut = Symbol("BrowserCleanupTimeout");

/** Every step settles independently, so one failure never suppresses subsequent teardown. */
export const cleanupStep = <A, E, R>(
  action: Effect.Effect<A, E, R>,
  timeoutMillis: number,
): Effect.Effect<CleanupStep<A>, never, R> =>
  action.pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: timeoutMillis, orElse: () => Effect.fail(timedOut) }),
    Effect.exit,
    Effect.map((exit): CleanupStep<A> => {
      if (Exit.isSuccess(exit)) return { _tag: "Success", value: exit.value };
      const error = Cause.findErrorOption(exit.cause);

      return {
        _tag: "Failure",
        reason:
          Option.isSome(error) && error.value === timedOut
            ? "timeout"
            : Cause.hasInterrupts(exit.cause)
              ? "interrupted"
              : "failed",
      };
    }),
  );

/** Bounded host notification; reporting cannot change the cleanup evidence it describes. */
export const reported = <A, E>(effect: Effect.Effect<A, E>): Effect.Effect<void> =>
  effect.pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: 2000, orElse: () => Effect.void }),
    Effect.ignore,
    Effect.asVoid,
  );
