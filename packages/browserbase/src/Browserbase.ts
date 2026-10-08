/**
 * A `Browser` running on Browserbase.
 *
 * `open` creates a session and connects to it over CDP. When its scope closes it disconnects,
 * releases the session and confirms that Browserbase reports it ended, so billing stops then
 * rather than at the session's timeout. `release` does the same sooner and says how it went:
 * `Settled`, or `Unconfirmed` when Browserbase still reported the session running, or could not
 * be asked, at the deadline. Each create carries a nonce of its own in its user metadata, so a
 * session made by a create whose answer was lost is found and ended too, rather than billing
 * unseen until its timeout.
 *
 * A session that persists to a stored context saves to it when the session ends, so two at once
 * can lose one's changes. `open` lets one such session at a time hold each context in this
 * process, and keeps holding it after release until Browserbase reports the session ended and
 * `contextSettle` has passed, since the save lands later and nothing acknowledges it. A release
 * left `Unconfirmed`, or a create whose answer was lost, may leave a session saving to the
 * context: the next `open` on it first ends the context's sessions, which `open` labels in their
 * user metadata, and fails with `ContextHeld` while they can't be confirmed ended. `reconcile` ends
 * them without opening. Writers in other processes are the application's to exclude: open under
 * its own lock, in the same scope, and the lock is released only after the save has settled.
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
  Random,
  Redacted,
  Schedule,
  Schema,
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
import * as CaptureConnection from "./internal/captureConnection.ts";

export interface Options extends Browser.Options {
  readonly session?: SessionOptions | undefined;
  /** Bound on connecting to the session. Defaults to 30 seconds. */
  readonly connectTimeoutMillis?: number | undefined;
  /**
   * How long a persisting session's context stays held after the session ends, for its save to
   * land. Defaults to 10 seconds, after which hosted checks have read a save back.
   */
  readonly contextSettle?: Duration.Input | undefined;
  /**
   * Run the pages' screencasts on a second connection to the session, which carries nothing else,
   * so that a frame never waits behind a large message, such as an upload or a read's answer, on
   * the connection that drives the page. Defaults to true.
   */
  readonly captureConnection?: boolean | undefined;
}

/** A browser on a Browserbase session. */
export interface Hosted {
  readonly browser: Browser.Service;
  readonly session: Session;
  /**
   * Release the session and confirm it ended, once: `open`'s scope runs it as it closes, while
   * `attach`'s only disconnects. It disconnects `browser` first, which is lost as `released`, so a
   * call in flight or a capture's reader is told so. Asked again, it reports the same outcome.
   */
  readonly release: Effect.Effect<Supervisor.Released>;
}

/**
 * A session that saves to the stored context may still run, as the context's sessions could not
 * be confirmed ended, so `open` does not write to it. The next `open`, or `reconcile`, tries again.
 */
export class ContextHeld extends Schema.TaggedError<ContextHeld>()("ContextHeld", {
  context: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `context ${this.context} is held: ${this.detail}`;
  }
}

/** The user metadata key naming the stored context a persisting session writes to. */
const contextLabel = "persistsContext";

/** The user metadata key holding each create's own nonce, which finds a session made unseen. */
const createLabel = "createNonce";

/**
 * How long a create whose answer was lost has its session looked for: Browserbase can list a new
 * session late, or still be making it when the client stops waiting.
 */
const orphanSearch = Duration.seconds(30);

/** How long a release waits for Browserbase to report the session ended. */
const releaseDeadline = Duration.minutes(1);

/**
 * One writer at a time for each stored context in this process. A context is `unconfirmed` while
 * a session that saves to it may still run, its release unconfirmed or its create's answer lost:
 * the next writer, or `reconcile`, ends the context's sessions first.
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

/** A search for the sessions with `value` under the user metadata key `label`. */
const labelled = (label: string, value: string) => `user_metadata['${label}']:'${value}'`;

