import { createServer } from "node:http";

import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Schema, Stream } from "effect";
import { jpegjs } from "playwright-core/lib/utilsBundle";

import { Browser } from "../../src/Browser.ts";
import { Failed, Timeout, undispatched } from "../../src/BrowserError.ts";
import type * as Frame from "../../src/Frame.ts";
import type { Page } from "../../src/Page.ts";
import * as Film from "../../src/presentation/Film.ts";
import * as TestPage from "../../src/testing/TestPage.ts";

const blank = Effect.gen(function* () {
  const browser = yield* Browser;

  return yield* Effect.acquireRelease(browser.newPage(), (page) => Effect.ignore(page.close));
});

// /a links to /b, and /leaves goes there by itself at 300 ms of its time; /b answers 300 ms late
// and finishes 300 ms after that.
const site = Effect.acquireRelease(
  Effect.callback<{ readonly url: (path: string) => string; readonly close: () => void }>(
    (resume) => {
      const server = createServer((request, response) => {
        const answer = (html: string) => {
          response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
          response.end(`<!doctype html><meta charset=utf-8>${html}`);
        };

        if (request.url === "/b")
          setTimeout(() => {
            response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
            response.write("<!doctype html><meta charset=utf-8><h1 id=title>Arrived</h1>");
            setTimeout(() => response.end("<p id=bottom>Loaded</p>"), 300);
          }, 300);
        else if (request.url === "/leaves")
          answer(`<script>setTimeout(() => (location.href = "/b"), 300)</script>`);
        else
          answer(
            `<a id=next href=/b style="position: fixed; left: 0; top: 0; width: 100px; height: 30px">next</a>`,
          );
      });

      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const port = typeof address === "object" && address !== null ? address.port : 0;

        resume(
          Effect.succeed({
            url: (path: string) => `http://127.0.0.1:${port}${path}`,
            close: () => server.close(),
          }),
        );
      });
    },
  ),
  ({ close }) => Effect.sync(close),
);

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
const column = (image: Frame.Image, y: number, matches: (rgb: readonly number[]) => boolean) => {
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

  it.effect("sends inputs at their film times, answered as held time steps on", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(
        page,
        `${slide}<button id=copy style="position: fixed; left: 300px; top: 40px; width: 60px; height: 30px" onclick="copy.textContent = '✓'; setTimeout(() => copy.textContent = 'copy', 1500)">copy</button>`,
      );
      const held = yield* page.hold;
      const go = (yield* page.find({ role: "button", name: "go" }))[0]?.ref ?? "";

      const copied = page
        .read(() => document.getElementById("copy")?.textContent, {
          arg: null,
          result: Schema.String,
        })
        .pipe(Effect.map(({ value }) => value));

      const shots = yield* Stream.runCollect(
        Film.frames(page, {
          times: { fps: 10, to: 2000 },
          time: held,
          inputs: [
            { t: 240, action: { _tag: "Click", target: { x: 330, y: 55 } }, label: "copy" },
            { t: 40, action: { _tag: "Click", target: go }, label: "go" },
          ],
        }).pipe(Stream.mapEffect((shot) => Effect.map(copied, (text) => ({ shot, text })))),
      );

      // Pressed at 40 ms, between frames, the box moves from there.
      for (const { shot } of shots)
        assert.closeTo(
          column(shot.image, 125, red),
          Math.min(100, Math.max(0, shot.t - 40) / 10),
          1.5,
        );
      assert.deepStrictEqual(
        shots.map(({ text }) => text),
        shots.map(({ shot }) => (shot.t >= 300 && shot.t < 1740 ? "✓" : "copy")),
      );
      assert.deepStrictEqual(
        shots.flatMap(({ shot }) => shot.sent.map((sent) => [shot.t, sent.t, sent.label])),
        [
          [100, 40, "go"],
          [300, 240, "copy"],
        ],
      );
      assert.strictEqual(shots[1]?.shot.sent[0]?.target?.name, "go");
    }),
  );

  it.effect("fails the film with an input that fails, after the frames before it", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, slide);
      const held = yield* page.hold;
      let frames = 0;

      const failed = yield* Effect.flip(
        Stream.runDrain(
          Film.frames(page, {
            times: [0, 100, 200],
            time: held,
            inputs: [{ t: 150, action: { _tag: "Click", target: "e999" } }],
          }).pipe(Stream.tap(() => Effect.sync(() => frames++))),
        ),
      );

      assert.strictEqual(frames, 2);
      assert.strictEqual(failed.operation, "click");
    }),
  );

  it.effect("holds film time while a new document loads, and says where it arrived", () =>
    Effect.gen(function* () {
      const { url } = yield* site;
      const page = yield* blank;

      yield* page.goto(url("/a"));
      const held = yield* page.hold;
      const seen: Array<[number, number]> = [];

      const film = (inputs: ReadonlyArray<Film.Contact>) =>
        Stream.runCollect(
          Film.frames(page, {
            times: { fps: 10, to: 1200 },
            time: held,
            inputs,
            picks: { title: { selector: "#title" } },
            at: (t, { passages }) => Effect.sync(() => (seen.push([t, passages.length]), {})),
          }),
        );

      const went = yield* film([{ t: 200, action: { _tag: "Goto", url: url("/b") } }]);
      const passage = went[2]?.passage;

      assert.strictEqual(passage?.t, 200);
      assert.isTrue(passage?.left.endsWith("/a"));
      assert.isTrue(passage?.url.endsWith("/b"));
      assert.isAtLeast(passage?.loadedAfter ?? 0, 250);
      assert.deepStrictEqual(
        passage?.layout.places.map(({ id }) => id),
        ["title"],
      );
      assert.deepStrictEqual(
        went.map(({ document }) => document === passage?.document),
        went.map(({ t }) => t >= 200),
      );
      // The input at 200 ms is sent before its document is found, and the frame there after.
      assert.deepStrictEqual(
        seen.map(([t, count]) => [t, count > 0]),
        went.flatMap(({ t }) =>
          t === 200
            ? [
                [200, false],
                [200, true],
              ]
            : [[t, t > 200]],
        ),
      );

      // A link the page follows when it will: the first frame to find the new document says so.
      yield* page.goto(url("/a"));

      const followed = yield* Film.summary(
        Film.frames(page, {
          times: { fps: 10, to: 1500 },
          time: held,
          inputs: [{ t: 100, action: { _tag: "Click", target: { x: 50, y: 15 } } }],
          picks: { bottom: { selector: "#bottom" } },
        }),
      );

      assert.strictEqual(followed.passages.length, 1);
      assert.isAtLeast(followed.passages[0]?.t ?? 0, 100);
      assert.isTrue(followed.passages[0]?.url.endsWith("/b"));
      assert.deepStrictEqual(followed.passages[0]?.layout.missing, []);

      // A page that leaves by itself, at a time of its own, is found as the document begins, and
      // measured once it has loaded.
      yield* page.goto(url("/leaves"));

      const left = yield* Film.summary(
        Film.frames(page, {
          times: { fps: 10, to: 3000 },
          time: held,
          picks: { bottom: { selector: "#bottom" } },
        }),
      );

      assert.strictEqual(left.passages.length, 1);
      assert.isAtLeast(left.passages[0]?.t ?? 0, 300);
      assert.deepStrictEqual(left.passages[0]?.layout.missing, []);
    }),
  );

  it.effect("on real time, moves the film's start on by a load, so no frame comes early", () =>
    Effect.gen(function* () {
      const { url } = yield* site;
      const page = yield* blank;

      yield* page.goto(url("/a"));
      const arrived: Array<[number, number]> = [];
      const begun = performance.now();

      const summary = yield* Film.summary(
        Film.frames(page, {
          times: { fps: 20, to: 600 },
          time: "real",
          inputs: [{ t: 100, action: { _tag: "Goto", url: url("/b") } }],
        }).pipe(Stream.tap(({ t }) => Effect.sync(() => arrived.push([t, performance.now()])))),
      );

      const loadedAfter = summary.passages[0]?.loadedAfter ?? 0;

      assert.isAtLeast(loadedAfter, 500);
      // Each frame after the load comes at its film time on a start the load moved on.
      for (const [t, at] of arrived.filter(([t]) => t > 100))
        assert.isAtLeast(at - begun, t + loadedAfter - 5, `frame at ${t}`);
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
      assert.deepStrictEqual(summary.sent, []);
      assert.isAtLeast(Date.now() - started, 450);
      assert.isAbove(summary.took, 0);
      assert.isAtMost(summary.slowest, summary.took);
    }),
  );

  it.effect("takes a timed-out screenshot again, and fails on any other failure", () =>
    Effect.gen(function* () {
      const page = yield* blank;

      yield* show(page, slide);

      // The page, whose second picture fails for `reason`.
      const flaky = (reason: Timeout | Failed) => {
        let calls = 0;

        return TestPage.withPictures(page, (own) => ({
          ...own,
          read: (options) =>
            Effect.suspend(() =>
              ++calls === 2 ? Effect.fail(undispatched("frame", reason)) : own.read(options),
            ),
        }));
      };

      const film = (on: Page, retries?: number) =>
        Film.summary(
          Film.frames(on, { times: [0, 10, 20], time: { seek: () => Effect.void }, retries }),
        );

      const summary = yield* film(yield* flaky(new Timeout({ millis: 10 })));

      assert.strictEqual(summary.frames, 3);
      assert.strictEqual(summary.retries, 1);
      assert.strictEqual(
        (yield* Effect.flip(film(yield* flaky(new Timeout({ millis: 10 })), 0))).reason._tag,
        "Timeout",
      );
      assert.strictEqual(
        (yield* Effect.flip(film(yield* flaky(new Failed({ detail: "gone" }))))).reason._tag,
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
          inputs: [{ t: Number.NaN, action: { _tag: "Back" } }],
        }),
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
