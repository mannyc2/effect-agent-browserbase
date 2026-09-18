import { Effect, Fiber } from "effect";
import { TestClock } from "effect/testing";

/**
 * These boundary scenarios deliberately mix native Promise callbacks and Effect
 * deadlines. Flush the native event loop before advancing virtual time, so an
 * immediately fulfilled SDK promise is not mistaken for a timed-out operation.
 * No wall-clock sleeps, background fibers, or real-time test mode are needed.
 * The 15-second virtual ceiling exceeds the 8-second provider cleanup budget.
 * A nonsettling scenario fails instead of silently advancing forever.
 */
export const runWithTestTime = <A, E, R>(body: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const fiber = yield* body.pipe(Effect.forkChild);

    for (let elapsed = 0; elapsed <= 15_000; elapsed++) {
      yield* Effect.promise(() => new Promise<void>((resolve) => setImmediate(resolve)));
      if (fiber.pollUnsafe() !== undefined) return yield* Fiber.join(fiber);
      yield* TestClock.adjust(1);
    }

    return yield* Effect.die(new Error("Boundary scenario exceeded its virtual-time budget"));
  });
