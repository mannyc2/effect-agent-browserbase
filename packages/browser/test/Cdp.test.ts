// A browser reached over CDP, where Playwright emulates no viewport: the page's own size must
// drive pointer bounds and scroll distances, not a default.
import { createServer } from "node:net";

import { assert, it } from "@effect/vitest";
import { Duration, Effect, Exit, Layer, Option } from "effect";
import { chromium } from "playwright-core";

import { Browser } from "../src/Browser.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Tools from "../src/Tools.ts";

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
    const page = yield* browser.page;

    yield* page.goto("data:text/html,<body style='margin:0;height:5000px'>tall</body>");

    const inner = yield* Effect.promise(() =>
      page.playwright.evaluate(() => ({ width: innerWidth, height: innerHeight })),
    );

    assert.isNull(page.playwright.viewportSize());
    assert.notDeepEqual(inner, { width: 1280, height: 720 });
    assert.deepStrictEqual(yield* page.viewport, inner);

    // One page of scrolling is one viewport of this page, not of a 1280x720 default.
    const tools = yield* Tools.make();

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
    const page = yield* browser.page;

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
