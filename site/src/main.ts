// The site: docs pages with replays placed in the prose, the featured demo, any packed replay, and
// the Try page that records a take on a visitor's own machine. Every page is also served as
// markdown for agents; see agent.ts.
import { Duration, Effect, Option, Record, Schema, Stream } from "effect";
import { Command, type Runtime, Subscription, Update } from "foldkit";
import { scrollIntoViewAfterPaint } from "foldkit/dom";
import type { Document, Html, HtmlBuilder } from "foldkit/html";
import { defineMessageUnion } from "foldkit/message";
import { load, pushUrl, UrlRequest } from "foldkit/navigation";
import { modifyFields } from "foldkit/struct";
import { toString as urlToString, Url } from "foldkit/url";

import {
  anchorOf,
  documentOf,
  pageOf,
  prose,
  replaysOf,
  sectionsOf,
  withoutTitle,
} from "./docs.ts";
import * as Try from "./page/try.ts";
import { featuredReplay, markdownPathOf, type Page, pages, pathOf, site } from "./pages.ts";
import * as Player from "./player/player.ts";
import { view as playerView } from "./player/view.ts";
import { AppRoute, urlToAppRoute } from "./route.ts";

export { AppRoute } from "./route.ts";

// MODEL

export const Model = Schema.Struct({
  route: AppRoute,
  /** The players on the current page, by replay id. */
  players: Schema.Record(Schema.String, Player.Model),
  /** Kept across pages, so a take keeps recording while the visitor reads. */
  tryPage: Try.Model,
  notice: Schema.Option(Schema.String),
  /** Counts notices, so an older notice's timer does not clear a newer one. */
  notices: Schema.Int,
});

export type Model = typeof Model.Type;

// MESSAGE

export const Message = defineMessageUnion({
  ClickedLink: { request: UrlRequest },
  ChangedUrl: { url: Url },
  CompletedNavigateInternal: {},
  CompletedLoadExternal: {},
  CompletedScroll: {},
  GotPlayerMessage: { id: Schema.String, message: Player.Message },
  GotTryMessage: { message: Try.Message },
  ClickedCopyMarkdown: { path: Schema.String },
  ClickedCopyCode: { text: Schema.String },
  CompletedCopy: { notice: Schema.String },
  ElapsedNotice: { notices: Schema.Int },
});

export type Message = typeof Message.Type;

// COMMAND

const NavigateInternal = Command.define("NavigateInternal", {
  args: { url: Schema.String },
  messages: [Message.CompletedNavigateInternal],
  execute: ({ url }) => pushUrl(url).pipe(Effect.as(Message.CompletedNavigateInternal())),
});

const LoadExternal = Command.define("LoadExternal", {
  args: { href: Schema.String },
  messages: [Message.CompletedLoadExternal],
  execute: ({ href }) => load(href).pipe(Effect.as(Message.CompletedLoadExternal())),
});

/** Scrolls to a heading on the new page, or to the top when there is none. */
const ScrollTo = Command.define("ScrollTo", {
  args: { anchor: Schema.String },
  messages: [Message.CompletedScroll],
  execute: ({ anchor }) =>
    (anchor === ""
      ? Effect.sync(() => window.scrollTo({ top: 0 }))
      : scrollIntoViewAfterPaint(`#${CSS.escape(anchor)}`)
    ).pipe(Effect.ignore, Effect.as(Message.CompletedScroll())),
});

const copied = <E>(text: Effect.Effect<string, E>, notice: string) =>
  text.pipe(
    Effect.flatMap((value) => Effect.tryPromise(() => navigator.clipboard.writeText(value))),
    Effect.as(Message.CompletedCopy({ notice })),
    Effect.orElseSucceed(() => Message.CompletedCopy({ notice: "The browser blocked copying" })),
  );

