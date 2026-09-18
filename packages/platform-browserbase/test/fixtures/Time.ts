import { Effect, Fiber, type Duration } from "effect";
import { TestClock } from "effect/testing";

/** Run a bounded operation concurrently with an explicit virtual-clock advance.
 * All fixtures that use this helper install the official TestClock for their
 * entire resource lifetime, including when executed by the portable harness. */
export const elapse = <A, E, R>(effect: Effect.Effect<A, E, R>, duration: Duration.Input) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkChild);
    yield* TestClock.adjust(duration);
    return yield* Fiber.join(fiber);
  });
export const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(Effect.provide(TestClock.layer()));
export const advance = TestClock.adjust;
