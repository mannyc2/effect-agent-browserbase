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
import { type Page, redacted } from "../src/Page.ts";
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

/** Hold the owner's actual popup registration, after Playwright has announced that exact tab. */
const holdPopupRegistration = Effect.fnUntraced(function* (browser: Browser.Service, opener: Page) {
  const createSession = browser.context.newCDPSession.bind(browser.context);
  const entered = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();

  browser.context.newCDPSession = async (target) => {
    if (target !== opener.playwright) {
      entered.resolve();
      await release.promise;
    }

    return createSession(target);
  };
  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      release.resolve();
      browser.context.newCDPSession = createSession;
    }),
  );

  return {
    entered: Effect.promise(() => entered.promise),
    release: Effect.sync(() => release.resolve()),
    fail: Effect.sync(() => release.reject(new Error("popup registration refused"))),
  };
});

describe("a tab opened by input", () => {
  it.live("is tracked before the input ends, even with slow registration and evicted events", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open({ eventHistory: 1 });
      const page = yield* browser.firstPage;

      yield* page.goto((yield* Site).url("/form"));
      const [link] = yield* page.find({ role: "link", name: "Open in a new tab" });
      const registration = yield* holdPopupRegistration(browser, page);
      const clicking = yield* Effect.forkChild(page.click(link?.ref ?? ""));

      yield* registration.entered;

      // The previous implementation returned here before registration. A real popup taking over
      // a second must still use the input's remaining deadline, regardless of event retention.
      const ended = yield* Fiber.await(clicking).pipe(
        Effect.asSome,
        Effect.timeoutOrElse({
          duration: "1250 millis",
          orElse: () => Effect.succeedNone,
        }),
      );

      assert.isTrue(Option.isNone(ended));
      assert.strictEqual((yield* browser.pages).length, 1);
      yield* registration.release;
      yield* Fiber.join(clicking);
      assert.strictEqual((yield* browser.pages).length, 2);
      assert.strictEqual(
        yield* (yield* browser.pages)[1]?.url ?? Effect.succeed(""),
        (yield* Site).url("/next"),
      );
      assert.strictEqual((yield* browser.recentEvents).length, 1);
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  );

  for (const outcome of ["failure", "timeout", "closed"] as const)
    it.live(`reports registration ${outcome} after dispatched input, without replaying it`, () =>
      Effect.gen(function* () {
        const owner = yield* Scope.make();

        yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));

        const browser = yield* Chromium.open({ actionTimeout: "2 seconds" }).pipe(
          Scope.provide(owner),
        );

        const page = yield* browser.firstPage;

        yield* page.goto((yield* Site).url("/form"));
        const [link] = yield* page.find({ role: "link", name: "Open in a new tab" });
        const registration = yield* holdPopupRegistration(browser, page);
        const clicking = yield* Effect.forkChild(Effect.flip(page.click(link?.ref ?? "")));

        yield* registration.entered;
        if (outcome === "failure") yield* registration.fail;
        if (outcome === "closed") yield* page.close;

        const error = yield* Fiber.join(clicking).pipe(
          Effect.timeout(outcome === "closed" ? "1 second" : "3 seconds"),
        );

        assert.strictEqual(
          error.reason._tag,
          { failure: "Failed", timeout: "Timeout", closed: "Closed" }[outcome],
        );
        assert.strictEqual(
          error.reason._tag === "Closed" ? error.reason.cause : undefined,
          outcome === "closed" ? "page" : undefined,
        );
        assert.isTrue(error.dispatched);
        assert.strictEqual(browser.context.pages().length, outcome === "closed" ? 1 : 2);

        const native = page.playwright as typeof page.playwright & {
          readonly listenerCount: (event: string) => number;
        };

        yield* registration.release;
        // Native input can fail Closed before the queued page cleanup. Scope closure is the
        // ownership guarantee for listeners, regardless of which operation observed the loss.
        yield* Scope.close(owner, Exit.void);
        assert.strictEqual(native.listenerCount("popup"), 0);
      }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
    );
});

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
      const titling = yield* Effect.forkChild(page.title);

      yield* Effect.sleep("100 millis");
      proxy.drop();
      assert.strictEqual(yield* browser.disconnected, "connection");
      // The browser answers a title whatever the page's script is doing, so the busy page held up
      // nothing, and the drop never stood in for its title with an empty one.
      assert.strictEqual(yield* Fiber.join(titling), "one");

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
          [1, true, site.url(`/form?ticker=ETH&access_token=${redacted}#top`)],
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

      const popup = (yield* browser.pages).at(-1) as Page;

      assert.notStrictEqual(popup, named);
      yield* Effect.promise(() => popup.playwright.waitForLoadState("domcontentloaded"));
      assert.match(popup.playwright.url(), /^http:\/\/localhost:\d+\/next$/);
      assert.deepStrictEqual(yield* marks(popup), ["localhost", true]);
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  );
});

