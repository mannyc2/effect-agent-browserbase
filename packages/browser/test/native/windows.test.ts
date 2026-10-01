import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Clock, Effect, Layer, Stream } from "effect";
import {
  BrowserPolicy,
  NavigateRequest,
  ScreenshotRequest,
  type ScreenshotResult,
} from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import { Chromium } from "effect-browser/chromium";

import { localSite } from "../fixtures/StandaloneBrowser.ts";

const policy = BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 });

const launch = {
  ...(process.env.BROWSERBASE_CHROMIUM === undefined
    ? {}
    : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
  chromiumSandbox: false,
  startupTimeoutMillis: 25000,
};

const visible = ScreenshotRequest.make({ fullPage: false });

/** A PNG's own width and height, from its header chunk. */
const size = (picture: ScreenshotResult) => {
  const header = new DataView(picture.bytes.buffer, picture.bytes.byteOffset, 24);

  return { width: header.getUint32(16), height: header.getUint32(20) };
};

const timed = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  Effect.gen(function* () {
    const started = yield* Clock.currentTimeMillis;
    const value = yield* effect;

    return { value, millis: (yield* Clock.currentTimeMillis) - started };
  });

// Chromium paints only the front tab of a window. As tabs, the page opened first waited 2–4 s
// for each picture, or never got one inside 8 s, and the page on air went behind the new tab.
it.live("a page behind a later one is pictured at speed, in a window of the session's size", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* localSite;
      const session = yield* (yield* Chromium).launch(policy);

      yield* session.navigate(NavigateRequest.make({ url: site.url }));
      const earlier = yield* session.createPage();
      const later = yield* session.createPage();
      const behind = yield* session.pinPage(earlier);
      const front = yield* session.pinPage(later);

      yield* behind.navigate({ url: new URL("/pinned?name=behind", site.url).href });
      yield* front.navigate({ url: new URL("/pinned?name=front", site.url).href });

      const millis: number[] = [];

      for (const idle of [0, 500, 1000, 2000, 500, 500]) {
        yield* Effect.sleep(idle);
        const picture = yield* timed(behind.screenshot(visible));

        expect(size(picture.value)).toEqual({ width: 640, height: 480 });
        millis.push(picture.millis);
      }
      expect(
        millis.filter((took) => took >= 1500),
        `pictures of the earlier page took ${millis.join(", ")} ms`,
      ).toEqual([]);
      expect(size(yield* front.screenshot(visible))).toEqual({ width: 640, height: 480 });

      // The selected page, animated, still streams while two later windows exist.
      const onAir = yield* Capture.start(session, { lifetime: "page", maxDurationMillis: 10000 });

      const frames = yield* onAir.frames.pipe(
        Stream.take(3),
        Stream.runCollect,
        Effect.timeout("5 seconds"),
      );

      expect(frames).toHaveLength(3);
      yield* onAir.stop;

      // One page's current address and title, without listing the others.
      expect(yield* session.describePage(earlier)).toMatchObject({
        pageId: earlier.pageId,
        targetId: earlier.targetId,
        title: "Pinned behind",
        url: new URL("/pinned?name=behind", site.url).href,
        selected: false,
      });
      expect(yield* session.pages()).toHaveLength(3);
    }),
  ).pipe(
    Effect.provide(
      Chromium.layer({ launch, viewport: { width: 640, height: 480 } }).pipe(
        Layer.provide(NodeCrypto.layer),
      ),
    ),
  ),
);