/** Copies the page as an agent reads it: the markdown the site serves beside it. */
const CopyMarkdown = Command.define("CopyMarkdown", {
  args: { path: Schema.String },
  messages: [Message.CompletedCopy],
  execute: ({ path }) =>
    copied(
      Effect.tryPromise(async () => {
        const response = await fetch(path);

        if (!response.ok) throw new Error(`${path} answered ${response.status}`);

        return response.text();
      }),
      "Copied the page as Markdown",
    ),
});

const CopyCode = Command.define("CopyCode", {
  args: { text: Schema.String },
  messages: [Message.CompletedCopy],
  execute: ({ text }) => copied(Effect.succeed(text), "Copied"),
});

const ElapseNotice = Command.define("ElapseNotice", {
  args: { notices: Schema.Int },
  messages: [Message.ElapsedNotice],
  execute: ({ notices }) =>
    Effect.sleep(Duration.seconds(2)).pipe(Effect.as(Message.ElapsedNotice({ notices }))),
});

// INIT

/** The replays a route shows, by id. */
export const replaysOn = (route: AppRoute): ReadonlyArray<string> =>
  AppRoute.match(route, {
    Home: () => replaysOf({ slug: "index" }),
    Doc: ({ slug }) => replaysOf({ slug }),
    Demo: () => [featuredReplay],
    Replay: ({ id }) => [id],
    Try: () => [],
    NotFound: () => [],
  });

const toPlayerMessage = (id: string) => (message: Player.Message) =>
  Message.GotPlayerMessage({ id, message });

const toTryMessage = (message: Try.Message) => Message.GotTryMessage({ message });

/** Shows a route: fresh players for its replays, and the runner looked up on the Try page. */
const enter = (model: Model, route: AppRoute): Update.Return<Model, Message> => {
  const players = replaysOn(route).map((id) => ({ id, ...Player.init(id) }));

  const tryCommands =
    route._tag === "Try" && model.tryPage.runner._tag === "Checking" ? Try.init().commands : [];

  return {
    model: modifyFields(model, {
      route: () => route,
      players: () => Object.fromEntries(players.map(({ id, model }) => [id, model])),
    }),
    commands: [
      ...players.flatMap(({ id, commands }) => Command.mapMessages(commands, toPlayerMessage(id))),
      ...Command.mapMessages(tryCommands, toTryMessage),
    ],
  };
};

export const init: Runtime.RoutingApplicationInit<Model, Message> = (url) =>
  enter(
    Model.make({
      route: AppRoute.Home(),
      players: {},
      tryPage: Try.init().model,
      notice: Option.none(),
      notices: 0,
    }),
    urlToAppRoute(url),
  );

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

/** Files the site serves beside its pages, which the browser opens itself. */
const isFile = (url: Url) =>
  /\.[a-z0-9]+$/i.test(url.pathname) ||
  url.pathname.startsWith("/replays/") ||
  url.pathname.startsWith("/api/");

const samePlace = (left: AppRoute, right: AppRoute) =>
  JSON.stringify(left) === JSON.stringify(right);

const foldPlayer = Update.foldChildAt({
  update: Player.update,
  readAt: (model: Model, id: string) => Record.get(model.players, id),
  writeAt: (model, id, player) =>
    modifyFields(model, { players: (players) => ({ ...players, [id]: player }) }),
  toParentMessage: (id, message) => Message.GotPlayerMessage({ id, message }),
});

const foldTry = Update.foldChild({
  update: Try.update,
  read: (model: Model) => Option.some(model.tryPage),
  write: (model, tryPage) => modifyFields(model, { tryPage: () => tryPage }),
  toParentMessage: toTryMessage,
});