// The two sides of the address rule. Credentials go, however they are written: tokens, keys,
// signatures, passwords, session ids, assertions and one-time codes, and codes and keys of a kind
// that signs someone in. What an address is about stays, among it names that hold a credential's
// word or end as one does, and the names that as often say what a page shows, such as a stock
// code, unless their value looks generated.
const credentialNames = Schema.Literals([
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
  "api_key",
  "apiKey",
  "client_secret",
  "password",
  "passcode",
  "pwd",
  "PHPSESSID",
  "session_id",
  "jwt",
  "auth",
  "bearer",
  "code_verifier",
  "client_assertion",
  "SAMLResponse",
  "SAMLart",
  "otp",
  "totp",
]);

const signsIn = Schema.Literals([
  "verification",
  "otp",
  "mfa",
  "reset",
  "confirmation",
  "activation",
  "sms",
  "auth",
  "access",
  "signing",
  "license",
  "client",
  "encryption",
]);

const identityNames = Schema.Literals([
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
  "country-code",
  "productCode",
  "sort_key",
  "publicKey",
  "state",
  "view",
  "author",
  "sessions",
  "ticket_id",
]);

const ambiguousNames = Schema.Literals(["code", "key", "session", "sid", "ticket", "Code", "KEY"]);

// What those names hold when they say what a page shows.
const shown = Schema.Literals(["BTC", "AAPL", "600519", "SAVE10", "INC0012345", "ai-keynote"]);

// A token, session id or authorization code, as a server generates one.
const generated = Arbitrary.array(
  Arbitrary.schema(
    Schema.Literals([..."abcdefghjkmnpqrstuvwxyzABCDEFGHJKLMNPQRSTUVWXYZ0123456789-_"]),
  ),
  { minLength: 14, maxLength: 40 },
).pipe(Arbitrary.map((characters) => `a1${characters.join("")}`));

// An address holds text, never a lone surrogate.
const text = Arbitrary.schema(Schema.String).pipe(
  Arbitrary.filter((value) => value !== "" && !/\p{Cs}/u.test(value)),
);

type Parameter = { readonly secret: boolean; readonly name: string; readonly value: string };

const parameter = Arbitrary.all({
  side: Arbitrary.schema(
    Schema.Literals(["credential", "signs in", "identity", "generated", "shown"]),
  ),
  credential: Arbitrary.schema(credentialNames),
  kind: Arbitrary.schema(signsIn),
  head: Arbitrary.schema(Schema.Literals(["code", "key", "Code", "Key"])),
  separator: Arbitrary.schema(Schema.Literals(["_", "-", ""])),
  identity: Arbitrary.schema(identityNames),
  ambiguous: Arbitrary.schema(ambiguousNames),
  generated,
  shown: Arbitrary.schema(shown),
  value: text,
}).pipe(
  Arbitrary.map((drawn): Parameter => {
    switch (drawn.side) {
      case "credential":
        return { secret: true, name: drawn.credential, value: drawn.value };
      case "signs in":
        return {
          secret: true,
          name: `${drawn.kind}${drawn.separator}${drawn.head}`,
          value: drawn.value,
        };
      case "identity":
        return { secret: false, name: drawn.identity, value: drawn.value };
      case "generated":
        return { secret: true, name: drawn.ambiguous, value: drawn.generated };
      case "shown":
        return { secret: false, name: drawn.ambiguous, value: drawn.shown };
    }
  }),
);

