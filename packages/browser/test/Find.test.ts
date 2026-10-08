import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Layer, Schema } from "effect";

import { Browser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import { type FindRequest, match } from "../src/internal/reading/match.inpage.ts";
import type { Found, Page } from "../src/Page.ts";
import { Site, SiteLayer } from "./fixtures.ts";

const { compile, normalize } = match();

const rules = (request: Partial<FindRequest>) =>
  compile({ role: null, name: null, text: null, near: null, ...request });

const candidate = (fields: {
  readonly role?: string | null;
  readonly name?: string;
  readonly text?: string;
  readonly context?: { readonly row?: string; readonly label?: string; readonly heading?: string };
}) => ({
  role: fields.role ?? null,
  name: () => fields.name ?? "",
  text: () => fields.text ?? "",
  context: () => fields.context ?? {},
});

const pattern = (source: RegExp) => Arbitrary.schema(Schema.String.check(Schema.isPattern(source)));
const word = pattern(/^[A-Za-z0-9ÀÉßİ$%+-]{1,8}$/);
const words = Arbitrary.array(word, { minLength: 1, maxLength: 6 });
const gap = pattern(/^[ \t\n ]{1,3}$/);
const flips = Arbitrary.array(Arbitrary.schema(Schema.Boolean), { minLength: 8, maxLength: 8 });

/** The words again, spaced by other whitespace, padded, and with their case changed. */
const respaced = (
  list: ReadonlyArray<string>,
  gaps: ReadonlyArray<string>,
  upper: ReadonlyArray<boolean>,
) =>
  list
    .map((item, index) => {
      const cased = upper[index % upper.length] === true ? item.toUpperCase() : item.toLowerCase();

      return `${gaps[index % gaps.length] ?? " "}${cased}`;
    })
    .join("") + (gaps[0] ?? "");

describe("Find's rules", () => {
  it.prop(
    "read a name the same however it is spaced or cased",
    { list: words, gaps: Arbitrary.array(gap, { minLength: 1, maxLength: 4 }), upper: flips },
    ({ list, gaps, upper }) => {
      const name = list.join(" ");
      const shown = respaced(list, gaps, upper);

      assert.isTrue(rules({ name })(candidate({ name: shown })), `${name} / ${shown}`);
      assert.isTrue(rules({ name: shown })(candidate({ name })), `${shown} / ${name}`);
    },
  );

  it.prop(
    "match no name with a letter more",
    { list: words, letter: pattern(/^[a-z0-9]$/) },
    ({ list, letter }) => {
      const name = list.join(" ");

      assert.isFalse(rules({ name })(candidate({ name: `${name}${letter}` })));
      assert.isFalse(rules({ name: `${letter}${name}` })(candidate({ name })));
    },
  );

  it.prop(
    "compare roles as one token, ignoring case and the space around it",
    { role: word, gaps: Arbitrary.array(gap, { minLength: 2, maxLength: 2 }), upper: flips },
    ({ role, gaps, upper }) => {
      const asked = `${gaps[0] ?? ""}${upper[0] === true ? role.toUpperCase() : role}${gaps[1] ?? ""}`;

      assert.isTrue(rules({ role: asked })(candidate({ role: role.toLowerCase() })));
      assert.isFalse(rules({ role: asked })(candidate({ role: `${role}x` })));
      assert.isFalse(rules({ role: asked })(candidate({ role: null })));
    },
  );

  it.prop(
    "try a pattern as the page shows the text, the same on every element",
    {
      list: words,
      gaps: Arbitrary.array(gap, { minLength: 1, maxLength: 4 }),
      upper: flips,
      flags: Arbitrary.schema(Schema.Literals(["", "i", "g", "gi", "y", "gy", "u"])),
    },
    ({ list, gaps, upper, flags }) => {
      const shown = respaced(list, gaps, upper);
      const source = (list[0] ?? "").replace(/[$+]/g, "\\$&");
      const wanted = new RegExp(source, flags.replace(/[gy]/g, ""));
      const matches = rules({ name: { source, flags } });
      const expected = wanted.test(shown.replace(/\s+/g, " ").trim());

      // A `g` or `y` pattern keeps a position between tests; the same element must not flip.
      for (let attempt = 0; attempt < 3; attempt++)
        assert.strictEqual(
          matches(candidate({ name: shown })),
          expected,
          `${source}/${flags} in ${shown}`,
        );
    },
  );

  it.prop(
    "find text anywhere in an element's text, however spaced or cased",
    {
      list: words,
      gaps: Arbitrary.array(gap, { minLength: 1, maxLength: 4 }),
      upper: flips,
      start: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 5 }))),
      length: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 6 }))),
    },
    ({ list, gaps, upper, start, length }) => {
      const part = list.slice(start % list.length, (start % list.length) + length).join(" ");

      assert.isTrue(rules({ text: part })(candidate({ text: respaced(list, gaps, upper) })));
      assert.isFalse(rules({ text: `${list.join("")}~` })(candidate({ text: list.join(" ") })));
    },
  );

  it.prop(
    "hold near when one part of the context holds it",
    { row: word, label: words, heading: word, near: word },
    ({ row, label, heading, near }) => {
      const context = { row, label: label.join(" "), heading };
      const alone = [{ row }, { label: label.join(" ") }, { heading }];
      const matches = rules({ near });

      assert.strictEqual(
        matches(candidate({ context })),
        alone.some((part) => matches(candidate({ context: part }))),
      );
      assert.isTrue(
        rules({ near: label.at(-1) ?? "" })(
          candidate({ context: { label: label.join(" ").toUpperCase() } }),
        ),
      );
      assert.isFalse(matches(candidate({})) && near !== "");
    },
  );

  it.prop(
    "hold near for whole words only, so BTC is not in WBTC",
    { near: word, letter: pattern(/^[a-z0-9]$/) },
    ({ near, letter }) => {
      assert.isTrue(rules({ near })(candidate({ context: { row: `${letter} ${near}` } })));
      assert.isFalse(rules({ near })(candidate({ context: { row: `${letter}${near}` } })));
      assert.isFalse(rules({ near })(candidate({ context: { row: `${near}${letter}` } })));
    },
  );

  // Words from two letters, so the rules hold and fail about as often.
  const short = pattern(/^[ab]{1,2}$/);

  it.prop(
    "hold a query when each of its rules holds alone",
    { role: short, name: short, text: short, near: short, other: short },
    ({ role, name, text, near, other }) => {
      const element = candidate({
        role: other,
        name: other,
        text: other,
        context: { label: other },
      });

      const each = [rules({ role }), rules({ name }), rules({ text }), rules({ near })];

      assert.strictEqual(
        rules({ role, name, text, near })(element),
        each.every((single) => single(element)),
      );
      assert.isTrue(rules({})(element));
    },
  );

  it.prop("normalize once for good", { text: Arbitrary.schema(Schema.String) }, ({ text }) => {
    assert.strictEqual(normalize(normalize(text)), normalize(text));
  });
});

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) => page.close);
  });