const notify = (model: Model, notice: string): UpdateReturn => {
  const notices = model.notices + 1;

  return {
    model: modifyFields(model, { notice: () => Option.some(notice), notices: () => notices }),
    commands: [ElapseNotice({ notices })],
  };
};

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    ClickedLink: ({ request }) =>
      UrlRequest.match<UpdateReturn>(request, {
        Internal: ({ url }) => ({
          model,
          commands: [
            isFile(url)
              ? LoadExternal({ href: urlToString(url) })
              : NavigateInternal({ url: urlToString(url) }),
          ],
        }),
        External: ({ href }) => ({ model, commands: [LoadExternal({ href })] }),
      }),
    ChangedUrl: ({ url }) => {
      const route = urlToAppRoute(url);
      const anchor = Option.getOrElse(url.hash, () => "");

      if (samePlace(route, model.route))
        return { model, commands: anchor === "" ? [] : [ScrollTo({ anchor })] };
      const entered = enter(model, route);

      return {
        model: entered.model,
        commands: [...(entered.commands ?? []), ScrollTo({ anchor })],
      };
    },
    CompletedNavigateInternal: () => ({ model }),
    CompletedLoadExternal: () => ({ model }),
    CompletedScroll: () => ({ model }),
    GotPlayerMessage: ({ id, message }) => foldPlayer(model, id, message),
    GotTryMessage: ({ message }) => foldTry(model, message),
    ClickedCopyMarkdown: ({ path }) => ({ model, commands: [CopyMarkdown({ path })] }),
    ClickedCopyCode: ({ text }) => ({ model, commands: [CopyCode({ text })] }),
    CompletedCopy: ({ notice }) => notify(model, notice),
    ElapsedNotice: ({ notices }) =>
      notices === model.notices
        ? { model: modifyFields(model, { notice: () => Option.none() }) }
        : { model },
  });

// SUBSCRIPTION

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  pollTake: entry(
    { recording: Schema.Boolean },
    {
      modelToDependencies: (model) => ({ recording: model.tryPage.take._tag === "Recording" }),
      dependenciesToStream: ({ recording }) =>
        Try.pollStream(recording).pipe(Stream.map(toTryMessage)),
    },
  ),
}));

// VIEW

type H = HtmlBuilder<Message>;

const container = "mx-auto w-full max-w-6xl px-4 sm:px-6";

const githubIcon = (h: H) =>
  h.svg(
    [h.ViewBox("0 0 16 16"), h.Class("size-4"), h.Fill("currentColor"), h.AriaHidden(true)],
    [
      h.path([
        h.D(
          "M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27.68 0 1.36.09 2 .27 1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.013 8.013 0 0016 8c0-4.42-3.58-8-8-8z",
        ),
      ]),
    ],
  );

const mark = (h: H) =>
  h.span(
    [
      h.Class(
        "grid size-6 place-items-center rounded-md bg-stone-900 text-[0.6875rem] font-bold text-amber-400 dark:bg-amber-400 dark:text-stone-950",
      ),
      h.AriaHidden(true),
    ],
    ["eb"],
  );

const navLink = (h: H, href: string, label: string, active: boolean) =>
  h.a(
    [
      h.Href(href),
      h.Class(
        `rounded-md px-2 py-1 text-sm whitespace-nowrap transition sm:px-2.5 ${
          active
            ? "font-semibold text-stone-950 dark:text-white"
            : "text-stone-600 hover:text-stone-950 dark:text-stone-400 dark:hover:text-white"
        }`,
      ),
    ],
    [label],
  );

const headerView = (route: AppRoute, h: H): Html =>
  h.header(
    [
      h.Class(
        "sticky top-0 z-30 border-b border-stone-200/80 bg-stone-50/85 backdrop-blur dark:border-stone-800/80 dark:bg-stone-950/85",
      ),
    ],
    [
      h.div(
        [h.Class(`${container} flex h-14 items-center justify-between gap-3`)],
        [
          h.a(
            [h.Href("/"), h.Class("flex items-center gap-2 font-semibold tracking-tight")],
            [
              mark(h),
              h.span([h.Class("hidden whitespace-nowrap min-[360px]:inline")], [site.name]),
            ],
          ),
          h.nav(
            [h.AriaLabel("Site"), h.Class("flex items-center gap-0.5")],
            [
              navLink(h, "/docs/get-started", "Docs", route._tag === "Doc"),
              navLink(h, "/demo", "Demo", route._tag === "Demo" || route._tag === "Replay"),
              navLink(h, "/try", "Try it", route._tag === "Try"),
              h.a(
                [
                  h.Href(site.repository),
                  h.AriaLabel("GitHub repository"),
                  h.Class(
                    "ml-1 rounded-md p-1.5 text-stone-600 hover:text-stone-950 dark:text-stone-400 dark:hover:text-white",
                  ),
                ],
                [githubIcon(h)],
              ),
            ],
          ),
        ],
      ),
    ],
  );