const written = (parameters: ReadonlyArray<Parameter>) =>
  parameters
    .map(({ name, value }) => `${encodeURIComponent(name)}=${encodeURIComponent(value)}`)
    .join("&");

// Each parameter as the report reads it: its name, and its value or the withheld mark.
const reported = (parameters: ReadonlyArray<Parameter>) =>
  parameters.map(({ secret, name, value }) => [name, secret ? redacted : value]);

describe("an address", () => {
  it.prop(
    "keeps its origin, path and what it is about, in order, and withholds each credential",
    {
      scheme: Arbitrary.schema(Schema.Literals(["http", "https"])),
      userinfo: Arbitrary.schema(Schema.Literals(["", "ada@", "ada:pass@"])),
      host: Arbitrary.schema(
        Schema.Literals(["chart.example", "shop.example.org", "127.0.0.1:8080", "localhost:3000"]),
      ),
      path: Arbitrary.array(Arbitrary.schema(Schema.Literals(["chart", "markets", "x y", "ü"])), {
        maxLength: 3,
      }),
      // A Java session id, written into the path.
      session: Arbitrary.schema(Schema.Union([Schema.Undefined, Schema.Literal("jsessionid")])),
      sessionId: generated,
      query: Arbitrary.array(parameter, { maxLength: 6 }),
      route: Arbitrary.schema(Schema.Literals(["", "/inbox?"])),
      fragment: Arbitrary.array(parameter, { maxLength: 4 }),
    },
    ({ scheme, userinfo, host, path, session, sessionId, query, route, fragment }) => {
      const segments = path.map(encodeURIComponent).join("/");
      const matrix = session === undefined ? "" : `;${session}=${sessionId}`;

      const address =
        `${scheme}://${userinfo}${host}/${segments}${matrix}` +
        (query.length === 0 ? "" : `?${written(query)}`) +
        (fragment.length === 0 ? "" : `#${route}${written(fragment)}`);

      const original = new URL(address);
      const report = Url.redact(address);
      const read = new URL(report);

      assert.deepStrictEqual([read.username, read.password], ["", ""]);
      assert.deepStrictEqual(
        [read.origin, decodeURI(read.pathname)],
        [original.origin, decodeURI(`/${segments}${matrix.replace(sessionId, redacted)}`)],
      );
      assert.deepStrictEqual([...read.searchParams], reported(query));
      if (fragment.length > 0)
        assert.deepStrictEqual(
          [...new URLSearchParams(read.hash.slice(1 + route.length))],
          reported(fragment),
        );
      assert.strictEqual(Url.redact(report), report);
      if (
        userinfo === "" &&
        session === undefined &&
        [...query, ...fragment].every((each) => !each.secret)
      )
        assert.strictEqual(report, original.href);
    },
  );

  it("without a host, such as inline content, stays as it is", () => {
    for (const address of ["about:blank", "data:text/html,<a href='?token=1'>x</a>"])
      assert.strictEqual(Url.redact(address), address);
  });

  // The page's own outline gives each link's address, a model reads it, and the page shortens a
  // link on its own site to its path: the rule applies first.
  it.live("of a link in the outline is reported by the same rule", () =>
    Effect.gen(function* () {
      const site = yield* Site;
      const browser = yield* Chromium.open();
      const page = yield* browser.newPage(site.url("/links"));
      const links = (yield* page.snapshot()).text.split("\n").filter((line) => line.includes("->"));

      assert.deepStrictEqual(
        links.map((line) => line.slice(line.indexOf("-> ") + 3)),
        [
          `/download?verification_code=${redacted}&format=pdf`,
          `https://partner.example/?token=${redacted}&ticker=ETH`,
          "/chart?code=BTC",
          `/cart;jsessionid=${redacted}`,
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(SiteLayer)),
  );
});
