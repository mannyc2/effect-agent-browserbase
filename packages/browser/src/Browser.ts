/**
 * A live browser: its pages and what happens in it.
 *
 * `Browser` is a service with one implementation, built by a provider over a Playwright browser
 * context: `Chromium` launches one locally, `Cdp` connects to any DevTools endpoint and
 * `effect-browserbase` allocates a hosted one. Code written against `Browser` runs on all three.
 * A page is named by its CDP target id, so a new connection to the same browser finds it again.
 *
 * @since 0.3.0
 */
import {
  Clock,
  Context,
  DateTime,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Queue,
  Schema,
  Scope,
  Semaphore,
  type Stream,
} from "effect";
import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";

import { type BrowserError, Closed, Failed, InvalidRequest, Limit } from "./BrowserError.ts";
import * as Events from "./BrowserEvent.ts";
import * as BrowserClock from "./Clock.ts";
import * as Gate from "./internal/input/gate.ts";
import { call, failWith, type Settings, undispatched } from "./internal/page/context.ts";
import { listen } from "./internal/page/dialogs.ts";
import * as Identity from "./internal/page/identity.ts";
import { FailFast } from "./internal/page/lane.ts";
import * as Openings from "./internal/page/openings.ts";
import * as PageImpl from "./internal/page/page.ts";
import * as Port from "./internal/page/port.ts";
import * as Requests from "./internal/page/requests.ts";
import * as Timeline from "./internal/timeline/events.ts";
import type * as Page from "./Page.ts";
import * as Url from "./Url.ts";

/** A script that documents run before their own, such as a consent-banner remover. */
export interface InitScript {
  /**
   * The documents that run it, by a pattern their address (`location.href`) matches; every
   * document and frame when left out. Under a `match`, the source runs as a block, so its own
   * top-level `let`, `const` and classes stay its own.
   */
  readonly match?: RegExp | undefined;
  readonly source: string;
}

/** Consumer-owned decision for one request caught by a narrow URL pattern. */
export type RequestDecision =
  | { readonly _tag: "Allowed" }
  | { readonly _tag: "Refused"; readonly reason: string }
  | {
      readonly _tag: "Fulfilled";
      readonly status: number;
      readonly contentType: string;
      readonly headers?: Readonly<Record<string, string>> | undefined;
      readonly body: string;
    };

export interface RequestPolicy {
  readonly patterns: ReadonlyArray<string>;
  /**
   * Receives sensitive data for this context only; keep it out of model inputs and logs.
   * Body is exact UTF-8 text, or null when absent. Incomplete/binary body evidence refuses
   * the request and ends authority. Preexisting workers make installation fail InvalidRequest.
   * Enforcement belongs to this connection's scope; it is not a firewall after CDP disconnects.
   */
  readonly decide: (request: {
    readonly url: string;
    readonly method: string;
    readonly body: string | null;
  }) => Effect.Effect<RequestDecision, BrowserError>;
  readonly timeout?: Duration.Input | undefined;
}

export interface Options {
  /** Fixed viewport applied before each existing or newly opened page registers. */
  readonly viewport?: { readonly width: number; readonly height: number } | undefined;
  /** This context's policy, installed before pages register; redirects retain ownership. */
  readonly requests?: RequestPolicy | undefined;
  /**
   * Bound on each action; finite and positive. Defaults to 10 seconds. What a presenter's view
   * takes to show an action, such as its glides and typing at a person's pace, does not count
   * against it.
   */
  readonly actionTimeout?: Duration.Input | undefined;
  /** Bound on each navigation; finite and positive. Defaults to 30 seconds. */
  readonly navigationTimeout?: Duration.Input | undefined;
  /**
   * How long each page keeps screencast frames for `recentFrames`, measured back from the newest;
   * finite and positive. Defaults to 5 seconds, a moment's default window.
   */
  readonly frameHistory?: Duration.Input | undefined;
  /** Events retained for replay and `recentEvents`. A positive safe integer, defaulting to 4,096. */
  readonly eventHistory?: number | undefined;
  /** Allow, deny or hold each input or navigation before it reaches the page. Defaults to allow. */
  readonly guard?: Page.InputGuard | undefined;
  /** A separate bound for policy holds, outside action timeouts. Defaults to 5 minutes. */
  readonly policyTimeout?: Duration.Input | undefined;
  /** Scripts that new documents run before their own, each where its `match` allows. */
  readonly initScripts?: ReadonlyArray<InitScript> | undefined;
  /**
   * The most pages the browser keeps open, those a site opens included, which are never refused. At
   * it, `newPage` waits for one to close, within the action timeout, then fails `Limit`; under
   * `Page.failFast` it fails at once. A positive safe integer; no limit when left out.
   */
  readonly maxPages?: number | undefined;
}

