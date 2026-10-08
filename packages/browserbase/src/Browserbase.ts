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
 * can lose one's changes. `open` holds the context through the `ContextLease` the application
 * provides, from before it creates such a session until Browserbase reports the session ended and
 * `contextSettle` has passed, since the save lands later and nothing acknowledges it. A writer that
 * leaves a session that saves to the context possibly running, its release `Unconfirmed`, its
 * create's answer lost or its session kept, leaves the context unsettled: the next writer first ends
 * the context's sessions, which `open` labels in their user metadata, and fails with `ContextHeld`
 * while they can't be confirmed ended. `reconcile` ends them without opening, and `verifyContext`
 * reads a context back under the same hold, from a session that saves nothing.
 *
 * `attach` connects to a session that already runs, as from another process: its pages keep their
 * ids, so a page stored before is found again. `supervise` keeps a session open across losses and
 * session ends, as `Supervisor` generations, and with `keep`, past its own scope, for the next
 * `supervise` to adopt.
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
  Scope,
} from "effect";
import * as Browser from "effect-browser/Browser";
import { BrowserError, Closed } from "effect-browser/BrowserError";
import * as Cdp from "effect-browser/Cdp";
import * as Supervisor from "effect-browser/Supervisor";

import {
  BrowserbaseClient,
  type Service,
  type Session,
  type SessionOptions,
} from "./BrowserbaseClient.ts";
import { BrowserbaseError, Decode, InvalidRequest, isTransient } from "./BrowserbaseError.ts";
import { ContextHeld, ContextLease } from "./ContextLease.ts";
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

/** The user metadata key naming the stored context a persisting session writes to. */
const contextLabel = "persistsContext";

/** The user metadata key holding each create's own nonce, which finds a session made unseen. */
const createLabel = "createNonce";

/** The user metadata key naming what a supervisor keeps its sessions under, past its scope. */
const keepLabel = "keptAs";

/**
 * How long a create whose answer was lost has its session looked for: Browserbase can list a new
 * session late, or still be making it when the client stops waiting.
 */
const orphanSearch = Duration.seconds(30);

/** How long a release waits for Browserbase to report the session ended. */
const releaseDeadline = Duration.minutes(1);

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
 * The sessions a search finds that have not ended. Pending ones are listed first, since one listed
 * as pending may be running by the second query.
 */
const unended = (client: Service, query: string) =>
  Effect.forEach(["PENDING", "RUNNING"], (status) => client.listSessions({ status, query })).pipe(
    Effect.map((found) => [
      ...new Map(found.flat().map((session) => [session.id, session])).values(),
    ]),
  );

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
 * Hold the stored context through the lease, as its only writer, until the scope closes or the
 * session's end is known; the hold goes once, saying how this writer leaves the context.
 */
