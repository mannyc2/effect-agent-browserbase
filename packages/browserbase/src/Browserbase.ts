/**
 * A `Browser` running on Browserbase.
 *
 * `open` creates a session and connects to it over CDP. When its scope closes it disconnects,
 * releases the session and confirms that Browserbase reports it ended, so billing stops then
 * rather than at the session's timeout. `release` does the same sooner and says how it went:
 * `Settled`, or `Unconfirmed` when Browserbase still reported the session running, or could not
 * be asked, at the deadline.
 *
 * A session that persists to a stored context saves to it when the session ends, so two at once
 * can lose one's changes. `open` lets one such session at a time hold each context in this
 * process, and keeps holding it after release until Browserbase reports the session ended and
 * `contextSettle` has passed, since the save lands later and nothing acknowledges it. A release
 * left `Unconfirmed` keeps the context held: `reconcile` ends the context's sessions, which `open`
 * labels in their user metadata, and lets the context go once they have ended. Writers in other
 * processes are the application's to exclude: open under its own lock, in the same scope, and the
 * lock is released only after the save has settled.
 *
 * `supervise` keeps a session open across losses and session ends, as `Supervisor` generations.
 *
 * @since 0.3.0
 */
import {
  DateTime,
  Duration,
  Effect,
  Exit,
  Layer,
  Option,
  Schedule,
  Scope,
  Semaphore,
} from "effect";
import * as Browser from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Cdp from "effect-browser/Cdp";
import * as Supervisor from "effect-browser/Supervisor";

import {
  BrowserbaseClient,
  type Service,
  type Session,
  type SessionOptions,
} from "./BrowserbaseClient.ts";
import { BrowserbaseError, Decode, isTransient } from "./BrowserbaseError.ts";

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

/** A browser on a Browserbase session. */
export interface Hosted {
  readonly browser: Browser.Service;
  readonly session: Session;
  /**
   * Release the session and confirm it ended, once: `open`'s scope runs it as it closes, while
   * `attach`'s only disconnects. Asked again, it reports the same outcome.
   */
  readonly release: Effect.Effect<Supervisor.Released>;
}

/** The user metadata key naming the stored context a persisting session writes to. */
const contextLabel = "persistsContext";

/** How long a release waits for Browserbase to report the session ended. */
const releaseDeadline = Duration.minutes(1);

/**
 * One writer at a time for each stored context in this process. A context whose writer's release
 * was left unconfirmed stays held, by no scope, until `reconcile` confirms its sessions ended.
 */
const writers = new Map<string, { readonly lock: Semaphore.Semaphore; unconfirmed: boolean }>();

const writer = (id: string) => {
  const known = writers.get(id) ?? { lock: Semaphore.makeUnsafe(1), unconfirmed: false };

  writers.set(id, known);

  return known;
};

const ended = (session: Session) => session.status !== "PENDING" && session.status !== "RUNNING";

/**
 * End the session and confirm Browserbase reports it ended. The release request and the status
 * reads are each tried again a second apart until the deadline; a session still running then, or
 * one Browserbase could not be asked about, is `Unconfirmed`. Once it has ended, wait `settle`
 * longer, for its context's save to land. It runs to the end once started.
 */
const confirm = (client: Service, id: string, settle: Duration.Duration | undefined) =>
  Effect.gen(function* () {
    // What Browserbase last said, for an end it never confirmed.
    let last = "Browserbase did not answer";

    const heard = (error: BrowserbaseError) => Effect.sync(() => (last = error.message));

    const read = client.getSession(id).pipe(
      Effect.tapError(heard),
      Effect.tap((session) => Effect.sync(() => (last = `the session was ${session.status}`))),
      Effect.retry(Schedule.spaced("1 second")),
      Effect.repeat({ until: ended, schedule: Schedule.spaced("1 second") }),
    );

    // A release that keeps failing leaves the status reads to tell whether the session ended.
    const confirmed = yield* client.releaseSession(id).pipe(
      Effect.tapError(heard),
      Effect.retry({ while: isTransient, schedule: Schedule.spaced("1 second") }),
      Effect.exit,
      Effect.andThen(read),
      Effect.as(true),
      Effect.timeoutOrElse({ duration: releaseDeadline, orElse: () => Effect.succeed(false) }),
      // The reads are retried until the deadline, so a failure here is the same unconfirmed end.
      Effect.orElseSucceed(() => false),
    );

    if (!confirmed)
      return new Supervisor.Unconfirmed({
        detail: `${last} ${Duration.format(releaseDeadline)} after its release`,
      });
    if (settle !== undefined) yield* Effect.sleep(settle);

    return new Supervisor.Settled();
  }).pipe(
    Effect.tap((released) => Effect.annotateCurrentSpan({ released: released._tag })),
    Effect.withSpan(
      "Browserbase.release",
      { attributes: { session: id, settle: settle !== undefined } },
      { captureStackTrace: false },
    ),
    Effect.uninterruptible,
  );

/**
 * Hold the context as its only writer in this process, until the scope closes or the session's
 * release reports: one that settles lets the context go at once, while one left unconfirmed keeps
 * it held past the scope.
 */
const holdContext = (id: string) =>
  Effect.gen(function* () {
    const context = writer(id);
    let held: "writing" | "released" = "writing";

    // A second writer waits here for the first one's whole session and the save after it.
    yield* Effect.acquireRelease(
      context.lock
        .take(1)
        .pipe(Effect.withSpan("Browserbase.holdContext", {}, { captureStackTrace: false })),
      () => (held === "writing" ? context.lock.release(1) : Effect.void),
      { interruptible: true },
    );

    return (released: Supervisor.Released) =>
      Effect.suspend(() => {
        held = "released";
        if (released._tag === "Settled") return context.lock.release(1);
        context.unconfirmed = true;

        return Effect.void;
      });
  });