export interface EventOptions {
  /** Resume after this sequence; 0 replays from the beginning if it is still retained. */
  readonly after?: number | undefined;
}

export interface SuspendOptions {
  /** Finite, nonnegative drain bound; defaults to the browser's navigationTimeout. */
  readonly drain?: Duration.Input | undefined;
}

/** When admitted input finished; events after `since` describe the handoff interval. */
export class Suspension extends Schema.Class<Suspension>("effect-browser/Suspension")({
  since: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  at: Schema.Finite,
}) {}

/**
 * A connection to the browser apart from the one that drives its pages, for their screencasts,
 * as a provider that reaches the browser over a network supplies it: a frame and its
 * acknowledgement then never wait behind a large message, such as an upload or a read's answer,
 * on the connection that drives the page. It is read-only. A page's session on it sends the
 * capture's commands alone, and the page's own session keeps its focus emulation, which keeps a
 * tab behind painting.
 */
export interface CaptureSource {
  /**
   * A session on the page's target, for the scope. `event` gets the session's events in the order
   * the browser sent them, its target's detach among them, until the scope closes; `lost` gets
   * the connection's failure, once, if it fails first. Its calls never throw: a failure rejects.
   */
  readonly attach: (
    target: string,
    listener: {
      readonly event: (method: string, params: unknown) => void;
      readonly lost: (error: BrowserError) => void;
    },
  ) => Effect.Effect<
    (
      method:
        | "Page.enable"
        | "Page.getFrameTree"
        | "Page.startScreencast"
        | "Page.screencastFrameAck"
        | "Page.stopScreencast",
      params?: Record<string, unknown>,
    ) => Promise<unknown>,
    BrowserError,
    Scope.Scope
  >;
}

