import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Stream } from "effect";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Failed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Image as BrowserImage } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
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

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) => page.close);
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

  it.effect("registers a tab a link opens and records events", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* open("/form");
      const before = (yield* browser.pages).length;

      yield* page.click(refOf(yield* page.snapshot(), "link", "Open in a new tab"));
      yield* Effect.sleep(Duration.millis(500));
      const pages = yield* browser.pages;

      assert.strictEqual(pages.length, before + 1);
      yield* Effect.forEach(
        pages.filter((other) => other.id !== page.id).slice(-1),
        (other) => other.close,
      );

      const events = (yield* browser.recentEvents).filter(
        (event) => "page" in event && event.page === page.id,
      );

      assert.isTrue(events.some((event) => event._tag === "Navigated"));
      assert.isTrue(
        events.some((event) => event._tag === "Action" && event.name === "click" && event.ok),
      );
    }),
  );

  it.effect("plays a canvas game by point and waits for the reels to stop", () =>
    Effect.gen(function* () {
      const page = yield* open("/slots");

      yield* page.click({ x: 300, y: 320 });
      assert.isTrue((yield* slotState(page)).spinning);
      yield* page.waitForStill({ timeout: Duration.seconds(10) });
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

  it.effect("takes JPEG screenshots in viewport pixels", () =>
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

  it.effect("checks every input with the guard, and refuses before sending", () =>
    Effect.gen(function* () {
      const site = yield* Site;

      const guarded = Chromium.layer({
        guard: (request) =>
          request.element?.includes("Submit") === true
            ? Effect.fail(
                new BrowserError({
                  operation: request.action,
                  reason: new Failed({ detail: "not allowed" }),
                  dispatched: false,
                }),
              )
            : Effect.void,
      });

      yield* Effect.gen(function* () {
        const page = yield* (yield* Browser).newPage(site.url("/form"));
        const snapshot = yield* page.snapshot();

        assert.deepStrictEqual(yield* reason(page.click(refOf(snapshot, "button", "Submit"))), {
          tag: "Failed",
          dispatched: false,
        });
        assert.strictEqual(yield* text(page, "#outcome"), "Not ordered");
        yield* page.click(refOf(snapshot, "checkbox", "I agree"));
      }).pipe(Effect.provide(guarded));
    }),
  );

  it.effect("moves the pointer along a path when humanized", () =>
    Effect.gen(function* () {
      const site = yield* Site;

      yield* Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.newPage(site.url("/form"));

        yield* page.click(refOf(yield* page.snapshot(), "button", "Submit"));
        assert.strictEqual(yield* text(page, "#outcome"), "Ordered 10 btc");

        const moves = (yield* browser.recentEvents).filter(
          (event) => event._tag === "PointerMoved",
        );

        assert.isAbove(moves.length, 5);
      }).pipe(Effect.provide(Chromium.layer({ humanize: true })));
    }),
  );
});
