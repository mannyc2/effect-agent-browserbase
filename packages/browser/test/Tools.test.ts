// The browser tools: receipts of what each call did and what followed it, tools pinned to a page or
// following a browser's tabs, and the page operations' projections. No model is called.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assert, it as unit, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Exit, Layer, Option, Schedule, Schema, Stream } from "effect";
import { RpcTest } from "effect/rpc";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, StaleRef, Timeout } from "../src/BrowserError.ts";
import { Action, DialogShown, Navigated, PageOpened } from "../src/BrowserEvent.ts";
import { Changes } from "../src/Change.ts";
import * as Chromium from "../src/Chromium.ts";
import { Image } from "../src/Frame.ts";
import { operations } from "../src/internal/agent/operations.ts";
import { told, toldFailure } from "../src/internal/agent/projection.ts";
import * as Page from "../src/Page.ts";
import { Snapshot } from "../src/Snapshot.ts";
import * as Tools from "../src/Tools.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const refOf = (outline: string, role: string, name: string) =>
  new RegExp(`${role} "${name}" \\[ref=(e\\d+)\\]`).exec(outline)?.[1] ?? "missing";

const opened = (browser: Browser["Service"], count: number) =>
  browser.pages.pipe(
    Effect.repeat({
      schedule: Schedule.spaced(Duration.millis(25)),
      until: (open) => open.length >= count,
    }),
    Effect.timeout(Duration.seconds(5)),
  );

/** A browser whose pages count each time something brings them to front. */
const watched = (browser: Browser["Service"]) => {
  const fronted: Array<string> = [];
  const views = new WeakMap<Page.Page, Page.Page>();

  const watch = (page: Page.Page) => {
    const view = views.get(page) ?? {
      ...page,
      bringToFront: Effect.sync(() => fronted.push(page.id)).pipe(
        Effect.andThen(page.bringToFront),
      ),
    };

    views.set(page, view);

    return view;
  };

  return {
    fronted,
    browser: Browser.of({
      ...browser,
      pages: Effect.map(browser.pages, (open) => open.map(watch)),
      firstPage: Effect.map(browser.firstPage, watch),
      newPage: (url) => Effect.map(browser.newPage(url), watch),
    }),
  };
};