/** The create request, with a persisting session labelled by its context for `reconcile`. */
const labelled = (session: SessionOptions | undefined, context: string | undefined) =>
  context === undefined
    ? session
    : { ...session, userMetadata: { ...session?.userMetadata, [contextLabel]: context } };

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
  const persisting = context?.persist === true ? context.id : undefined;
  const local = yield* Scope.fork(yield* Effect.scope);

  const settle =
    persisting === undefined
      ? undefined
      : Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));

  return yield* Effect.gen(function* () {
    const released = persisting === undefined ? undefined : yield* holdContext(persisting);

    const { session, release } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const session = yield* client.createSession(labelled(options.session, persisting));

        const release = yield* Effect.cached(
          confirm(client, session.id, settle).pipe(
            Effect.tap((outcome) => released?.(outcome) ?? Effect.void),
          ),
        );

        return { session, release };
      }),
      ({ release }) => release,
    );

    yield* Effect.annotateCurrentSpan({ session: session.id, region: session.region });

    const browser = yield* connect("open", session, options, "fresh");

    return { browser, session, release } satisfies Hosted;
  }).pipe(
    Scope.provide(local),
    Effect.onError((cause) => Scope.close(local, Exit.failCause(cause))),
  );
});

/**
 * Open a `Browser` on a session that already exists, such as a `keepAlive` session. Closing the
 * scope disconnects and leaves the session running; `release` ends it.
 */
export const attach = Effect.fn("Browserbase.attach")(function* (
  sessionId: string,
  options: Options = {},
) {
  const client = yield* BrowserbaseClient;
  const session = yield* client.getSession(sessionId);

  yield* Effect.annotateCurrentSpan({ session: session.id, region: session.region });

  const browser = yield* connect("attach", session, options, "borrowed");
  const release = yield* Effect.cached(confirm(client, session.id, undefined));

  return { browser, session, release } satisfies Hosted;
});

/**
 * End a stored context's sessions, the ones `open` labelled as writing to it, and let the context
 * go once they are confirmed ended and its save has settled: the way out of a release left
 * `Unconfirmed`, which keeps the context held in this process. It waits for a writer this process
 * has open, and ends another process's writer. A session still running at the deadline makes it
 * `Unconfirmed` again, and a failure keeps the context held too.
 */
export const reconcile = Effect.fn("Browserbase.reconcile")(function* (
  contextId: string,
  options: { readonly contextSettle?: Duration.Input | undefined } = {},
) {
  const client = yield* BrowserbaseClient;
  const settle = Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));

  // Reading the context first refuses an id that is not one before it reaches the query.
  yield* client.getContext(contextId);
  const context = writer(contextId);

  const ending = Effect.forEach(["RUNNING", "PENDING"], (status) =>
    client.listSessions({ status, query: `user_metadata['${contextLabel}']:'${contextId}'` }),
  ).pipe(
    Effect.flatMap((found) =>
      Effect.forEach(found.flat(), (session) => confirm(client, session.id, undefined), {
        concurrency: 4,
      }),
    ),
    Effect.flatMap((outcomes) => {
      const unconfirmed = outcomes.find((outcome) => outcome._tag === "Unconfirmed");

      return unconfirmed === undefined
        ? Effect.sleep(settle).pipe(Effect.as<Supervisor.Released>(new Supervisor.Settled()))
        : Effect.succeed<Supervisor.Released>(unconfirmed);
    }),
  );

  // Take the context as a writer would, or adopt the hold an unconfirmed release left.
  const take = Effect.suspend(() => {
    if (!context.unconfirmed) return Effect.asVoid(context.lock.take(1));
    context.unconfirmed = false;

    return Effect.void;
  });

  return yield* Effect.uninterruptibleMask((restore) =>
    restore(take).pipe(
      Effect.andThen(
        restore(ending).pipe(
          Effect.onExit((exit) =>
            Exit.isSuccess(exit) && exit.value._tag === "Settled"
              ? context.lock.release(1)
              : Effect.sync(() => (context.unconfirmed = true)),
          ),
        ),
      ),
    ),
  );
});

export interface SuperviseOptions
  extends
    Options,
    Pick<
      Supervisor.Options<BrowserError | BrowserbaseError, BrowserbaseClient>,
      "reopen" | "rotateBefore" | "waitTimeout"
    > {}

/**
 * Keep Browserbase sessions open as `Supervisor` generations, each a new session made from
 * `session`. Sessions that persist to a stored context are exclusive: a rotation releases the
 * current one, and its context's save settles, before the next one opens.
 */
export const supervise = (options: SuperviseOptions = {}) =>
  Supervisor.make({
    open: open(options).pipe(
      Effect.map(({ browser, session, release }) => ({
        browser,
        release,
        expiresAt: Option.getOrUndefined(DateTime.make(session.expiresAt)),
      })),
    ),
    exclusive: options.session?.browserSettings?.context?.persist === true,
    reopen: options.reopen,
    rotateBefore: options.rotateBefore,
    waitTimeout: options.waitTimeout,
  });

export const layer = (
  options: Options = {},
): Layer.Layer<Browser.Browser, BrowserError | BrowserbaseError, BrowserbaseClient> =>
  Layer.effect(
    Browser.Browser,
    Effect.map(open(options), ({ browser }) => browser),
  );
