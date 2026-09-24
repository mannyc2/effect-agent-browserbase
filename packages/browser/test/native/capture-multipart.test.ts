import assert from "node:assert/strict";
import { createServer } from "node:http";

import { NodeCrypto, NodeHttpServer } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, PubSub, Redacted, Stream } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";
import { HttpRouter, HttpServer, HttpServerResponse } from "effect/unstable/http";
import { chromium } from "playwright-core";

import { externalChromium } from "../fixtures/StandaloneBrowser.ts";

const viewer = `<!doctype html><img id=live src="/live.mjpeg"><script>
window.centre = () => {
  const image = document.getElementById("live");
  if (!image.naturalWidth) return null;
  const canvas = Object.assign(document.createElement("canvas"), { width: image.naturalWidth, height: image.naturalHeight });
  const context = canvas.getContext("2d");
  context.drawImage(image, 0, 0);
  return [...context.getImageData(canvas.width >> 1, canvas.height >> 1, 1, 1).data.slice(0, 3)];
};
</script>`;

const layer = Chromium.layer({}).pipe(Layer.provide(NodeCrypto.layer));

it.live("real CDP: an <img> shows the last picture of a page that has gone still", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const host = yield* externalChromium;

      const operator = yield* Effect.acquireRelease(
        Effect.promise(() =>
          chromium.connectOverCDP(Redacted.value(host.endpoint), { noDefaults: true }),
        ),
        (browser) => Effect.promise(() => browser.close()),
      );

      const session = yield* Chromium.attach(host.endpoint, {
        policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60_000 }),
      });

      yield* session.resizeViewport({ width: 320, height: 240 });
      const page = operator.contexts()[0]?.pages()[0];

      assert.ok(page);
      yield* Effect.promise(() =>
        page.setContent("<!doctype html><body style='margin:0;background:rgb(255,0,0)'>"),
      );

      // One interval, fanned out: a viewer that joins late is shown the current picture.
      const interval = yield* Capture.start(session, { size: { width: 320, height: 240 } });
      const frames = yield* PubSub.sliding<Capture.CapturedFrame>({ capacity: 2, replay: 1 });

      yield* interval.frames.pipe(
        Stream.runForEach((frame) => PubSub.publish(frames, frame)),
        Effect.forkScoped,
      );

      const routes = Layer.mergeAll(
        HttpRouter.add("GET", "/", HttpServerResponse.html(viewer)),
        HttpRouter.add(
          "GET",
          "/live.mjpeg",
          Effect.map(Capture.multipart(Stream.fromPubSub(frames)), ({ contentType, body }) =>
            HttpServerResponse.stream(body, { contentType }),
          ).pipe(Effect.orDie),
        ),
      );

      const served = HttpRouter.serve(routes, { disableLogger: true, disableListenLog: true }).pipe(
        Layer.provideMerge(NodeHttpServer.layer(createServer, { host: "127.0.0.1", port: 0 })),
      );

      yield* Effect.gen(function* () {
        const address = HttpServer.formatAddress((yield* HttpServer.HttpServer).address);

        // A viewer is another browser; a tab in the filmed one would push the filmed page into
        // the background, where it stops painting.
        const audience = yield* Effect.acquireRelease(
          Effect.promise(() => chromium.launch()),
          (browser) => Effect.promise(() => browser.close()),
        );

        const watcher = yield* Effect.promise(() => audience.newPage());

        yield* Effect.promise(() => watcher.goto(address, { waitUntil: "commit" }));

        const until = (expected: ReadonlyArray<number>) =>
          Effect.promise((): Promise<ReadonlyArray<number> | null> =>
            watcher.evaluate("window.centre && window.centre()"),
          ).pipe(
            Effect.repeat({
              until: (pixel) =>
                pixel !== null &&
                pixel.every((value, index) => Math.abs(value - (expected[index] ?? 0)) < 40),
            }),
            Effect.timeout("10 seconds"),
          );

        yield* until([255, 0, 0]);
        // One repaint, then nothing: the picture must reach the viewer without a later frame.
        yield* Effect.promise(() =>
          page.evaluate(() => {
            document.body.style.background = "rgb(0,0,255)";
          }),
        );
        expect(yield* until([0, 0, 255])).not.toBeNull();
        // The viewer leaves before the server stops, as a closed tab would.
      }).pipe(Effect.scoped, Effect.provide(served));

      const summary = yield* interval.stop;

      expect(summary.discarded - summary.late).toBe(0);
    }).pipe(Effect.provide(layer)),
  ),
);
