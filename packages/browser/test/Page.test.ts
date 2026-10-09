import type { EventEmitter } from "node:events";
import { setFlagsFromString } from "node:v8";
import { runInNewContext } from "node:vm";

import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Layer, Schedule, Scope, Stream } from "effect";
import type { CDPSession } from "playwright-core";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { type BrowserError, PolicyDenied } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Image as BrowserImage } from "../src/Frame.ts";
import * as Moment from "../src/Moment.ts";
import { type Page, redacted } from "../src/Page.ts";
import type { Snapshot } from "../src/Snapshot.ts";
import { Site, SiteLayer } from "./fixtures.ts";

/** The ref of the line for this role and name, failing the test when there is none. */
export const refOf = (snapshot: Snapshot, role: string, name: string): string => {
  const ref = new RegExp(`${role} "${name}"[^\\n]*?\\[ref=(e\\d+)\\]`).exec(snapshot.text)?.[1];

  assert.isDefined(ref, `no ${role} "${name}" in:\n${snapshot.text}`);

  return ref ?? "";
};

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) =>
      Effect.ignore(page.close),
    );
  });

const text = (page: Page, selector: string) =>
  Effect.promise(() =>
    page.playwright.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector),
  );

const slotState = (page: Page) =>
  Effect.promise(() =>
    page.playwright.evaluate(
      () => (window as unknown as { state: { spins: number; spinning: boolean } }).state,
    ),
  );

/** Decode the actual capture so a wrong crop origin cannot pass on dimensions alone. */
const centerPixel = (page: Page, image: BrowserImage) =>
  Effect.promise(() =>
    page.playwright.evaluate(
      async (source) => {
        const image = new Image();

        image.src = source;
        await image.decode();
        const canvas = document.createElement("canvas");

        canvas.width = image.width;
        canvas.height = image.height;
        const context = canvas.getContext("2d");

        context?.drawImage(image, 0, 0);

        const pixel = context?.getImageData(
          Math.floor(image.width / 2),
          Math.floor(image.height / 2),
          1,
          1,
        ).data;

        return pixel === undefined ? [] : Array.from(pixel);
      },
      "data:" + image.mediaType + ";base64," + Buffer.from(image.data).toString("base64"),
    ),
  );

/** What the page shows, read as the next look after an action reads it. */
const shows = (page: Page) => Effect.map(page.text(), (read) => read.text);

/** How long `effect` took, on the browser's clock. */
const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const started = yield* browser.now;
    const value = yield* effect;

    return { value, millis: (yield* browser.now) - started };
  });

