/**
 * A live browser: its pages and what happens in it.
 *
 * `Browser` is a service with one implementation, built by a provider over a Playwright browser
 * context: `Chromium` launches one locally, `Cdp` connects to any DevTools endpoint and
 * `effect-browserbase` allocates a hosted one. Code written against `Browser` runs on all three.
 *
 * @since 0.3.0
 */
import {
  Clock,
  Context,
  Duration,
  Effect,
  Layer,
  Option,
  Queue,
  Ref,
  Scope,
  Semaphore,
  type Stream,
} from "effect";
import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";

import { BrowserError, Failed, InvalidRequest } from "./BrowserError.ts";
import {
  type BrowserEvent,
  DialogShown,
  Navigated,
  PageClosed,
  PageOpened,
  type RecordedEvent,
} from "./BrowserEvent.ts";
import { CaptureCalibration } from "./Frame.ts";
import * as Startup from "./internal/calibration.ts";
import * as Timeline from "./internal/timeline.ts";
import * as Motion from "./Motion.ts";
import * as Page from "./Page.ts";

export interface Options {
  /** Move the pointer along curved paths and type with human pacing. Defaults to false. */
  readonly humanize?: boolean | undefined;
  /** Bound on each action. Defaults to 10 seconds. */
  readonly actionTimeout?: Duration.Input | undefined;
  /** Bound on each navigation. Defaults to 30 seconds. */
  readonly navigationTimeout?: Duration.Input | undefined;
  /** Screencast frames each page keeps for `recentFrames`. Defaults to 60. */
  readonly frameHistory?: number | undefined;
  /** Events retained for replay and `recentEvents`. A positive safe integer, defaulting to 4,096. */
  readonly eventHistory?: number | undefined;
  /** Allow, deny or hold each input or navigation before it reaches the page. Defaults to allow. */
  readonly guard?: Page.InputGuard | undefined;
  /** A separate bound for policy holds, outside action timeouts. Defaults to 5 minutes. */
  readonly policyTimeout?: Duration.Input | undefined;
  /** Scripts every new document runs before its own, such as a consent-banner remover. */
  readonly initScripts?: ReadonlyArray<string> | undefined;
}

/** Providers attest freshness only immediately after allocating the context or session. */
export type ContextOrigin = "fresh" | "borrowed";

export interface EventOptions {
  /** Resume after this sequence; 0 replays from the beginning if it is still retained. */
  readonly after?: number | undefined;
}

export interface Service {
  /** The provider's session id, or a local id. */
  readonly id: string;
  readonly provider: string;
  /** Host monotonic milliseconds on the clock shared by this browser’s events and frames. */
  readonly now: Effect.Effect<number>;
  /** The Playwright context, for anything this API does not cover. Never give it to a model. */
  readonly context: BrowserContext;
  /** Measured on a private startup page only when the provider attested a fresh context. */
  readonly captureCalibration: Option.Option<CaptureCalibration>;
  /** Open pages in the order they opened. */
  readonly pages: Effect.Effect<ReadonlyArray<Page.Page>>;
  /** The first open page, opening one when there is none. */
  readonly page: Effect.Effect<Page.Page, BrowserError>;
  readonly newPage: (url?: string) => Effect.Effect<Page.Page, BrowserError>;
  /** Live events, or replay after a cursor. A reader that falls behind fails with EventHistoryExpired. */
  readonly events: (options?: EventOptions) => Stream.Stream<RecordedEvent, BrowserError>;
  /** The latest `eventHistory` events, oldest first. */
  readonly recentEvents: Effect.Effect<ReadonlyArray<BrowserEvent>>;
}

export class Browser extends Context.Service<Browser, Service>()("effect-browser/Browser") {}

/**
 * Build the service over a context the provider owns. The provider closes the context; this only
 * tracks its pages and events, for as long as the surrounding scope is open.
 */