const footerView = (h: H): Html =>
  h.footer(
    [h.Class("mt-24 border-t border-stone-200 dark:border-stone-800")],
    [
      h.div(
        [
          h.Class(
            `${container} flex flex-col gap-3 py-8 text-sm text-stone-500 sm:flex-row sm:items-center sm:justify-between`,
          ),
        ],
        [
          h.p([], [`${site.name} · MIT · built with Foldkit on Cloudflare`]),
          h.p(
            [h.Class("flex flex-wrap gap-x-4 gap-y-1")],
            [
              h.a(
                [h.Href("/llms.txt"), h.Class("hover:text-stone-900 dark:hover:text-white")],
                ["llms.txt"],
              ),
              h.a(
                [h.Href("/docs/for-agents"), h.Class("hover:text-stone-900 dark:hover:text-white")],
                ["For AI agents"],
              ),
              h.a(
                [h.Href(site.repository), h.Class("hover:text-stone-900 dark:hover:text-white")],
                ["Source"],
              ),
            ],
          ),
        ],
      ),
    ],
  );

const noticeView = (model: Model, h: H): Html =>
  h.div(
    [
      h.AriaLive("polite"),
      h.Class(
        "pointer-events-none fixed inset-x-0 bottom-[max(1rem,env(safe-area-inset-bottom))] z-40 flex justify-center px-4",
      ),
    ],
    [
      Option.match(model.notice, {
        onNone: () => h.empty,
        onSome: (notice) =>
          h.p(
            [
              h.Class(
                "rounded-full bg-stone-900 px-4 py-2 text-sm font-medium text-white shadow-lg dark:bg-stone-100 dark:text-stone-900",
              ),
            ],
            [notice],
          ),
      }),
    ],
  );

const playerSlot = (model: Model, id: string, h: H): Html =>
  Option.match(Record.get(model.players, id), {
    onNone: () => h.empty,
    onSome: (player) =>
      h.submodel({
        slotId: `player-${id}`,
        model: player,
        view: playerView,
        toParentMessage: toPlayerMessage(id),
      }),
  });

const pageProse = (model: Model, page: Pick<Page, "slug">, h: H): Html =>
  Option.match(documentOf(page), {
    onNone: () => h.empty,
    onSome: (document) =>
      prose(
        withoutTitle(document),
        {
          replay: (id) => playerSlot(model, id, h),
          copy: (text) => Message.ClickedCopyCode({ text }),
        },
        h,
      ),
  });

const button = (variant: "primary" | "secondary") =>
  variant === "primary"
    ? "inline-flex h-10 items-center rounded-lg bg-stone-900 px-4 text-sm font-semibold text-white shadow-sm transition hover:bg-stone-700 dark:bg-amber-400 dark:text-stone-950 dark:hover:bg-amber-300"
    : "inline-flex h-10 items-center rounded-lg px-4 text-sm font-semibold text-stone-800 ring-1 ring-stone-300 transition hover:bg-white hover:ring-stone-400 dark:text-stone-200 dark:ring-stone-700 dark:hover:bg-stone-900";

