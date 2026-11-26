import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Option } from "effect";
import { jpegjs } from "playwright-core/lib/utilsBundle";

import { Browser } from "../src/Browser.ts";
import * as Overlay from "../src/Overlay.ts";
import type { Page } from "../src/Page.ts";
import * as PageTime from "../src/PageTime.ts";
import * as Stillness from "../src/timeline/Stillness.ts";
import * as TestCdp from "./support/TestCdp.ts";

const blank = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
});

const show = (page: Page, html: string) =>
  page.goto("data:text/html," + encodeURIComponent(`<!doctype html><meta charset=utf-8>${html}`));

const evaluate = <A>(page: Page, run: () => A) =>
  Effect.promise(() => TestCdp.nativePage(page).evaluate(run));

const realSleep = (millis: number) =>
  Effect.promise(
    () =>
      new Promise((resolve) => {
        setTimeout(resolve, millis);
      }),
  );

declare global {
  var ticks: number;
  var painted: number;
  var copied: number;
  var reverted: number;
  var ended: number;
  var started: number;
}

const motion = `<style>
  body { margin: 0; width: 400px; height: 300px }
  #copy { position: absolute; left: 0; top: 0; width: 60px; height: 30px }
  #go { position: absolute; left: 70px; top: 0; width: 60px; height: 30px }
  #slide { position: absolute; left: 0; top: 100px; width: 50px; height: 50px; background: rgb(255, 0, 0); transition: transform 1000ms linear }
  #slide.go { transform: translateX(100px) }
  #spin { position: absolute; left: 0; top: 200px; width: 50px; height: 50px; background: blue }
  #spin.go { animation: move 1000ms linear forwards }
  @keyframes move { to { transform: translateX(100px) } }
</style>
<button id=copy>copy</button><button id=go>go</button>
<div id=slide></div><div id=spin></div><div id=fade>fade</div>
<script>
  window.ticks = 0; window.painted = 0;
  setInterval(() => ticks++, 100);
  const frame = () => { painted++; requestAnimationFrame(frame) }; requestAnimationFrame(frame);
  copy.onclick = () => {
    copy.textContent = "✓"; window.copied = performance.now();
    setTimeout(() => { copy.textContent = "copy"; window.reverted = performance.now() }, 1500);
  };
  go.onclick = () => {
    slide.classList.add("go"); spin.classList.add("go");
    window.waapi = document.getElementById("fade").animate([{ opacity: 1 }, { opacity: 0 }], { duration: 1000 });
    window.started = performance.now();
  };
  slide.addEventListener("transitionend", () => { window.ended = performance.now() });
</script>`;

const x = (page: Page) =>
  evaluate(page, () => {
    const at = (id: string) =>
      new DOMMatrix(getComputedStyle(document.getElementById(id)!).transform).m41;

    return {
      slide: at("slide"),
      spin: at("spin"),
      opacity: Number(getComputedStyle(document.getElementById("fade")!).opacity),
    };
  });

// The left edge of the red box a new screenshot shows on its row.
const redFrom = (page: Page) =>
  page.screenshot({ maxAge: 0, quality: 100 }).pipe(
    Effect.map((image) => {
      const decoded = jpegjs.decode(image.data, { useTArray: true });
      const row = 125 * decoded.width * 4;

      for (let column = 0; column < decoded.width; column++) {
        const at = row + column * 4;

        if (decoded.data[at]! > 200 && decoded.data[at + 1]! < 60) return column;
      }

      return -1;
    }),
  );