export const make = Effect.fn("Browser.make")(function* (
  context: BrowserContext,
  info: {
    readonly id: string;
    readonly provider: string;
    readonly contextOrigin?: ContextOrigin | undefined;
  },
  options: Options = {},
) {
  const clock = yield* Clock.Clock;
  const motion = yield* Motion.Motion;
  const ownerScope = yield* Scope.Scope;
  const now = () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6;
  const policyTimeout = Duration.fromInput(options.policyTimeout ?? Duration.minutes(5));

  if (
    Option.isNone(policyTimeout) ||
    !Number.isFinite(Duration.toMillis(policyTimeout.value)) ||
    !Duration.isPositive(policyTimeout.value)
  )
    return yield* new BrowserError({
      operation: "make",
      reason: new InvalidRequest({ detail: "policyTimeout must be finite and greater than zero" }),
      dispatched: false,
    });

  const settings: Page.Settings = {
    humanize: options.humanize ?? false,
    actionTimeout: Duration.fromInputUnsafe(options.actionTimeout ?? Duration.seconds(10)),
    navigationTimeout: Duration.fromInputUnsafe(options.navigationTimeout ?? Duration.seconds(30)),
    frameHistory: options.frameHistory ?? 60,
    guard: options.guard,
    policyTimeout: policyTimeout.value,
  };

  if (!Number.isSafeInteger(settings.frameHistory) || settings.frameHistory < 1)
    return yield* new BrowserError({
      operation: "make",
      reason: new InvalidRequest({ detail: "frameHistory must be a positive safe integer" }),
      dispatched: false,
    });

  const eventHistory = options.eventHistory ?? 4096;

  if (!Number.isSafeInteger(eventHistory) || eventHistory < 1)
    return yield* new BrowserError({
      operation: "make",
      reason: new InvalidRequest({ detail: "eventHistory must be a positive safe integer" }),
      dispatched: false,
    });

  // A caller's scripts or existing tabs can react to probe input. Providers opt fresh allocations
  // into this private phase before scripts, page registration or the public service exist.
  const captureCalibration =
    info.contextOrigin === "fresh"
      ? Option.some(
          new CaptureCalibration(
            yield* Startup.owned(context, clock).pipe(
              Effect.mapError(
                (error) =>
                  new BrowserError({
                    operation: "calibrate",
                    reason: Page.reasonOf(error.cause),
                    dispatched: false,
                  }),
              ),
            ),
          ),
        )
      : Option.none<CaptureCalibration>();

  const timeline = Timeline.make(eventHistory);

  yield* Effect.addFinalizer(() => timeline.close);
  const publish = timeline.publish;
  // One visible pointer belongs to the browser, including when input changes tabs.
  const pointer = yield* Ref.make(Option.none<Page.Point>());
  const inputLock = yield* Semaphore.make(1);

  const registry = new Map<PlaywrightPage, Page.Page>();
  const registering = yield* Semaphore.make(1);
  let counter = 0;

  const native = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new BrowserError({ operation, reason: Page.reasonOf(cause), dispatched: false }),
    });

  const releaseNative = (run: () => Promise<unknown>) =>
    Effect.tryPromise(run).pipe(
      Effect.interruptible,
      Effect.timeoutOrElse({ duration: Duration.seconds(1), orElse: () => Effect.void }),
      Effect.provideService(Clock.Clock, clock),
      Effect.ignore,
    );

  const register = (playwright: PlaywrightPage) =>
    registering.withPermits(1)(
      Effect.gen(function* () {
        const known = registry.get(playwright);

        if (known !== undefined) return known;
        if (playwright.isClosed())
          return yield* new BrowserError({
            operation: "newPage",
            reason: new Failed({ detail: "the page closed as it opened" }),
            dispatched: false,
          });
        const cdp = yield* native("newPage", () => context.newCDPSession(playwright));
        const id = `p${++counter}`;

        const page = yield* Page.make({
          id,
          playwright,
          cdp,
          settings,
          motion,
          clock,
          publish,
          pointer,
          inputLock,
        }).pipe(
          Effect.provideService(Scope.Scope, ownerScope),
          Effect.onError(() => releaseNative(() => cdp.detach())),
        );

        registry.set(playwright, page);
        playwright.on("framenavigated", (frame) => {
          if (frame === playwright.mainFrame())
            publish(new Navigated({ at: now(), page: id, url: frame.url() }));
        });
        playwright.on("close", () => {
          registry.delete(playwright);
          publish(new PageClosed({ at: now(), page: id }));
        });
        playwright.on("dialog", (dialog) => {
          const kind = dialog.type();

          publish(
            new DialogShown({ at: now(), page: id, kind, message: dialog.message().slice(0, 500) }),
          );

          const answer =
            kind === "alert" || kind === "beforeunload" ? dialog.accept() : dialog.dismiss();

          answer.catch(() => undefined);
        });
        publish(new PageOpened({ at: now(), page: id, url: playwright.url() }));

        return page;
      }),
    );

  for (const script of options.initScripts ?? [])
    yield* native("initScripts", () => context.addInitScript({ content: script }));

  // Pages opened by the site, such as popups, are registered by a fiber as Playwright reports them.
  const opened = yield* Queue.unbounded<PlaywrightPage>();

  const onPage = (playwright: PlaywrightPage) => {
    Queue.offerUnsafe(opened, playwright);
  };

  context.on("page", onPage);
  yield* Effect.addFinalizer(() => Effect.sync(() => context.off("page", onPage)));
  yield* Queue.take(opened).pipe(
    Effect.flatMap((playwright) => Effect.ignore(register(playwright))),
    Effect.forever,
    Effect.forkScoped,
  );
  for (const existing of context.pages()) yield* register(existing);

  const pages = Effect.sync(() =>
    [...registry.values()].toSorted(
      (left, right) => Number(left.id.slice(1)) - Number(right.id.slice(1)),
    ),
  );

  const newPage = (url?: string) =>
    Effect.gen(function* () {
      const playwright = yield* native("newPage", () => context.newPage());

      const page = yield* register(playwright).pipe(
        Effect.onError(() => releaseNative(() => playwright.close())),
      );

      // A rejected or interrupted navigation must not leave the newly allocated blank tab behind.
      if (url !== undefined) yield* page.goto(url).pipe(Effect.onError(() => page.close));

      return page;
    });

  const service: Service = {
    id: info.id,
    provider: info.provider,
    captureCalibration,
    now: Effect.sync(now),
    context,
    pages,
    page: pages.pipe(
      Effect.map((open) => Option.fromNullishOr(open[0])),
      Effect.flatMap(Option.match({ onNone: () => newPage(), onSome: Effect.succeed })),
    ),
    newPage,
    events: (eventOptions = {}) => timeline.stream(eventOptions.after),
    recentEvents: timeline.recent.pipe(
      Effect.map((records) => records.map((record) => record.event)),
    ),
  };

  return Browser.of(service);
});

/** A Layer over a context a provider acquires in the same scope. */
export const layer = <E, R>(
  acquire: Effect.Effect<
    { readonly context: BrowserContext; readonly id: string; readonly provider: string },
    E,
    R
  >,
  options?: Options,
): Layer.Layer<Browser, E | BrowserError, Exclude<R, Scope.Scope>> =>
  Layer.effect(
    Browser,
    Effect.flatMap(acquire, ({ context, id, provider }) =>
      make(context, { id, provider }, options),
    ),
  );
