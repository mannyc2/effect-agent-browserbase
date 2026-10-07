import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";

import { Browser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) => page.close);
  });

// What the account page's fields hold, none of it shown unless asked for.
const held = ["ada@example.com", "Ring twice", "Chile", "Likes chess"];
const secrets = ["424242", "hunter2-secret"];

/** The ref of the one element a query finds. */
const only = (page: Page, role: string, name: string) =>
  page.find({ role, name }).pipe(Effect.map((found) => found[0]?.ref ?? "none"));

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Page.text", (it) => {
  it.effect("reads what the viewport shows, a line per block and cells apart by tabs", () =>
    Effect.gen(function* () {
      const page = yield* open("/account");
      const { text, truncated } = yield* page.text();
      const lines = text.split("\n");

      for (const line of ["Account", "Show password Save", "Plan\tPrice", "Pro\t$9", "First part"])
        assert.include(lines, line);
      assert.notInclude(text, "Last part");
      assert.isFalse(truncated);

      const short = yield* page.text({ maxChars: 20 });

      assert.isTrue(short.truncated);
      assert.isAtMost(short.text.length, 20);
    }),
  );

  it.effect("masks what fields hold unless asked, and never shows a secret", () =>
    Effect.gen(function* () {
      const page = yield* open("/account");

      yield* page.type("hunter2-secret", { into: yield* only(page, "textbox", "Password") });
      const masked = (yield* page.text()).text;
      const unmasked = (yield* page.text({ unmask: true })).text;

      for (const value of [...held, ...secrets]) assert.notInclude(masked, value);
      for (const value of held) assert.include(unmasked, value);
      for (const value of secrets) assert.notInclude(unmasked, value);

      // A password its page reveals stays secret, in text and in the outline.
      yield* page.click(yield* only(page, "button", "Show password"));
      assert.strictEqual(
        yield* Effect.promise(() =>
          page.playwright.evaluate(() =>
            document.querySelector("input#password")?.getAttribute("type"),
          ),
        ),
        "text",
      );
      assert.notInclude((yield* page.text({ unmask: true })).text, "hunter2-secret");
      for (const value of secrets) assert.notInclude((yield* page.snapshot()).text, value);
    }),
  );

  it.effect("reads one element whole, in view or not", () =>
    Effect.gen(function* () {
      const page = yield* open("/account");
      const story = yield* page.text({ scope: yield* only(page, "region", "Story") });

      assert.deepStrictEqual(story.text.split("\n"), ["First part", "Last part"]);
      assert.strictEqual(
        yield* page.text({ scope: "e999999" }).pipe(
          Effect.flip,
          Effect.map((error) => error.reason._tag),
        ),
        "StaleRef",
      );
    }),
  );
});
