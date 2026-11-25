import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Schema, Stream } from "effect";
import { jpegjs } from "playwright-core/lib/utilsBundle";

import { Browser } from "../src/Browser.ts";
import { Failed, Timeout, undispatched } from "../src/BrowserError.ts";
import * as Film from "../src/film/Film.ts";
import type { Image } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
import * as Chromium from "../src/providers/Chromium.ts";

const blank = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
});

const show = (page: Page, html: string) =>
  page.goto("data:text/html," + encodeURIComponent(`<!doctype html><meta charset=utf-8>${html}`));

// A red box that slides 100 px in a second once #go is pressed, and a page tall enough to scroll.
const slide = `<style>
  body { margin: 0; height: 3000px }
  #go { position: fixed; left: 300px; top: 0; width: 60px; height: 30px }
  #box { position: fixed; left: 0; top: 100px; width: 50px; height: 50px; background: rgb(255, 0, 0); transition: transform 1000ms linear }
  #box.go { transform: translateX(100px) }
</style><button id=go onclick="box.classList.add('go')">go</button><div id=box></div>`;

// The first column on row `y` whose pixel `matches`, or -1.
const column = (image: Image, y: number, matches: (rgb: readonly number[]) => boolean) => {
  const decoded = jpegjs.decode(image.data, { useTArray: true });

  for (let x = 0; x < decoded.width; x++) {
    const at = (y * decoded.width + x) * 4;

    if (matches([decoded.data[at] ?? 0, decoded.data[at + 1] ?? 0, decoded.data[at + 2] ?? 0]))
      return x;
  }

  return -1;
};

const red = ([r, g]: readonly number[]) => (r ?? 0) > 200 && (g ?? 255) < 60;

const green = ([r, g, b]: readonly number[]) =>
  (g ?? 0) > 150 && (r ?? 255) < 80 && (b ?? 255) < 80;

const ring = (x: number) =>
  ({
    _tag: "Svg",
    markup: `<svg xmlns="http://www.w3.org/2000/svg"><rect x="${x}" y="200" width="20" height="20" fill="rgb(0,200,0)"/></svg>`,
  }) as const;

layer(Chromium.layer({ pageTime: true, viewport: { width: 400, height: 300 } }), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Film", (it) => {
  it.effect("films held time: each frame at its own time, drawn and scrolled in its step", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, slide);
      const held = yield* page.hold;
      const overlay = yield* page.overlay;

      yield* page.click({ x: 320, y: 15 });

      const shots = yield* Stream.runCollect(
        Film.frames(page, {
          times: { fps: 10, to: 1000 },
          time: held,
          overlay,
          at: (t) => Effect.succeed({ overlay: ring(200 + Math.floor(t / 200) * 20), scroll: t }),
        }),
      );

      assert.deepStrictEqual(
        shots.map(({ index, t }) => [index, t]),
        Array.from({ length: 10 }, (_, index) => [index, index * 100]),
      );
      for (const shot of shots) {
        assert.closeTo(column(shot.image, 125, red), shot.t / 10, 1.5, `box at ${shot.t}`);
        assert.closeTo(
          column(shot.image, 210, green),
          200 + Math.floor(shot.t / 200) * 20,
          1.5,
          `drawing at ${shot.t}`,
        );
        assert.deepStrictEqual(shot.scroll, { x: 0, y: shot.t });
        assert.strictEqual(shot.retries, 0);
      }
      assert.strictEqual(Duration.toMillis(yield* held.elapsed), 900);
    }),
  );

  it.effect("films a page that seeks itself, and real time, and sums what a film cost", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(
        page,
        `${slide}<script>window.seek = (t) => { box.style.transition = "none"; box.style.transform = "translateX(" + t / 10 + "px)" }</script>`,
      );

      const seek = (t: number) =>
        Effect.flatMap(page.state, ({ document }) =>
          page.act((at: number) => (globalThis as { seek?: (t: number) => void }).seek?.(at), {
            arg: t,
            result: Schema.Unknown,
            document,
          }),
        ).pipe(Effect.asVoid);

      const seeking = yield* Stream.runCollect(
        Film.frames(page, { times: [0, 250, 250, 800], time: { seek } }),
      );

      for (const [index, x] of [0, 25, 25, 80].entries())
        assert.closeTo(column(seeking[index]!.image, 125, red), x, 1.5);
      assert.isUndefined(seeking[0]?.scroll);

      const started = Date.now();

      const summary = yield* Film.summary(
        Film.frames(page, { times: { fps: 20, to: 500 }, time: "real" }),
      );

      assert.strictEqual(summary.frames, 10);
      assert.strictEqual(summary.retries, 0);
      assert.isAtLeast(Date.now() - started, 450);
      assert.isAbove(summary.took, 0);
      assert.isAtMost(summary.slowest, summary.took);
    }),
  );

  it.effect("takes a timed-out screenshot again, and fails on any other failure", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, slide);

      // The page, whose second screenshot fails for `reason`.
      const flaky = (reason: Timeout | Failed): Page => {
        let calls = 0;

        return {
          ...page,
          screenshot: (options) =>
            Effect.suspend(() =>
              ++calls === 2
                ? Effect.fail(undispatched("screenshot", reason))
                : page.screenshot(options),
            ),
        };
      };

      const film = (on: Page, retries?: number) =>
        Film.summary(
          Film.frames(on, { times: [0, 10, 20], time: { seek: () => Effect.void }, retries }),
        );

      const summary = yield* film(flaky(new Timeout({ millis: 10 })));

      assert.strictEqual(summary.frames, 3);
      assert.strictEqual(summary.retries, 1);
      assert.strictEqual(
        (yield* Effect.flip(film(flaky(new Timeout({ millis: 10 })), 0))).reason._tag,
        "Timeout",
      );
      assert.strictEqual(
        (yield* Effect.flip(film(flaky(new Failed({ detail: "gone" }))))).reason._tag,
        "Failed",
      );
    }),
  );

  it.effect("refuses what it cannot film", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, slide);

      const refused = (options: Film.Options) =>
        Effect.map(
          Effect.flip(Stream.runDrain(Film.frames(page, options))),
          (error) => error.reason._tag,
        );

      assert.strictEqual(
        yield* refused({ times: { fps: 0, to: 100 }, time: "real" }),
        "InvalidRequest",
      );
      assert.strictEqual(
        yield* refused({ times: { fps: 30, from: 200, to: 100 }, time: "real" }),
        "InvalidRequest",
      );
      assert.strictEqual(yield* refused({ times: [100, 50], time: "real" }), "InvalidRequest");
      assert.strictEqual(
        yield* refused({ times: [0], time: "real", retries: -1 }),
        "InvalidRequest",
      );
      assert.strictEqual(
        yield* refused({
          times: [0],
          time: "real",
          at: () => Effect.succeed({ overlay: ring(0) }),
        }),
        "InvalidRequest",
      );
      assert.strictEqual(
        yield* refused({ times: [0], time: "real", at: () => Effect.succeed({ scroll: 10 }) }),
        "InvalidRequest",
      );
    }),
  );
});