const reason = <A>(effect: Effect.Effect<A, BrowserError>) =>
  Effect.flip(effect).pipe(
    Effect.map((error) => ({ tag: error.reason._tag, dispatched: error.dispatched })),
  );

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Page", (it) => {
  it.effect("outlines the viewport, with refs on controls and counts of what is out of view", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const snapshot = yield* page.snapshot();

      assert.include(snapshot.text, 'heading "Place an order"');
      for (const [role, name] of [
        ["textbox", "Amount"],
        ["combobox", "Coin"],
        ["checkbox", "I agree"],
        ["button", "Submit"],
        ["link", "Next page"],
      ] as const) {
        refOf(snapshot, role, name);
      }
      assert.notInclude(snapshot.text, "Bottom of the page");
      assert.isAbove(snapshot.below, 0);
      assert.include((yield* page.snapshot({ full: true })).text, "Bottom of the page");
      assert.notInclude((yield* page.snapshot({ query: "submit" })).text, "Amount");
    }),
  );

  it.effect("lists the controls it outlines as values, and reads inside a CSS selector", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const snapshot = yield* page.snapshot();

      const byName = new Map(snapshot.controls.map((control) => [control.name, control]));

      assert.deepInclude(byName.get("Amount"), {
        ref: refOf(snapshot, "textbox", "Amount"),
        kind: "textbox",
        value: "10",
        editable: true,
      });
      assert.deepInclude(byName.get("Coin"), {
        kind: "combobox",
        value: "Bitcoin",
        options: ["Bitcoin", "Ethereum"],
        optionCount: 2,
      });
      assert.deepInclude(byName.get("I agree"), { kind: "checkbox", checked: false });
      assert.strictEqual(byName.get("Submit")?.ref, refOf(snapshot, "button", "Submit"));

      // A cut outline lists only the controls whose lines it kept.
      const cut = yield* page.snapshot({ maxChars: 80 });

      assert.isTrue(cut.truncated);
      for (const control of cut.controls) assert.include(cut.text, `[ref=${control.ref}]`);
      assert.isBelow(cut.controls.length, snapshot.controls.length);

      const nav = yield* page.snapshot({ within: "nav" });

      assert.deepStrictEqual(
        nav.controls.map((control) => control.name),
        ["Next page", "Open in a new tab"],
      );
      assert.notInclude(nav.text, "Amount");
      assert.strictEqual((yield* page.snapshot({ within: "#nothing" })).text, "");

      const invalid = yield* Effect.flip(page.snapshot({ within: "nav[" }));

      assert.strictEqual(invalid.reason._tag, "InvalidRequest");
    }),
  );

  it.effect("waits for what a selector matches to show, hide or enable, with its text", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          setTimeout(() => {
            document.querySelector("#outcome")!.textContent = "Ordered later";
            document.querySelector<HTMLButtonElement>("#submit")!.disabled = true;
          }, 300);
        }),
      );
      yield* page.waitFor({ selector: "#outcome", text: "Ordered later" });
      yield* page.waitFor({ selector: "#outcome", text: "ordered later", state: "hidden" });
      yield* page.waitFor({ selector: "h1", state: "visible" });

      const unmet = yield* Effect.flip(
        page.waitFor({ selector: "#submit", state: "enabled" }, 300),
      );

      assert.strictEqual(unmet.reason._tag, "Timeout");
      assert.isFalse(unmet.dispatched);
      assert.strictEqual(
        (yield* Effect.flip(page.waitFor({ selector: "#outcome[" }))).reason._tag,
        "InvalidRequest",
      );
    }),
  );

  it.effect("presses a key on the element a ref names, focusing it first", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const snapshot = yield* page.snapshot();
      const submit = refOf(snapshot, "button", "Submit");

      yield* page.press("Enter", { on: submit });
      assert.strictEqual(yield* text(page, "#outcome"), "Ordered 10 btc");

      const pressed = (yield* page.recentEvents).findLast(
        (event) => event._tag === "Action" && event.name === "press",
      );

      assert.strictEqual(pressed?._tag === "Action" ? pressed.subject?.name : undefined, "Submit");

      const stale = yield* Effect.flip(page.press("Enter", { on: "e9999" }));

      assert.strictEqual(stale.reason._tag, "StaleRef");
      assert.isFalse(stale.dispatched);
    }),
  );

  it.effect("fills and submits a form by ref", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const snapshot = yield* page.snapshot();

      yield* page.type("25", { into: refOf(snapshot, "textbox", "Amount") });
      assert.strictEqual(
        yield* page.select(refOf(snapshot, "combobox", "Coin"), ["Ethereum"]),
        "Ethereum",
      );
      yield* page.click(refOf(snapshot, "checkbox", "I agree"));
      yield* page.click(refOf(snapshot, "button", "Submit"));
      assert.strictEqual(yield* text(page, "#outcome"), "Ordered 25 eth (agreed)");

      // Each action records what it acted on by role and name, which outlive the refs.
      assert.deepStrictEqual(
        (yield* page.recentEvents).flatMap((event) =>
          event._tag === "Action" && event.name !== "navigate"
            ? [[event.name, event.subject?.role, event.subject?.name, event.subject?.tag]]
            : [],
        ),
        [
          ["type", "textbox", "Amount", "input"],
          ["select", "combobox", "Coin", "select"],
          ["click", "checkbox", "I agree", "input"],
          ["click", "button", "Submit", "button"],
        ],
      );
    }),
  );

  it.effect("names what a hover and a scroll acted on, and nothing for a scroll of the page", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const snapshot = yield* page.snapshot();

      yield* page.hover(refOf(snapshot, "link", "Next page"));
      yield* page.scroll({ at: refOf(snapshot, "textbox", "Amount"), dy: 200 });
      yield* page.scroll({ dy: 200 });

      assert.deepStrictEqual(
        (yield* page.recentEvents).flatMap((event) =>
          event._tag === "Action" && (event.name === "hover" || event.name === "scroll")
            ? [[event.name, event.subject?.role, event.subject?.name, event.subject?.tag]]
            : [],
        ),
        [
          ["hover", "link", "Next page", "a"],
          ["scroll", "textbox", "Amount", "input"],
          ["scroll", undefined, undefined, undefined],
        ],
      );
    }),
  );

  it.effect("names an editable secret field without the text typed into it", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<div contenteditable="true" role="textbox" autocomplete="one-time-code" title="Code">482913</div>',
        ),
      );
      const snapshot = yield* page.snapshot();

      assert.notInclude(snapshot.text, "482913");
      yield* page.click(refOf(snapshot, "textbox", "Code"));

      const clicked = (yield* page.recentEvents).findLast(
        (event) => event._tag === "Action" && event.name === "click",
      );

      assert.strictEqual(clicked?._tag === "Action" ? clicked.subject?.name : undefined, "Code");
    }),
  );

  it.effect("names a select by its label alone when a script wraps it in a custom select", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      // Browserbase's markup for a select in a label, on every page a hosted session navigates to.
      yield* Effect.promise(() =>
        page.playwright.setContent(`<label id="l">Country <div class="bb-custom-select-container">
          <span role="combobox" aria-labelledby="l" tabindex="0"><span>Choose a country</span></span>
          <select id="country" tabindex="-1"><option value="">Choose a country</option><option value="US">United States</option></select>
          <div role="listbox"><div role="option">Choose a country</div><div role="option">United States</div></div>
        </div></label>
        <label>I agree to the <a href="#terms">terms</a> <input type="checkbox"></label>`),
      );
      const snapshot = yield* page.snapshot();
      // The native select is the line with options; the scripted opener has the same name.
      const select = /combobox "Country" \[ref=(e\d+)\][^\n]*options=/.exec(snapshot.text)?.[1];

      assert.isDefined(select, snapshot.text);
      assert.strictEqual(yield* page.select(select ?? "", ["United States"]), "United States");
      refOf(snapshot, "checkbox", "I agree to the terms");
      assert.notInclude(snapshot.text, "Country Choose");
    }),
  );

  it.effect("refuses to type where a space or letter could activate the focused control", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const snapshot = yield* page.snapshot();

      const focus = (selector: string) =>
        Effect.promise(() => page.playwright.locator(selector).focus());

      yield* focus("#submit");
      assert.deepStrictEqual(yield* reason(page.type("a b")), {
        tag: "NotActionable",
        dispatched: false,
      });
      assert.deepStrictEqual(
        yield* reason(page.type("ok go", { into: refOf(snapshot, "button", "Submit") })),
        { tag: "NotActionable", dispatched: false },
      );
      yield* focus("#agree");
      assert.deepStrictEqual(yield* reason(page.type(" ")), {
        tag: "NotActionable",
        dispatched: false,
      });
      assert.strictEqual(yield* text(page, "#outcome"), "Not ordered");
      assert.isFalse(yield* Effect.promise(() => page.playwright.locator("#agree").isChecked()));

      // A page without a focused control, such as a keyboard game, still receives typed keys.
      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          (document.activeElement as HTMLElement | null)?.blur();
          document.addEventListener("keydown", (event) => {
            document.body.dataset.keys = (document.body.dataset.keys ?? "") + event.key;
          });
        }),
      );
      yield* page.type("wasd");
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.keys)),
        "wasd",
      );
    }),
  );

  it.effect(
    "types a secret only into a secret field, and records the field typed into by focus",
    () =>
      Effect.gen(function* () {
        const page = yield* open("/form");

        const value = (selector: string) =>
          Effect.promise(() => page.playwright.inputValue(selector));

        const focus = (selector: string) =>
          Effect.promise(() => page.playwright.locator(selector).focus());

        yield* Effect.promise(() =>
          page.playwright.setContent(
            '<label>Company <input id="company"></label><label>Password <input id="password" type="password"></label>',
          ),
        );
        yield* focus("#company");
        assert.deepStrictEqual(yield* reason(page.type("hunter2", { secret: true })), {
          tag: "NotActionable",
          dispatched: false,
        });
        yield* focus("#password");
        yield* page.type("hunter2", { secret: true });

        const typed = (yield* page.recentEvents).flatMap((event) =>
          event._tag === "Action" && event.name === "type" && event.ok
            ? [[event.subject?.name, event.text]]
            : [],
        );

        assert.deepStrictEqual(typed, [["Password", redacted]]);
        assert.deepStrictEqual(
          [yield* value("#company"), yield* value("#password")],
          ["", "hunter2"],
        );
      }),
  );

  it.effect("stops repeated keys at a navigation instead of pressing on the next page", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const armed = (yield* Site).url("/armed");

      // The next page focuses a destructive control on load, where a second Enter would land.
      yield* Effect.promise(() =>
        page.playwright.route(armed, (route) =>
          route.fulfill({
            contentType: "text/html",
            body: "<title>Armed</title><button autofocus onclick=\"document.title='Deleted'\">Delete account</button>",
          }),
        ),
      );
      yield* Effect.promise(() =>
        page.playwright.setContent('<a id="next" href="' + armed + '">Next</a>'),
      );
      yield* Effect.promise(() => page.playwright.locator("#next").focus());

      assert.deepStrictEqual(yield* reason(page.press("Enter", { times: 2, holdMillis: 600 })), {
        tag: "NotActionable",
        dispatched: true,
      });
      assert.strictEqual(yield* page.title, "Armed");
    }),
  );

  it.effect("drags a slider between points", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      const box = yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          const rect = document.getElementById("slider")?.getBoundingClientRect();

          return rect === undefined
            ? undefined
            : { x: rect.x, y: rect.y + rect.height / 2, width: rect.width };
        }),
      );

      assert.isDefined(box);
      if (box === undefined) return;
      yield* page.drag({ x: box.x + 2, y: box.y }, { x: box.x + box.width / 2, y: box.y });
      const level = Number(yield* text(page, "#level"));

      assert.isAbove(level, 35);
      assert.isBelow(level, 65);

      const drag = (yield* page.recentEvents).find(
        (event) => event._tag === "Action" && event.name === "drag",
      );

      assert.deepStrictEqual(
        drag?._tag === "Action" ? [drag.subject?.name, drag.to?.role] : undefined,
        ["Level", "slider"],
      );
    }),
  );

  it.effect("refuses a stale ref without sending anything", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const submit = refOf(yield* page.snapshot(), "button", "Submit");
      const site = yield* Site;

      yield* page.goto(site.url("/next"));
      assert.deepStrictEqual(yield* reason(page.click(submit)), {
        tag: "StaleRef",
        dispatched: false,
      });
      assert.deepStrictEqual(yield* reason(page.click("submit")), {
        tag: "InvalidRequest",
        dispatched: false,
      });

      // Nodes of a navigated frame can stay connected to their old document; they are stale too.
      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<iframe name="child" srcdoc="<button>Frame action</button>"></iframe>',
        ),
      );
      const framed = refOf(yield* page.snapshot(), "button", "Frame action");

      yield* Effect.promise(() =>
        page.playwright.frame({ name: "child" })!.goto(site.url("/next")),
      );
      assert.deepStrictEqual(yield* reason(page.click(framed)), {
        tag: "StaleRef",
        dispatched: false,
      });
    }),
  );

  it.effect("gives no ref twice on a page, so one from an earlier document names nothing", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const site = yield* Site;
      const first = yield* page.snapshot();
      const submit = refOf(first, "button", "Submit");
      const given = new Set(Array.from(first.text.matchAll(/\[ref=(e\d+)\]/g), ([, ref]) => ref));

      // The same form again, each time read first by an outline or by `find`, which number refs
      // apart: the old Submit's ref would name the new one if either began again at `e1`.
      for (const read of [
        page.snapshot().pipe(
          Effect.map((snapshot) => Array.from(snapshot.text.matchAll(/\[ref=(e\d+)\]/g))),
          Effect.map((matches) => matches.map(([, ref]) => ref)),
        ),
        page.find({ role: "button" }).pipe(Effect.map((found) => found.map(({ ref }) => ref))),
      ]) {
        yield* page.goto(site.url("/form"));
        const refs = yield* read;

        assert.isNotEmpty(refs);
        assert.deepStrictEqual(
          refs.filter((ref) => given.has(ref)),
          [],
        );
        for (const ref of refs) given.add(ref);
        assert.deepStrictEqual(yield* reason(page.click(submit)), {
          tag: "StaleRef",
          dispatched: false,
        });
      }
    }),
  );

  it.effect("waits for text on through documents that replace one another meanwhile", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      // Each hop sends the tab on 100 ms after it loads, and the third shows the text.
      yield* Effect.promise(() =>
        page.playwright.route(/\/hop\/\d$/, (route) => {
          const hop = Number(route.request().url().slice(-1));

          return route.fulfill({
            contentType: "text/html",
            body:
              hop < 3
                ? `<script>setTimeout(() => location.assign("/hop/${hop + 1}"), 100)</script>`
                : "<p>Arrived after three hops</p>",
          });
        }),
      );
      yield* Effect.promise(() =>
        page.playwright.evaluate(() => setTimeout(() => location.assign("/hop/1"), 100)),
      );
      yield* page.waitFor({ text: "Arrived after three hops" });
    }),
  );

  it.effect("goes back through frame-only history and refuses when there is nothing behind", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const site = yield* Site;

      const fresh = yield* Effect.acquireRelease(browser.newPage(), (page) =>
        Effect.ignore(page.close),
      );

      assert.deepStrictEqual(yield* reason(fresh.back), { tag: "NotFound", dispatched: false });

      const page = yield* open("/form");

      yield* Effect.promise(() =>
        page.playwright.setContent(`<iframe name="child" src="${site.url("/next")}"></iframe>`),
      );
      const child = page.playwright.frame({ name: "child" });

      assert.isNotNull(child);
      if (child === null) return;
      yield* Effect.promise(() => child.waitForLoadState());
      yield* Effect.promise(() => child.goto(site.url("/chart")));

      // Only the frame navigated: the traversal must finish without a main-frame navigation.
      yield* page.back.pipe(Effect.timeout(Duration.seconds(5)));
      assert.strictEqual(child.url(), site.url("/next"));
    }),
  );

  it.effect("reports a refused connection as a failed navigation", () =>
    Effect.gen(function* () {
      const page = yield* open("/next");

      assert.deepStrictEqual(yield* reason(page.goto("http://127.0.0.1:9/")), {
        tag: "NavigationFailed",
        dispatched: true,
      });
    }),
  );

  it.effect("registers a tab that is busy while it opens, before its click is done", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* open("/opens-busy");
      const before = (yield* browser.pages).length;

      yield* page.click(refOf(yield* page.snapshot(), "link", "Open a busy tab"));

      // Registration must not depend on the new tab's renderer answering in time.
      const pages = yield* browser.pages;

      const opened = pages.filter((other) => other.id !== page.id).at(-1);

      assert.strictEqual(pages.length, before + 1);
      if (opened === undefined) return;
      assert.strictEqual(yield* opened.url, (yield* Site).url("/busy"));
      yield* opened.close;
    }),
  );

  it.effect("plays a canvas game by point and waits for the reels to stop", () =>
    Effect.gen(function* () {
      const page = yield* open("/slots");

      yield* page.click({ x: 300, y: 320 });
      assert.isTrue((yield* slotState(page)).spinning);
      yield* page.ready({ quietMillis: 600, timeout: Duration.seconds(10) });
      assert.deepInclude(yield* slotState(page), { spins: 1, spinning: false });
      assert.deepStrictEqual(yield* reason(page.click({ x: 5000, y: 5 })), {
        tag: "InvalidRequest",
        dispatched: false,
      });
    }),
  );

  it.effect("streams viewport-sized frames while the page moves", () =>
    Effect.gen(function* () {
      const page = yield* open("/slots");

      const frames = yield* page
        .screencast()
        .pipe(Stream.take(5), Stream.runCollect, Effect.forkChild);

      yield* Effect.sleep(Duration.millis(300));
      yield* page.click({ x: 300, y: 320 });
      const collected = yield* Fiber.join(frames).pipe(Effect.timeout(Duration.seconds(10)));
      const arrivals = collected.map((frame) => frame.receivedAt);

      assert.strictEqual(collected.length, 5);
      assert.deepStrictEqual([collected[0]?.width, collected[0]?.height], [1280, 720]);
      assert.deepStrictEqual(
        arrivals,
        [...arrivals].sort((a, b) => a - b),
      );
    }),
  );

  // The red page keeps painting until the blue one, which the server answers late, commits, so its
  // own frames are the newest when the navigation returns: every read must show the blue one.
  it.effect("shows the page a navigation reached, never the one it left", () =>
    Effect.gen(function* () {
      const site = yield* Site;
      const page = yield* open("/spinning");

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);

      const reads: Record<string, Effect.Effect<BrowserImage | undefined, BrowserError>> = {
        screenshot: page.screenshot(),
        frame: Effect.map(page.frame(), (frame) => frame.image),
        "frame after input": Effect.map(page.frame({ after: "input" }), (frame) => frame.image),
        moment: Effect.map(
          Moment.capture(page, { frames: 1 }),
          (moment) => moment.frames[0]?.image,
        ),
      };

      for (const [read, image] of Object.entries(reads)) {
        yield* page.goto(site.url("/spinning"));
        yield* Effect.sleep(Duration.millis(300));
        yield* page.goto(site.url("/late"));
        const shown = yield* image;
        const [red = 0, , blue = 0] = shown === undefined ? [] : yield* centerPixel(page, shown);

        assert.isTrue(red < 80 && blue > 180, `${read} showed rgb ${red}, _, ${blue}`);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("takes JPEG and PNG screenshots in viewport pixels", () =>
    Effect.gen(function* () {
      const page = yield* open("/chart");
      const image = yield* page.screenshot();
      const detail = yield* page.screenshot({ clip: { x: 0, y: 0, width: 200, height: 100 } });

      assert.deepStrictEqual(
        [image.mediaType, image.width, image.height],
        ["image/jpeg", 1280, 720],
      );
      assert.deepStrictEqual([image.data[0], image.data[1]], [0xff, 0xd8]);
      assert.deepStrictEqual([detail.width, detail.height], [200, 100]);

      const png = yield* page.screenshot({ format: "png" });

      assert.deepStrictEqual([png.mediaType, png.width, png.height], ["image/png", 1280, 720]);
      assert.deepStrictEqual([png.data[0], png.data[1]], [0x89, 0x50]);
    }),
  );

  // Chromium has no surface to copy until a page paints its first frame, as just after a
  // navigation, and says "Unable to capture screenshot" until then.
  it.effect("takes a picture again once a page that has not painted yet has", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      if (native === null) return yield* Effect.die("the test requires local Chromium");

      const context = yield* Effect.acquireRelease(
        Effect.promise(() => native.newContext({ viewport: { width: 1280, height: 720 } })),
        (context) => Effect.promise(() => context.close()),
      );

      const createSession = context.newCDPSession.bind(context);
      let captures = 0;

      context.newCDPSession = async (target) => {
        const cdp = await createSession(target);
        const send = cdp.send.bind(cdp);

        const unpainted: CDPSession["send"] = (method, params) => {
          if (method === "Page.captureScreenshot" && ++captures === 1)
            return Promise.reject(
              new Error("Protocol error (Page.captureScreenshot): Unable to capture screenshot"),
            );

          return send(method, params);
        };

        cdp.send = unpainted;

        return cdp;
      };

      const browser = yield* makeBrowser(context, { id: "unpainted", provider: "test" });
      const page = yield* browser.newPage((yield* Site).url("/chart"));
      const image = yield* page.screenshot({ maxAge: 0 });

      assert.deepStrictEqual([image.width, image.height, captures], [1280, 720, 2]);
    }),
  );

  it.effect("zooms a scrolled viewport in CSS pixels at device scale factor two", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const native = browser.context.browser();

      assert.isNotNull(native);
      if (native === null) return;

      const context = yield* Effect.acquireRelease(
        Effect.promise(() =>
          native.newContext({
            viewport: { width: 640, height: 480 },
            deviceScaleFactor: 2,
          }),
        ),
        (context) => Effect.promise(() => context.close()),
      );

      const highDpi = yield* makeBrowser(context, { id: "test-dpr-two", provider: "test" });
      const page = yield* highDpi.newPage((yield* Site).url("/form"));

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0;height:1600px;background:#111">' +
            '<div style="position:absolute;left:80px;top:120px;width:100px;height:60px;background:rgb(200,20,20)"></div>' +
            '<button id="target" style="position:absolute;left:80px;top:720px;width:100px;height:60px;border:0;padding:0;background:rgb(20,200,40)" onclick="document.body.dataset.clicked=\'yes\'"></button>',
        ),
      );
      yield* Effect.promise(() => page.playwright.evaluate(() => window.scrollTo(0, 600)));
      const region = { x: 80, y: 120, width: 100, height: 60 };
      const zoom = yield* page.zoom(region);
      const pixel = yield* centerPixel(page, zoom.image);

      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => window.devicePixelRatio)),
        2,
      );
      assert.deepStrictEqual({ ...zoom.region }, region);
      assert.strictEqual(zoom.page, page.id);
      assert.deepStrictEqual([zoom.image.width, zoom.image.height], [100, 60]);
      assert.isBelow(pixel[0] ?? 255, 40);
      assert.isAbove(pixel[1] ?? 0, 180);
      assert.isBelow(pixel[2] ?? 255, 60);

      const clicked = yield* page.click({ x: 130, y: 150 });

      assert.deepStrictEqual(clicked.point, { x: 130, y: 150 });
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.clicked)),
        "yes",
      );
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => window.scrollY)),
        600,
      );
    }),
  );

  it.effect("rejects invalid zoom regions before capturing a picture", () =>
    Effect.gen(function* () {
      const page = yield* open("/chart");
      const screenshot = page.playwright.screenshot.bind(page.playwright);
      let captures = 0;

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          page.playwright.screenshot = (...args: Parameters<typeof screenshot>) => {
            captures += 1;

            return screenshot(...args);
          };
        }),
        () =>
          Effect.sync(() => {
            page.playwright.screenshot = screenshot;
          }),
      );

      for (const region of [
        { x: -1, y: 0, width: 10, height: 10 },
        { x: 0, y: -1, width: 10, height: 10 },
        { x: 0, y: 0, width: 0, height: 10 },
        { x: 0, y: 0, width: 10, height: 0 },
        { x: 0, y: 0, width: Number.NaN, height: 10 },
        { x: Number.POSITIVE_INFINITY, y: 0, width: 10, height: 10 },
        { x: 1270, y: 0, width: 20, height: 10 },
        { x: 0, y: 710, width: 10, height: 20 },
      ]) {
        assert.deepStrictEqual(yield* reason(page.zoom(region)), {
          tag: "InvalidRequest",
          dispatched: false,
        });
      }
      assert.strictEqual(captures, 0);
      yield* page.zoom({ x: 0, y: 0, width: 40, height: 40 });
      assert.strictEqual(captures, 1);
    }),
  );

  it.effect("names the actionable ancestor at a pixel without moving the requested point", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const destination = (yield* Site).url("/next");

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0"><a id="target" href="/next" style="position:absolute;left:50px;top:40px;width:200px;height:100px;cursor:pointer" onclick="event.preventDefault();document.body.dataset.clicked=event.clientX+\',\'+event.clientY">' +
            '<span style="position:absolute;left:10px;top:10px;width:80px;height:20px">Next page</span></a>',
        ),
      );

      const target = yield* page.click({ x: 70, y: 60 });

      assert.strictEqual(target.role, "link");
      assert.strictEqual(target.name, "Next page");
      assert.strictEqual(target.cursor, "pointer");
      assert.strictEqual(target.href, destination);
      assert.include(target.element, "<a#target>");
      assert.deepStrictEqual(target.point, { x: 70, y: 60 });
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.clicked)),
        "70,60",
      );
    }),
  );

  it.effect("resolves pixels inside open shadow roots and same-origin frames", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0"><div id="host" style="position:absolute;left:300px;top:40px"></div>' +
            '<iframe id="frame" style="position:absolute;left:50px;top:200px;width:250px;height:130px;border:5px solid black" srcdoc="<body style=margin:0><button id=target style=position:absolute;left:20px;top:20px;width:140px;height:60px;cursor:progress onclick=&quot;document.body.dataset.clicked=event.clientX+\',\'+event.clientY&quot;>Frame action</button>"></iframe>',
        ),
      );
      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          const root = document.getElementById("host")?.attachShadow({ mode: "open" });

          if (root !== undefined)
            root.innerHTML =
              '<button id="shadow-target" style="width:100px;height:70px;cursor:crosshair" onclick="document.body.dataset.shadow=event.clientX+\',\'+event.clientY"><span>Shadow action</span></button>';
        }),
      );

      const shadow = yield* page.click({ x: 350, y: 75 });

      assert.strictEqual(shadow.role, "button");
      assert.strictEqual(shadow.name, "Shadow action");
      assert.strictEqual(shadow.cursor, "crosshair");
      assert.deepStrictEqual(shadow.point, { x: 350, y: 75 });
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.evaluate(() => document.body.dataset.shadow)),
        "350,75",
      );

      const frame = yield* page.click({ x: 105, y: 245 });

      assert.strictEqual(frame.role, "button");
      assert.strictEqual(frame.name, "Frame action");
      assert.strictEqual(frame.cursor, "progress");
      assert.deepStrictEqual(frame.point, { x: 105, y: 245 });
      assert.strictEqual(
        yield* Effect.promise(() =>
          page.playwright.evaluate(
            () => document.querySelector("iframe")?.contentDocument?.body.dataset.clicked,
          ),
        ),
        "50,40",
      );
    }),
  );

  it.effect(
    "measures frame refs in the top viewport: covered frames refuse, distant ones scroll",
    () =>
      Effect.gen(function* () {
        const page = yield* open("/form");
        const record = (name: string) => `parent.document.body.dataset.${name}=1`;

        yield* Effect.promise(() =>
          page.playwright.setContent(
            `<body style="margin:0;height:4000px">` +
              `<iframe style="position:absolute;left:0;top:0;width:400px;height:200px;border:0" srcdoc="<body style='margin:0'><button style='width:400px;height:200px' onclick='${record("covered")}'>Covered action</button>"></iframe>` +
              `<div style="position:absolute;left:0;top:0;width:400px;height:200px;z-index:5" onmousedown="document.body.dataset.cover=1"></div>` +
              `<iframe style="position:absolute;left:0;top:1500px;width:400px;height:200px;border:0" srcdoc="<body style='margin:0'><button style='width:200px;height:50px' onclick='${record("deep")}'>Deep action</button>"></iframe></body>`,
          ),
        );
        const snapshot = yield* page.snapshot({ full: true });

        assert.deepStrictEqual(
          yield* reason(page.click(refOf(snapshot, "button", "Covered action"))),
          {
            tag: "NotActionable",
            dispatched: false,
          },
        );

        const deep = yield* page.click(refOf(snapshot, "button", "Deep action"));

        const dataset = yield* Effect.promise(() =>
          page.playwright.evaluate(() => ({ ...document.body.dataset })),
        );

        assert.isBelow(deep.point.y, 720);
        assert.deepStrictEqual(dataset, { deep: "1" });
      }),
  );

  it.effect("keeps transformed iframe receipts conservative without changing the click", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<body style="margin:0"><iframe title="Scaled view" style="position:absolute;left:50px;top:50px;width:250px;height:130px;border:0;transform:scale(2);transform-origin:top left" srcdoc="<body style=margin:0><button style=position:absolute;left:100px;top:20px;width:100px;height:60px onclick=&quot;document.body.dataset.clicked=event.clientX+\',\'+event.clientY&quot;>Scaled action</button>"></iframe>',
        ),
      );

      const target = yield* page.click({ x: 350, y: 130 });

      assert.strictEqual(target.role, "iframe");
      assert.strictEqual(target.name, "Scaled view");
      assert.deepStrictEqual(target.point, { x: 350, y: 130 });
      assert.strictEqual(
        yield* Effect.promise(() =>
          page.playwright.evaluate(
            () => document.querySelector("iframe")?.contentDocument?.body.dataset.clicked,
          ),
        ),
        "150,40",
      );
    }),
  );

  // After input a page gets a task and a frame, and a document only if the input asked for one:
  // a link and a handler's timer do, whether the server answers at once or 300 ms later; a
  // fetch's answer comes too late to tell; `pushState` and a link the server answers with no
  // content ask for none.
  it.effect("waits after a click for the document it asked for, and for nothing else", () =>
    Effect.gen(function* () {
      for (const [role, name] of [
        ["link", "Link"],
        ["button", "Timer"],
      ] as const) {
        const page = yield* open("/navigating");

        yield* page.click(refOf(yield* page.snapshot(), role, name));
        assert.include(yield* shows(page), "The next page", name);
      }
      for (const [role, name] of [
        ["link", "Later"],
        ["button", "Delayed"],
      ] as const) {
        const page = yield* open("/navigating");

        yield* page.click(refOf(yield* page.snapshot(), role, name));
        assert.match((yield* page.text()).url, /\/late$/, name);
      }

      // A document whose end comes 300 ms after its start is parsed as the click returns.
      const streaming = yield* open("/navigating");

      yield* streaming.click(refOf(yield* streaming.snapshot(), "link", "Streaming"));
      assert.include(yield* shows(streaming), "The bottom");

      const fetching = yield* open("/navigating");

      const asked = yield* timed(
        fetching.click(refOf(yield* fetching.snapshot(), "button", "Fetch")),
      );

      assert.isBelow(asked.millis, 400);
      assert.include(yield* shows(fetching), "Fetch");
      yield* fetching.waitFor({ text: "The next page" });

      for (const [role, name] of [
        ["button", "Push"],
        ["link", "Empty"],
      ] as const) {
        const page = yield* open("/navigating");
        const clicked = yield* timed(page.click(refOf(yield* page.snapshot(), role, name)));

        assert.isBelow(clicked.millis, 1000, name);
        assert.include(yield* shows(page), "Still", name);
      }
    }),
  );

  // The fixed sleeps after clicks alone took 1.2 s per ten.
  it.effect("settles ten clicks in a fraction of the time the fixed sleeps took", () =>
    Effect.gen(function* () {
      const page = yield* open("/navigating");
      const still = refOf(yield* page.snapshot(), "button", "Still");

      yield* page.click(still);
      const ten = yield* timed(Effect.repeat(page.click(still), { times: 9 }));

      assert.isBelow(ten.millis, 1200);
    }),
  );

  it.effect("checks every input with the guard, and refuses before sending", () =>
    Effect.gen(function* () {
      const site = yield* Site;

      const guarded = Chromium.layer({
        guard: (request) =>
          request.element?.includes("Submit") === true
            ? Effect.fail(new PolicyDenied({ detail: "not allowed" }))
            : Effect.void,
      });

      yield* Effect.gen(function* () {
        const page = yield* (yield* Browser).newPage(site.url("/form"));
        const snapshot = yield* page.snapshot();

        assert.deepStrictEqual(yield* reason(page.click(refOf(snapshot, "button", "Submit"))), {
          tag: "PolicyDenied",
          dispatched: false,
        });
        assert.strictEqual(yield* text(page, "#outcome"), "Not ordered");
        yield* page.click(refOf(snapshot, "checkbox", "I agree"));
      }).pipe(Effect.provide(guarded));
    }),
  );
});

