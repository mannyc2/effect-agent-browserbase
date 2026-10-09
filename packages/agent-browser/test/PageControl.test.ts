// The ports over a real Chromium page, called directly: no model.
import { assert, layer } from "@effect/vitest";
import type { BrowserUse } from "@yielded/agent";
import { Duration, Effect, Layer } from "effect";
import { Browser, make as makeBrowser } from "effect-browser/Browser";
import { BrowserError, PolicyDenied, Timeout } from "effect-browser/BrowserError";
import * as Chromium from "effect-browser/Chromium";
import type * as Page from "effect-browser/Page";
import * as Policy from "effect-browser/Policy";

import * as PageControl from "../src/PageControl.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) =>
      Effect.ignore(page.close),
    );
  });

type Observation = typeof BrowserUse.Observation.Type;

const refOf = (seen: Observation, name: string) => {
  const ref = seen.controls.find((control) => control.name === name)?.ref;

  assert.isDefined(ref, `no control named ${name} in:\n${seen.text}`);

  return ref ?? "";
};

const outcome = (page: {
  readonly playwright: { textContent: (s: string) => Promise<string | null> };
}) => Effect.promise(() => page.playwright.textContent("#outcome"));

/** A browser of its own in a new context, whose every input goes to `guard`. */
const guarded = Effect.fnUntraced(function* (
  guard: (request: Page.InputRequest) => Effect.Effect<void, PolicyDenied>,
) {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the test needs a launched Chromium");

  const context = yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext({ viewport: { width: 1280, height: 720 } })),
    (context) => Effect.promise(() => context.close()),
  );

  return yield* makeBrowser(context, { id: "guarded", provider: "test" }, { guard });
});

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

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("PageControl", (it) => {
  it.effect("observes the outline and its controls, and acts on them in order", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const { actions } = yield* PageControl.make({ page });
      const seen = yield* actions.observe;

      assert.include(seen.text, 'heading "Place an order"');
      assert.deepInclude(
        seen.controls.find((control) => control.name === "Coin"),
        { kind: "combobox", value: "Bitcoin", options: ["Bitcoin", "Ethereum", "Solana"] },
      );
      assert.strictEqual(seen.page?.title, "Order");
      assert.isUndefined(seen.tabs);

      const done = yield* actions.act([
        { kind: "fill", ref: refOf(seen, "Amount"), value: "25" },
        { kind: "select", ref: refOf(seen, "Coin"), value: "Ethereum" },
        { kind: "click", ref: refOf(seen, "Submit") },
      ]);

      assert.strictEqual(done.completed, 3);
      assert.strictEqual(done.dispatch, "acknowledged");
      assert.isNull(done.error);
      assert.strictEqual(yield* outcome(page), "Ordered 25 eth");
      // The look after the actions begins with what their input changed.
      assert.match(
        done.observation?.text ?? "",
        /^It changed: .*"Not ordered" became "Ordered 25 eth"/,
      );
    }),
  );

  it.effect("stops at the first failure, saying whether its input went, and never retries", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const { actions } = yield* PageControl.make({ page });
      const seen = yield* actions.observe;

      const stale = yield* actions.act([
        { kind: "click", ref: "e9999" },
        { kind: "click", ref: refOf(seen, "Submit") },
      ]);

      assert.strictEqual(stale.completed, 0);
      assert.strictEqual(stale.dispatch, "not-dispatched");
      assert.include(stale.error ?? "", "Observe the page again");
      assert.strictEqual(yield* outcome(page), "Not ordered");

      const blind = yield* actions.act([{ kind: "click", ref: refOf(seen, "Submit") }], {
        observe: false,
      });

      assert.deepStrictEqual([blind.completed, blind.observation], [1, null]);
    }),
  );

  it.effect("reports a failure after its input went as unknown, which may have taken effect", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      const late: Page.Page = {
        ...page,
        click: () =>
          Effect.fail(
            new BrowserError({
              operation: "click",
              reason: new Timeout({ millis: 10_000 }),
              dispatched: true,
            }),
          ),
      };

      const { actions } = yield* PageControl.make({ page: late });
      const seen = yield* actions.observe;
      const sent = yield* actions.act([{ kind: "click", ref: refOf(seen, "Submit") }]);

      assert.deepStrictEqual([sent.completed, sent.dispatch], [0, "unknown"]);
      assert.include(sent.error ?? "", "may have taken effect");
    }),
  );

  it.effect("tells how the browser answered a dialog, and refuses to answer one itself", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const { actions, control } = yield* PageControl.make({ page });

      const done = yield* actions.act([
        { kind: "click", ref: refOf(yield* actions.observe, "Cancel") },
      ]);

      assert.include(
        done.observation?.text ?? "",
        'A confirm dialog said "Cancel the order?", and it was dismissed.',
      );
      assert.strictEqual(yield* outcome(page), "Kept");

      const refused = yield* Effect.flip(control.respondDialog({ ref: "d1", accept: true }));

      assert.strictEqual(refused.code, "invalid");
    }),
  );

  it.effect("gives the input policy the task, and reports its refusal as not dispatched", () =>
    Effect.gen(function* () {
      const tasks: Array<string | undefined> = [];

      const browser = yield* guarded((request) =>
        Effect.gen(function* () {
          // Opening the page is the test's own navigation, outside the ports.
          if (request.action !== "navigate") tasks.push(yield* Policy.Task);
          if (request.name === "Submit") return yield* new PolicyDenied({ detail: "not this one" });
        }),
      );

      const page = yield* browser.newPage((yield* Site).url("/form"));
      const { actions } = yield* PageControl.make({ page }, { task: "Order 25 coins" });
      const seen = yield* actions.observe;

      const refused = yield* actions.act([
        { kind: "fill", ref: refOf(seen, "Amount"), value: "25" },
        { kind: "click", ref: refOf(seen, "Submit") },
      ]);

      assert.strictEqual(refused.completed, 1);
      assert.strictEqual(refused.dispatch, "not-dispatched");
      assert.include(refused.error ?? "", "not this one");
      assert.deepStrictEqual(tasks, ["Order 25 coins", "Order 25 coins"]);
      assert.strictEqual(yield* outcome(page), "Not ordered");
    }),
  );

  it.effect("inspects inside a selector and narrows a select's options, keeping its value", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const { control } = yield* PageControl.make({ page });
      const nav = yield* control.inspect({ selector: "nav" });

      assert.deepStrictEqual(
        nav.controls.map((one) => one.name),
        ["Next page", "Open in a new tab"],
      );

      const sol = yield* control.inspect({ optionFilter: "sol" });

      assert.deepStrictEqual(sol.controls.find((one) => one.name === "Coin")?.options, [
        "Bitcoin",
        "Solana",
      ]);
      assert.strictEqual(
        (yield* Effect.flip(control.inspect({ selector: "nav[" }))).code,
        "invalid",
      );
      assert.strictEqual((yield* Effect.flip(control.inspect({ frame: "f1" }))).code, "invalid");
    }),
  );

  it.effect("waits for a condition, and returns the page as it is when it stays unmet", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const { actions, control } = yield* PageControl.make({ page }, { maxWaitMillis: 500 });

      yield* actions.act([{ kind: "click", ref: refOf(yield* actions.observe, "Ship later") }], {
        observe: false,
      });

      const met = yield* control.wait({
        selector: "#outcome",
        state: "text",
        text: "Shipped",
        timeoutMillis: 5000,
      });

      assert.notInclude(met.text, "unmet");
      assert.include(met.text, "Shipped");

      const unmet = yield* control.wait({
        selector: "#outcome",
        state: "text",
        text: "Delivered",
        timeoutMillis: 5000,
      });

      assert.match(unmet.text, /^The wait ended after 500 ms unmet\./);
    }),
  );

  it.effect(
    "navigates only to web addresses, presses keys on a ref and takes PNG screenshots",
    () =>
      Effect.gen(function* () {
        const page = yield* open("/form");
        const { actions, control } = yield* PageControl.make({ page });

        const file = yield* control.navigate({ url: "file:///etc/passwd" });

        assert.deepStrictEqual([file.completed, file.dispatch], [0, "not-dispatched"]);

        const pressed = yield* control.press({
          ref: refOf(yield* actions.observe, "Submit"),
          key: "Enter",
        });

        assert.strictEqual(pressed.dispatch, "acknowledged");
        assert.strictEqual(yield* outcome(page), "Ordered 10 btc");

        const picture = yield* control.screenshot;

        assert.strictEqual(picture.mediaType, "image/png");
        assert.strictEqual(Buffer.from(picture.base64, "base64").subarray(1, 4).toString(), "PNG");

        const went = yield* control.navigate({ url: (yield* Site).url("/next") });

        assert.strictEqual(went.dispatch, "acknowledged");
        assert.include(went.observation?.text ?? "", 'heading "The next page"');
      }),
  );

  for (const follow of ["select", "front", "never"] as const)
    it.effect(`following tabs, "${follow}" shows a tab an action opens as it says`, () =>
      Effect.gen(function* () {
        const { browser, fronted } = watched(yield* guarded(() => Effect.void));
        const first = yield* browser.newPage((yield* Site).url("/form"));
        const { actions, control } = yield* PageControl.make({ browser, follow });
        const seen = yield* actions.observe;

        assert.deepStrictEqual(
          seen.tabs?.map((tab) => tab.active),
          [true],
        );

        const opened = yield* actions.act([
          { kind: "click", ref: refOf(seen, "Open in a new tab") },
        ]);

        const text = opened.observation?.text ?? "";

        assert.include(text, "A tab opened at");
        assert.include(
          text,
          follow === "never" ? 'heading "Place an order"' : 'heading "The next page"',
        );
        assert.deepStrictEqual(
          opened.observation?.tabs?.map((tab) => tab.active),
          follow === "never" ? [true, false] : [false, true],
        );
        const popup = (yield* browser.pages).find((page) => page.id !== first.id);

        assert.deepStrictEqual(fronted, follow === "front" ? [popup?.id] : []);

        const back = yield* control.selectTab({ ref: opened.observation?.tabs?.[0]?.ref ?? "" });

        assert.include(back.text, 'heading "Place an order"');
        assert.strictEqual(
          (yield* Effect.flip(control.selectTab({ ref: "tab9" }))).code,
          "invalid",
        );
      }),
    );

  it.effect("pinned to a page, the ports list no tabs and stay on it", () =>
    Effect.gen(function* () {
      const { browser, fronted } = watched(yield* guarded(() => Effect.void));
      const page = yield* browser.newPage((yield* Site).url("/form"));
      const { actions, control } = yield* PageControl.make({ page });

      const opened = yield* actions.act([
        { kind: "click", ref: refOf(yield* actions.observe, "Open in a new tab") },
      ]);

      assert.isUndefined(opened.observation?.tabs);
      assert.include(opened.observation?.text ?? "", 'heading "Place an order"');
      assert.strictEqual((yield* browser.pages).length, 2);
      assert.deepStrictEqual(fronted, []);
      assert.strictEqual((yield* Effect.flip(control.selectTab({ ref: "tab1" }))).code, "invalid");
    }),
  );
});
