import { Clock, Duration, Effect } from "effect";

/** Monotonic elapsed time is distinct from provider dates and document presentation time. */
export const nowMillis = Clock.monotonicTimeNanos.pipe(
  Effect.map((value) => Number(value) / 1_000_000),
);

export const deadlineAfter = (millis: number) => nowMillis.pipe(Effect.map((now) => now + millis));

export const until = <A, E, R, Timeout>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  timeout: () => Timeout,
): Effect.Effect<A, E | Timeout, R> =>
  nowMillis.pipe(
    Effect.flatMap((now) =>
      deadline <= now
        ? Effect.fail(timeout())
        : effect.pipe(
            Effect.timeoutOrElse({
              duration: Duration.millis(deadline - now),
              orElse: () => Effect.fail(timeout()),
            }),
          ),
    ),
  );
