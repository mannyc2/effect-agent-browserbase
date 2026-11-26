import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Fiber, Option, Schedule } from "effect";
import { jpegjs } from "playwright-core/lib/utilsBundle";

import { Browser } from "../src/Browser.ts";
import * as Change from "../src/Change.ts";
import * as Frame from "../src/Frame.ts";
import * as Layout from "../src/Layout.ts";
import type { Content } from "../src/Overlay.ts";
import * as Overlay from "../src/Overlay.ts";
import type { Page } from "../src/Page.ts";
import * as Snapshot from "../src/Snapshot.ts";
import * as Text from "../src/Text.ts";
import * as Stillness from "../src/timeline/Stillness.ts";
import * as TestCdp from "./support/TestCdp.ts";

const blank = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
});

const show = (page: Page, html: string) =>
  page.goto("data:text/html," + encodeURIComponent(`<!doctype html>${html}`));

const evaluate = <A>(page: Page, run: () => A) =>
  Effect.promise(() => TestCdp.nativePage(page).evaluate(run));

const svg = (body: string): Content => ({
  _tag: "Svg",
  markup: `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 300">${body}</svg>`,
});

const square = svg(`<rect x="20" y="20" width="60" height="60" fill="rgb(255,0,0)"/>`);

// The colour a new screenshot shows at a viewport point.
const colorAt = (page: Page, x: number, y: number) =>
  Frame.read(page, { maxAge: 0, quality: 100 }).pipe(
    Effect.map((image) => {
      const decoded = jpegjs.decode(image.data, { useTArray: true });
      const at = (Math.round(y) * decoded.width + Math.round(x)) * 4;

      return [decoded.data[at] ?? 0, decoded.data[at + 1] ?? 0, decoded.data[at + 2] ?? 0];
    }),
  );

const red = ([r, g, b]: ReadonlyArray<number>) => r! > 200 && g! < 60 && b! < 60;

const page400 = `<style>body { margin: 0; width: 400px; height: 300px }</style>`;

layer(TestCdp.provideLayer(Chromium.layer({ viewport: { width: 400, height: 300 } })), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Overlay.make", (it) => {
  it.effect("draws over the page, in its pictures, and passes input through to it", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(
        page,
        `${page400}<button id=under style="position:absolute;left:0;top:0;width:400px;height:300px">Under</button>
<script>under.onclick = () => { document.title = "pressed" }</script>`,
      );
      const overlay = yield* Overlay.make(page);
      const drawn = yield* overlay.draw(square);

      assert.strictEqual(drawn.length, 1);
      assert.deepStrictEqual({ ...drawn[0] }, { x: 20, y: 20, width: 60, height: 60 });
      assert.deepStrictEqual(yield* Overlay.drawn(page), Option.some(drawn));
      assert.isTrue(red(yield* colorAt(page, 50, 50)));

      yield* page.click({ x: 50, y: 50 });
      assert.strictEqual(yield* page.title, "pressed");

      yield* overlay.draw({ _tag: "Empty" });
      assert.isFalse(red(yield* colorAt(page, 50, 50)));
      assert.isTrue(Option.isNone(yield* Overlay.drawn(page)));
    }),
  );

  it.effect("is read by none of the library's readers", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, `${page400}<h1>Page words</h1><div>A plain div</div>`);
      yield* Change.read(page);
      const overlay = yield* Overlay.make(page);

      for (const x of [20, 60, 100])
        yield* overlay.draw(
          svg(
            `<style>@keyframes grow { from { opacity: 0 } to { opacity: 1 } } rect { animation: grow 10s }</style><rect x="${x}" y="100" width="40" height="40" fill="red"/><text x="10" y="200">Secret overlay words</text><foreignObject x="0" y="220" width="200" height="40"><button xmlns="http://www.w3.org/1999/xhtml">Overlay button</button></foreignObject>`,
          ),
        );
      const changes = yield* Change.read(page);
      const found = yield* Snapshot.find(page, { scope: "document" });
      const words = yield* Snapshot.find(page, { text: "Secret overlay words", scope: "document" });
      const snapshot = yield* Snapshot.read(page, { full: true });
      const text = yield* Text.read(page);
      const layout = yield* Layout.measure(page, { div: { selector: "div", choose: "last" } });

      assert.deepStrictEqual(changes.changes, []);
      assert.deepStrictEqual(
        found.map((each) => each.subject.name),
        ["Page words"],
      );
      assert.deepStrictEqual(words, []);
      assert.notInclude(snapshot.text, "Secret");
      assert.notInclude(snapshot.text, "Overlay button");
      assert.notInclude(text.text, "Secret");
      assert.strictEqual(layout.places[0]?.subject.name, "A plain div");
      yield* page.ready({ timeout: Duration.seconds(2) });
    }),
  );

  it.effect("keeps the page's styles out, under a strict style-src as well", () =>
    Effect.gen(function* () {
      const page = yield* blank;
      const overlay = yield* Overlay.make(page);

      yield* show(
        page,
        `${page400}<style>div, svg, rect { display: none !important; opacity: 0 !important } html { zoom: 2 }</style>`,
      );
      yield* overlay.draw(square);
      assert.isTrue(red(yield* colorAt(page, 50, 50)));

      yield* show(
        page,
        `<meta http-equiv="Content-Security-Policy" content="style-src 'none'"><p>Strict</p>`,
      );
      yield* overlay.draw(square);
      assert.isTrue(red(yield* colorAt(page, 50, 50)));
    }),
  );

  it.effect("comes back in a new document, one at a time, and goes with its scope", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, `${page400}<p>First</p>`);
      yield* Effect.scoped(
        Effect.gen(function* () {
          const overlay = yield* Overlay.make(page);

          yield* overlay.draw(square);
          const second = yield* Effect.flip(Effect.scoped(Overlay.make(page)));

          assert.strictEqual(second.reason._tag, "InvalidRequest");
          yield* show(page, `${page400}<p>Second</p>`);
          yield* colorAt(page, 50, 50).pipe(
            Effect.repeat({
              schedule: Schedule.spaced(Duration.millis(50)),
              until: red,
              times: 60,
            }),
          );
          assert.isTrue(red(yield* colorAt(page, 50, 50)));
        }),
      );
      assert.isFalse(red(yield* colorAt(page, 50, 50)));
      assert.isTrue(Option.isNone(yield* Overlay.drawn(page)));

      const again = yield* Effect.scoped(
        Overlay.make(page).pipe(Effect.flatMap((overlay) => overlay.draw(square))),
      );

      assert.strictEqual(again.length, 1);
    }),
  );

  it.effect("leaves screen stillness to the page while it moves", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, `${page400}<p>Still page</p>`);
      const overlay = yield* Overlay.make(page);
      let x = 0;

      const moving = yield* Effect.forkScoped(
        Effect.suspend(() =>
          overlay.draw(svg(`<circle cx="${100 + (x++ % 20) * 5}" cy="150" r="20" fill="red"/>`)),
        ).pipe(Effect.repeat(Schedule.spaced(Duration.millis(40)))),
      );

      yield* Effect.sleep(Duration.millis(200));
      yield* Stillness.wait(page, { still: "screen", quiet: "500 millis", timeout: "5 seconds" });
      assert.isTrue(x > 5);
      yield* Fiber.interrupt(moving);
      assert.isTrue(yield* evaluate(page, () => document.querySelectorAll("p").length === 1));
    }),
  );
});