const cardsView = (h: H): Html =>
  h.ul(
    [h.Class("grid gap-3 sm:grid-cols-2 lg:grid-cols-3")],
    pages
      .filter((page) => page.slug !== "index")
      .map((page) =>
        h.li(
          [],
          [
            h.a(
              [
                h.Href(pathOf(page)),
                h.Class(
                  "flex h-full flex-col gap-1 rounded-xl bg-white p-4 ring-1 ring-stone-200 transition hover:-translate-y-0.5 hover:ring-stone-300 hover:shadow-sm dark:bg-stone-900 dark:ring-stone-800 dark:hover:ring-stone-700",
                ),
              ],
              [
                h.span(
                  [
                    h.Class(
                      "text-[0.6875rem] font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400",
                    ),
                  ],
                  [page.section],
                ),
                h.span([h.Class("font-semibold")], [page.title]),
                h.span([h.Class("text-sm text-stone-600 dark:text-stone-400")], [page.summary]),
              ],
            ),
          ],
        ),
      ),
  );

const homeView = (model: Model, h: H): Html =>
  h.div(
    [h.Class(container)],
    [
      h.section(
        [h.Class("flex flex-col items-start gap-5 pt-14 pb-10 sm:pt-20")],
        [
          h.p(
            [
              h.Class(
                "rounded-full bg-amber-100 px-3 py-1 text-xs font-semibold text-amber-900 dark:bg-amber-400/15 dark:text-amber-300",
              ),
            ],
            ["Effect · Playwright · Browserbase"],
          ),
          h.h1(
            [h.Class("max-w-3xl text-4xl font-semibold tracking-tight text-balance sm:text-5xl")],
            ["Browser automation for Effect agents, built to be watched."],
          ),
          h.p(
            [h.Class("max-w-2xl text-lg text-pretty text-stone-600 dark:text-stone-400")],
            [
              "Drive Chromium or a Browserbase session from Effect. Give models compact page outlines and what changed. Perform input at a person's pace, and record the run so anyone can watch it back.",
            ],
          ),
          h.div(
            [h.Class("flex flex-wrap gap-3")],
            [
              h.a([h.Href("/demo"), h.Class(button("primary"))], ["Watch the demo"]),
              h.a([h.Href("/docs/get-started"), h.Class(button("secondary"))], ["Get started"]),
              h.a([h.Href("/try"), h.Class(button("secondary"))], ["Run it yourself"]),
            ],
          ),
        ],
      ),
      h.article([h.Class("max-w-3xl")], [pageProse(model, { slug: "index" }, h)]),
      h.section(
        [h.Class("mt-16 flex flex-col gap-4")],
        [h.h2([h.Class("text-xl font-semibold tracking-tight")], ["Read on"]), cardsView(h)],
      ),
    ],
  );

/** The home page is the docs' overview. */
const titleOf = (page: Page) => (page.slug === "index" ? "Overview" : page.title);

const sidebarLinks = (current: string, h: H): ReadonlyArray<Html> =>
  (["Start", "Guides", "Site"] as const).map((section) =>
    h.div(
      [h.Class("flex flex-col gap-1")],
      [
        h.p(
          [h.Class("px-2 text-[0.6875rem] font-semibold tracking-wide text-stone-500 uppercase")],
          [section],
        ),
        h.ul(
          [h.Class("flex flex-col")],
          pages
            .filter((page) => page.section === section)
            .map((page) =>
              h.li(
                [],
                [
                  h.a(
                    [
                      h.Href(pathOf(page)),
                      h.Class(
                        `block rounded-md px-2 py-1.5 text-sm ${
                          page.slug === current
                            ? "bg-amber-100 font-semibold text-stone-950 dark:bg-amber-400/15 dark:text-white"
                            : "text-stone-600 hover:bg-stone-100 hover:text-stone-950 dark:text-stone-400 dark:hover:bg-stone-900 dark:hover:text-white"
                        }`,
                      ),
                    ],
                    [titleOf(page)],
                  ),
                ],
              ),
            ),
        ),
      ],
    ),
  );

