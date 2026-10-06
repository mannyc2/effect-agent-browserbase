/**
 * A `Browser` running on Browserbase.
 *
 * `open` creates a session and connects to it over CDP. When its scope closes it disconnects and
 * releases the session, so billing stops then rather than at the session's timeout.
 *
 * A session that persists to a stored context saves to it when the session ends, so two at once
 * can lose one's changes. `open` lets one such session at a time hold each context in this
 * process, and keeps holding it after release until Browserbase reports the session ended and
 * `contextSettle` has passed, since the save lands later and nothing acknowledges it. Writers in
 * other processes are the application's to exclude: open under its own lock, in the same scope,
 * and the lock is released only after the save has settled.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Exit, Layer, Schedule, Scope, Semaphore } from "effect";
import * as Browser from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Cdp from "effect-browser/Cdp";

import {
  BrowserbaseClient,
  type Service,
  type Session,
  type SessionOptions,
} from "./BrowserbaseClient.ts";
import { BrowserbaseError, Decode } from "./BrowserbaseError.ts";

export interface Options extends Browser.Options {
  readonly session?: SessionOptions | undefined;
  /** Bound on connecting to the session. Defaults to 30 seconds. */
  readonly connectTimeoutMillis?: number | undefined;
  /**
   * How long a persisting session's context stays held after the session ends, for its save to
   * land. Defaults to 10 seconds, after which hosted checks have read a save back.
   */
  readonly contextSettle?: Duration.Input | undefined;
}

/** One lock per stored context this process has written to: an entry each, never removed. */
const writers = new Map<string, Semaphore.Semaphore>();

/** Hold the context as its only writer in this process until the scope closes. */
const holdContext = (id: string) =>
  Effect.suspend(() => {
    const lock = writers.get(id) ?? Semaphore.makeUnsafe(1);

    writers.set(id, lock);

    // A second writer waits here for the first one's whole session and the save after it.
    return Effect.acquireRelease(
      lock
        .take(1)
        .pipe(Effect.withSpan("Browserbase.holdContext", {}, { captureStackTrace: false })),
      () => lock.release(1),
      { interruptible: true },
    );
  });

const ended = (session: Session) => session.status !== "PENDING" && session.status !== "RUNNING";

/**
 * Release the session. With `settle`, also wait until Browserbase reports it ended and then
 * `settle` longer, so its context's save has landed before the context is let go.
 */
const release = (client: Service, id: string, settle: Duration.Duration | undefined) =>
  client.releaseSession(id).pipe(
    Effect.ignore({ log: "Warn", message: "Browserbase session release failed" }),
    Effect.andThen(
      settle === undefined
        ? Effect.void
        : client.getSession(id).pipe(
            Effect.repeat({ until: ended, schedule: Schedule.spaced("1 second") }),
            Effect.timeout("1 minute"),
            Effect.ignore({
              log: "Warn",
              message: "Browserbase did not report the session ended; its context may change later",
            }),
            Effect.andThen(Effect.sleep(settle)),
          ),
    ),
    Effect.withSpan(
      "Browserbase.release",
      { attributes: { settle: settle !== undefined } },
      { captureStackTrace: false },
    ),
  );

const connect = (
  operation: string,
  session: Session,
  options: Options,
  contextOrigin: Browser.ContextOrigin,
) =>
  session.connectUrl === undefined
    ? Effect.fail(
        new BrowserbaseError({
          operation,
          reason: new Decode({ detail: `session ${session.id} has no connectUrl` }),
        }),
      )
    : Cdp.open(
        {
          ...options,
          endpoint: session.connectUrl,
          id: session.id,
          provider: "browserbase",
        },
        { contextOrigin },
      );

/**
 * Create a session and open a `Browser` on it, for as long as the scope is open. If opening
 * fails, the session and context are released then, so a retry in the same scope can take them.
 */
export const open = Effect.fn("Browserbase.open")(function* (options: Options = {}) {
  const client = yield* BrowserbaseClient;
  const context = options.session?.browserSettings?.context;
  const local = yield* Scope.fork(yield* Effect.scope);

  const settle =
    context?.persist === true
      ? Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10))
      : undefined;

  return yield* Effect.gen(function* () {
    if (context?.persist === true) yield* holdContext(context.id);

    const session = yield* Effect.acquireRelease(client.createSession(options.session), (session) =>
      release(client, session.id, settle),
    );

    return yield* connect("open", session, options, "fresh");
  }).pipe(
    Scope.provide(local),
    Effect.onError((cause) => Scope.close(local, Exit.failCause(cause))),
  );
});

/**
 * Open a `Browser` on a session that already exists, such as a `keepAlive` session. Closing the
 * scope disconnects and leaves the session running.
 */
export const attach = Effect.fn("Browserbase.attach")(function* (
  sessionId: string,
  options: Options = {},
) {
  const client = yield* BrowserbaseClient;
  const session = yield* client.getSession(sessionId);

  return yield* connect("attach", session, options, "borrowed");
});

export const layer = (
  options: Options = {},
): Layer.Layer<Browser.Browser, BrowserError | BrowserbaseError, BrowserbaseClient> =>
  Layer.effect(Browser.Browser, open(options));
