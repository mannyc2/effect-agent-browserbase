import { assert, it, layer } from "@effect/vitest";
import { Clock, Duration, Effect, Fiber, Schedule, Stream } from "effect";
import type { CDPSession } from "playwright-core";
import { jpegjs } from "playwright-core/lib/utilsBundle";

import { Browser, make as makeBrowser } from "../src/Browser.ts";
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
    it.effect("never takes a screenshot's paused capture for a still animated screen", () =>
      Effect.gen(function* () {
        const native = (yield* Browser).context.browser();

        if (native === null) return yield* Effect.die("the fixture requires local Chromium");

        const context = yield* Effect.acquireRelease(
          Effect.promise(() => native.newContext({ viewport: { width: 800, height: 600 } })),
          (context) => Effect.promise(() => context.close()),
        );

        const browser = yield* makeBrowser(context, { id: "ready-picture", provider: "test" });
        const page = yield* browser.newPage();

        yield* show(
          page,
          `<canvas id=c width=400 height=200></canvas><script>
  const g = c.getContext("2d");
  function draw(now) {
    g.fillStyle = "hsl(" + Math.round(now) % 360 + ", 80%, 50%)";
    g.fillRect(0, 0, 400, 200);
    requestAnimationFrame(draw);
  }
  requestAnimationFrame(draw);
</script>`,
        );
        yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
        yield* page.state.pipe(
          Effect.repeat({
            schedule: Schedule.spaced("10 millis"),
            until: (state) => state.frame !== undefined,
          }),
          Effect.timeout("5 seconds"),
        );
        const entered = Promise.withResolvers<void>();
        const restored = Promise.withResolvers<void>();
        const screenshot = page.playwright.screenshot.bind(page.playwright);

        page.playwright.screenshot = (options) => {
          entered.resolve();

          return screenshot(options).then((image) => restored.promise.then(() => image));
        };
        yield* Effect.addFinalizer(() => Effect.sync(() => restored.resolve()));

        const outcome = (timeout: Duration.Input) =>
          page
            .ready({ quietMillis: 100, timeout })
            .pipe(
              Effect.match({ onSuccess: () => "ready", onFailure: (error) => error.reason._tag }),
            );

        const before = yield* outcome("1 second").pipe(Effect.forkScoped);

        yield* Effect.sleep("20 millis");

        const picture = yield* page
          .zoom({ x: 5, y: 5, width: 160, height: 90 })
          .pipe(Effect.forkScoped);

        yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("5 seconds"));
        assert.strictEqual(yield* outcome("300 millis"), "Timeout");
        assert.strictEqual(yield* Fiber.join(before), "Timeout");
        restored.resolve();
        yield* Fiber.join(picture);
        // The resumed stream still observes the drawing canvas.
        assert.strictEqual(yield* outcome("300 millis"), "Timeout");
      }),
    );

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

    // Accepted stage 2, L1: paint never becomes quiet, although the visible DOM does.
    it.effect(
      "observes content quiet from its first read and after changes, while canvas paints",
      () =>
        Effect.gen(function* () {
          const page = yield* blank;

          yield* show(
            page,
            `<p id=p>Initial</p><canvas id=c width=400 height=200></canvas>
<script>
  const g = c.getContext("2d");
  function draw(now) { g.fillStyle = "hsl(" + now % 360 + ",80%,50%)"; g.fillRect(0,0,400,200); requestAnimationFrame(draw); }
  requestAnimationFrame(draw);
</script>`,
          );
          const started = performance.now();

          yield* page.ready({ still: "content", quietMillis: 200, timeout: Duration.seconds(2) });
          assert.isAtLeast(performance.now() - started, 200);
          yield* evaluate(page, () => {
            for (const after of [100, 200, 300])
              setTimeout(() => {
                document.querySelector("p")!.textContent = String(after);
                document.body.dataset.changed = String(performance.now());
              }, after);
          });
          yield* page.ready({ still: "content", quietMillis: 200, timeout: Duration.seconds(2) });

          const observed = yield* evaluate(page, () => ({
            text: document.querySelector("p")!.textContent,
            quiet: performance.now() - Number(document.body.dataset.changed),
          }));

          assert.strictEqual(observed.text, "300");
          assert.isAtLeast(observed.quiet, 200);
        }),
    );

    // L1 exposed the second commit failing Runtime.evaluate instead of restarting readiness.
    it.effect("restarts content quiet across repeated commits within the original deadline", () =>
      Effect.gen(function* () {
        const page = yield* (yield* Browser).newPage();

        yield* Effect.promise(() =>
          page.playwright.route("https://ready.test/**", (route) => {
            const url = new URL(route.request().url());
            const hop = Number(url.pathname.slice(1));
            const ending = hop === 2 && url.search === "";
            const next = `setTimeout(() => location.href = "/${hop + 1}${url.search}", 100)`;

            return route.fulfill({
              contentType: "text/html",
              body: `<main ${ending ? "" : 'aria-busy="true"'}><h1>${hop}</h1></main>
<script>window.arrived = performance.now(); ${ending ? "" : hop === 0 ? `window.start = () => { ${next} }` : next}</script>`,
            });
          }),
        );
        yield* page.goto("https://ready.test/0");
        yield* evaluate(page, () => (window as unknown as { start: () => void }).start());
        yield* page.ready({ still: "content", quietMillis: 250, timeout: Duration.seconds(2) });
        assert.strictEqual(yield* page.url, "https://ready.test/2");
        assert.isAtLeast(
          yield* evaluate(
            page,
            () => performance.now() - (window as unknown as { arrived: number }).arrived,
          ),
          250,
        );
        yield* page.goto("https://ready.test/0?endless");
        yield* evaluate(page, () => (window as unknown as { start: () => void }).start());
        const started = performance.now();

        assert.strictEqual(
          yield* reason(
            page.ready({ still: "content", quietMillis: 250, timeout: Duration.millis(700) }),
          ),
          "Timeout",
        );
        assert.isBelow(performance.now() - started, 1500);
      }),
    );
  },
);