/**
 * End the sessions and confirm they ended; then wait `settle`, if given, for the last save to land.
 * One still running at its release's deadline makes the outcome `Unconfirmed`.
 */
const endAll = (
  client: Service,
  sessions: ReadonlyArray<string>,
  settle: Duration.Duration | undefined,
) =>
  Effect.forEach(sessions, (session) => confirm(client, session, undefined), {
    concurrency: 4,
  }).pipe(
    Effect.flatMap((outcomes) => {
      const unconfirmed = outcomes.find((outcome) => outcome._tag === "Unconfirmed");

      return unconfirmed === undefined
        ? Effect.sleep(settle ?? Duration.zero).pipe(
            Effect.as<Supervisor.Released>(new Supervisor.Settled()),
          )
        : Effect.succeed<Supervisor.Released>(unconfirmed);
    }),
  );

/**
 * End the stored context's running sessions, found by the label `open` gives them, and confirm
 * they ended; then wait `settle` for the last save to land. Unless that settles, the context is
 * left unconfirmed, so the next writer ends its sessions again. Pending sessions are listed first,
 * since one listed as pending may be running by the second query.
 */
const endSessions = (client: Service, id: string, settle: Duration.Duration) =>
  Effect.forEach(["PENDING", "RUNNING"], (status) =>
    client.listSessions({ status, query: labelled(contextLabel, id) }),
  ).pipe(
    Effect.flatMap((found) =>
      endAll(client, [...new Set(found.flat().map((session) => session.id))], settle),
    ),
    Effect.onExit((exit) =>
      Effect.sync(() => {
        writer(id).unconfirmed = !(Exit.isSuccess(exit) && exit.value._tag === "Settled");
      }),
    ),
  );

/**
 * End the session a create may have made though its answer was lost, found in any state by the
 * create's own label, and then wait `settle`, if given, for its save. Browserbase can list a new
 * session late, so it is looked for again, more and more seldom, until it is found or
 * `orphanSearch` has passed. A search Browserbase never answered is `Unconfirmed`, as is a session
 * still running at its release's deadline.
 */
const endOrphan = (client: Service, nonce: string, settle: Duration.Duration | undefined) =>
  Effect.gen(function* () {
    let answered = false;

    const found = yield* client.listSessions({ query: labelled(createLabel, nonce) }).pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          answered = true;
        }),
      ),
      Effect.retry(Schedule.exponential("1 second")),
      Effect.repeat({
        schedule: Schedule.exponential("1 second"),
        until: (sessions) => sessions.length > 0,
      }),
      Effect.timeoutOption(orphanSearch),
    );

    if (Option.isNone(found) && !answered)
      return new Supervisor.Unconfirmed({
        detail: `Browserbase did not answer a search for it within ${Duration.format(orphanSearch)}`,
      });
    const running = Option.getOrElse(found, () => []).filter((session) => !ended(session));

    return yield* endAll(
      client,
      running.map((session) => session.id),
      settle,
    );
  });

/**
 * Hold the context as its only writer in this process, until the scope closes or the session's
 * release reports. When a session before it may still save to the context, its sessions are ended
 * first, and the open fails with `ContextHeld` if they can't be confirmed ended.
 */