const pagerView = (page: Page, h: H): Html => {
  const index = pages.indexOf(page);

  const link = (target: Page | undefined, label: string, align: string) =>
    target === undefined
      ? h.span([], [])
      : h.a(
          [
            h.Href(pathOf(target)),
            h.Class(
              `flex flex-col gap-0.5 rounded-xl p-4 ring-1 ring-stone-200 transition hover:ring-stone-300 dark:ring-stone-800 dark:hover:ring-stone-700 ${align}`,
            ),
          ],
          [
            h.span([h.Class("text-xs text-stone-500")], [label]),
            h.span([h.Class("font-semibold")], [titleOf(target)]),
          ],
        );

  return h.nav(
    [h.AriaLabel("Pages"), h.Class("mt-14 grid gap-3 sm:grid-cols-2")],
    [link(pages[index - 1], "Previous", ""), link(pages[index + 1], "Next", "sm:text-right")],
  );
};

const docView = (model: Model, page: Page, h: H): Html => {
  const sections = Option.match(documentOf(page), { onNone: () => [], onSome: sectionsOf });

  return h.div(
    [
      h.Class(
        `${container} grid gap-10 pt-8 lg:grid-cols-[13rem_minmax(0,1fr)] xl:grid-cols-[13rem_minmax(0,1fr)_12rem]`,
      ),
    ],
    [
      h.aside(
        [h.Class("hidden lg:block")],
        [
          h.nav(
            [h.AriaLabel("Docs"), h.Class("sticky top-20 flex flex-col gap-6")],
            sidebarLinks(page.slug, h),
          ),
        ],
      ),
      h.article(
        [h.Class("min-w-0 max-w-3xl")],
        [
          h.details(
            [h.Class("mb-6 rounded-xl ring-1 ring-stone-200 lg:hidden dark:ring-stone-800")],
            [
              h.summary(
                [h.Class("cursor-pointer px-4 py-2.5 text-sm font-medium")],
                [`Docs · ${page.title}`],
              ),
              h.nav(
                [h.AriaLabel("Docs"), h.Class("flex flex-col gap-4 px-2 pb-3")],
                sidebarLinks(page.slug, h),
              ),
            ],
          ),
          h.p(
            [
              h.Class(
                "text-xs font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400",
              ),
            ],
            [page.section],
          ),
          h.h1([h.Class("mt-1 text-3xl font-semibold tracking-tight sm:text-4xl")], [page.title]),
          h.p([h.Class("mt-3 text-lg text-stone-600 dark:text-stone-400")], [page.summary]),
          h.div(
            [
              h.Class(
                "mt-5 flex flex-wrap items-center gap-2 border-b border-stone-200 pb-5 dark:border-stone-800",
              ),
            ],
            [
              h.button(
                [
                  h.Type("button"),
                  h.Class(
                    "rounded-md px-2.5 py-1 text-xs font-medium text-stone-700 ring-1 ring-stone-300 hover:bg-white dark:text-stone-300 dark:ring-stone-700 dark:hover:bg-stone-900",
                  ),
                  h.OnClick(Message.ClickedCopyMarkdown({ path: markdownPathOf(page) })),
                ],
                ["Copy page as Markdown"],
              ),
              h.a(
                [
                  h.Href(markdownPathOf(page)),
                  h.Class(
                    "rounded-md px-2.5 py-1 text-xs font-medium text-stone-600 hover:text-stone-950 dark:text-stone-400 dark:hover:text-white",
                  ),
                ],
                ["View as Markdown"],
              ),
            ],
          ),
          pageProse(model, page, h),
          pagerView(page, h),
        ],
      ),
      sections.length === 0
        ? h.empty
        : h.aside(
            [h.Class("hidden xl:block")],
            [
              h.nav(
                [h.AriaLabel("On this page"), h.Class("sticky top-20 flex flex-col gap-2 text-sm")],
                [
                  h.p(
                    [
                      h.Class(
                        "text-[0.6875rem] font-semibold tracking-wide text-stone-500 uppercase",
                      ),
                    ],
                    ["On this page"],
                  ),
                  ...sections.map((section) =>
                    h.a(
                      [
                        h.Href(`#${anchorOf(section)}`),
                        h.Class(
                          "text-stone-600 hover:text-stone-950 dark:text-stone-400 dark:hover:text-white",
                        ),
                      ],
                      [section],
                    ),
                  ),
                ],
              ),
            ],
          ),
    ],
  );
};

