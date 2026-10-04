import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Layer, Stream } from "effect";

import { Browser } from "../src/Browser.ts";
import { BrowserError, Failed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
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