const holdContext = (client: Service, id: string, settle: Duration.Duration) =>
  Effect.gen(function* () {
    const context = writer(id);
    let holding = true;

    // The context goes once: when the release reports, or else when the scope closes.
    const letGo = Effect.suspend(() => {
      if (!holding) return Effect.void;
      holding = false;

      return Effect.asVoid(context.lock.release(1));
    });

    const clear = endSessions(client, id, settle).pipe(
      Effect.flatMap((outcome) =>
        outcome._tag === "Settled"
          ? Effect.void
          : Effect.fail(new ContextHeld({ context: id, detail: outcome.detail })),
      ),
    );

    // A second writer waits here for the first one's whole session and the save after it.
    yield* Effect.acquireRelease(
      context.lock
        .take(1)
        .pipe(Effect.withSpan("Browserbase.holdContext", {}, { captureStackTrace: false })),
      () => letGo,
      { interruptible: true },
    );
    if (context.unconfirmed) yield* clear;

    // Record how this writer's session ended, and let the context go.
    const released = (outcome: Supervisor.Released) =>
      Effect.suspend(() => {
        context.unconfirmed = outcome._tag === "Unconfirmed";

        return letGo;
      });

    return {
      released,
      /** How ending the session a lost create may have made went: unconfirmed, it holds the context. */
      lost: (outcome: Supervisor.Released) =>
        released(outcome).pipe(
          Effect.andThen(
            outcome._tag === "Settled"
              ? Effect.void
              : Effect.fail(new ContextHeld({ context: id, detail: outcome.detail })),
          ),
        ),
    };
  });

/** A create that failed so may still have made its session: its answer is lost or unreadable. */
const mayHaveCreated = (error: BrowserbaseError) =>
  error.reason._tag === "Transport" ||
  error.reason._tag === "Decode" ||
  (error.reason._tag === "Status" && (error.reason.status >= 500 || error.reason.status === 408));

/** A create's own nonce: two random draws, which no other create draws in practice. */
const nonce = Effect.map(Effect.all([Random.nextInt, Random.nextInt]), (draws) =>
  draws.map((draw) => Math.abs(draw).toString(36)).join("-"),
);

/**
 * The create request, labelled with its own nonce, and a persisting session with its context too,
 * so either can be found.
 */
const withLabels = (
  session: SessionOptions | undefined,
  own: string,
  context: string | undefined,
) => ({
  ...session,
  userMetadata: {
    ...session?.userMetadata,
    [createLabel]: own,
    ...(context === undefined ? {} : { [contextLabel]: context }),
  },
});

/**
 * A release by the browser's owner: it closes the browser first, so that whatever fails then, a
 * capture's reader or a call in flight, says the session was released, and not that the
 * connection Browserbase cuts as the session ends was lost.
 */
const releasing = (browser: Scope.Closeable, end: Effect.Effect<Supervisor.Released>) =>
  Scope.close(browser, Exit.void).pipe(Effect.andThen(end));

/**
 * A browser over the session's DevTools address, its pages' screencasts on a capture connection of
 * their own. A DevTools server's HTTP address, as a local Chromium gives in tests, keeps them on
 * each page's own session: there the connection is loopback, and fast.
 */
const connect = Effect.fnUntraced(function* (
  operation: string,
  session: Session,
  options: Options,
) {
  const endpoint = session.connectUrl;

  if (endpoint === undefined)
    return yield* new BrowserbaseError({
      operation,
      reason: new Decode({ detail: `session ${session.id} has no connectUrl` }),
    });
  const apart = options.captureConnection !== false && /^wss?:/i.test(Redacted.value(endpoint));

  return yield* Cdp.open({
    ...options,
    endpoint,
    id: session.id,
    provider: "browserbase",
    expiresAt: Option.getOrUndefined(DateTime.make(session.expiresAt)),
    capture: apart ? yield* CaptureConnection.make(endpoint) : undefined,
  });
});

/**
 * Create a session and open a `Browser` on it, for as long as the scope is open. If opening
 * fails, the session and context are released then, so a retry in the same scope can take them.
 * A session that may still save to a persisting open's context, its release left `Unconfirmed` or
 * its create's answer lost, is ended first, and the open fails with `ContextHeld` while that can't
 * be confirmed. A lost create's own open looks for its session by the create's nonce, within
 * `orphanSearch`, ends it, then fails with the create's error. `release` disconnects the browser
 * before it asks Browserbase to end the session, so what fails meanwhile says it was released.
 */
