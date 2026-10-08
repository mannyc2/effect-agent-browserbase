// A browser's pages and their life story: each page's name across connections, how a page or the
// whole browser is lost and why, the documents a page moves through, and the addresses it reports.
import { assert, describe, it } from "@effect/vitest";
import {
  Arbitrary,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Schedule,
  Schema,
  Scope,
  Stream,
} from "effect";

import type * as Browser from "../src/Browser.ts";
import type { BrowserError } from "../src/BrowserError.ts";
import type { BrowserEvent } from "../src/BrowserEvent.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Url from "../src/internal/page/url.ts";
import type { Page } from "../src/Page.ts";
import { Site, SiteLayer } from "./fixtures.ts";
import { behindProxy } from "./protocol.ts";

const still = (title: string) =>
  `data:text/html,${encodeURIComponent(`<title>${title}</title><h1>${title}</h1>`)}`;

/** A connection in a scope of its own, so a test can end it and connect again. */
const connect = (endpoint: string, options: Partial<Cdp.Options> = {}) =>
  Effect.gen(function* () {
    const scope = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));
    const browser = yield* Cdp.open({ ...options, endpoint }).pipe(Scope.provide(scope));

    return { browser, end: Scope.close(scope, Exit.void) };
  });

const found = (browser: Browser.Service, id: string) =>
  Effect.map(
    browser.page(id),
    Option.map((page) => page.playwright.url()),
  );

/** A page's failure: its reason, and why the page is gone. */
const lossOf = (error: BrowserError) => ({
  reason: error.reason._tag,
  cause: error.reason._tag === "Closed" ? error.reason.cause : undefined,
});

/** The browser's events since `from` of them were recorded. */
const since = (browser: Browser.Service, from: number) =>
  Effect.map(browser.recentEvents, (events) => events.slice(from));

const losses = (events: ReadonlyArray<BrowserEvent>) =>
  events.flatMap((event) =>
    event._tag === "Disconnected" || event._tag === "PageClosed"
      ? [`${event._tag} ${event.cause}`]
      : [],
  );

/** A page that keeps its renderer busy for a while, so a call to it is still waiting. */
const holdRenderer = (page: Page, millis: number) =>
  Effect.promise(() =>
    page.playwright.evaluate((busy) => {
      setTimeout(() => {
        const end = Date.now() + busy;

        while (Date.now() < end);
      }, 50);
    }, millis),
  ).pipe(Effect.andThen(Effect.sleep("150 millis")));

describe("a page's name", () => {
  // Positional ids would shift here: the page after the one closed would take its number.
  it.live("is its target id, the same on every connection, closing one in between", () =>
    Effect.gen(function* () {
      const proxy = yield* behindProxy();
      const first = yield* connect(proxy.endpoint);
      const titles = ["one", "two", "three"];
      const opened = yield* Effect.forEach(titles, (title) => first.browser.newPage(still(title)));
      const all = (yield* first.browser.pages).map((page) => page.id);

      yield* first.end;
      // The owner's scope closing the browser loses it, as released.
      assert.strictEqual(yield* first.browser.disconnected, "released");

      const second = yield* connect(proxy.endpoint);

      for (const [index, page] of opened.entries())
        assert.deepStrictEqual(
          yield* found(second.browser, page.id),
          Option.some(still(titles[index] ?? "")),
        );
      const two = Option.getOrThrow(yield* second.browser.page(opened[1]?.id ?? ""));

      yield* two.close;
      yield* second.end;

      const third = yield* connect(proxy.endpoint);

      assert.sameMembers(
        (yield* third.browser.pages).map((page) => page.id),
        all.filter((id) => id !== two.id),
      );
      assert.isTrue(Option.isNone(yield* third.browser.page(two.id)));
      assert.deepStrictEqual(
        yield* found(third.browser, opened[2]?.id ?? ""),
        Option.some(still("three")),
      );
    }).pipe(Effect.scoped),
  );
});