/** A browser of its own, so that the tabs a test opens are its alone. */
const fresh = Effect.gen(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires local Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
    (owned) => Effect.promise(() => owned.close()),
  );

  return yield* makeBrowser(context, { id: "tools", provider: "test" });
});

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Tools", (it) => {
  it.effect(
    "receipts say what an action caused: a dialog and its answer, changes, a navigation, a tab",
    () =>
      Effect.gen(function* () {
        const browser = yield* fresh;
        const page = yield* browser.firstPage;
        const tools = yield* Tools.make({ page });

        yield* page.goto(
          "data:text/html,<title>Shop</title><button onclick=\"out.textContent = confirm('Empty the cart?') ? 'Emptied' : 'Kept'\">Empty</button><p id=out>Full</p>",
        );
        // The first read of a page's changes starts its record.
        yield* page.changes();
        const shop = (yield* tools.handlers.browser_snapshot({})).did;

        const emptied = yield* tools.handlers
          .browser_click({ ref: refOf(shop, "button", "Empty") })
          .pipe(Page.correlate("call-1"));

        assert.deepStrictEqual(
          emptied.dialogs.map(({ kind, answer }) => [kind, answer]),
          [["confirm", "dismissed"]],
        );
        assert.deepStrictEqual(
          emptied.changes?.changes.map(({ before, after }) => [before, after]),
          [["Full", "Kept"]],
        );
        assert.strictEqual(emptied.action?.subject?.name, "Empty");
        assert.strictEqual(emptied.action?.correlation, "call-1");

        const form = (yield* Site).url("/form");

        yield* page.goto(form);
        const links = (yield* tools.handlers.browser_snapshot({})).did;

        const next = yield* tools.handlers.browser_click({
          ref: refOf(links, "link", "Next page"),
        });

        assert.include(next.navigated?.url ?? "", "/next");
        assert.isFalse(next.navigated?.sameDocument);

        yield* page.goto(form);
        const again = (yield* tools.handlers.browser_snapshot({})).did;

        const tab = yield* tools.handlers.browser_click({
          ref: refOf(again, "link", "Open in a new tab"),
        });

        yield* opened(browser, 2);

        // A tab registers as it opens, which can be after the click's receipt: the page's events
        // hold its opening either way.
        const openings = (yield* page.recentEvents).filter(
          (event) => event._tag === "PageOpened" && event.opener === page.id,
        );

        assert.strictEqual(openings.length, 1);
        assert.isAtMost(tab.opened.length, 1);
        // Tools pinned to a page stay on it.
        assert.strictEqual((yield* tools.page).id, page.id);
      }),
  );

  it.effect("tells a model what followed a call, and what to do after a failure", () =>
    Effect.sync(() => {
      const page = "p1";

      const receipt = new Tools.Receipt({
        page,
        did: 'Clicked <button> "Pay" at (10, 20).',
        dialogs: [
          new DialogShown({
            at: 2,
            page,
            kind: "confirm",
            message: "Pay $5?",
            answer: "dismissed",
          }),
        ],
        navigated: new Navigated({
          at: 3,
          page,
          url: "https://shop.example/paid",
          document: 2,
          sameDocument: false,
        }),
        opened: [
          new PageOpened({ at: 4, page: "p2", url: "https://shop.example/receipt", opener: page }),
        ],
        missing: [],
      });

      const text = told(receipt);

      for (const fact of [
        "Pay $5?",
        "dismissed",
        "https://shop.example/paid",
        "https://shop.example/receipt",
      ])
        assert.include(text, fact);

      const stale = new BrowserError({
        operation: "click",
        reason: new StaleRef({ ref: "e9" }),
        dispatched: false,
      });

      const late = new BrowserError({
        operation: "click",
        reason: new Timeout({ millis: 10 }),
        dispatched: true,
      });

      assert.include(toldFailure(stale), "Take a new snapshot.");
      assert.notInclude(toldFailure(stale), "may have taken effect");
      assert.include(toldFailure(late), "may have taken effect");
    }),
  );

  it.effect("pinned to a page, they never select or bring another tab to front", () =>
    Effect.gen(function* () {
      const { browser, fronted } = watched(yield* fresh);
      const page = yield* browser.firstPage;
      const tools = yield* Tools.make({ page });

      assert.notInclude(Object.keys(tools.handlers), "browser_tabs");
      yield* page.goto((yield* Site).url("/form"));
      const outline = (yield* tools.handlers.browser_snapshot({})).did;

      yield* tools.handlers.browser_click({ ref: refOf(outline, "link", "Open in a new tab") });
      yield* opened(browser, 2);
      // Every later call stays on the page, which the model still sees.
      assert.strictEqual((yield* tools.page).id, page.id);
      assert.include((yield* tools.handlers.browser_snapshot({})).did, "Place an order");
      yield* tools.handlers.browser_type({ text: "7", ref: refOf(outline, "textbox", "Amount") });
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.locator("#amount").inputValue()),
        "7",
      );
      assert.deepStrictEqual(fronted, []);
    }),
  );

  for (const follow of ["select", "front", "never"] as const)
    it.effect(`following a browser's tabs, "${follow}" shows a tab that opens as it says`, () =>
      Effect.gen(function* () {
        const { browser, fronted } = watched(yield* fresh);
        const first = yield* browser.firstPage;
        const tools = yield* Tools.make({ browser, follow });

        yield* first.goto((yield* Site).url("/form"));
        assert.strictEqual((yield* tools.page).id, first.id);
        const outline = (yield* tools.handlers.browser_snapshot({})).did;

        yield* tools.handlers.browser_click({ ref: refOf(outline, "link", "Open in a new tab") });
        const [, popup] = yield* opened(browser, 2);

        // Until the model looks again, calls stay on the tab it saw.
        assert.include((yield* tools.handlers.browser_snapshot({})).did, "Place an order");
        const shown = yield* tools.page;

        assert.strictEqual(shown.id, follow === "never" ? first.id : popup?.id);
        assert.deepStrictEqual(fronted, follow === "front" ? [popup?.id] : []);
      }),
    );

  it.effect("following tabs, a switch waits to be seen and a tab gone gives way", () =>
    Effect.gen(function* () {
      const browser = yield* fresh;
      const first = yield* browser.firstPage;
      const tools = yield* Tools.make({ browser });

      yield* first.goto((yield* Site).url("/form"));
      yield* tools.page;

      const tabs = yield* tools.handlers.browser_tabs({
        action: "new",
        url: (yield* Site).url("/next"),
      });

      assert.include(tabs.did, "2. [current] Next");
      // Reads see the tab it switched to, and actions wait until the model has seen it.
      assert.include((yield* tools.handlers.browser_snapshot({})).did, "The next page");
      const held = yield* tools.handlers.browser_press({ keys: "Tab" }).pipe(Effect.flip);

      assert.strictEqual(held.reason._tag, "InvalidRequest");
      assert.isFalse(held.dispatched);
      const second = yield* tools.page;

      yield* tools.handlers.browser_press({ keys: "Tab" });
      yield* second.close;
      const gone = yield* tools.handlers.browser_press({ keys: "Tab" }).pipe(Effect.flip);

      assert.include(toldFailure(gone), "The tab is gone.");
      assert.strictEqual((yield* tools.page).id, first.id);
    }),
  );

  it.effect("opens typed addresses, but never a local file, from the navigation tools", () =>
    Effect.gen(function* () {
      const browser = yield* fresh;
      const page = yield* browser.firstPage;
      const tools = yield* Tools.make({ browser });
      const { host } = new URL((yield* Site).url("/next"));

      // A host and port is an address, not a `localhost:` scheme; loopback is plain HTTP.
      const port = host.split(":")[1];
      const went = yield* tools.handlers.browser_navigate({ url: `localhost:${port}/next` });

      assert.strictEqual(went.did, `Opened http://localhost:${port}/next.`);
      assert.include(yield* page.url, "/next");

      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "effect-browser-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );

      const file = pathToFileURL(join(directory, "secret.html")).href;

      yield* Effect.promise(() => writeFile(new URL(file), "<title>Secret</title>secret"));

      for (const url of [file, "javascript:alert(1)", "chrome://settings"]) {
        const refused = yield* tools.handlers.browser_navigate({ url }).pipe(Effect.flip);

        assert.include(toldFailure(refused), "was not opened");
        assert.isFalse(refused.dispatched);
      }
      const before = (yield* browser.pages).length;

      const refused = yield* tools.handlers
        .browser_tabs({ action: "new", url: file })
        .pipe(Effect.flip);

      assert.include(refused.message, "was not opened");
      assert.strictEqual((yield* browser.pages).length, before);

      // The consumer's own navigation is not the model's, and still opens what it is given.
      yield* page.goto(file);
      assert.strictEqual(yield* page.title, "Secret");
    }),
  );

  it.effect("plays a canvas game by point, and waits for its reels to rest", () =>
    Effect.gen(function* () {
      const browser = yield* fresh;
      const page = yield* browser.firstPage;
      const tools = yield* Tools.make({ page });

      yield* page.goto((yield* Site).url("/slots"));
      const spin = yield* tools.handlers.browser_click({ x: 300, y: 320 });
      const still = yield* tools.handlers.browser_wait({ still: true });

      const spins = yield* Effect.promise(() =>
        page.playwright.evaluate(
          () => (window as unknown as { state: { spins: number } }).state.spins,
        ),
      );

      assert.include(spin.did, "<canvas#game>");
      assert.include(spin.did, "at (300, 320).");
      assert.strictEqual(spin.action?.subject?.tag, "canvas");
      assert.strictEqual(still.did, "The screen is still.");
      assert.strictEqual(spins, 1);
      assert.match(
        toldFailure(yield* tools.handlers.browser_click({ ref: "e99999" }).pipe(Effect.flip)),
        /take a new snapshot/i,
      );
    }),
  );
});

