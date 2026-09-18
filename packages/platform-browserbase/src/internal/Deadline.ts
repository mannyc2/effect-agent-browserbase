import { Clock, Duration, Effect } from "effect";

import { BrowserbaseError } from "../Types.ts";

/** Effect's nanosecond clock is monotonic; provider wall-clock dates are kept separately. */
export const nowMillis = Clock.monotonicTimeNanos.pipe(Effect.map((n) => Number(n) / 1_000_000));

export const deadlineAfter = (millis: number) => nowMillis.pipe(Effect.map((now) => now + millis));

export const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  operation: string,
  onTimeout?: () => void,
): Effect.Effect<A, E | BrowserbaseError, R> =>
  Effect.suspend(() =>
    nowMillis.pipe(
      Effect.flatMap((now) => {
        const remaining = deadline - now;

        const timeout = () => {
          onTimeout?.();

          return Effect.fail(BrowserbaseError.make({ operation, reason: "timeout" }));
        };

        return remaining <= 0
          ? timeout()
          : effect.pipe(
              Effect.timeoutOrElse({
                duration: Duration.millis(remaining),
                orElse: timeout,
              }),
            );
      }),
    ),
  );
