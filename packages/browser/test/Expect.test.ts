// Expectations over real Chromium: an action sent only while what it is for has not happened, its
// effect waited for, a failure after its input went checked, and each kind of expectation.
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Option } from "effect";

import { Browser } from "../src/Browser.ts";
import { BrowserError, StaleRef, Timeout } from "../src/BrowserError.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Expect from "../src/Expect.ts";
import type { FindQuery, Page } from "../src/Page.ts";
import * as Presentation from "../src/Presentation.ts";
import { Site, SiteLayer, unpaused } from "./fixtures.ts";
import { behindProxy } from "./protocol.ts";

// A shop whose order shows late, a banner that closes, a counter, a note, and a button that does
// nothing.
const shop = `data:text/html,${encodeURIComponent(`<title>Shop</title>
<body style="margin:0;font-family:sans-serif">
<div role="alert" id="banner">We use cookies <button onclick="banner.remove()">Close</button></div>
<button onclick="placed += 1; setTimeout(() => { outcome.textContent = 'Order placed, number ' + placed }, 300)">Place order</button>
<button>Nothing</button>
<button onclick="count.textContent = String(Number(count.textContent) + 1)">More</button>
<p role="status" id="count">0</p>
<label>Note <input id="note"></label>
<p id="outcome">Not ordered</p>
<script>var placed = 0</script>
</body>`)}`;

const open = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(shop), (page) => Effect.ignore(page.close));
});

const refOf = (page: Page, query: FindQuery) =>
  Effect.map(page.find(query), (found) => found[0]?.ref ?? "");

const button = (page: Page, name: string) => refOf(page, { role: "button", name });

const placed = (page: Page) =>
  Effect.promise(() => page.playwright.evaluate(() => (globalThis as { placed?: number }).placed));