const holdContext = Effect.fnUntraced(function* (
  client: Service,
  lease: ContextLease["Service"],
  id: string,
  settle: Duration.Duration,
) {
  const scope = yield* Scope.fork(yield* Effect.scope);

  // A second writer waits here for the first one's whole session and the save after it.
  const hold = yield* lease
    .hold(id)
    .pipe(
      Scope.provide(scope),
      Effect.withSpan("Browserbase.holdContext", {}, { captureStackTrace: false }),
    );

  // Whether a session that saves to the context may run, as this writer would leave it now.
  let unsettled = hold.unsettled;

  const set = (now: boolean) =>
    Effect.sync(() => {
      unsettled = now;
    });

  yield* Scope.addFinalizer(
    scope,
    Effect.suspend(() => hold.leave(unsettled)),
  );

  const letGo = (now: boolean) => set(now).pipe(Effect.andThen(Scope.close(scope, Exit.void)));

  /** End the context's sessions but `except`, found by the label `open` gives them. */
  const end = (except: ReadonlyArray<string>) =>
    unended(client, labelled(contextLabel, id)).pipe(
      Effect.flatMap((found) =>
        endAll(
          client,
          found.map((session) => session.id).filter((session) => !except.includes(session)),
          settle,
        ),
      ),
      Effect.onExit((exit) => set(!(Exit.isSuccess(exit) && exit.value._tag === "Settled"))),
    );

  const refuse = (outcome: Supervisor.Released) =>
    outcome._tag === "Settled"
      ? Effect.void
      : Effect.fail(new ContextHeld({ context: id, detail: outcome.detail }));

  return {
    end,
    /**
     * End the sessions, but `except`, that a writer before may have left saving to the context,
     * failing with `ContextHeld` while they can't be confirmed ended.
     */
    clear: (except: ReadonlyArray<string>) =>
      Effect.suspend(() => (unsettled ? Effect.flatMap(end(except), refuse) : Effect.void)),
    /** A session that saves to the context runs from now. */
    writing: set(true),
    /** How the writer's session ended: unconfirmed, it may still save to the context. */
    released: (outcome: Supervisor.Released) => letGo(outcome._tag === "Unconfirmed"),
    /** How ending the session a lost create may have made went: unconfirmed, the open fails. */
    lost: (outcome: Supervisor.Released) =>
      letGo(outcome._tag === "Unconfirmed").pipe(Effect.andThen(refuse(outcome))),
    /** The writer's session runs on past its scope, saving to the context when it ends. */
    kept: letGo(true),
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
 * The create request, labelled with its own nonce, a persisting session with its context too, so
 * either can be found, and a kept one with what it is kept under, kept alive past disconnecting.
 */
const withLabels = (
  session: SessionOptions | undefined,
  own: string,
  context: string | undefined,
  keep: string | undefined,
) => ({
  ...session,
  ...(keep === undefined ? {} : { keepAlive: true }),
  userMetadata: {
    ...session?.userMetadata,
    [createLabel]: own,
    ...(context === undefined ? {} : { [contextLabel]: context }),
    ...(keep === undefined ? {} : { [keepLabel]: keep }),
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
 * each page's own session: there the connection is loopback, and fast. A session that has ended
 * fails `Closed` by the session, with no connect.
 */
const connect = Effect.fnUntraced(function* (
  operation: string,
  session: Session,
  options: Options,
) {
  const endpoint = session.connectUrl;

  if (ended(session))
    return yield* new BrowserError({
      operation,
      reason: new Closed({ cause: "session" }),
      dispatched: false,
    });
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

/** How a supervisor keeps its sessions past its scope: under `name`, adopting one first if `adopt`. */
interface Keeping {
  readonly name: string;
  readonly adopt: boolean;
}

const keepName = /^[\w.:-]{1,64}$/;

const newestFirst = (sessions: ReadonlyArray<Session>) => {
  const created = (session: Session) =>
    Option.getOrElse(Option.map(DateTime.make(session.createdAt), DateTime.toEpochMillis), () => 0);

  return sessions.toSorted((a, b) => created(b) - created(a));
};

/**
 * The newest session kept under `name` that saves where this open would, to adopt. Every other
 * session kept under it is to end, since nothing else adopts it: those that save to this open's
 * context are its writers, for the context's hold to end, as `writers` says, and the rest end here.
 */
const adoptable = Effect.fnUntraced(function* (
  client: Service,
  name: string,
  persisting: string | undefined,
) {
  const [newest, ...older] = newestFirst(yield* unended(client, labelled(keepLabel, name)));
  const fits = newest !== undefined && newest.userMetadata?.[contextLabel] === persisting;
  const others = [...(fits || newest === undefined ? [] : [newest]), ...older];

  const writes = (session: Session) =>
    persisting !== undefined && session.userMetadata?.[contextLabel] === persisting;

  const rest = others.filter((session) => !writes(session));

  if (rest.length > 0) {
    const outcome = yield* endAll(
      client,
      rest.map((session) => session.id),
      undefined,
    );

    yield* Effect.annotateCurrentSpan({ endedKept: rest.length, endedKeptAs: outcome._tag });
  }

  return { adoptee: fits ? newest : undefined, writers: others.some(writes) };
});

/**
 * Open a browser on a new session, or, when keeping, adopt one a supervisor kept before. A kept
 * session's scope only disconnects, unless it closes on a failure: `release` ends it.
 */
const start = Effect.fnUntraced(function* (options: Options, keeping: Keeping | undefined) {
  const client = yield* BrowserbaseClient;
  const lease = yield* ContextLease;
  const context = options.session?.browserSettings?.context;
  const persisting = context?.persist === true ? context.id : undefined;
  const local = yield* Scope.fork(yield* Effect.scope);
  const settle = Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));

  return yield* Effect.gen(function* () {
    if (keeping !== undefined && !keepName.test(keeping.name))
      return yield* new BrowserbaseError({
        operation: "supervise",
        reason: new InvalidRequest({
          detail: `keep must be 1 to 64 letters, digits, "_", ".", ":" or "-"`,
        }),
      });

    const writing =
      persisting === undefined ? undefined : yield* holdContext(client, lease, persisting, settle);

    const adoption = keeping?.adopt
      ? yield* adoptable(client, keeping.name, persisting)
      : undefined;

    const adopted = adoption?.adoptee;

    // Another writer kept under the name may still save to the context: clear it as any other.
    if (adoption?.writers === true) yield* writing?.writing ?? Effect.void;
    yield* writing?.clear(adopted === undefined ? [] : [adopted.id]) ?? Effect.void;
    const connected = yield* Scope.fork(local);
    const own = yield* nonce;

    // Releasing ends the session; leaving, as a kept session's scope does, only disconnects.
    const ending = (session: Session) =>
      Effect.gen(function* () {
        let asked = false;

        const release = yield* Effect.cached(
          Effect.suspend(() => {
            asked = true;

            return releasing(connected, confirm(client, session.id, writing && settle)).pipe(
              Effect.tap((outcome) => writing?.released(outcome) ?? Effect.void),
            );
          }),
        );

        const leave = Effect.suspend(() =>
          asked
            ? Effect.void
            : Scope.close(connected, Exit.void).pipe(Effect.andThen(writing?.kept ?? Effect.void)),
        );

        return { session, release, leave };
      });

    const made = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const session =
          adopted === undefined
            ? yield* client.createSession(
                withLabels(options.session, own, persisting, keeping?.name),
              )
            : yield* client.getSession(adopted.id);

        yield* writing?.writing ?? Effect.void;

        return yield* ending(session);
      }),
      ({ release, leave }, exit) =>
        keeping !== undefined && Exit.isSuccess(exit) ? leave : Effect.asVoid(release),
    ).pipe(
      // A session nobody can see bills until its timeout, and one that saves to the context would
      // write beside the next writer: end it, found by its create's own label.
      Effect.tapError((error) =>
        adopted === undefined && mayHaveCreated(error)
          ? endOrphan(client, own, writing && settle).pipe(
              Effect.flatMap((outcome) => writing?.lost(outcome) ?? Effect.void),
            )
          : Effect.void,
      ),
    );

    const { session, release } = made;

    yield* Effect.annotateCurrentSpan({
      session: session.id,
      region: session.region,
      adopted: adopted !== undefined,
    });

    const browser = yield* connect(
      adopted === undefined ? "open" : "attach",
      session,
      options,
    ).pipe(Scope.provide(connected));

    return { browser, session, release } satisfies Hosted;
  }).pipe(
    Scope.provide(local),
    Effect.onError((cause) => Scope.close(local, Exit.failCause(cause))),
  );
});

/**
 * Create a session and open a `Browser` on it, for as long as the scope is open. If opening
 * fails, the session and context are released then, so a retry in the same scope can take them.
 * A persisting open holds its context through the `ContextLease`; a session that may still save
 * to it, as one whose release was left `Unconfirmed` or whose create's answer was lost, is ended
 * first, and the open fails with `ContextHeld` while that can't be confirmed. A lost create's own
 * open looks for its session by the create's nonce, within `orphanSearch`, ends it, then fails with
 * the create's error. `release` disconnects the browser before it asks Browserbase to end the
 * session, so what fails meanwhile says it was released.
 */
export const open = Effect.fn("Browserbase.open")(function* (options: Options = {}) {
  return yield* start(options, undefined);
});

/**
 * Open a `Browser` on a session that already runs, such as a `keepAlive` session another process
 * opened. This is resume: its pages keep their ids, their CDP target ids, so `browser.page(id)`
 * finds a page stored before. Closing the scope disconnects and leaves the session running;
 * `release` ends it. A session that has ended fails `Closed` by the session. It holds no context.
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
 * left running. It holds the context through the `ContextLease`, so it waits for a writer. A
 * session still running at the deadline makes it `Unconfirmed`, and leaves the context unsettled,
 * as a failure does.
 */
export const reconcile = Effect.fn("Browserbase.reconcile")(function* (
  contextId: string,
  options: { readonly contextSettle?: Duration.Input | undefined } = {},
) {
  const client = yield* BrowserbaseClient;
  const lease = yield* ContextLease;
  const settle = Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));

  // Reading the context first refuses an id that is not one before it reaches the query.
  yield* client.getContext(contextId);
  const hold = yield* holdContext(client, lease, contextId, settle);

  return yield* hold.end([]);
}, Effect.scoped);

/**
 * Read a stored context back, as a login: a session that loads it and saves nothing runs `check`
 * on its browser, and is released. The context is held through the `ContextLease` meanwhile, so
 * the read never runs beside a writer, which a site could sign out, and it reads what the last
 * writer saved, once that save settled. A session a writer before may have left saving to it is
 * ended first, as for `open`.
 */
export const verifyContext = Effect.fn("Browserbase.verifyContext")(function* <A, E, R>(
  contextId: string,
  check: (browser: Browser.Service) => Effect.Effect<A, E, R>,
  options: Options = {},
) {
  const client = yield* BrowserbaseClient;
  const lease = yield* ContextLease;
  const settle = Duration.fromInputUnsafe(options.contextSettle ?? Duration.seconds(10));
  const reading = yield* holdContext(client, lease, contextId, settle);

  yield* reading.clear([]);

  const { browser } = yield* start(
    {
      ...options,
      session: {
        ...options.session,
        browserSettings: {
          ...options.session?.browserSettings,
          context: { id: contextId, persist: false },
        },
      },
    },
    undefined,
  );

  return yield* check(browser);
}, Effect.scoped);

export interface SuperviseOptions
  extends
    Options,
    Pick<
      Supervisor.Options<BrowserError | BrowserbaseError | ContextHeld, BrowserbaseClient>,
      "reopen" | "rotateBefore" | "waitTimeout"
    > {
  /**
   * Keep the session past the supervisor's scope, under this name: 1 to 64 letters, digits, `_`,
   * `.`, `:` or `-`. Each session is created with `keepAlive` and labelled `keptAs: <keep>` in its
   * user metadata. Closing the scope only disconnects the current one, published as `Kept`, and
   * the first generation of the next `supervise` under the same name adopts it, with its pages,
   * rather than creating a session; other sessions kept under it are ended. `retire` releases. A
   * kept session bills until it is adopted and released, or until its timeout ends it.
   */
  readonly keep?: string | undefined;
}

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
 * refused, as for a bad key or an invalid request, is `Down` at once. With `keep`, closing the
 * scope leaves the current session running for the next `supervise` under that name to adopt.
 */
export const supervise = (options: SuperviseOptions = {}) =>
  Effect.suspend(() => {
    const { keep } = options;
    // Only the first generation adopts a kept session: a later one would find its own.
    let opened = false;

    return Supervisor.make({
      open: Effect.suspend(() =>
        start(options, keep === undefined ? undefined : { name: keep, adopt: !opened }),
      ).pipe(
        Effect.tap(() =>
          Effect.sync(() => {
            opened = true;
          }),
        ),
        Effect.withSpan("Browserbase.open", {}, { captureStackTrace: false }),
      ),
      exclusive: options.session?.browserSettings?.context?.persist === true,
      keep: keep !== undefined,
      reopen: options.reopen,
      definite: refused,
      rotateBefore: options.rotateBefore,
      waitTimeout: options.waitTimeout,
    });
  });

export const layer = (
  options: Options = {},
): Layer.Layer<
  Browser.Browser,
  BrowserError | BrowserbaseError | ContextHeld,
  BrowserbaseClient | ContextLease
> =>
  Layer.effect(
    Browser.Browser,
    Effect.map(open(options), ({ browser }) => browser),
  );