// A corner that pulses from the start, as a slot's idle art does, and a region a click sets moving
// for 1.5 s, or for good: a reel's large area, or a win counter's few digits.
const stage = (moving: "reels" | "counter", seconds: number) =>
  `<body style="margin:0"><canvas id=c width=640 height=360></canvas><script>
  const g = c.getContext("2d");
  let until = -1;
  g.fillStyle = "#222"; g.fillRect(0, 0, 640, 360);
  function draw(now) {
    g.fillStyle = "hsl(" + Math.round(now / 4) % 360 + ", 80%, 50%)";
    g.fillRect(600, 10, 30, 30);
    if (now < until) {
      g.fillStyle = "#222"; g.fillRect(20, 60, 400, 260);
      // The reels change color with equal green, so a single color channel cannot prove stillness.
      g.fillStyle = ${moving === "reels"} ? (Math.floor(now / 80) % 2 === 0 ? "#f00" : "#00f") : "#fff";
      if (${moving === "reels"}) g.fillRect(20, 60, 400, 260);
      else { g.font = "24px sans-serif"; g.fillText(String(Math.round(now)), 24, 84); }
    } else if (until > 0 && window.stoppedAt === undefined) {
      // A delayed rAF must timestamp a visible final paint, not a later notification of silence.
      g.fillStyle = "#fff"; g.fillRect(20, 60, ${moving === "reels" ? 400 : 24}, ${moving === "reels" ? 260 : 24});
      window.stoppedAt = performance.now();
    }
    requestAnimationFrame(draw);
  }
  c.onclick = () => { until = performance.now() + ${seconds * 1000}; };
  requestAnimationFrame(draw);
</script></body>`;

