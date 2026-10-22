import { assert, describe, it, layer } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Exit, Layer, Option, Schema } from "effect";

import { Browser } from "../src/Browser.ts";
import { type FindRequest, match } from "../src/Matching.ts";
import type { Found, Page } from "../src/Page.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import { Site, SiteLayer } from "./fixtures.ts";
import * as TestCdp from "./support/TestCdp.ts";

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

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) =>
      Effect.ignore(page.close),
    );
  });

const rows = (found: ReadonlyArray<Found>) =>
  found.map(({ subject }) => [subject.context.row, subject.context.column]);

const scrollTo = (page: Page, selector: string) =>
  Effect.promise(() =>
    TestCdp.nativePage(page).evaluate((s) => document.querySelector(s)?.scrollIntoView(), selector),
  );

layer(TestCdp.provideLayer(Layer.mergeAll(Chromium.layer(), SiteLayer)), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Page.find", (it) => {
  it.effect("refuses invalid wait durations before page dispatch", () =>
    Effect.gen(function* () {
      const page = yield* (yield* Browser).newPage();

      for (const millis of [-1, Number.NaN, Infinity]) {
        const exit = yield* page
          .until({ text: "absent" }, "some", millis)
          .pipe(Effect.timeout("100 millis"), Effect.exit);

        const error = Exit.findErrorOption(exit);

        assert.isTrue(Exit.isFailure(exit));
        assert.isTrue(Option.isSome(error) && error.value._tag === "BrowserError");
        if (Option.isSome(error) && error.value._tag === "BrowserError")
          assert.deepStrictEqual(
            [error.value.reason._tag, error.value.dispatched],
            ["InvalidRequest", false],
          );
      }
    }),
  );

  // PLAN bug 10: replacing documents spend one deadline, rather than restart the window
  // in every document and eventually fail with Timeout.
  it.effect("answers unmet at one deadline while documents keep replacing its context", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const host = yield* Chromium.open({ actionTimeout: "150 millis" });
        const page = yield* host.newPage((yield* Site).url("/replacing"));
        const first = (yield* page.state).document;
        const result = yield* page.until({ text: "Never present" }, "some", 120);

        assert.isFalse(result.met);
        assert.isAtLeast((yield* page.state).document - first, 2);
      }),
    ),
  );

  it.effect("shares selector, enabled-state and text matching with the public wait", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* Browser;

        const page = yield* Effect.acquireRelease(
          browser.newPage(
            `data:text/html;charset=utf-8,${encodeURIComponent(`
        <span class="status">Saved   ＮＯＴＥ</span><span>Outside</span>
        <fieldset disabled><button>Blocked</button></fieldset><button id="enabled">Allowed</button>`)}`,
          ),
          (page) => Effect.ignore(page.close),
        );

        assert.lengthOf(yield* page.find({ selector: ".status", text: "saved note" }), 1);
        assert.isTrue(
          (yield* page.until({ selector: ".status", text: "saved note" }, "some", 0)).met,
        );
        assert.deepStrictEqual(
          (yield* page.find({ selector: "button", state: "enabled" })).map(
            ({ subject }) => subject.name,
          ),
          ["Allowed"],
        );
        assert.isFalse(
          (yield* page.until({ selector: "fieldset button", state: "enabled" }, "some", 0)).met,
        );
        assert.isTrue((yield* page.until({ selector: "#absent" }, "none", 0)).met);
        assert.strictEqual(
          (yield* Effect.flip(page.find({ selector: "[" }))).reason._tag,
          "InvalidRequest",
        );
        assert.strictEqual(
          (yield* Effect.flip(page.until({ selector: "[" }, "some", 0))).reason._tag,
          "InvalidRequest",
        );
      }),
    ),
  );

  // PLAN reading findings: the same native visibility and accessibility semantics must hold
  // at whole-document and individually queried boundaries.
  it.effect("reads visible descendants through nonpainting wrappers", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* Browser;

        const page = yield* Effect.acquireRelease(
          browser.newPage(
            `data:text/html,${encodeURIComponent(`
        <div style="width:0;height:0"><button>Zero wrapper</button></div>
        <div id="contents" style="display:contents"><button>Contents wrapper</button></div>
        <div style="visibility:hidden"><button style="visibility:visible">Visible child</button><button>Hidden child</button></div>
        <div style="opacity:0"><button>Transparent child</button></div>
        <div aria-hidden="true"><button>Aria hidden child</button></div>`)}`,
          ),
          (page) => Effect.ignore(page.close),
        );

        const found = yield* page.find({ role: "button" });

        assert.deepStrictEqual(
          found.map(({ subject }) => subject.name),
          ["Zero wrapper", "Contents wrapper", "Visible child"],
        );
        const outlined = yield* page.snapshot();

        for (const name of ["Zero wrapper", "Contents wrapper", "Visible child"])
          assert.include(outlined.text, name);
        assert.isTrue(
          (yield* page.until({ selector: "#contents", text: "Contents wrapper" }, "some", 200)).met,
        );
      }),
    ),
  );

  it.effect("uses labelledby before label and finds requested structural roles", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const browser = yield* Browser;

        const page = yield* Effect.acquireRelease(
          browser.newPage(
            `data:text/html,${encodeURIComponent(`
        <span id="label">Canonical label</span><button aria-label="Fallback label" aria-labelledby="label">Own words</button>
        <table><tr><th>Header</th><td>Cell</td></tr></table><ul><li>List item</li></ul>`)}`,
          ),
          (page) => Effect.ignore(page.close),
        );

        assert.lengthOf(yield* page.find({ role: "button", name: "Canonical label" }), 1);
        for (const role of ["row", "columnheader", "cell", "table", "list", "listitem"])
          assert.lengthOf(yield* page.find({ role }), 1, role);
        const outlined = yield* page.snapshot();

        assert.notInclude(outlined.text, "- row:");
        assert.notInclude(outlined.text, "- list:");
      }),
    ),
  );

  it.effect("binds each cell to its row and the header over it, spanned cells counted", () =>
    TestCdp.withCdp(
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
    ),
  );

  it.effect("tells equal controls apart by their context, and its refs work with actions", () =>
    TestCdp.withCdp(
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
    ),
  );

  it.effect("finds the smallest element that shows some text, and a control for its words", () =>
    TestCdp.withCdp(
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
    ),
  );

  it.effect("reads the viewport only, but keeps what is pinned in it", () =>
    TestCdp.withCdp(
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
    ),
  );

  // The budget suite holds `find` to one call to the page, on a long page too.
  it.effect("finds across a long page, and skips the rows out of view whole", () =>
    TestCdp.withCdp(
      Effect.gen(function* () {
        const page = yield* open("/ticker");

        yield* Effect.promise(() =>
          TestCdp.nativePage(page).evaluate(() => {
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
    ),
  );
});
