import { assert, it, layer } from "@effect/vitest";
import { Duration, Effect, Option, Schedule, Stream } from "effect";

import { Browser } from "../src/Browser.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import { behindProxy } from "./protocol.ts";

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

    // Each shows only its loading state until its content comes, 800 ms after it loads.
    it.effect("is not ready on a loading screen, and is once its content shows", () =>
      Effect.gen(function* () {
        const page = yield* blank;
        const content = `document.title = "drawn"; document.body.insertAdjacentHTML("beforeend", "<p>BTC 64,000</p>")`;

        const screens = {
          "a canvas mounted blank": `<canvas id=c width=600 height=300></canvas>
<script>setTimeout(() => { c.getContext("2d").fillRect(0, 0, 600, 300); document.title = "drawn"; }, 800)</script>`,
          "a spinner alone": `<svg id=s width=40 height=40><circle cx=20 cy=20 r=15 stroke=#888 fill=none /></svg>
<script>setTimeout(() => { s.remove(); ${content} }, 800)</script>`,
          "a region marked busy": `<main id=m aria-busy=true><p>Fetching prices</p></main>
<script>setTimeout(() => { m.removeAttribute("aria-busy"); ${content} }, 800)</script>`,
        };

        for (const [screen, html] of Object.entries(screens)) {
          yield* show(page, `<body style="margin:0">${html}</body>`);
          assert.strictEqual(
            yield* reason(page.ready({ timeout: Duration.millis(300) })),
            "Timeout",
            screen,
          );
          yield* page.ready({ timeout: Duration.seconds(5) });
          assert.strictEqual(yield* evaluate(page, () => document.title), "drawn", screen);
        }
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

// Over raw CDP a tab behind another is hidden, unless some session holds focus emulation on it;
// here none can, so the page behind paints no frame and is never ready to be shown.
it.live("is never ready on a tab behind another that paints nothing", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();

    proxy.swallow = (command) => command.method === "Emulation.setFocusEmulationEnabled";
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint });
    const behind = yield* browser.newPage("data:text/html,<h1>Prepared off stage</h1>");

    yield* browser.newPage("data:text/html,<h1>On stage</h1>");
    assert.strictEqual(yield* reason(behind.ready({ timeout: Duration.seconds(1) })), "Timeout");
  }).pipe(Effect.scoped),
);

// Reels that spin for 1.2 s after a click, painting every frame, or ten times a second.
const reels = (slow: boolean) =>
  `data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0">
<canvas id=c width=400 height=200></canvas><script>
  const g = c.getContext("2d");
  let until = 0;
  const next = (draw) => ${slow} ? setTimeout(() => draw(performance.now()), 100) : requestAnimationFrame(draw);
  function draw(now) {
    g.fillStyle = now < until ? "hsl(" + Math.round(now / 3) % 360 + ", 80%, 50%)" : "#c33";
    g.fillRect(0, 0, 400, 200);
    if (now < until) next(draw);
  }
  c.onclick = () => { if (performance.now() >= until) { until = performance.now() + 1200; next(draw); } };
  draw(0);
</script></body>`)}`;

// While the reels spin, the connection stalls for 600 ms toward one end. Toward the client it holds
// frames on their way, here while no acknowledgement is outstanding, as between the frames of a page
// that paints ten times a second. Toward the browser it holds acknowledgements, as a large message
// ahead of them does, and Chromium sends no more frames until they come. Neither is a still screen.
it.live("never takes a stalled connection for a still screen", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint });

    for (const [toward, slow] of [
      ["client", true],
      ["browser", false],
    ] as const) {
      const page = yield* browser.newPage(reels(slow));

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.sleep(Duration.millis(300));
      const clicked = yield* browser.now;

      yield* page.click({ x: 200, y: 100 });
      yield* Effect.sleep(Duration.millis(150)).pipe(
        Effect.andThen(Effect.sync(() => proxy.stall(toward, 600))),
        Effect.forkScoped,
      );
      yield* page.ready({ quietMillis: 400, timeout: Duration.seconds(10) });
      assert.isAtLeast((yield* browser.now) - clicked, 1200, `stalled toward the ${toward}`);
    }
  }).pipe(Effect.scoped),
);

// A price that ticks for 1.2 s once started, then rests.
const ticking = `data:text/html,${encodeURIComponent(`<!doctype html><body style="margin:0">
<p>BTC <span id=btc>64,000</span></p><script>
  window.tick = () => {
    const started = performance.now();
    const timer = setInterval(() => {
      btc.textContent = String(64000 + Math.round(Math.random() * 500));
      if (performance.now() - started > 1200) clearInterval(timer);
    }, 50);
  };
</script></body>`)}`;

// Frames held back inside the browser, as by an encoder's backlog, leave a capture silent while the
// page still changes, so frames alone would call the screen still. Where the page's changes are
// recorded, what changed in view leads.
it.live(
  "never takes frames held back for a still screen where the page's changes are recorded",
  () =>
    Effect.gen(function* () {
      const proxy = yield* behindProxy();
      const browser = yield* Cdp.open({ endpoint: proxy.endpoint });
      const page = yield* browser.newPage(ticking);

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* page.latestFrame.pipe(
        Effect.repeat({ schedule: Schedule.spaced("10 millis"), until: Option.isSome }),
      );
      yield* page.changes();
      proxy.withhold = (method) => method === "Page.screencastFrame";
      const started = yield* browser.now;

      yield* evaluate(page, () => (window as unknown as { tick: () => void }).tick());
      yield* page.ready({ quietMillis: 300, timeout: Duration.seconds(10) });
      assert.isAtLeast((yield* browser.now) - started, 1200);
    }).pipe(Effect.scoped),
);
