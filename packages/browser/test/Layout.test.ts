import { assert, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import type { Action } from "../src/Action.ts";
import { Browser } from "../src/Browser.ts";
import * as Layout from "../src/Layout.ts";
import type { Page } from "../src/Page.ts";
import * as Chromium from "../src/providers/Chromium.ts";
import * as TestCdp from "./support/TestCdp.ts";

const blank = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
});

const show = (page: Page, html: string) =>
  page.goto("data:text/html," + encodeURIComponent(`<!doctype html>${html}`));

const evaluate = <A>(page: Page, run: () => A) =>
  Effect.promise(() => TestCdp.nativePage(page).evaluate(run));

const rect = (page: Page, selector: string) =>
  Effect.promise(() =>
    TestCdp.nativePage(page).evaluate((s) => {
      const { x, y, width, height } = document.querySelector(s)!.getBoundingClientRect();

      return { x, y, width, height };
    }, selector),
  );

const command = `<style>
  body { margin: 0; font: 16px/20px monospace }
  #bar { position: fixed; top: 0; left: 0; width: 100%; height: 30px; background: #eee }
  #cmd { position: absolute; left: 100.5px; top: 300.25px; width: 300px; height: 40px; text-align: left }
  #icon { position: absolute; right: 8px; top: 8px; width: 24px; height: 24px }
  #code { position: absolute; left: 40px; top: 420px; margin: 0 }
  #tall { height: 3000px }
</style>
<header id=bar>Top</header>
<button id=cmd>npm install effect<svg id=icon role=img aria-label=copy viewBox="0 0 24 24"><rect width=24 height=24 /></svg></button>
<pre id=code>const <span>answer</span> = <span id=n>42</span>; // 42</pre>
<div id=tall></div>`;

layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Page.layout", (it) => {
  it.effect("reads unrounded boxes in the viewport and the document, at the scroll it read", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, command);
      yield* evaluate(page, () => scrollTo(0, 100));

      const layout = yield* page.layout({
        command: { role: "button", name: /npm install/, words: "npm install effect" },
        icon: { selector: "#cmd svg", name: "copy" },
        bar: { selector: "#bar" },
        nothing: { selector: "#nope" },
      });

      const command_ = Layout.place(layout, "command")!;
      const icon = Layout.place(layout, "icon")!;
      const bar = Layout.place(layout, "bar")!;
      const shown = yield* rect(page, "#cmd");

      assert.deepStrictEqual(layout.scroll, { x: 0, y: 100 });
      assert.strictEqual(layout.scale, 1);
      assert.deepStrictEqual(layout.missing, ["nothing"]);
      assert.deepStrictEqual(
        layout.places.map((place) => place.id),
        ["command", "icon", "bar"],
      );
      assert.deepStrictEqual({ ...command_.box }, shown);
      assert.strictEqual(command_.box.x, 100.5);
      assert.strictEqual(command_.page.y, 300.25);
      assert.strictEqual(command_.page.y - command_.box.y, 100);
      assert.isFalse(command_.fixed);
      assert.isTrue(bar.fixed);
      assert.strictEqual(icon.subject.name, "copy");

      // The copy icon sits inside the command, right of its words.
      const [words] = command_.words!;

      assert.strictEqual(words!.text, "npm install effect");
      assert.isTrue(icon.box.x > words!.box.x + words!.box.width);
      assert.isTrue(icon.box.x + icon.box.width <= command_.box.x + command_.box.width);
      assert.isTrue(icon.box.y >= command_.box.y);
      assert.isTrue(words!.box.x >= command_.box.x);
    }),
  );

  it.effect("boxes each match of words across the elements its text is split into", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, command);

      const layout = yield* page.layout({
        literal: { selector: "#code", words: "42" },
        numbers: { selector: "#code", words: /\d+/ },
        phrase: { selector: "#code", words: "answer = 42" },
      });

      const span = yield* rect(page, "#n");
      const [inSpan, inComment] = Layout.place(layout, "literal")!.words!;

      assert.deepStrictEqual({ ...inSpan!.box }, span);
      assert.isTrue(inComment!.box.x > inSpan!.box.x);
      assert.deepStrictEqual(
        Layout.place(layout, "numbers")!.words!.map((word) => word.text),
        ["42", "42"],
      );
      const [phrase] = Layout.place(layout, "phrase")!.words!;

      assert.strictEqual(phrase!.text, "answer = 42");
      assert.strictEqual(phrase!.box.x + phrase!.box.width, span.x + span.width);
    }),
  );

  it.effect("chooses among the matches, and refuses a selector that is not CSS", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(
        page,
        `<button style="width:40px">A</button><button style="width:200px">Bee</button><button style="width:80px">C</button>`,
      );

      const layout = yield* page.layout({
        first: { role: "button" },
        last: { role: "button", choose: "last" },
        smallest: { role: "button", choose: "smallest" },
        largest: { role: "button", choose: "largest" },
      });

      assert.deepStrictEqual(
        layout.places.map((place) => place.subject.name),
        ["A", "C", "A", "Bee"],
      );
      const refused = yield* Effect.flip(page.layout({ bad: { selector: "[" } }));

      assert.strictEqual(refused.reason._tag, "InvalidRequest");
    }),
  );

  it.effect("rehearses: measures what an interaction shows, then puts the page back", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(
        page,
        `<div role=tablist><button role=tab id=one aria-selected=true>One</button><button role=tab id=two>Two</button></div>
<section id=p1>First panel</section><section id=p2 hidden><button id=play>Run</button><output id=result>42</output></section>
<script>
  const pick = (open) => { p1.hidden = open !== 1; p2.hidden = open !== 2; one.ariaSelected = String(open === 1); two.ariaSelected = String(open === 2); };
  one.onclick = () => pick(1); two.onclick = () => pick(2);
</script>`,
      );

      const tab = (name: string) =>
        page
          .find({ role: "tab", name })
          .pipe(Effect.map(([found]): Action => ({ _tag: "Click", target: found!.ref })));

      const act = [yield* tab("Two")];
      const undo = [yield* tab("One")];

      const layout = yield* Layout.rehearse(page, {
        act,
        undo,
        picks: { play: { role: "button", name: "Run" }, result: { selector: "#result" } },
      });

      assert.deepStrictEqual(layout.missing, []);
      assert.isTrue(Layout.place(layout, "result")!.box.width > 0);
      assert.isTrue(yield* evaluate(page, () => document.getElementById("p2")!.hidden));

      // The page is put back when reading fails too, and the failure is the rehearsal's.
      const failed = yield* Effect.flip(
        Layout.rehearse(page, { act, undo, picks: { bad: { selector: "[" } } }),
      );

      assert.strictEqual(failed.reason._tag, "InvalidRequest");
      assert.isTrue(yield* evaluate(page, () => document.getElementById("p2")!.hidden));
    }),
  );
});
