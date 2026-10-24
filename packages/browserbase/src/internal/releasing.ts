/**
 * Retire the browser first so in-flight calls see release, then always attempt the provider end.
 * A failed local cleanup remains explicit release evidence even when the provider confirms its end.
 */
import { Cause, Effect, Exit, Scope } from "effect";
import * as Released from "effect-browser/Released";

export const releasing = (browser: Scope.Closeable, end: Effect.Effect<Released.Released>) =>
  Effect.gen(function* () {
    const closed = yield* Effect.exit(Scope.close(browser, Exit.void));
    const ended = yield* Effect.exit(end);

    if (Exit.isFailure(ended))
      return yield* Effect.failCause(
        Exit.isFailure(closed) ? Cause.combine(closed.cause, ended.cause) : ended.cause,
      );
    if (Exit.isFailure(closed))
      return new Released.Unconfirmed({
        detail: `browser cleanup failed; provider release was ${ended.value._tag}`,
      });

    return ended.value;
  });