describe("a loss", () => {
  // The connection drops while a read waits on a busy page and a navigation on a server that
  // answers late. Playwright never answers the read, on the library's own session, and fails the
  // navigation as each page closes, before the context does.
  it.live("of the connection fails each page Closed by the connection, as one Disconnected", () =>
    Effect.gen(function* () {
      const site = yield* Site;
      const proxy = yield* behindProxy();
      const { browser } = yield* connect(proxy.endpoint);
      const page = yield* browser.newPage(still("one"));
      const other = yield* browser.newPage(still("two"));
      const from = (yield* browser.recentEvents).length;

      const watching = yield* other
        .screencast()
        .pipe(Stream.runDrain, Effect.flip, Effect.forkChild);

      yield* holdRenderer(page, 2000);
      const reading = yield* Effect.forkChild(Effect.flip(page.text()));
      const navigating = yield* Effect.forkChild(Effect.flip(other.goto(site.url("/late"))));

      yield* Effect.sleep("100 millis");
      proxy.drop();
      assert.strictEqual(yield* browser.disconnected, "connection");

      for (const [error, dispatched] of [
        [yield* Fiber.join(reading), false],
        [yield* Fiber.join(navigating), true],
        [yield* Fiber.join(watching), false],
        [yield* Effect.flip(page.snapshot()), false],
      ] as const) {
        assert.deepStrictEqual(lossOf(error), { reason: "Closed", cause: "connection" });
        assert.strictEqual(error.dispatched, dispatched);
      }
      // The browser ran on, so a new connection finds the page under its name. By then the first
      // connection has published whatever its pages' closes would.
      const again = yield* connect(proxy.endpoint);

      assert.deepStrictEqual(yield* found(again.browser, page.id), Option.some(still("one")));
      assert.deepStrictEqual(losses(yield* since(browser, from)), ["Disconnected connection"]);
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  );

  it.live("of the session, at its end, is the session's, which the browser announced", () =>
    Effect.gen(function* () {
      const proxy = yield* behindProxy();
      const expiresAt = yield* DateTime.now;
      const { browser } = yield* connect(proxy.endpoint, { expiresAt });
      const page = yield* browser.newPage(still("one"));

      assert.strictEqual(browser.expiresAt, expiresAt);
      assert.deepStrictEqual(
        (yield* browser.recentEvents).flatMap((event) =>
          event._tag === "SessionEnding" ? [DateTime.toEpochMillis(event.expiresAt)] : [],
        ),
        [DateTime.toEpochMillis(expiresAt)],
      );
      proxy.drop();
      assert.strictEqual(yield* browser.disconnected, "session");
      assert.deepStrictEqual(lossOf(yield* Effect.flip(page.text())), {
        reason: "Closed",
        cause: "session",
      });
      assert.deepStrictEqual(losses(yield* browser.recentEvents), ["Disconnected session"]);
    }).pipe(Effect.scoped),
  );

  // A crashed page's calls never return, so the browser closes it and they fail at once.
  it.live("of a crashed page closes it, failing its calls Closed as crashed", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open({ actionTimeout: Duration.seconds(3) });
      const page = yield* browser.newPage(still("doomed"));
      const from = (yield* browser.recentEvents).length;
      const session = yield* Effect.promise(() => browser.context.newCDPSession(page.playwright));

      void session.send("Page.crash").catch(() => undefined);
      assert.deepStrictEqual(lossOf(yield* Effect.flip(page.text())), {
        reason: "Closed",
        cause: "crashed",
      });
      assert.isTrue(page.playwright.isClosed());

      const events = yield* since(browser, from).pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (recent) => losses(recent).length > 0,
        }),
        Effect.timeout("5 seconds"),
      );

      assert.deepStrictEqual(losses(events), ["PageClosed crashed"]);
      assert.notInclude(yield* browser.pages, page);
    }).pipe(Effect.scoped),
  );
});

describe("a page's documents", () => {
  it.live("are counted as it moves, apart from moves within one, and tag each frame", () =>
    Effect.gen(function* () {
      const site = yield* Site;
      const browser = yield* Chromium.open();
      const page = yield* browser.newPage(site.url("/form"));

      yield* Effect.promise(() =>
        page.playwright.evaluate(() =>
          history.pushState({}, "", "/form?ticker=ETH&access_token=s3cret#top"),
        ),
      );
      yield* page.goto(site.url("/next"));
      const frame = yield* page.frame({ maxAge: 0 });

      const captured = yield* page
        .screencast()
        .pipe(Stream.take(1), Stream.runHead, Effect.map(Option.getOrThrow));

      // A document's `load` can follow the navigation's return.
      const loadedSince = (events: ReadonlyArray<BrowserEvent>) =>
        events
          .slice(events.findLastIndex((event) => event._tag === "Navigated"))
          .flatMap((event) => (event._tag === "PageLoaded" ? [event.state] : []));

      const events = yield* page.recentEvents.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (recent) => loadedSince(recent).includes("load"),
        }),
        Effect.timeout("5 seconds"),
      );

      assert.deepStrictEqual(
        events.flatMap((event) =>
          event._tag === "Navigated" ? [[event.document, event.sameDocument, event.url]] : [],
        ),
        [
          [1, false, site.url("/form")],
          [1, true, site.url("/form?ticker=ETH#top")],
          [2, false, site.url("/next")],
        ],
      );
      assert.deepStrictEqual(loadedSince(events), ["domcontentloaded", "load"]);
      for (const shown of [frame, captured])
        assert.deepStrictEqual([shown.document, shown.url], [2, site.url("/next")]);
      assert.notInclude(JSON.stringify(events), "s3cret");
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  );
});

