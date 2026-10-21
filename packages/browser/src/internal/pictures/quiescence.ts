/** Actual native replies outlive callers; bounded transactions retain them without holding teardown. */
import { Cause, Clock, Duration, Effect, Exit, Fiber } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import * as Replies from "../page/replies.ts";

const deadline = Duration.seconds(2);

type Operation = "screencast start" | "screencast stop" | "picture restoration";

interface Options<G> {
  readonly clock: Clock.Clock;
  readonly error: (cause: unknown) => BrowserError;
  readonly closed: () => boolean;
  readonly current: () => G;
  readonly pause: (current: G) => Effect.Effect<void, BrowserError>;
  readonly resume: (current: G) => Effect.Effect<void, BrowserError>;
  readonly fail: (current: G, error: BrowserError) => void;
}

export const make = <G>(options: Options<G>) => {
  const replies = Replies.make();
  const pending = new Map<Operation, Promise<void>>();

  const late = (kind: Operation) => options.error(new Error(`${kind} exceeded its deadline`));

  const track = (
    operation: Operation,
    actual: Promise<unknown>,
    failed: (cause: unknown) => void,
  ) => {
    const reply = actual.then(() => undefined, failed);

    pending.set(operation, reply);

    return reply.finally(() => {
      if (pending.get(operation) === reply) pending.delete(operation);
    });
  };

  const wait = (operation?: Operation) =>
    (operation === undefined
      ? replies.idle.pipe(Effect.andThen(Effect.promise(() => Promise.all(pending.values()))))
      : Effect.promise(() => pending.get(operation) ?? Promise.resolve())
    ).pipe(
      Effect.asVoid,
      Effect.interruptible,
      Effect.timeoutOrElse({
        duration: deadline,
        orElse: () =>
          Effect.fail(late(operation ?? pending.keys().next().value ?? "picture restoration")),
      }),
      Effect.provideService(Clock.Clock, options.clock),
    );

  const excluding = <A, E, R>(picture: Effect.Effect<A, E, R>) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(wait());
        if (options.closed()) return yield* options.error(new Error("Target page has been closed"));
        const current = options.current();
        const run = yield* replies.begin;

        const result = yield* restore(
          options
            .pause(current)
            .pipe(Effect.andThen(picture), Effect.provideService(Replies.Current, run)),
        ).pipe(Effect.exit);

        // Called after the Effect exits: the owner cannot become idle between its commands.
        const cleaned = yield* wait().pipe(
          Effect.andThen(options.resume(current)),
          Effect.timeoutOrElse({
            duration: deadline,
            orElse: () => Effect.fail(late("picture restoration")),
          }),
          Effect.provideService(Clock.Clock, options.clock),
          Effect.exit,
          // A joined child has fresh interruption state. Parent cancellation cannot skip cleanup.
          Effect.forkChild,
          Effect.flatMap(Fiber.join),
        );

        if (Exit.isFailure(cleaned))
          options.fail(current, options.error(Cause.squash(cleaned.cause)));
        if (Exit.isFailure(result)) return yield* Effect.failCause(result.cause);
        if (Exit.isFailure(cleaned)) return yield* Effect.failCause(cleaned.cause);

        return result.value;
      }),
    );

  return { excluding, idle: wait(), wait, track };
};
