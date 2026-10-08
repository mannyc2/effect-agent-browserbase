// A browser reached over CDP, where Playwright emulates no viewport: the page's own size must
// drive pointer bounds and scroll distances, not a default.
import { createServer } from "node:net";

import { assert, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option, Scope, Stream } from "effect";
import { chromium } from "playwright-core";

import { Browser } from "../src/Browser.ts";
import * as Cdp from "../src/Cdp.ts";
import type { Frame } from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";
import * as Tools from "../src/Tools.ts";
import { behindProxy } from "./protocol.ts";

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    server.close(() =>
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0)),
    );
  });
});

const attachedWith = (args: ReadonlyArray<string>, options: Partial<Cdp.Options> = {}) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const port = yield* freePort;

      yield* Effect.acquireRelease(
        Effect.promise(() =>
          chromium.launch({
            args: [`--remote-debugging-port=${port}`, "--window-size=1000,700", ...args],
          }),
        ),
        (launched) => Effect.promise(() => launched.close()),
      );

      return Cdp.layer({ ...options, endpoint: `http://127.0.0.1:${port}` });
    }),
  );

const attached = attachedWith([]);

const elapsed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = performance.now();
    const exit = yield* Effect.exit(effect);

    return { exit, millis: performance.now() - started };
  });

it.live("measures the viewport of a page Playwright did not size", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const page = yield* browser.firstPage;

    yield* page.goto("data:text/html,<body style='margin:0;height:5000px'>tall</body>");

    const inner = yield* Effect.promise(() =>
      page.playwright.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    );

    assert.isNull(page.playwright.viewportSize());
    assert.notDeepEqual(inner, { width: 1280, height: 720 });
    assert.deepStrictEqual(yield* page.viewport, inner);

    // One page of scrolling is one viewport of this page, not of a 1280x720 default.
    const tools = yield* Tools.make({ page });

    yield* tools.handlers.browser_scroll({ direction: "down", pages: 1 });
    assert.strictEqual(
      yield* Effect.promise(() => page.playwright.evaluate(() => scrollY)),
      inner.height,
    );
  }).pipe(Effect.provide(attached)),
);

it.live("bounds a viewport read on a busy page by the action's deadline and records it", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const page = yield* browser.firstPage;

    // The page becomes unresponsive for five seconds, longer than every bound here.
    yield* page.goto(
      "data:text/html,<body style='margin:0;height:5000px'>busy<script>setTimeout(() => { const s = Date.now(); while (Date.now() - s < 5000) {} }, 300)</script></body>",
    );
    yield* Effect.sleep("600 millis");

    for (const [name, operation] of [
      ["scroll", page.scroll({ dy: 100 })],
      ["viewport", page.viewport],
    ] as const) {
      const { exit, millis } = yield* elapsed(operation);

      assert.isTrue(Exit.isFailure(exit), name);
      assert.isBelow(millis, 1800, name);
      if (Exit.isFailure(exit)) {
        const error = Option.getOrThrow(Exit.findErrorOption(exit));

        assert.strictEqual(error.reason._tag, "Timeout", name);
        assert.isFalse(error.dispatched, name);
      }
    }

    const scrolls = (yield* browser.recentEvents).filter(
      (event) => event._tag === "Action" && event.name === "scroll",
    );

    assert.strictEqual(scrolls.length, 1);
  }).pipe(Effect.provide(attachedWith([], { actionTimeout: Duration.seconds(1) }))),
);

it.live("captures an unsized page at its CSS viewport and reuses current frames", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const page = yield* browser.firstPage;

    yield* page.goto(
      "data:text/html,<title>Spin</title><body style='margin:0'><canvas id=c width=300 height=300></canvas><script>const g=c.getContext('2d');(function f(t){g.fillStyle='hsl('+(t/5%360)+',80%,50%)';g.fillRect(0,0,300,300);requestAnimationFrame(f)})(0)</script></body>",
    );
    const viewport = yield* page.viewport;

    yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
    yield* Effect.sleep("500 millis");
    const { frame } = yield* page.state;

    if (frame === undefined) return yield* Effect.die("no frame came");

    // At a device scale factor of 2 the native frame would be twice the CSS viewport.
    assert.deepStrictEqual([frame.width, frame.height], [viewport.width, viewport.height]);
    let reused = 0;

    for (let index = 0; index < 5; index++) {
      const shot = yield* page.screenshot();

      if ((yield* page.recentFrames).some((recent) => recent.data === shot.data)) reused++;
      yield* Effect.sleep("50 millis");
    }
    assert.isAbove(reused, 0);
  }).pipe(Effect.scoped, Effect.provide(attachedWith(["--force-device-scale-factor=2"]))),
);