const rows = (found: ReadonlyArray<Found>) =>
  found.map(({ subject }) => [subject.context.row, subject.context.column]);

const scrollTo = (page: Page, selector: string) =>
  Effect.promise(() =>
    page.playwright.evaluate((s) => document.querySelector(s)?.scrollIntoView(), selector),
  );

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Page.find", (it) => {
  it.effect("binds each cell to its row and the header over it, spanned cells counted", () =>
    Effect.gen(function* () {
      const page = yield* open("/ticker");
      const buys = yield* page.find({ role: "button", name: " BUY " });

      assert.deepStrictEqual(rows(buys), [
        ["BTC", "Trade"],
        ["ETH", "Trade"],
        ["SOL, paused", "Trade"],
      ]);
      assert.deepStrictEqual(
        buys.map(({ state }) => state.disabled),
        [false, false, true],
      );
      assert.isTrue(buys.every(({ subject }) => subject.context.heading === "Prices"));
      // A value is read under its own header, not the one beside it.
      assert.deepStrictEqual(rows(yield* page.find({ text: "+2.5%" })), [["ETH", "24h"]]);
    }),
  );

  it.effect("tells equal controls apart by their context, and its refs work with actions", () =>
    Effect.gen(function* () {
      const page = yield* open("/ticker");
      const [eth, ...others] = yield* page.find({ role: "button", name: "Buy", near: "eth" });

      assert.isDefined(eth);
      assert.lengthOf(others, 0);
      yield* page.click(eth?.ref ?? "");
      assert.lengthOf(yield* page.find({ text: "Bought ETH" }), 1);

      // The action records the same subject, context and all.
      const click = (yield* page.recentEvents).find(
        (event) => event._tag === "Action" && event.name === "click",
      );

      assert.deepStrictEqual(click?._tag === "Action" ? click.subject : undefined, eth?.subject);
    }),
  );

  it.effect("finds the smallest element that shows some text, and a control for its words", () =>
    Effect.gen(function* () {
      const page = yield* open("/ticker");
      const ordered = yield* page.find({ text: "ordered 25 ETH" });

      assert.deepStrictEqual(
        ordered.map(({ subject }) => subject.tag),
        ["div"],
      );
      assert.deepStrictEqual(
        (yield* page.find({ text: /^buy$/i })).map(({ subject }) => subject.role),
        ["button", "button", "button"],
      );
      assert.lengthOf(yield* page.find({ text: "Nothing like this" }), 0);
    }),
  );

  it.effect("reads the viewport only, but keeps what is pinned in it", () =>
    Effect.gen(function* () {
      const page = yield* open("/pinned");

      yield* scrollTo(page, "#middle");
      for (const [role, name] of [
        ["link", "Sign in"],
        ["button", "Accept"],
        ["dialog", "Offer"],
      ] as const)
        assert.lengthOf(yield* page.find({ role, name }), 1, `${role} ${name}`);
      assert.lengthOf(yield* page.find({ text: "Saved" }), 1);
      // Pinned inside a part out of view, under a transparent layer over the whole page: by style
      // attributes, one ignoring the pointer and one away from the probe points, and by a
      // stylesheet, found at a probe point beneath the layer.
      for (const text of [
        "A toast that ignores the pointer",
        "A badge between the points",
        "A bar pinned by an adopted stylesheet",
      ])
        assert.lengthOf(yield* page.find({ text }), 1, text);
      assert.lengthOf(yield* page.find({ text: "The top of the story" }), 0);
      assert.lengthOf(yield* page.find({ role: "button", name: "At the bottom" }), 0);
      // What is pinned to the viewport sits under no heading of the story behind it.
      const [accept] = yield* page.find({ role: "button", name: "Accept" });

      assert.isUndefined(accept?.subject.context.heading);

      const [bottom] = yield* page.find({ name: "At the bottom", scope: "document" });

      assert.isFalse(bottom?.inViewport ?? true);
      // The outline skips the same subtrees, and counts each as one part.
      const outline = yield* page.snapshot();

      for (const line of ['link "Sign in"', 'button "Accept"', "dialog"])
        assert.include(outline.text, line);
      assert.notInclude(outline.text, "At the bottom");
      assert.isAbove(outline.above, 0);
      assert.isAbove(outline.below, 0);
    }),
  );

  // The budget suite holds `find` to one call to the page, on a long page too.
  it.effect("finds across a long page, and skips the rows out of view whole", () =>
    Effect.gen(function* () {
      const page = yield* open("/ticker");

      yield* Effect.promise(() =>
        page.playwright.evaluate(() => {
          const body = document.querySelector("tbody");

          for (let row = 0; row < 2000; row++)
            body?.insertAdjacentHTML(
              "beforeend",
              `<tr><td>Coin ${row}</td><td>$${row}</td><td>+0.1%</td><td>-0.1%</td><td><button>Buy</button></td></tr>`,
            );
        }),
      );

      assert.lengthOf(yield* page.find({ role: "button", scope: "document" }), 2003);
      // Rows out of view are skipped whole: the outline counts each as one part, not its cells.
      assert.isBelow((yield* page.snapshot()).below, 2100);
    }),
  );
});
