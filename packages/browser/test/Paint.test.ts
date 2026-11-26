import { createServer } from "node:http";

import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, it, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Schema } from "effect";
import { chromium } from "playwright-core";

import { Browser } from "../src/Browser.ts";
import * as Cdp from "../src/Cdp.ts";
import * as Frame from "../src/Frame.ts";
import type { Page } from "../src/Page.ts";

const freePort = Effect.callback<number>((resume) => {
  const server = createServer();

  server.listen(0, "127.0.0.1", () => {
    const address = server.address();

    server.close(() =>
      resume(Effect.succeed(typeof address === "object" && address !== null ? address.port : 0)),
    );
  });
});

// A browser attached over CDP, as a hosted one is, with the scrollbars headless Chromium hides.
const attached = Layer.unwrap(
  Effect.gen(function* () {
    const port = yield* freePort;

    yield* Effect.acquireRelease(
      Effect.promise(() =>
        chromium.launch({
          args: [`--remote-debugging-port=${port}`, "--window-size=800,600"],
          ignoreDefaultArgs: ["--hide-scrollbars"],
        }),
      ),
      (launched) => Effect.promise(() => launched.close()),
    );

    return Cdp.layer({ endpoint: `http://127.0.0.1:${port}` });
  }),
);

const tall = `data:text/html,${encodeURIComponent(
  `<body style="margin: 0; height: 3000px"><div id=wide style="height: 10px; background: blue"></div><button id=hit style="position: absolute; left: 100px; top: 100px; width: 50px; height: 50px" onclick="this.textContent = 'hit'">go</button></body>`,
)}`;

const measured = (page: Page) =>
  page
    .read(
      () => ({
        ratio: devicePixelRatio,
        width: document.documentElement.clientWidth,
        text: document.getElementById("hit")?.textContent ?? "",
      }),
      {
        arg: null,
        result: Schema.Struct({ ratio: Schema.Finite, width: Schema.Finite, text: Schema.String }),
      },
    )
    .pipe(Effect.map(({ value }) => value));

layer(attached, { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "Page.paint, attached",
  (it) => {
    it.effect("paints device pixels for a scope, and documents then without scrollbars", () =>
      Effect.gen(function* () {
        const browser = yield* Browser;
        const page = yield* browser.firstPage;

        yield* page.goto(tall);
        const viewport = yield* page.viewport;
        const before = yield* measured(page);
        const plain = yield* Frame.read(page, { maxAge: 0, scale: "device" });

        assert.strictEqual(before.ratio, 1);
        assert.isBelow(before.width, viewport.width, "a classic scrollbar takes room");
        assert.strictEqual(plain.width, viewport.width);

        yield* Effect.scoped(
          Effect.gen(function* () {
            yield* Frame.paint(page, { scale: 2, scrollbars: false });
            assert.strictEqual((yield* measured(page)).ratio, 2);
            yield* page.goto(tall);
            const painted = yield* measured(page);
            const shot = yield* Frame.read(page, { maxAge: 0, scale: "device" });
            const css = yield* Frame.read(page, { maxAge: 0 });

            assert.strictEqual(painted.ratio, 2);
            assert.strictEqual(painted.width, viewport.width);
            assert.deepStrictEqual(yield* page.viewport, viewport);
            assert.deepStrictEqual(
              [shot.width, shot.height],
              [viewport.width * 2, viewport.height * 2],
            );
            assert.deepStrictEqual([css.width, css.height], [viewport.width, viewport.height]);
            yield* page.click({ x: 125, y: 125 });
            assert.strictEqual((yield* measured(page)).text, "hit");
            assert.strictEqual(
              (yield* Effect.flip(Effect.scoped(Frame.paint(page, { scale: 2 })))).reason._tag,
              "InvalidRequest",
            );
          }),
        );
        yield* page.goto(tall);
        const after = yield* measured(page);

        assert.deepStrictEqual([after.ratio, after.width], [1, before.width]);
        assert.strictEqual(
          (yield* Frame.read(page, { maxAge: 0, scale: "device" })).width,
          viewport.width,
        );
        for (const scale of [0, Number.NaN, 5])
          assert.strictEqual(
            (yield* Effect.flip(Effect.scoped(Frame.paint(page, { scale })))).reason._tag,
            "InvalidRequest",
          );
      }),
    );
  },
);

it.effect("a launched browser paints at its launch's scale, and refuses another", () =>
  Effect.gen(function* () {
    const browser = yield* Browser;

    const page = yield* Effect.acquireRelease(browser.newPage(tall), (page) =>
      Effect.ignore(page.close),
    );

    yield* Effect.scoped(Frame.paint(page, { scale: 2 }));
    assert.strictEqual(
      (yield* Effect.flip(Effect.scoped(Frame.paint(page, { scale: 1 })))).reason._tag,
      "InvalidRequest",
    );
    assert.strictEqual((yield* Frame.read(page, { maxAge: 0, scale: "device" })).width, 1280 * 2);
  }).pipe(
    Effect.scoped,
    Effect.provide(Chromium.layer({ deviceScaleFactor: 2 })),
    Effect.timeout("60 seconds"),
  ),
);
