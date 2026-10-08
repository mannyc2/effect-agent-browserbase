import { assert, layer } from "@effect/vitest";
import { Duration, Effect } from "effect";

import { Browser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";

const blank = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
});

const show = (page: Page, html: string) =>
  page.goto("data:text/html," + encodeURIComponent(`<!doctype html>${html}`));

const evaluate = <A>(page: Page, run: () => A) =>
  Effect.promise(() => page.playwright.evaluate(run));

const reason = (effect: Effect.Effect<void, { readonly reason: { readonly _tag: string } }>) =>
  Effect.flip(effect).pipe(Effect.map((error) => error.reason._tag));

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Page.ready",
  (it) => {
    it.effect("is not ready while the viewport shows nothing, and is once the chart draws", () =>
      Effect.gen(function* () {
        const page = yield* blank;

        yield* show(
          page,
          `<body style="margin:0"><script>
  setTimeout(() => {
    const chart = document.createElement("canvas");
    chart.width = 400; chart.height = 200;
    document.body.append(chart);
    const g = chart.getContext("2d");
    g.strokeStyle = "#0a0"; g.beginPath(); g.moveTo(0, 150); g.lineTo(400, 40); g.stroke();
  }, 800);
</script></body>`,
        );
        assert.strictEqual(yield* reason(page.ready({ timeout: Duration.millis(300) })), "Timeout");
        yield* page.ready({ timeout: Duration.seconds(5) });
        assert.isTrue(yield* evaluate(page, () => document.querySelector("canvas") !== null));
      }),
    );

    it.effect("is not ready while what the viewport holds is hidden", () =>
      Effect.gen(function* () {
        const page = yield* blank;

        yield* show(
          page,
          `<body style="visibility:hidden"><canvas width="400" height="200"></canvas><p>Prices</p></body>`,
        );
        assert.strictEqual(yield* reason(page.ready({ timeout: Duration.millis(500) })), "Timeout");
      }),
    );

    it.effect("waits for an entrance animation in view to end, but not for an endless one", () =>
      Effect.gen(function* () {
        const page = yield* blank;

        yield* show(
          page,
          `<style>
  @keyframes in { from { opacity: 0 } to { opacity: 1 } }
  @keyframes pulse { from { opacity: 0.4 } to { opacity: 1 } }
</style>
<h1 style="animation: in 700ms">Prices</h1>
<span style="animation: pulse 1s infinite alternate">Live</span>`,
        );
        yield* page.ready({ timeout: Duration.seconds(5) });
        assert.isTrue(
          yield* evaluate(page, () =>
            document
              .getAnimations()
              .every((animation) => animation.effect?.getComputedTiming().iterations === Infinity),
          ),
        );
      }),
    );
  },
);