// The screen's foreground: what an input set moving must stop, while what moved before it may not.
layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Page.ready in the foreground",
  (it) => {
    // bea3a16 compared only the newest frame at each look: motion and its return in between
    // disappeared. Hold that look while real Chromium delivers both paints, then let it resume.
    it.effect("counts foreground motion between looks and after deferred frame acceptance", () =>
      Effect.gen(function* () {
        const native = (yield* Browser).context.browser();

        if (native === null) return yield* Effect.die("the fixture requires local Chromium");

        const context = yield* Effect.acquireRelease(
          Effect.promise(() => native.newContext({ viewport: { width: 320, height: 180 } })),
          (context) => Effect.promise(() => context.close()),
        );

        const clock = yield* Clock.Clock;
        let entered = Promise.withResolvers<void>();
        let resume = Promise.withResolvers<void>();
        let held = false;
        const viewportRead = Promise.withResolvers<void>();
        const viewportReply = Promise.withResolvers<void>();
        const createSession = context.newCDPSession.bind(context);
        let resize: "off" | "waiting" | "delivered" = "off";

        const waitFor = (phase: string) =>
          Effect.timeoutOrElse({
            duration: "5 seconds",
            orElse: () => Effect.die(new Error(`foreground fixture timed out: ${phase}`)),
          });

        context.newCDPSession = async (target) => {
          const cdp = await createSession(target);
          const send = cdp.send.bind(cdp);

          const emitter = cdp as CDPSession & {
            emit(event: string | symbol, ...args: ReadonlyArray<unknown>): boolean;
          };

          const emit = emitter.emit.bind(emitter);

          // The viewport request proves an eligible resize is queued; earlier native frames can
          // still be late or malformed. Hold later notifications until the context closes.
          emitter.emit = (event, ...args) =>
            event === "Page.screencastFrame" && resize === "delivered"
              ? true
              : emit(event, ...args);

          const observed: CDPSession["send"] = (method, params) => {
            const response = send(method, params);

            if (
              resize === "waiting" &&
              method === "Runtime.evaluate" &&
              params !== undefined &&
              "expression" in params &&
              params.expression.endsWith(".__effectBrowser.viewport()")
            ) {
              resize = "delivered";
              viewportRead.resolve();

              return response.then((value) => viewportReply.promise.then(() => value));
            }

            return response;
          };

          cdp.send = observed;

          return cdp;
        };

        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            resume.resolve();
            viewportReply.resolve();
          }),
        );

        const browser = yield* makeBrowser(context, { id: "ready-pulse", provider: "test" }).pipe(
          Effect.provideService(Clock.Clock, {
            currentTimeMillisUnsafe: () => clock.currentTimeMillisUnsafe(),
            currentTimeMillis: clock.currentTimeMillis,
            currentTimeNanosUnsafe: () => clock.currentTimeNanosUnsafe(),
            currentTimeNanos: clock.currentTimeNanos,
            monotonicTimeNanosUnsafe: () => clock.monotonicTimeNanosUnsafe(),
            monotonicTimeNanos: clock.monotonicTimeNanos,
            sleep: (duration) => {
              if (Duration.toMillis(duration) !== 100 || held) return clock.sleep(duration);
              held = true;
              entered.resolve();

              return Effect.promise(() => resume.promise);
            },
          }),
        );

        const page = yield* browser.newPage();

        yield* show(page, '<canvas width="200" height="100"></canvas>');

        const draw = (color: string) =>
          Effect.promise(() =>
            page.playwright.evaluate((color) => {
              const context = document.querySelector("canvas")!.getContext("2d")!;

              context.fillStyle = color;
              context.fillRect(0, 0, 200, 100);
            }, color),
          );

        const paint = (color: string) =>
          Effect.gen(function* () {
            const before = (yield* page.captureStats()).accepted;

            yield* draw(color);
            yield* page.captureStats().pipe(
              Effect.flatMap(({ accepted }) =>
                page.state.pipe(
                  Effect.map(({ frame }) => {
                    if (accepted <= before || frame === undefined) return false;
                    const picture = jpegjs.decode(frame.data, { useTArray: true });
                    const green = picture.data[(50 * picture.width + 100) * 4 + 1];

                    // A queued older frame must not let the next paint erase this one unseen.
                    return (
                      green !== undefined && Math.abs(green - (color === "white" ? 255 : 0)) < 16
                    );
                  }),
                ),
              ),
              Effect.repeat({
                schedule: Schedule.spaced("5 millis"),
                until: (seen) => seen,
              }),
              waitFor(`captured ${color} paint`),
            );
          });

        yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
        yield* paint("black");

        const waiting = yield* page
          .ready({ still: "foreground", quietMillis: 300, timeout: "5 seconds" })
          .pipe(Effect.forkScoped);

        yield* Effect.promise(() => entered.promise).pipe(waitFor("first readiness look"));
        yield* Effect.sleep("350 millis");
        yield* paint("white");
        yield* paint("black");
        const returned = yield* browser.now;

        resume.resolve();
        yield* Fiber.join(waiting);
        assert.isAtLeast((yield* browser.now) - returned, 300);

        // CI #38297573716 showed that a resize need not arrive within 200 ms. Wait for its
        // actual viewport lookup, then hold that answer while ready establishes its reference.
        page.playwright.viewportSize = () => null;
        const before = yield* page.captureStats();

        resize = "waiting";
        yield* Effect.promise(() => page.playwright.setViewportSize({ width: 640, height: 360 }));
        // A resize and its first paint can coalesce without a capture frame. Keep changing pixels
        // until a real resized frame reaches the held viewport request, then stop the producer.
        let bright = false;

        const repainting = yield* Effect.suspend(() => {
          bright = !bright;

          return draw(bright ? "white" : "black");
        }).pipe(Effect.repeat({ schedule: Schedule.spaced("40 millis") }), Effect.forkScoped);

        yield* Effect.promise(() => viewportRead.promise).pipe(
          waitFor("resize viewport request"),
          Effect.ensuring(Fiber.interrupt(repainting)),
        );
        const heldFrames = yield* page.captureStats();

        assert.isAbove(heldFrames.received, before.received);
        assert.strictEqual(heldFrames.accepted, before.accepted);
        entered = Promise.withResolvers<void>();
        resume = Promise.withResolvers<void>();
        held = false;

        const resizing = yield* page
          .ready({ still: "foreground", quietMillis: 300, timeout: "5 seconds" })
          .pipe(Effect.forkScoped);

        yield* Effect.promise(() => entered.promise).pipe(waitFor("resized readiness look"));
        yield* Effect.sleep("350 millis");
        viewportReply.resolve();

        const adopted = yield* page.captureStats().pipe(
          Effect.repeat({
            schedule: Schedule.spaced("5 millis"),
            until: ({ accepted }) => accepted > before.accepted,
          }),
          waitFor("resized frame acceptance"),
        );

        const delivered = yield* browser.now;

        assert.strictEqual(adopted.received, heldFrames.received);
        resume.resolve();
        yield* Fiber.join(resizing);
        assert.isAtLeast((yield* browser.now) - delivered, 300);
      }),
    );

    const clicked = (moving: "reels" | "counter", seconds: number) =>
      Effect.gen(function* () {
        const page = yield* blank;

        yield* show(page, stage(moving, seconds));
        yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
        yield* Effect.sleep("800 millis");
        yield* page.click({ x: 200, y: 150 });

        return page;
      });

    const quiet = (page: Page) =>
      evaluate(
        page,
        () => performance.now() - (window as unknown as { stoppedAt: number }).stoppedAt,
      );

    for (const moving of ["reels", "counter"] as const)
      it.effect(`waits for the ${moving} a click set moving, not for the idle art`, () =>
        Effect.gen(function* () {
          const page = yield* clicked(moving, 1.5);

          yield* page.ready({
            still: "foreground",
            quietMillis: 600,
            timeout: Duration.seconds(10),
          });
          // Within a sample of the spell: the wait looks every 100 ms.
          assert.isAtLeast(yield* quiet(page), 450, moving);
          assert.strictEqual(
            yield* reason(page.ready({ quietMillis: 600, timeout: Duration.seconds(2) })),
            "Timeout",
          );
        }),
      );

    it.effect("never ends while what a click set moving keeps moving", () =>
      Effect.gen(function* () {
        const page = yield* clicked("reels", 1000);

        assert.strictEqual(
          yield* reason(
            page.ready({ still: "foreground", quietMillis: 600, timeout: Duration.seconds(3) }),
          ),
          "Timeout",
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

    for (const still of ["screen", "foreground"] as const)
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
        yield* page.ready({ still, quietMillis: 400, timeout: Duration.seconds(10) });
        assert.isAtLeast(
          (yield* browser.now) - clicked,
          1200,
          `${still}, stalled toward the ${toward}`,
        );
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
      yield* page.state.pipe(
        Effect.repeat({
          schedule: Schedule.spaced("10 millis"),
          until: (state) => state.frame !== undefined,
        }),
      );
      yield* page.changes();
      proxy.withhold = (method) => method === "Page.screencastFrame";
      const started = yield* browser.now;

      yield* evaluate(page, () => (window as unknown as { tick: () => void }).tick());
      yield* page.ready({ quietMillis: 300, timeout: Duration.seconds(10) });
      assert.isAtLeast((yield* browser.now) - started, 1200);
    }).pipe(Effect.scoped),
);