layer(
  TestCdp.provideLayer(Chromium.layer({ pageTime: true, viewport: { width: 400, height: 300 } })),
  { excludeTestServices: true, timeout: Duration.seconds(60) },
)("PageTime", (it) => {
  it.effect("holds timers, intervals, frames and both clocks, and steps them in order", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, motion);
      const held = yield* PageTime.hold(page);

      const before = yield* evaluate(page, () => ({
        ticks,
        painted,
        perf: performance.now(),
        date: Date.now(),
        made: new Date().getTime(),
        called: Date.parse(Date()),
      }));

      yield* page.click({ x: 30, y: 15 });
      yield* realSleep(300);
      const still = yield* evaluate(page, () => ({ ticks, painted, perf: performance.now() }));

      assert.deepStrictEqual(still, {
        ticks: before.ticks,
        painted: before.painted,
        perf: before.perf,
      });
      yield* held.advance("1499 millis");

      const almost = yield* evaluate(page, () => ({
        text: document.getElementById("copy")!.textContent,
        ticks,
        painted,
        perf: performance.now(),
        date: Date.now(),
        made: new Date().getTime(),
      }));

      assert.strictEqual(almost.text, "✓");
      // A 100 ms interval set before the hold, whatever its phase then.
      assert.include([14, 15], almost.ticks - before.ticks);
      assert.strictEqual(almost.painted - before.painted, 1);
      assert.strictEqual(almost.perf - before.perf, 1499);
      assert.strictEqual(almost.date - before.date, 1499);
      assert.strictEqual(almost.made - before.made, 1499);
      yield* held.advance("1 millis");
      const done = yield* evaluate(page, () => ({ copied, reverted }));

      assert.strictEqual(done.reverted - done.copied, 1500);
      assert.deepStrictEqual(Duration.toMillis(yield* held.elapsed), 1500);
      assert.isTrue(before.called <= before.date);
    }),
  );

  it.effect("takes a transition, a CSS animation and a Web Animation at exact times", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, motion);
      const held = yield* PageTime.hold(page);

      yield* page.click({ x: 100, y: 15 });
      yield* realSleep(200);
      yield* held.advance("120 millis");
      const early = yield* x(page);

      assert.closeTo(early.slide, 12, 0.01);
      assert.closeTo(early.spin, 12, 0.01);
      assert.closeTo(early.opacity, 0.88, 0.001);
      yield* held.advance("380 millis");
      assert.closeTo((yield* x(page)).slide, 50, 0.01);
      assert.closeTo(yield* redFrom(page), 50, 1);
      yield* held.advance("500 millis");
      const end = yield* x(page);

      assert.strictEqual(end.slide, 100);
      assert.strictEqual(end.spin, 100);
      yield* realSleep(100);
      const times = yield* evaluate(page, () => ({ started, ended }));

      assert.strictEqual(times.ended - times.started, 1000);
    }),
  );

  it.effect("leaves ready unsettled while a held animation is part way", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, motion);
      const held = yield* PageTime.hold(page);

      yield* page.click({ x: 100, y: 15 });
      yield* held.advance("100 millis");
      const waiting = yield* Effect.flip(page.ready({ timeout: "300 millis" }));

      assert.strictEqual(waiting.reason._tag, "Timeout");

      const still = yield* Effect.flip(
        Stillness.wait(page, { quietMillis: 100, timeout: "400 millis" }),
      );

      assert.strictEqual(still.reason._tag, "Timeout");
      yield* held.advance("1000 millis");
      yield* page.ready({ timeout: "2 seconds" });
    }),
  );

  it.effect("goes back to real time, never back in time, when its scope closes", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, motion);

      const [page0, stale] = yield* Effect.scoped(
        Effect.gen(function* () {
          const held = yield* PageTime.hold(page);

          yield* page.click({ x: 30, y: 15 });
          yield* held.advance("10 seconds");

          return [yield* evaluate(page, () => performance.now()), held] as const;
        }),
      );

      const after = yield* evaluate(page, () => ({ perf: performance.now(), ticks }));

      assert.isTrue(after.perf >= page0);
      yield* realSleep(350);
      const later = yield* evaluate(page, () => ({ perf: performance.now(), ticks }));

      assert.isTrue(later.perf - after.perf >= 300);
      assert.isTrue(later.ticks - after.ticks >= 2);
      // A hold that has ended never holds the page again.
      assert.strictEqual(
        (yield* Effect.flip(stale.advance("1 second"))).reason._tag,
        "InvalidRequest",
      );
    }),
  );

  it.effect("loads a new document on real time and holds it from the next step", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, motion);
      const held = yield* PageTime.hold(page);

      yield* show(page, motion);
      yield* realSleep(350);
      const loading = yield* evaluate(page, () => ticks);

      assert.isTrue(loading >= 2);
      yield* held.advance("0 millis");
      yield* realSleep(300);
      assert.strictEqual(yield* evaluate(page, () => ticks), loading);
      yield* held.advance("200 millis");
      assert.strictEqual(yield* evaluate(page, () => ticks), loading + 2);
    }),
  );

  it.effect("scrolls and draws in the same step, and refuses what it cannot do", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, `<div style="height: 3000px">Tall</div>`);
      const held = yield* PageTime.hold(page);
      const refused = yield* Effect.flip(held.advance("10 millis", { overlay: { _tag: "Empty" } }));

      assert.strictEqual(refused.reason._tag, "InvalidRequest");
      assert.strictEqual(
        (yield* Effect.flip(Effect.scoped(PageTime.hold(page)))).reason._tag,
        "InvalidRequest",
      );
      assert.strictEqual(
        (yield* Effect.flip(held.advance("-1 millis"))).reason._tag,
        "InvalidRequest",
      );
      yield* Overlay.make(page);

      const scroll = yield* held.advance("33 millis", {
        scroll: 200,
        overlay: {
          _tag: "Svg",
          markup: `<svg xmlns="http://www.w3.org/2000/svg"><rect x="10" y="10" width="20" height="20"/></svg>`,
        },
      });

      assert.deepStrictEqual(scroll, { x: 0, y: 200 });
      assert.strictEqual(Option.getOrUndefined(yield* Overlay.drawn(page))?.length, 1);
    }),
  );
});

layer(TestCdp.provideLayer(Chromium.layer()), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("PageTime without the browser's pageTime", (it) => {
  it.effect("refuses to hold, and leaves the page's globals its own", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, `<p>Plain</p>`);
      const refused = yield* Effect.flip(Effect.scoped(PageTime.hold(page)));

      assert.strictEqual(refused.reason._tag, "InvalidRequest");
      assert.isTrue(yield* evaluate(page, () => String(setTimeout).includes("native code")));
    }),
  );
});