/** An action that clicks and then fails as if its reply never came, its input gone. */
const lostReply = (ref: string) => (page: Page) =>
  page.click(ref).pipe(
    Effect.andThen(
      Effect.fail(
        new BrowserError({
          operation: "click",
          reason: new Timeout({ millis: 10_000 }),
          dispatched: true,
        }),
      ),
    ),
  );

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Expect", (it) => {
  it.effect("acts, waits for its effect, and sends nothing once it holds", () =>
    Effect.gen(function* () {
      const page = yield* open;
      const place = yield* button(page, "Place order");
      const placing = yield* Expect.attempt(page, Expect.appeared({ text: "Order placed" }));

      assert.strictEqual(yield* placing.run(page, (page) => page.click(place)), "Done");
      assert.strictEqual(yield* placing.run(page, (page) => page.click(place)), "AlreadyDone");
      assert.strictEqual(yield* placed(page), 1);
    }),
  );

  it.effect("says NotDone when the effect does not come in time", () =>
    Effect.gen(function* () {
      const page = yield* open;
      const nothing = yield* button(page, "Nothing");

      const never = yield* Expect.attempt(page, Expect.appeared({ text: "Order placed" }), {
        wait: "300 millis",
      });

      assert.strictEqual(yield* never.run(page, (page) => page.click(nothing)), "NotDone");
      // Focus is no change: the field a click focused shows what it did.
      const note = { role: "textbox", name: "Note" };
      const focusing = yield* Expect.attempt(page, Expect.changed(note), { wait: "300 millis" });

      assert.strictEqual(
        yield* focusing.run(page, (page) =>
          Effect.flatMap(refOf(page, note), (ref) => page.click(ref)),
        ),
        "NotDone",
      );
      // What it holds is.
      assert.strictEqual(
        yield* focusing.run(page, (page) =>
          Effect.flatMap(refOf(page, note), (ref) => page.type("BTC", { into: ref })),
        ),
        "Done",
      );
    }),
  );

  it.effect("checks a failure after its input went, and fails as it did if nothing came", () =>
    Effect.gen(function* () {
      const page = yield* open;
      const place = yield* button(page, "Place order");
      const nothing = yield* button(page, "Nothing");
      const placing = yield* Expect.attempt(page, Expect.appeared({ text: "Order placed" }));

      assert.strictEqual(yield* placing.run(page, lostReply(place)), "Done");
      assert.strictEqual(yield* placing.run(page, lostReply(place)), "AlreadyDone");
      assert.strictEqual(yield* placed(page), 1);

      const never = yield* Expect.attempt(page, Expect.gone({ role: "alert" }), {
        wait: "300 millis",
      });

      const lost = yield* Effect.flip(never.run(page, lostReply(nothing)));

      assert.deepStrictEqual([lost.reason._tag, lost.dispatched], ["Timeout", true]);
    }),
  );

  it.effect("leaves a failure before the input went as it is, checking nothing after it", () =>
    Effect.gen(function* () {
      const page = yield* open;
      const place = yield* button(page, "Place order");
      const placing = yield* Expect.attempt(page, Expect.appeared({ text: "Order placed" }));
      const stale = yield* Effect.flip(placing.run(page, (page) => page.click("e9999")));

      assert.deepStrictEqual([stale.reason._tag, stale.dispatched], ["StaleRef", false]);
      assert.strictEqual(yield* placed(page), 0);

      // Even where the order then shows, a failure that says nothing went is not looked past.
      const refused = yield* Effect.flip(
        placing.run(page, (page) =>
          page.click(place).pipe(
            Effect.andThen(
              Effect.fail(
                new BrowserError({
                  operation: "click",
                  reason: new StaleRef({ ref: place }),
                  dispatched: false,
                }),
              ),
            ),
          ),
        ),
      );

      assert.strictEqual(refused.reason._tag, "StaleRef");
    }),
  );

  it.effect("tells gone and changed, changed against what the attempt began with", () =>
    Effect.gen(function* () {
      const page = yield* open;
      const close = yield* button(page, "Close");
      const more = yield* button(page, "More");
      const closing = yield* Expect.attempt(page, Expect.gone({ role: "alert" }));

      assert.isFalse(yield* closing.holds(page));
      assert.strictEqual(yield* closing.run(page, (page) => page.click(close)), "Done");
      assert.isTrue(yield* closing.holds(page));

      const counting = yield* Expect.attempt(page, Expect.changed({ role: "status" }));

      assert.strictEqual(yield* counting.run(page, (page) => page.click(more)), "Done");
      // Changed since the attempt began, so its second run sends nothing; a new attempt counts on.
      assert.strictEqual(yield* counting.run(page, (page) => page.click(more)), "AlreadyDone");
      const again = yield* Expect.attempt(page, Expect.changed({ role: "status" }));

      assert.strictEqual(yield* again.run(page, (page) => page.click(more)), "Done");
      assert.strictEqual(yield* Effect.promise(() => page.playwright.textContent("#count")), "2");
    }),
  );

  it.effect("tells a navigation by its address, or by any move from where it began", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const site = yield* Site;
      const page = yield* browser.newPage(site.url("/form"));

      const link = yield* Effect.map(
        page.find({ role: "link", name: "Next page" }),
        (found) => found[0]?.ref ?? "",
      );

      const going = yield* Expect.attempt(page, Expect.navigated(/\/next$/));
      const moving = yield* Expect.attempt(page, Expect.navigated());

      assert.isFalse(yield* moving.holds(page));
      assert.strictEqual(yield* going.run(page, (page) => page.click(link)), "Done");
      assert.isTrue(yield* moving.holds(page));
      assert.strictEqual(yield* going.run(page, (page) => page.click(link)), "AlreadyDone");
      // A reload stays at its address, and the new document it makes tells it.
      const reloading = yield* Expect.attempt(page, Expect.navigated(), { wait: "2 seconds" });

      assert.strictEqual(yield* reloading.run(page, (page) => page.reload), "Done");
    }),
  );

  it.effect("on a page a reconnect finds by its id, tells a navigation by its address", () =>
    Effect.gen(function* () {
      const proxy = yield* behindProxy();
      const first = yield* Cdp.open({ endpoint: proxy.endpoint });
      const page = yield* first.newPage(shop);

      // Its third document, at the same address.
      yield* page.reload;
      yield* page.reload;
      const moving = yield* Expect.attempt(page, Expect.navigated());
      const later = yield* Cdp.open({ endpoint: proxy.endpoint });
      const again = Option.getOrThrow(yield* later.page(page.id));

      // The new connection counts the page's documents afresh, so only the address can tell.
      assert.isFalse(yield* moving.holds(again));
      yield* again.goto(`${shop}%3C!--elsewhere--%3E`);
      assert.isTrue(yield* moving.holds(again));
    }),
  );

  it.effect("checks through a presenter's view, and refuses a page no Browser made", () =>
    Effect.gen(function* () {
      const page = yield* open;
      const presenter = yield* Presentation.make({ pacing: unpaused });
      const view = presenter.view(page);
      const close = yield* button(page, "Close");
      const closing = yield* Expect.attempt(view, Expect.gone({ role: "alert" }));

      assert.strictEqual(yield* closing.run(view, (view) => view.click(close)), "Done");

      const copied: Page = { ...page };
      const refused = yield* Effect.flip(closing.holds(copied));

      assert.strictEqual(refused.reason._tag, "InvalidRequest");
    }),
  );
});