const intro = (h: H, eyebrow: string, title: string, lede: ReadonlyArray<Html | string>) =>
  h.div(
    [h.Class("flex max-w-3xl flex-col gap-3 pt-10 pb-6")],
    [
      h.p(
        [
          h.Class(
            "text-xs font-semibold tracking-wide text-amber-700 uppercase dark:text-amber-400",
          ),
        ],
        [eyebrow],
      ),
      h.h1([h.Class("text-3xl font-semibold tracking-tight text-balance sm:text-4xl")], [title]),
      h.p([h.Class("text-base text-pretty text-stone-600 sm:text-lg dark:text-stone-400")], lede),
    ],
  );

const inlineLink = (h: H, href: string, label: string) =>
  h.a(
    [
      h.Href(href),
      h.Class(
        "font-medium text-stone-900 underline decoration-amber-500/60 decoration-2 underline-offset-[3px] hover:decoration-amber-500 dark:text-stone-100",
      ),
    ],
    [label],
  );

const demoView = (model: Model, h: H): Html =>
  h.div(
    [h.Class(container)],
    [
      intro(h, "Demo", "An agent explores Polymarket while a narrator watches", [
        "One take, recorded in a real Chromium: the agent browses on its own and reports a market, a narrator describes what each moment shows in its own voice, and the report is checked against Polymarket's public API. ",
        inlineLink(h, "/docs/moments-and-narration", "How the narration works"),
        " · ",
        inlineLink(h, "/try", "Record your own take"),
      ]),
      playerSlot(model, featuredReplay, h),
    ],
  );

const replayView = (model: Model, id: string, h: H): Html =>
  h.div(
    [h.Class(container)],
    [
      intro(h, "Replay", id, [
        "A packed recording: video, narration, captions and the agent's steps. Its data is at ",
        inlineLink(h, `${Player.baseOf(id)}/replay.json`, "replay.json"),
        ".",
      ]),
      playerSlot(model, id, h),
    ],
  );

const tryView = (model: Model, h: H): Html =>
  h.div(
    [h.Class(container)],
    [
      intro(h, "Try it", "Record a take on your machine", [
        "Your Chromium, your model key, your spending cap. ",
        inlineLink(h, "/docs/run-the-demo", "What a take does and costs"),
      ]),
      h.div(
        [h.Class("max-w-3xl")],
        [
          h.submodel({
            slotId: "try",
            model: model.tryPage,
            view: Try.view,
            toParentMessage: toTryMessage,
          }),
        ],
      ),
    ],
  );

const notFoundView = (path: string, h: H): Html =>
  h.div(
    [h.Class(container)],
    [
      intro(h, "404", "Nothing here", [
        `No page at ${path}. `,
        inlineLink(h, "/", "Go home"),
        " or ",
        inlineLink(h, "/llms.txt", "read the index for agents"),
        ".",
      ]),
    ],
  );

const titled = (title: string) => (title === site.name ? site.name : `${title} · ${site.name}`);

export const view = (model: Model, h: H): Document => {
  const [title, body] = AppRoute.match(model.route, {
    Home: () => [site.name, homeView(model, h)] as const,
    Doc: ({ slug }) =>
      Option.match(pageOf(slug), {
        onNone: () => ["Not found", notFoundView(`/docs/${slug}`, h)] as const,
        onSome: (page) => [page.title, docView(model, page, h)] as const,
      }),
    Demo: () => ["Demo", demoView(model, h)] as const,
    Replay: ({ id }) => [`Replay ${id}`, replayView(model, id, h)] as const,
    Try: () => ["Try it", tryView(model, h)] as const,
    NotFound: ({ path }) => ["Not found", notFoundView(path, h)] as const,
  });

  return {
    title: titled(title),
    body: h.div(
      [h.Class("flex min-h-dvh flex-col")],
      [
        headerView(model.route, h),
        h.main([h.Class("flex-1")], [body]),
        footerView(h),
        noticeView(model, h),
      ],
    ),
  };
};
