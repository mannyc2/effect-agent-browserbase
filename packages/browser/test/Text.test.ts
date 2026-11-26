import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";

import { Browser } from "../src/Browser.ts";
import type { Page } from "../src/Page.ts";
import * as Snapshot from "../src/Snapshot.ts";
import * as Text from "../src/Text.ts";
import { Site, SiteLayer } from "./fixtures.ts";
import * as TestCdp from "./support/TestCdp.ts";

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) =>
      Effect.ignore(page.close),
    );
  });

// What the account page's fields hold, none of it shown unless asked for.
const held = ["ada@example.com", "Ring twice", "Chile", "Likes chess"];
// A one-time code, a password typed in, and a PIN whose field only its style masks.
const secrets = ["424242", "hunter2-secret", "4321"];

/** The ref of the one element a query finds. */
const only = (page: Page, role: string, name: string) =>
  Snapshot.find(page, { role, name }).pipe(Effect.map((found) => found[0]?.ref ?? "none"));

layer(TestCdp.provideLayer(Layer.mergeAll(Chromium.layer(), SiteLayer)), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Text.read", (it) => {
  it.effect("reads what the viewport shows, a line per block and cells apart by tabs", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const page = yield* open("/account");
        const { text, truncated } = yield* Text.read(page);
        const lines = text.split("\n");

        for (const line of [
          "Account",
          "Show password Save",
          "Plan\tPrice",
          "Pro\t$9",
          "First part",
        ])
          assert.include(lines, line);
        assert.notInclude(text, "Last part");
        assert.isFalse(truncated);

        const short = yield* Text.read(page, { maxChars: 20 });

        assert.isTrue(short.truncated);
        assert.isAtMost(short.text.length, 20);
        // It is cut at a line.
        for (const line of short.text.split("\n")) assert.include(lines, line);
      }),
    ),
  );

  it.effect("masks what fields hold unless asked, and never shows a secret", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const page = yield* open("/account");

        yield* page.type("hunter2-secret", { into: yield* only(page, "textbox", "Password") });
        const masked = (yield* Text.read(page)).text;
        const unmasked = (yield* Text.read(page, { unmask: true })).text;

        for (const value of [...held, ...secrets]) assert.notInclude(masked, value);
        for (const value of held) assert.include(unmasked, value);
        for (const value of secrets) assert.notInclude(unmasked, value);

        // A password its page reveals stays secret, in text and in the outline.
        yield* page.click(yield* only(page, "button", "Show password"));
        assert.strictEqual(
          yield* Effect.promise(() =>
            TestCdp.nativePage(page).evaluate(() =>
              document.querySelector("input#password")?.getAttribute("type"),
            ),
          ),
          "text",
        );
        assert.notInclude((yield* Text.read(page, { unmask: true })).text, "hunter2-secret");
        for (const value of secrets) assert.notInclude((yield* Snapshot.read(page)).text, value);
      }),
    ),
  );

  it.effect("reads one element whole, in view or not", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const page = yield* open("/account");
        const story = yield* Text.read(page, { scope: yield* only(page, "region", "Story") });

        assert.deepStrictEqual(story.text.split("\n"), ["First part", "Last part"]);
        assert.strictEqual(
          yield* Text.read(page, { scope: "e999999" }).pipe(
            Effect.flip,
            Effect.map((error) => error.reason._tag),
          ),
          "StaleRef",
        );
      }),
    ),
  );
});
