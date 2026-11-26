/**
 * Who may write a stored context. A session that persists to a context saves to it when the
 * session ends, so two at once can lose one's changes. `Browserbase.make` holds a context through
 * its `ContextLease` from before it creates a persisting session until that session has ended and
 * its save has settled, and the next writer waits. `verifyContext` and `reconcile` hold it too.
 *
 * The lease is a port. Unless the application provides one, it holds contexts within this process,
 * one lease for every writer in it. An application whose writers run in several processes provides
 * its own, such as an advisory lock in its database, and so excludes them all. `layer` provides a
 * lease within the process of its own, as a test does so that it inherits no context another left
 * unsettled.
 *
 * A hold also passes on how the writer before left the context: `unsettled` while a session that
 * saves to it may still run, as when that writer's release was left unconfirmed, its create's answer
 * was lost, or it kept its session past its scope. The next writer then ends the context's sessions
 * before it writes. A writer says how it leaves the context once, as it lets the hold go; a hold
 * that never says, as when its process ends first, must read as `unsettled` to the next.
 *
 * @stability stable
 * @since 0.3.0
 */
import { Context, Effect, Layer, Schema, type Scope, Semaphore } from "effect";

/**
 * The stored context could not be held for writing: a session that saves to it may still run, as
 * its sessions could not be confirmed ended, or the lease itself could not be taken. The next try
 * clears it again.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export class ContextHeld extends Schema.TaggedError<ContextHeld>(
  "@effect-browser/browserbase/ContextLease/ContextHeld",
)("ContextHeld", {
  context: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `context ${this.context} is held: ${this.detail}`;
  }
}

/**
 * The lease refuses this writer outright; retrying cannot change its policy.
 *
 * @stability stable
 * @category errors
 * @since 0.3.0
 */
export class ContextRefused extends Schema.TaggedError<ContextRefused>(
  "@effect-browser/browserbase/ContextLease/ContextRefused",
)("ContextRefused", {
  context: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `context ${this.context} is refused: ${this.detail}`;
  }
}

/**
 * A writer's hold on a stored context, for the scope `hold` was given.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Hold {
  /** Whether a session that saves to the context may still run, as the writer before left it. */
  readonly unsettled: boolean;
  /** Say how this writer leaves the context, once, before the hold goes: the next writer reads it. */
  readonly leave: (unsettled: boolean) => Effect.Effect<void>;
}

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Service {
  /**
   * Hold the context as its only writer until the scope closes, waiting while another holds it.
   * It fails with `ContextHeld` when the lease cannot be taken, as when its own store is down,
   * or `ContextRefused` when this writer is forbidden and another try cannot help.
   */
  readonly hold: (
    context: string,
  ) => Effect.Effect<Hold, ContextHeld | ContextRefused, Scope.Scope>;
}

interface Entry {
  readonly lock: Semaphore.Semaphore;
  unsettled: boolean;
  /** Its holder and the writers waiting for it. */
  users: number;
}

/**
 * A lease within this process: one writer at a time for each stored context. A context it has not
 * held is presumed settled, so writers in other processes are the application's to exclude, with a
 * lease of its own. It forgets a context once nobody holds it, or waits for it, and it was left
 * settled.
 */
const inProcess = (): Service => {
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

  return {
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
  };
};

/**
 * The lease that `Browserbase` holds stored contexts through; the process's own by default.
 *
 * @stability stable
 * @category services
 * @since 0.3.0
 */
export const ContextLease = Context.Reference<Service>("@effect-browser/browserbase/ContextLease", {
  defaultValue: inProcess,
});

/**
 * A lease within this process of its own, apart from the default one that the process shares.
 *
 * @stability stable
 * @category layers
 * @since 0.3.0
 */
export const layer: Layer.Layer<never> = Layer.sync(ContextLease, inProcess);