setFlagsFromString("--expose_gc");
const collectGarbage = runInNewContext("gc") as () => void;

const ownContext = Effect.gen(function* () {
  const native = (yield* Browser).context.browser();

  if (native === null) return yield* Effect.die("the fixture requires a launched Chromium");

  return yield* Effect.acquireRelease(
    Effect.promise(() => native.newContext()),
    (context) => Effect.promise(() => context.close()),
  );
});

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Page lifetime",
  (it) => {
    it.effect("releases a closed tab's frames while its browser stays open", () =>
      Effect.gen(function* () {
        const context = yield* ownContext;
        const browser = yield* makeBrowser(context, { id: "lifetime", provider: "test" });
        const frames: Array<WeakRef<object>> = [];

        const visit = Effect.gen(function* () {
          const page = yield* browser.newPage("data:text/html,<h1>Captured tab</h1>");

          yield* page.screencast().pipe(Stream.take(1), Stream.runDrain);
          for (const frame of yield* page.recentFrames) frames.push(new WeakRef(frame));
          yield* page.close;
        });

        for (let index = 0; index < 3; index++) yield* visit;
        yield* (yield* browser.firstPage).close;
        yield* browser.pages.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(50)),
            until: (open) => open.length === 0,
          }),
        );
        for (let attempt = 0; attempt < 3; attempt++) {
          yield* Effect.sleep("100 millis");
          collectGarbage();
        }

        assert.isAbove(frames.length, 0);
        assert.strictEqual(frames.filter((frame) => frame.deref() !== undefined).length, 0);
      }),
    );

    it.effect("leaves a caller's context with none of its listeners once it closes", () =>
      Effect.gen(function* () {
        const context = yield* ownContext;
        const page = yield* Effect.promise(() => context.newPage());
        const scope = yield* Scope.make();

        // Playwright's pages are event emitters; its typings omit the count.
        const listeners = () =>
          (["dialog", "close", "framenavigated"] as const).map((event) =>
            (page as unknown as EventEmitter).listenerCount(event),
          );

        const before = listeners();

        yield* makeBrowser(context, { id: "short", provider: "test" }).pipe(Scope.provide(scope));
        assert.notDeepEqual(listeners(), before);
        yield* Scope.close(scope, Exit.void);
        assert.deepStrictEqual(listeners(), before);

        // The caller now answers its own dialogs; a leftover handler would dismiss them first.
        page.on("dialog", (dialog) => {
          dialog.accept("from the caller").catch(() => undefined);
        });
        const answer = yield* Effect.promise(() => page.evaluate(() => prompt("name?")));

        assert.strictEqual(answer, "from the caller");
      }),
    );
  },
);