// Over CDP a crop is taken on the page's own session, and Chromium draws it into the running
// screencast at the crop's own size. So only frames of another size are the crop's: they never
// reach readers, nor even the size filter, which holds a run of them until it could pass for a
// resize, as it would on a still page. The page's own frames keep reaching readers, so on a page
// that keeps painting they arrive right after each crop, within the 50 ms the library would
// otherwise wait past its reply.
it.live("keeps a crop's frames out of a running capture, but not the page's own", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint });

    const zoomed = (body: string) =>
      Effect.gen(function* () {
        const page = yield* browser.newPage(`data:text/html,${encodeURIComponent(body)}`);
        const { width, height } = yield* page.viewport;
        const frames: Array<Frame> = [];
        const replies: Array<number> = [];

        yield* page.screencast().pipe(
          Stream.runForEach((frame) => Effect.sync(() => frames.push(frame))),
          Effect.forkScoped,
        );
        yield* Effect.sleep("500 millis");
        for (let index = 0; index < 10; index++) {
          yield* page.zoom({ x: 5, y: 5, width: 160, height: 90 });
          replies.push(yield* browser.now);
          yield* Effect.sleep("250 millis");
        }
        yield* Effect.sleep("1200 millis");

        return {
          crops: frames.filter((frame) => frame.width !== width || frame.height !== height),
          afterCrops: frames.filter((frame) =>
            replies.some((at) => frame.receivedAt >= at && frame.receivedAt <= at + 40),
          ),
          stats: yield* page.captureStats(),
        };
      });

    const moving = yield* zoomed(
      "<canvas id=c width=300 height=300></canvas><script>const g=c.getContext('2d');(function f(t){g.fillStyle='hsl('+(t/5%360)+',80%,50%)';g.fillRect(0,0,300,300);requestAnimationFrame(f)})(0)</script>",
    );

    const still = yield* zoomed("<h1>Still</h1>");

    assert.deepStrictEqual(
      [moving.crops.length, moving.stats.foreignSize, still.crops.length, still.stats.foreignSize],
      [0, 0, 0, 0],
    );
    assert.isNotEmpty(moving.afterCrops);
  }).pipe(Effect.scoped),
);

// Another session emulates the page's screen, as a Browserbase session's own does. Chromium takes a
// crop through the emulation of the session that asks for it and then restores that session's
// own, so a crop on a session that emulates nothing would leave the page reading Chromium's real
// screen: here 800x600, and `device-width` queries with it.
it.live("keeps the screen another session emulates through crops and pictures", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint });
    const page = yield* browser.newPage("data:text/html,<h1>Screen</h1>");

    const other = yield* Effect.promise(() =>
      page.playwright.context().newCDPSession(page.playwright),
    );

    const reads = Effect.promise(() =>
      page.playwright.evaluate(() => [
        screen.width,
        screen.height,
        matchMedia("(device-width: 1280px)").matches,
      ]),
    );

    yield* Effect.promise(() =>
      other.send("Emulation.setDeviceMetricsOverride", {
        width: 0,
        height: 0,
        deviceScaleFactor: 0,
        mobile: false,
        screenWidth: 1280,
        screenHeight: 720,
      }),
    );
    assert.deepStrictEqual(yield* reads, [1280, 720, true]);
    yield* page.zoom({ x: 10, y: 10, width: 160, height: 90 });
    assert.deepStrictEqual(yield* reads, [1280, 720, true]);
    yield* page.zoom({ x: 40, y: 20, width: 90, height: 160 });
    yield* page.screenshot({ maxAge: 0 });
    assert.deepStrictEqual(yield* reads, [1280, 720, true]);
  }).pipe(Effect.scoped),
);