describe("init scripts", () => {
  // The site serves both loopback names, two origins; the popup is the form's link to `/next`.
  it.live("run where their match allows, in a popup's first document too", () =>
    Effect.gen(function* () {
      const site = yield* Site;

      const browser = yield* Chromium.open({
        initScripts: [
          {
            match: /^http:\/\/localhost:/,
            source: "const origin = 'localhost'; window.marked = origin;",
          },
          { source: "window.everywhere = true;" },
        ],
      });

      const marks = (page: Page) =>
        Effect.promise(() =>
          page.playwright.evaluate(() => {
            const marked = window as unknown as { marked?: string; everywhere?: boolean };

            return [marked.marked ?? null, marked.everywhere ?? null];
          }),
        );

      const loopback = yield* browser.newPage(site.url("/form"));
      const named = yield* browser.newPage(site.url("/form").replace("127.0.0.1", "localhost"));

      assert.deepStrictEqual(yield* marks(loopback), [null, true]);
      assert.deepStrictEqual(yield* marks(named), ["localhost", true]);

      const [link] = yield* named.find({ role: "link", name: "Open in a new tab" });

      yield* named.click(link?.ref ?? "");

      const popup = yield* browser.pages.pipe(
        Effect.map((open) => open.at(-1)),
        Effect.repeat({
          schedule: Schedule.spaced("20 millis"),
          until: (newest) => newest !== undefined && newest !== named,
        }),
        Effect.timeout("5 seconds"),
        Effect.map((newest) => newest as Page),
      );

      yield* Effect.promise(() => popup.playwright.waitForLoadState("domcontentloaded"));
      assert.match(popup.playwright.url(), /^http:\/\/localhost:\d+\/next$/);
      assert.deepStrictEqual(yield* marks(popup), ["localhost", true]);
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  );
});

// Names that carry credentials, as sign-ins, signed links and APIs write them, and names that do
// not, among them some that only contain one of those words.
const secretNames = Schema.Literals([
  "token",
  "access_token",
  "id_token",
  "Refresh-Token",
  "X-Amz-Signature",
  "X-Amz-Credential",
  "X-Amz-Security-Token",
  "X-Goog-Signature",
  "sig",
  "signature",
  "key",
  "api_key",
  "apiKey",
  "code",
  "client_secret",
  "password",
  "pwd",
  "PHPSESSID",
  "session_id",
  "jwt",
  "auth",
  "ticket",
  "code_verifier",
  "client_assertion",
  "SAMLResponse",
  "otp",
]);

const plainNames = Schema.Literals([
  "ticker",
  "q",
  "page",
  "sort",
  "lang",
  "id",
  "symbol",
  "ref",
  "keyword",
  "zipcode",
  "promo_code",
  "state",
  "view",
  "author",
]);

const parameter = Arbitrary.all({
  secret: Arbitrary.schema(Schema.Boolean),
  hidden: Arbitrary.schema(secretNames),
  plain: Arbitrary.schema(plainNames),
  // An address holds text, never a lone surrogate.
  value: Arbitrary.schema(Schema.String).pipe(Arbitrary.filter((value) => !/\p{Cs}/u.test(value))),
}).pipe(
  Arbitrary.map(({ secret, hidden, plain, value }) => ({
    secret,
    name: secret ? hidden : plain,
    value,
  })),
);

type Parameter = { readonly secret: boolean; readonly name: string; readonly value: string };

const written = (parameters: ReadonlyArray<Parameter>) =>
  parameters
    .map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");

const kept = (parameters: ReadonlyArray<Parameter>) =>
  parameters.filter((each) => !each.secret).map(({ name, value }) => [name, value]);

describe("an address", () => {
  it.prop(
    "keeps its origin, path and plain parameters in order, and loses its secrets",
    {
      scheme: Arbitrary.schema(Schema.Literals(["http", "https"])),
      userinfo: Arbitrary.schema(Schema.Literals(["", "ada@", "ada:pass@"])),
      host: Arbitrary.schema(
        Schema.Literals(["chart.example", "shop.example.org", "127.0.0.1:8080", "localhost:3000"]),
      ),
      path: Arbitrary.array(Arbitrary.schema(Schema.Literals(["chart", "markets", "x y", "ü"])), {
        maxLength: 3,
      }),
      query: Arbitrary.array(parameter, { maxLength: 6 }),
      route: Arbitrary.schema(Schema.Literals(["", "/inbox?"])),
      fragment: Arbitrary.array(parameter, { maxLength: 4 }),
    },
    ({ scheme, userinfo, host, path, query, route, fragment }) => {
      const address =
        `${scheme}://${userinfo}${host}/${path.map(encodeURIComponent).join("/")}` +
        (query.length === 0 ? "" : `?${written(query)}`) +
        (fragment.length === 0 ? "" : `#${route}${written(fragment)}`);

      const original = new URL(address);
      const reported = Url.redact(address);
      const redacted = new URL(reported);

      assert.deepStrictEqual([redacted.username, redacted.password], ["", ""]);
      assert.deepStrictEqual(
        [redacted.origin, redacted.pathname],
        [original.origin, original.pathname],
      );
      assert.deepStrictEqual([...redacted.searchParams], kept(query));
      const tail = redacted.hash.slice(1 + route.length);

      if (fragment.length > 0)
        assert.deepStrictEqual([...new URLSearchParams(tail)], kept(fragment));
      assert.strictEqual(Url.redact(reported), reported);
      if (userinfo === "" && [...query, ...fragment].every((each) => !each.secret))
        assert.strictEqual(reported, original.href);
    },
  );

  it("without a host, such as inline content, stays as it is", () => {
    for (const address of ["about:blank", "data:text/html,<a href='?token=1'>x</a>"])
      assert.strictEqual(Url.redact(address), address);
  });
});