export const open = Effect.fn("Browserbase.open")(function* (options: Options = {}) {
  const client = yield* BrowserbaseClient;
  const context = options.session?.browserSettings?.context;
  const persisting = context?.persist === true ? context.id : undefined;
  const local = yield* Scope.fork(yield* Effect.scope);
  const settle = Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));

  return yield* Effect.gen(function* () {
    const writing =
      persisting === undefined ? undefined : yield* holdContext(client, persisting, settle);

    const connected = yield* Scope.fork(local);
    const own = yield* nonce;

    const { session, release } = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const session = yield* client.createSession(withLabels(options.session, own, persisting));

        const release = yield* Effect.cached(
          releasing(connected, confirm(client, session.id, writing && settle)).pipe(
            Effect.tap((outcome) => writing?.released(outcome) ?? Effect.void),
          ),
        );

        return { session, release };
      }),
      ({ release }) => release,
    ).pipe(
      // A session nobody can see bills until its timeout, and one that saves to the context would
      // write beside the next writer: end it, found by its create's own label.
      Effect.tapError((error) =>
        mayHaveCreated(error)
          ? endOrphan(client, own, writing && settle).pipe(
              Effect.flatMap((outcome) => writing?.lost(outcome) ?? Effect.void),
            )
          : Effect.void,
      ),
    );

    yield* Effect.annotateCurrentSpan({ session: session.id, region: session.region });

    const browser = yield* connect("open", session, options).pipe(Scope.provide(connected));

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

  const connected = yield* Scope.fork(yield* Effect.scope);
  const browser = yield* connect("attach", session, options).pipe(Scope.provide(connected));

  const release = yield* Effect.cached(
    releasing(connected, confirm(client, session.id, undefined)),
  );

  return { browser, session, release } satisfies Hosted;
});

/**
 * End a stored context's sessions, the ones `open` labelled as writing to it, and let the context
 * go once they are confirmed ended and its save has settled. `open` does this itself when a writer
 * before it may still run; `reconcile` does it without opening, as for sessions another process
 * left running. It waits for a writer this process has open. A session still running at the
 * deadline makes it `Unconfirmed`, and leaves the context unconfirmed, as a failure does.
 */
export const reconcile = Effect.fn("Browserbase.reconcile")(function* (
  contextId: string,
  options: { readonly contextSettle?: Duration.Input | undefined } = {},
) {
  const client = yield* BrowserbaseClient;
  const settle = Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));

  // Reading the context first refuses an id that is not one before it reaches the query.
  yield* client.getContext(contextId);

  return yield* writer(contextId).lock.withPermit(endSessions(client, contextId, settle));
});

export interface SuperviseOptions
  extends
    Options,
    Pick<
      Supervisor.Options<BrowserError | BrowserbaseError | ContextHeld, BrowserbaseClient>,
      "reopen" | "rotateBefore" | "waitTimeout"
    > {}

/**
 * Browserbase refused the request: no new try mends a refused key, request or id. A context held
 * is not among them, since each try ends its sessions again.
 */
const refused = (error: BrowserError | BrowserbaseError | ContextHeld) =>
  error._tag === "BrowserbaseError" && !isTransient(error) && error.reason._tag !== "Decode";

/**
 * Keep Browserbase sessions open as `Supervisor` generations, each a new session made from
 * `session`. Sessions that persist to a stored context are exclusive: a rotation releases the
 * current one, and its context's save settles, before the next one opens. An open Browserbase
 * refused, as for a bad key or an invalid request, is `Down` at once.
 */
export const supervise = (options: SuperviseOptions = {}) =>
  Supervisor.make({
    open: open(options),
    exclusive: options.session?.browserSettings?.context?.persist === true,
    reopen: options.reopen,
    definite: refused,
    rotateBefore: options.rotateBefore,
    waitTimeout: options.waitTimeout,
  });

export const layer = (
  options: Options = {},
): Layer.Layer<Browser.Browser, BrowserError | BrowserbaseError | ContextHeld, BrowserbaseClient> =>
  Layer.effect(
    Browser.Browser,
    Effect.map(open(options), ({ browser }) => browser),
  );