/**
 * A page that answers each operation at once, as the given handler says, and records what it was
 * asked: enough of a page for the projections, and no more.
 */
const recording = (answer: (call: ReadonlyArray<unknown>) => BrowserError | undefined) => {
  const asked: Array<ReadonlyArray<unknown>> = [];
  const page = "page";

  const image = new Image({
    data: new Uint8Array([1, 2]),
    mediaType: "image/jpeg",
    width: 2,
    height: 1,
  });

  const ask = <A>(value: A, ...call: ReadonlyArray<unknown>) =>
    Effect.suspend(() => {
      asked.push(call);
      const failure = answer(call);

      return failure === undefined ? Effect.succeed(value) : Effect.fail(failure);
    });

  const resolved = new Page.ResolvedTarget({
    point: { x: 1, y: 2 },
    element: '<button> "Go"',
    tag: "button",
    role: "button",
    name: "Go",
    context: {},
    cursor: "pointer",
  });

  const snapshot = new Snapshot({
    url: "about:blank",
    title: "Blank",
    text: 'button "Go" [ref=e1]',
    truncated: false,
    above: 0,
    below: 0,
    viewport: { width: 800, height: 600 },
    scroll: { y: 0, height: 600 },
  });

  const events = [
    new Action({ at: 2, startedAt: 1.5, page, name: "click", ok: true, dispatched: true }),
    new DialogShown({ at: 2, page, kind: "alert", message: "Hi", answer: "accepted" }),
  ];

  const fake: Partial<Page.Page> = {
    id: page,
    state: Effect.succeed(new Page.State({ page, at: 1, url: "about:blank", document: 0 })),
    recentEvents: Effect.succeed(events),
    changes: () =>
      Effect.succeed(
        new Changes({ document: 0, from: 0, until: 3, cursor: 3, dropped: 0, changes: [] }),
      ),
    viewport: Effect.succeed({ width: 800, height: 600 }),
    goto: (url) => ask(undefined, "goto", url),
    back: ask(undefined, "back"),
    snapshot: (options) => ask(snapshot, "snapshot", options),
    zoom: (region) => ask(new Page.Zoom({ page, region, image }), "zoom", region),
    click: (target, options) => ask(resolved, "click", target, options),
    hover: (target) => ask(undefined, "hover", target),
    drag: (from, to) => ask(undefined, "drag", from, to),
    type: (text, options) => ask(undefined, "type", text, options),
    press: (keys, options) => ask(undefined, "press", keys, options),
    scroll: (options) => ask(undefined, "scroll", options),
    select: (ref, values) => ask("Bitcoin", "select", ref, values),
    waitForText: (text) => ask(undefined, "waitForText", text),
    ready: (options) => ask(undefined, "ready", options),
  };

  // The projections reach a page only through these members.
  return { page: fake as Page.Page, asked };
};