// A picture saves the view's size and the emulation it finds, and restores them once taken, so a
// second picture taken during a crop would restore the crop's own: the page's view would stay
// the crop's size. Pictures of a page go one at a time, so another session's whole picture of a
// still page is the same after two crops asked together.
it.live("leaves the page's view as it was after crops asked together", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const browser = yield* Cdp.open({ endpoint: proxy.endpoint });

    const page = yield* browser.newPage(
      "data:text/html,<body style='margin:0;background:linear-gradient(90deg,white,navy)'><h1>View</h1></body>",
    );

    const other = yield* Effect.promise(() =>
      page.playwright.context().newCDPSession(page.playwright),
    );

    const whole = Effect.promise(() =>
      other.send("Page.captureScreenshot", { format: "png" }).then(({ data }) => data),
    );

    yield* page.screenshot({ maxAge: 0 });
    const before = yield* whole;

    yield* Effect.all(
      [
        page.zoom({ x: 10, y: 10, width: 200, height: 100 }),
        page.zoom({ x: 300, y: 50, width: 120, height: 300 }),
      ],
      { concurrency: "unbounded" },
    );
    const after = yield* whole;

    assert.isTrue(
      after === before,
      `a whole picture went from ${before.length} to ${after.length} B`,
    );
  }).pipe(Effect.scoped),
);

// Animation frames a page runs in a second, read from its own counter.
const paintRate = (page: Page) =>
  Effect.gen(function* () {
    const count = Effect.promise(() =>
      page.playwright.evaluate(() => (window as unknown as { painted: number }).painted),
    );

    const before = yield* count;

    yield* Effect.sleep("1 second");

    return (yield* count) - before;
  });

const painting = `data:text/html,${encodeURIComponent(
  "<script>window.painted = 0; (function tick() { window.painted++; requestAnimationFrame(tick); })();</script>",
)}`;

// Over raw CDP a tab behind another is hidden and stops painting, unless some session holds focus
// emulation on it. Playwright sends it on its own sessions; the proxy swallows those, so only the
// library's own session can keep the page behind painting. Planting its absence too, the same
// page stops: the measurement can see a page that is not painting.
it.live("keeps a page behind painting with its own focus emulation", () =>
  Effect.gen(function* () {
    const behind = (plantedOff: boolean) =>
      Effect.gen(function* () {
        const proxy = yield* behindProxy();

        proxy.swallow = (command) =>
          command.method === "Emulation.setFocusEmulationEnabled" &&
          (plantedOff || !proxy.attached.has(command.sessionId ?? ""));
        const browser = yield* Cdp.open({ endpoint: proxy.endpoint });
        const page = yield* browser.newPage(painting);

        // The newest tab is in front.
        yield* browser.newPage("about:blank");

        return yield* paintRate(page);
      }).pipe(Effect.scoped);

    assert.isAbove(yield* behind(false), 20);
    assert.strictEqual(yield* behind(true), 0);
  }),
);

// The page script's registration belongs to a session, and its world to the page. A connection that
// comes later, as after a reconnect, registers again; once the first connection has gone, every
// later document still runs the script from its start.
it.live("reads every later document after another connection takes over a page", () =>
  Effect.gen(function* () {
    const proxy = yield* behindProxy();
    const still = (title: string) => `data:text/html,<title>${title}</title><h1>${title}</h1>`;
    const earlier = yield* Scope.make();

    yield* Effect.addFinalizer(() => Scope.close(earlier, Exit.void));
    const first = yield* Cdp.open({ endpoint: proxy.endpoint }).pipe(Scope.provide(earlier));
    const opened = yield* first.newPage(still("one"));

    assert.include((yield* opened.snapshot()).text, "one");

    const later = yield* Cdp.open({ endpoint: proxy.endpoint });
    const page = Option.getOrThrow(yield* later.page(opened.id));

    assert.include((yield* page.snapshot()).text, "one");
    yield* Scope.close(earlier, Exit.void);
    yield* page.goto(still("two"));

    const before = proxy.commands.length;
    const text = (yield* page.snapshot()).text;
    const read = proxy.commands.slice(before);

    assert.include(text, "two");
    assert.deepStrictEqual(
      read.map((command) => command.method),
      ["Page.createIsolatedWorld", "Runtime.evaluate"],
    );
  }).pipe(Effect.scoped),
);