export interface Service {
  /** The provider's session id, or a local id. */
  readonly id: string;
  /** Fresh for this connection, even when reattaching the same provider session and page. */
  readonly connection: string;
  readonly provider: string;
  /** When the provider ends the session on its own, as a hosted session's timeout does. */
  readonly expiresAt: DateTime.Utc | undefined;
  /** Host monotonic milliseconds on the clock shared by this browser’s events and frames. */
  readonly now: Effect.Effect<number>;
  /** Drain admitted input and withhold new input for this scope; reads and capture continue. */
  readonly suspend: (
    options?: SuspendOptions,
  ) => Effect.Effect<Suspension, BrowserError, Scope.Scope>;
  /** Open pages in the order this browser began tracking them. */
  readonly pages: Effect.Effect<ReadonlyArray<Page.Page>>;
  /** The open page with this id, its CDP target id, as stored before a reconnect. */
  readonly page: (id: string) => Effect.Effect<Option.Option<Page.Page>>;
  /** The first open page, opening one when there is none. */
  readonly firstPage: Effect.Effect<Page.Page, BrowserError>;
  readonly newPage: (url?: string) => Effect.Effect<Page.Page, BrowserError>;
  /** Whether an applicable cookie exists; its value never leaves the browser owner. */
  readonly hasCookie: (query: {
    readonly name: string;
    readonly url: string;
  }) => Effect.Effect<boolean, BrowserError>;
  /**
   * Completes once the browser is lost to its owner, with why: its connection dropped, its
   * provider ended its session, or its owner's scope released it.
   */
  readonly disconnected: Effect.Effect<Events.DisconnectCause>;
  /** Live events, or replay after a cursor. A reader that falls behind fails with EventHistoryExpired. */
  readonly events: (options?: EventOptions) => Stream.Stream<Events.RecordedEvent, BrowserError>;
  /** The latest `eventHistory` events, oldest first. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<Events.BrowserEvent>>;
}

export class Browser extends Context.Service<Browser, Service>()("effect-browser/Browser") {}

/** The settings every page shares, and how many events the browser keeps, from its options. */
const settingsOf = Effect.fnUntraced(function* (options: Options) {
  const invalid = (detail: string) => undispatched("make", new InvalidRequest({ detail }));

  // Every bound guards a lock or a held key, so each must be a real, finite deadline.
  const bound = (name: string, input: Duration.Input | undefined, fallback: Duration.Duration) => {
    const decoded = Duration.fromInput(input ?? fallback);

    return Option.isSome(decoded) &&
      Number.isFinite(Duration.toMillis(decoded.value)) &&
      Duration.isPositive(decoded.value)
      ? Effect.succeed(decoded.value)
      : Effect.fail(invalid(`${name} must be finite and greater than zero`));
  };

  const settings: Settings = {
    actionTimeout: yield* bound("actionTimeout", options.actionTimeout, Duration.seconds(10)),
    navigationTimeout: yield* bound(
      "navigationTimeout",
      options.navigationTimeout,
      Duration.seconds(30),
    ),
    frameHistory: yield* bound("frameHistory", options.frameHistory, Duration.seconds(5)),
    guard: options.guard,
    policyTimeout: yield* bound("policyTimeout", options.policyTimeout, Duration.minutes(5)),
  };

  if (
    options.viewport !== undefined &&
    ![options.viewport.width, options.viewport.height].every(
      (size) => Number.isSafeInteger(size) && size > 0,
    )
  )
    return yield* invalid("viewport dimensions must be positive safe integers");
  const eventHistory = options.eventHistory ?? 4096;
  const { maxPages } = options;

  if (!Number.isSafeInteger(eventHistory) || eventHistory < 1)
    return yield* invalid("eventHistory must be a positive safe integer");
  if (maxPages !== undefined && (!Number.isSafeInteger(maxPages) || maxPages < 1))
    return yield* invalid("maxPages must be a positive safe integer");

  return { settings, eventHistory, maxPages };
});

/**
 * A provider that ends a session at `expiresAt` by its own clock can cut the connection a little
 * before this host's clock gets there.
 */
const endMargin = Duration.seconds(5);

/**
 * The browser's loss, once: its context closing from the other side, at or after the session's
 * end or before it, or `lose`, as the owner's scope releases it. Playwright leaves the calls in
 * flight on the library's own sessions unanswered when the connection drops, so `untilLost` fails
 * each with the browser, as a closed page's call fails.
 */
const watchLoss = Effect.fnUntraced(function* (
  context: BrowserContext,
  expiresAt: DateTime.Utc | undefined,
  clock: Clock.Clock,
  disconnected: (cause: Events.DisconnectCause) => void,
) {
  let lostBy: Events.DisconnectCause | undefined;
  const lost = yield* Deferred.make<Events.DisconnectCause>();
  const inFlight = new Set<(cause: Error) => void>();
  const gone = () => new Error("Target page, context or browser has been closed");

  const lose = (cause: Events.DisconnectCause) => {
    if (lostBy !== undefined) return;
    lostBy = cause;
    for (const reject of inFlight) reject(gone());
    disconnected(cause);
    Deferred.doneUnsafe(lost, Exit.succeed(cause));
  };

  const untilLost = <A>(reply: Promise<A>): Promise<A> => {
    if (lostBy !== undefined) {
      void reply.catch(() => undefined);

      return Promise.reject(gone());
    }

    return new Promise<A>((resolve, reject) => {
      inFlight.add(reject);
      void reply.then(resolve, reject).finally(() => inFlight.delete(reject));
    });
  };

  const ended = () =>
    expiresAt !== undefined &&
    clock.currentTimeMillisUnsafe() >=
      DateTime.toEpochMillis(expiresAt) - Duration.toMillis(endMargin);

  const onClose = () => lose(ended() ? "session" : "connection");

  context.on("close", onClose);
  yield* Effect.addFinalizer(() => Effect.sync(() => context.off("close", onClose)));
  if (context.browser()?.isConnected() === false) onClose();

  const native = <A>(operation: string, run: () => Promise<A>) =>
    Effect.suspend(() =>
      lostBy === undefined
        ? call(
            operation,
            () => untilLost(run()),
            () => lostBy ?? "page",
          )
        : failWith(operation, new Closed({ cause: lostBy })),
    );

  return { lostBy: () => lostBy, lost: Deferred.await(lost), lose, untilLost, native };
});

/**
 * Register each page the site opens, such as a popup, as Playwright reports it, for as long as the
 * scope is open. One that could not be tracked is published, unless it closed as it opened.
 */
const followOpened = Effect.fnUntraced(function* (
  context: BrowserContext,
  register: (playwright: PlaywrightPage) => Effect.Effect<Page.Page, BrowserError>,
  publish: (event: Events.BrowserEvent) => number,
  now: () => number,
  registrations: Openings.Registrations,
  overflow: () => void,
) {
  const opened = yield* Queue.bounded<PlaywrightPage>(32);

  const onPage = (playwright: PlaywrightPage) => {
    const done = Deferred.makeUnsafe<void, BrowserError>();

    registrations.set(playwright, done);
    if (!Queue.offerUnsafe(opened, playwright)) {
      Deferred.doneUnsafe(
        done,
        failWith("newPage", new Failed({ detail: "page registration overflow" })),
      );
      overflow();
    }
  };

  const untracked = (playwright: PlaywrightPage) => (error: BrowserError) =>
    Effect.sync(() => {
      const url = Url.redact(playwright.url());

      if (!playwright.isClosed())
        publish(new Events.PageUntracked({ at: now(), url, detail: error.message }));
    });

  context.on("page", onPage);
  yield* Effect.addFinalizer(() => Effect.sync(() => context.off("page", onPage)));

  const registerNext = Queue.take(opened).pipe(
    Effect.flatMap((playwright) =>
      register(playwright).pipe(
        Effect.asVoid,
        Effect.onExit((exit) =>
          Effect.sync(() => {
            const done = registrations.get(playwright);

            if (done !== undefined) Deferred.doneUnsafe(done, exit);
          }),
        ),
        Effect.catch(untracked(playwright)),
      ),
    ),
    Effect.forever,
  );

  for (let worker = 0; worker < 8; worker++) yield* Effect.forkScoped(registerNext);
});

/** Release something native, on the owner's clock, giving up after a second: cleanup only. */
const releaseNative = (clock: Clock.Clock) => (run: () => Promise<unknown>) =>
  Effect.tryPromise(run).pipe(
    Effect.interruptible,
    Effect.timeoutOrElse({ duration: Duration.seconds(1), orElse: () => Effect.void }),
    Effect.provideService(Clock.Clock, clock),
    Effect.ignore,
  );

/** A page's own events among the browser's retained ones, and the openings of tabs it opened. */
const eventsOf = (recent: Effect.Effect<ReadonlyArray<Events.RecordedEvent>>, page: string) =>
  Effect.map(recent, (records) =>
    records.flatMap(({ event }) =>
      ("page" in event && event.page === page) ||
      (event._tag === "PageOpened" && event.opener === page)
        ? [event]
        : [],
    ),
  );

/** A script as its documents run it: everywhere, or as a block where its `match` allows. */
const scoped = ({ match, source }: InitScript) =>
  match === undefined ? source : `if (${String(match)}.test(location.href)) {\n${source}\n}`;

/**
 * At most `maxPages` open pages, those a site opened included, which are never refused: an open
 * past it waits for one to close, within `wait` on the owner's clock, then fails `Limit`, or fails
 * at once under `FailFast`. An open counts until its page is tracked.
 */
const pageBudget = (
  maxPages: number | undefined,
  tracked: () => number,
  wait: Duration.Duration,
  clock: Clock.Clock,
) => {
  let opening = 0;
  // Completed as a page closes or an open ends, so the opens waiting look again.
  let roomMade = Deferred.makeUnsafe<void>();

  const makeRoom = () => {
    Deferred.doneUnsafe(roomMade, Exit.void);
    roomMade = Deferred.makeUnsafe<void>();
  };

  const full = (limit: number) => tracked() + opening >= limit;

  const room = (limit: number) =>
    Effect.gen(function* () {
      const refused = undispatched("newPage", new Limit({ maxPages: limit }));

      if ((yield* FailFast) && full(limit)) return yield* refused;
      yield* Effect.gen(function* () {
        while (full(limit)) yield* Deferred.await(roomMade);
        opening += 1;
      }).pipe(
        Effect.timeoutOrElse({ duration: wait, orElse: () => Effect.fail(refused) }),
        Effect.provideService(Clock.Clock, clock),
      );
    });

  const open = <A, E, R>(opened: Effect.Effect<A, E, R>) =>
    maxPages === undefined
      ? opened
      : Effect.uninterruptibleMask((restore) =>
          restore(room(maxPages)).pipe(
            Effect.andThen(
              restore(opened).pipe(
                Effect.ensuring(
                  Effect.sync(() => {
                    opening -= 1;
                    makeRoom();
                  }),
                ),
              ),
            ),
          ),
        );

  return { makeRoom, open };
};

/** A call sent now and awaited later, by whatever needs its answer. */
const sentNow = <A>(sent: Promise<A>) => {
  void sent.catch(() => undefined);

  return sent;
};

/** Close tab resources after publishing their close; a browser loss speaks for all its tabs. */
const closures = (
  lostBy: () => Events.DisconnectCause | undefined,
  publish: (event: Events.BrowserEvent) => number,
  now: () => number,
) =>
  Effect.gen(function* () {
    const closing = yield* Queue.unbounded<{
      readonly scope: Scope.Closeable;
      readonly page: string;
      readonly cause: Events.PageClosed["cause"];
    }>();

    yield* Queue.take(closing).pipe(
      Effect.tap(({ page, cause }) =>
        Effect.sync(() => {
          if (lostBy() === undefined) publish(new Events.PageClosed({ at: now(), page, cause }));
        }),
      ),
      Effect.flatMap(({ scope }) => Scope.close(scope, Exit.void)),
      Effect.forever,
      Effect.forkScoped,
    );

    return closing;
  });

/** Cookie checks disclose presence only, within the browser's native deadline. */
const cookieQuery =
  (
    context: BrowserContext,
    native: Effect.Success<ReturnType<typeof watchLoss>>["native"],
    timeout: Duration.Duration,
    clock: Clock.Clock,
  ): Service["hasCookie"] =>
  ({ name, url }) =>
    native("hasCookie", () => context.cookies(url)).pipe(
      Effect.map((cookies) => cookies.some((cookie) => cookie.name === name)),
      Effect.timeoutOrElse({
        duration: timeout,
        orElse: () =>
          Effect.fail(undispatched("hasCookie", new Failed({ detail: "cookie query timed out" }))),
      }),
      Effect.provideService(Clock.Clock, clock),
    );

/** Tab allocation shares its budget, registration and first-tab lock. */
const tabs = (
  context: BrowserContext,
  registry: Map<PlaywrightPage, Page.Page>,
  budget: ReturnType<typeof pageBudget>,
  native: Effect.Success<ReturnType<typeof watchLoss>>["native"],
  register: (page: PlaywrightPage) => Effect.Effect<Page.Page, BrowserError>,
  release: ReturnType<typeof releaseNative>,
  firstPageLock: Semaphore.Semaphore,
) => {
  const pages = Effect.sync(() => [...registry.values()]);

  const newPage = Effect.fn("Browser.newPage")(function* (url?: string) {
    const page = yield* budget.open(
      native("newPage", () => context.newPage()).pipe(
        Effect.flatMap((playwright) =>
          register(playwright).pipe(Effect.onError(() => release(() => playwright.close()))),
        ),
      ),
    );

    // A rejected or interrupted navigation must not leave the newly allocated blank tab behind.
    if (url !== undefined)
      yield* page.goto(url).pipe(Effect.onError(() => page.close.pipe(Effect.ignore)));

    return page;
  });

  return {
    pages,
    page: (id: string) =>
      Effect.map(pages, (open) => Option.fromNullishOr(open.find((page) => page.id === id))),
    firstPage: firstPageLock.withPermits(1)(
      pages.pipe(
        Effect.map((open) => Option.fromNullishOr(open[0])),
        Effect.flatMap(Option.match({ onNone: () => newPage(), onSome: Effect.succeed })),
      ),
    ),
    newPage,
  };
};

/** One connection owns clocks, loss, authority and its bounded timeline. */
const runtime = Effect.fnUntraced(function* (
  context: BrowserContext,
  expiresAt: DateTime.Utc | undefined,
  options: Options,
) {
  const clock = yield* Clock.Clock;
  const connection = yield* Identity.make;
  const protocol = yield* Port.Current;
  const releasePort = protocol.browser?.(connection, context);

  yield* Effect.addFinalizer(() => Effect.sync(() => releasePort?.()));
  const now = () => BrowserClock.monotonicMillis(clock);
  const { settings, eventHistory, maxPages } = yield* settingsOf(options);
  // Measured on first need: the first capture of any page measures it, and input never waits.
  const mapping = BrowserClock.mapping(now);

  const timeline = Timeline.make(eventHistory);

  yield* Effect.addFinalizer(() => timeline.close);
  const publish = timeline.publish;

  if (expiresAt !== undefined)
    publish(new Events.SessionEnding({ at: now(), expiresAt: expiresAt }));

  const { lostBy, lost, lose, untilLost, native } = yield* watchLoss(
    context,
    expiresAt,
    clock,
    (cause) => publish(new Events.Disconnected({ at: now(), cause })),
  );

  if (options.requests !== undefined)
    yield* Requests.install(context, options.requests, clock, publish, now, () =>
      lose("connection"),
    );

  const inputGate = Gate.make({
    now,
    sequence: timeline.sequence,
    closedBy: lostBy,
    lost,
    clock,
    drain: settings.navigationTimeout,
  });

  return {
    clock,
    connection,
    protocol,
    now,
    settings,
    maxPages,
    mapping,
    timeline,
    publish,
    lostBy,
    lost,
    lose,
    untilLost,
    native,
    inputGate,
  };
});

/**
 * Build the service over a context the provider owns. The provider closes the context; this only
 * tracks its pages and events, for as long as the surrounding scope is open. Each page's protocol
 * session, capture and listeners end when that page closes or when the scope does, so a closed
 * tab retains nothing and the context keeps none of them afterwards.
 */
export const make = Effect.fn("Browser.make")(function* (
  context: BrowserContext,
  info: {
    readonly id?: string | undefined;
    readonly provider: string;
    readonly expiresAt?: DateTime.Utc | undefined;
    /** Where pages' screencasts run, if not on each page's own session. */
    readonly capture?: CaptureSource | undefined;
  },
  options: Options = {},
) {
  const {
    clock,
    connection,
    protocol,
    now,
    settings,
    maxPages,
    mapping,
    timeline,
    publish,
    lostBy,
    lost,
    lose,
    untilLost,
    native,
    inputGate,
  } = yield* runtime(context, info.expiresAt, options);

  const session = info.id ?? connection;

  const registry = new Map<PlaywrightPage, Page.Page>();
  const registrations: Openings.Registrations = new WeakMap();
  const registering = new WeakMap<PlaywrightPage, Semaphore.Semaphore>();
  // The pages' scopes close after the browser is marked released, so what fails as they close
  // says why.
  const pagesScope = yield* Scope.fork(yield* Scope.Scope);

  const release = releaseNative(clock);
  const budget = pageBudget(maxPages, () => registry.size, settings.actionTimeout, clock);

  // Each tab's scope closes with the tab or the browser. A dropped connection closes every page,
  // then the context, and `Disconnected` stands for all of them: the queue hands a close to its
  // fiber in a later turn, once Playwright has reported the context's.
  const closing = yield* closures(lostBy, publish, now);

  const register = (playwright: PlaywrightPage) => {
    const lock = registering.get(playwright) ?? Semaphore.makeUnsafe(1);

    registering.set(playwright, lock);

    return lock.withPermits(1)(
      Effect.gen(function* () {
        const known = registry.get(playwright);

        if (known !== undefined) return known;
        if (playwright.isClosed())
          return yield* failWith("newPage", new Failed({ detail: "the page closed as it opened" }));
        const viewport = options.viewport;

        if (viewport !== undefined)
          yield* native("viewport", () => playwright.setViewportSize(viewport));
        const scope = yield* Scope.fork(pagesScope);

        return yield* Effect.gen(function* () {
          let crashed = false;
          const closedBy = () => lostBy() ?? (crashed ? "crashed" : "page");

          const cdp = yield* Port.openSession(
            () => context.newCDPSession(playwright),
            playwright,
          ).pipe(Effect.provideService(Port.Current, protocol));

          yield* Effect.addFinalizer(() => release(() => cdp.detach()));
          // The page's name, its target id, costs one round trip, which the calls that keep it
          // painting behind other tabs and report its documents share. A renderer busy with its
          // first script answers those two late, so what needs them waits, and registering does not.
          const send: typeof cdp.send = (method, params) => untilLost(cdp.send(method, params));
          const focusing = sentNow(send("Emulation.setFocusEmulationEnabled", { enabled: true }));
          const paging = sentNow(send("Page.enable"));
          const { targetInfo } = yield* native("newPage", () => send("Target.getTargetInfo"));
          const id = targetInfo.targetId;

          const page = yield* PageImpl.make({
            id,
            session,
            connection,
            url: targetInfo.url,
            playwright,
            cdp,
            nativePort: protocol.native,
            untilLost,
            settings,
            inputGate,
            clock,
            mapping,
            publish,
            recentEvents: eventsOf(timeline.recent, id),
            openings: yield* Openings.make(playwright, cdp, registrations, closedBy),
            focused: call("focus", () => focusing, closedBy).pipe(Effect.asVoid),
            paging: (operation) => call(operation, () => paging, closedBy).pipe(Effect.asVoid),
            closedBy,
            capture: info.capture,
          }).pipe(Effect.provideService(Port.Current, protocol));

          const close = () => {
            if (registry.get(playwright) !== page) return;
            registry.delete(playwright);
            budget.makeRoom();
            Queue.offerUnsafe(closing, { scope, page: id, cause: crashed ? "crashed" : "page" });
          };

          // Playwright drives a crashed page no more and its calls never return, so it is closed:
          // they fail at once, `Closed` because it crashed.
          const crash = () => {
            crashed = true;
            void playwright.close().catch(() => undefined);
          };

          registry.set(playwright, page);
          publish(
            new Events.PageOpened({
              at: now(),
              page: id,
              url: Url.redact(targetInfo.url),
              opener: targetInfo.openerId,
            }),
          );
          yield* listen(
            playwright,
            id,
            publish,
            now,
            (accept) =>
              native("dialog", () => send("Page.handleJavaScriptDialog", { accept })).pipe(
                Effect.asVoid,
                Effect.timeoutOrElse({
                  duration: settings.actionTimeout,
                  orElse: () =>
                    failWith("dialog", new Failed({ detail: "dialog answer timed out" })),
                }),
                Effect.provideService(Clock.Clock, clock),
              ),
            { close, crash, failed: () => lose("connection") },
          );
          if (playwright.isClosed()) close();

          return page;
        }).pipe(
          Scope.provide(scope),
          Effect.onError(() => Scope.close(scope, Exit.void)),
        );
      }),
    );
  };

  // Playwright registers its init scripts as it sets up each page, before a popup's first document
  // runs, and they cost no call per document.
  for (const script of options.initScripts ?? [])
    yield* native("initScripts", () => context.addInitScript({ content: scoped(script) }));
  yield* followOpened(context, register, publish, now, registrations, () => lose("connection"));
  for (const existing of context.pages()) yield* register(existing);

  // Added last, so it runs first as the owner's scope closes.
  yield* Effect.addFinalizer(() => Effect.sync(() => lose("released")));

  const service: Service = {
    id: session,
    connection,
    provider: info.provider,
    expiresAt: info.expiresAt,
    now: Effect.sync(now),
    suspend: (options = {}) =>
      Effect.map(inputGate.suspend(options.drain), (held) => new Suspension(held)),
    ...tabs(context, registry, budget, native, register, release, Semaphore.makeUnsafe(1)),
    hasCookie: cookieQuery(context, native, settings.actionTimeout, clock),
    disconnected: lost,
    events: (eventOptions = {}) => timeline.stream(eventOptions.after),
    recentEvents: timeline.recent.pipe(
      Effect.map((records) => records.map((record) => record.event)),
    ),
  };

  return Browser.of(service);
});