const names = Object.keys(operations) as ReadonlyArray<keyof typeof operations>;

// Each operation's parameters as a model or another process sends them: any its schema admits,
// but a wait of no seconds, since only the page is fake.
const calls = Arbitrary.all(
  Object.fromEntries(
    names.map((name) => [
      name,
      Arbitrary.schema(operations[name].input).pipe(
        Arbitrary.map((input) =>
          Schema.encodeSync(operations[name].input)(
            name === "browser_wait" ? { ...input, seconds: 0 } : input,
          ),
        ),
      ),
    ]),
  ),
);

const outcome = <A, E>(exit: Exit.Exit<A, E>) =>
  Exit.isSuccess(exit) ? exit.value : Option.getOrUndefined(Exit.findErrorOption(exit));

unit.live.prop(
  "a contract's tool, its page method and its RPC make the same call and answer alike",
  { calls, fails: Schema.Boolean },
  ({ calls: encoded, fails }) =>
    Effect.gen(function* () {
      const failure = new BrowserError({
        operation: "fake",
        reason: new StaleRef({ ref: "e1" }),
        dispatched: true,
      });

      for (const name of names) {
        const params = encoded[name];
        const input = yield* Schema.decodeUnknownEffect(operations[name].input)(params);
        const answer = () => (fails ? failure : undefined);
        const direct = recording(answer);
        const viaTool = recording(answer);
        const viaMethod = recording(answer);
        const viaRpc = recording(answer);

        // What the operation's own handler asks of the page.
        yield* Effect.exit(operations[name].run(direct.page, input as never));

        const tools = yield* Tools.make({ page: viaTool.page });
        const { toolkit } = yield* tools.batch;

        const tool = yield* toolkit
          .handle(name, params as never)
          .pipe(Stream.unwrap, Stream.runLast, Effect.flatMap(Effect.fromOption));

        const method = yield* Effect.exit(Tools.on(viaMethod.page)[name](input as never));

        const rpc = yield* RpcTest.makeClient(Tools.PageRpcs).pipe(
          Effect.flatMap((client) => Effect.exit(client[name](input as never))),
          Effect.provide(Tools.PageRpcs.toLayer(Tools.on(viaRpc.page))),
          Effect.scoped,
        );

        for (const via of [viaTool, viaMethod, viaRpc])
          assert.deepStrictEqual(via.asked, direct.asked, name);
        const answered = outcome(method);

        assert.deepStrictEqual(outcome(rpc), answered, name);
        assert.deepStrictEqual(tool.result, answered, name);
        assert.strictEqual(tool.isFailure, Exit.isFailure(method), name);
        assert.strictEqual(
          tool.encodedResult,
          Schema.is(Tools.Receipt)(answered)
            ? told(answered)
            : Schema.is(BrowserError)(answered)
              ? toldFailure(answered)
              : "no outcome",
          name,
        );
        // A receipt or a failure crosses a process boundary as JSON and comes back the same.
        const json = Schema.toCodecJson(Schema.Union([Tools.Receipt, BrowserError]));
        const sent = JSON.stringify(yield* Schema.encodeUnknownEffect(json)(answered));

        assert.deepStrictEqual(
          yield* Schema.decodeUnknownEffect(json)(JSON.parse(sent)),
          answered,
          name,
        );
      }
    }),
  { arbitrary: { runs: 25 } },
);
