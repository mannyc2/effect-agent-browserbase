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
  PubSub,
  Queue,
  type Scope,
  Semaphore,
  Stream,
} from "effect";
import type { BrowserContext, Page as PlaywrightPage } from "playwright-core";

import { BrowserError, Failed } from "./BrowserError.ts";
import {
  type BrowserEvent,
  DialogShown,
  Navigated,
  PageClosed,
  PageOpened,
} from "./BrowserEvent.ts";
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
  /** Events kept for `recentEvents`. Defaults to 512. */
  readonly eventHistory?: number | undefined;
  /** Checked before every input on every page. */
  readonly guard?: Page.InputGuard | undefined;
  /** Scripts every new document runs before its own, such as a consent-banner remover. */
  readonly initScripts?: ReadonlyArray<string> | undefined;
}

export interface Service {
  /** The provider's session id, or a local id. */
  readonly id: string;
  readonly provider: string;
  /** The Playwright context, for anything this API does not cover. Never give it to a model. */
  readonly context: BrowserContext;
  /** Open pages in the order they opened. */
  readonly pages: Effect.Effect<ReadonlyArray<Page.Page>>;
  /** The first open page, opening one when there is none. */
  readonly page: Effect.Effect<Page.Page, BrowserError>;
  readonly newPage: (url?: string) => Effect.Effect<Page.Page, BrowserError>;
  /** Events from the moment of subscription. */
  readonly events: Stream.Stream<BrowserEvent>;
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
  info: { readonly id: string; readonly provider: string },
  options: Options = {},
) {
  const clock = yield* Clock.Clock;
  const now = () => clock.currentTimeMillisUnsafe();

  const settings: Page.Settings = {
    humanize: options.humanize ?? false,
    actionTimeout: Duration.fromInputUnsafe(options.actionTimeout ?? Duration.seconds(10)),
    navigationTimeout: Duration.fromInputUnsafe(options.navigationTimeout ?? Duration.seconds(30)),
    frameHistory: options.frameHistory ?? 60,
    guard: options.guard,
  };

  const eventHistory = options.eventHistory ?? 512;
  const hub = yield* PubSub.sliding<BrowserEvent>(1024);
  let recent: ReadonlyArray<BrowserEvent> = [];

  const publish = (event: BrowserEvent) => {
    recent = recent.length >= eventHistory ? [...recent.slice(1), event] : [...recent, event];
    PubSub.publishUnsafe(hub, event);
  };

  const registry = new Map<PlaywrightPage, Page.Page>();
  const registering = yield* Semaphore.make(1);
  let counter = 0;

  const native = <A>(operation: string, run: () => Promise<A>) =>
    Effect.tryPromise({
      try: run,
      catch: (cause) =>
        new BrowserError({ operation, reason: Page.reasonOf(cause), dispatched: false }),
    });

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
        const page = yield* Page.make({ id, playwright, cdp, settings, clock, publish });

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
      const page = yield* register(playwright);

      if (url !== undefined) yield* page.goto(url);

      return page;
    });

  const service: Service = {
    id: info.id,
    provider: info.provider,
    context,
    pages,
    page: pages.pipe(
      Effect.map((open) => Option.fromNullishOr(open[0])),
      Effect.flatMap(Option.match({ onNone: () => newPage(), onSome: Effect.succeed })),
    ),
    newPage,
    events: Stream.fromPubSub(hub),
    recentEvents: Effect.sync(() => recent),
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
