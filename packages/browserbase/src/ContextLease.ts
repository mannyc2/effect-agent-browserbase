/**
 * Who may write a stored context. A session that persists to a context saves to it when the
 * session ends, so two at once can lose one's changes. `Browserbase.open` holds a context through
 * its `ContextLease` from before it creates a persisting session until that session has ended and
 * its save has settled, and the next writer waits. `verifyContext` and `reconcile` hold it too.
 *
 * The lease is a port. `layer` holds contexts within the process that builds it. An application
 * whose writers run in several processes provides its own, such as an advisory lock in its
 * database, and so excludes them all.
 *
 * A hold also passes on how the writer before left the context: `unsettled` while a session that
 * saves to it may still run, as when that writer's release was left unconfirmed, its create's answer
 * was lost, or it kept its session past its scope. The next writer then ends the context's sessions
 * before it writes. A writer says how it leaves the context once, as it lets the hold go; a hold
 * that never says, as when its process ends first, must read as `unsettled` to the next.
 *
 * @since 0.3.0
 */
import { Context, Effect, Layer, Schema, type Scope, Semaphore } from "effect";

/**
 * The stored context could not be held for writing: a session that saves to it may still run, as
 * its sessions could not be confirmed ended, or the lease itself could not be taken. The next try
 * clears it again.
 */
export class ContextHeld extends Schema.TaggedError<ContextHeld>()("ContextHeld", {
  context: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `context ${this.context} is held: ${this.detail}`;
  }
}

/** A writer's hold on a stored context, for the scope `hold` was given. */
export interface Hold {
  /** Whether a session that saves to the context may still run, as the writer before left it. */
  readonly unsettled: boolean;
  /** Say how this writer leaves the context, once, before the hold goes: the next writer reads it. */
  readonly leave: (unsettled: boolean) => Effect.Effect<void>;
}

export interface Service {
  /**
   * Hold the context as its only writer until the scope closes, waiting while another holds it.
   * It fails with `ContextHeld` when the lease cannot be taken, as when its own store is down.
   */
  readonly hold: (context: string) => Effect.Effect<Hold, ContextHeld, Scope.Scope>;
}

export class ContextLease extends Context.Service<ContextLease, Service>()(
  "effect-browserbase/ContextLease",
) {}

interface Entry {
  readonly lock: Semaphore.Semaphore;
  unsettled: boolean;
  /** Its holder and the writers waiting for it. */
  users: number;
}

/**
 * The lease within this process: one writer at a time for each stored context. A context it has
 * not held is presumed settled, so writers in other processes are the application's to exclude,
 * with a lease of its own. It forgets a context once nobody holds it, or waits for it, and it was
 * left settled.
 */
export const layer: Layer.Layer<ContextLease> = Layer.sync(ContextLease, () => {
  const contexts = new Map<string, Entry>();

  const enter = (context: string) => {
    const entry = contexts.get(context) ?? {
      lock: Semaphore.makeUnsafe(1),
      unsettled: false,
      users: 0,
    };

    entry.users += 1;
    contexts.set(context, entry);

    return entry;
  };

  const exit = (context: string, entry: Entry) => {
    entry.users -= 1;
    if (entry.users === 0 && !entry.unsettled) contexts.delete(context);
  };

  return ContextLease.of({
    hold: (context) =>
      Effect.gen(function* () {
        const entry = yield* Effect.acquireRelease(
          Effect.sync(() => enter(context)),
          (entered) => Effect.sync(() => exit(context, entered)),
        );

        // Unless the holder says otherwise, it leaves a session that saves to the context running.
        let leaving = true;

        yield* Effect.acquireRelease(
          entry.lock.take(1),
          () =>
            Effect.sync(() => {
              entry.unsettled = leaving;
            }).pipe(Effect.andThen(entry.lock.release(1))),
          { interruptible: true },
        );

        return {
          unsettled: entry.unsettled,
          leave: (unsettled) =>
            Effect.sync(() => {
              leaving = unsettled;
            }),
        } satisfies Hold;
      }),
  });
});
