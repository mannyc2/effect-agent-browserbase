/**
 * Pictures of a page: screenshots, the current frame, zooms, its screencast and waiting until it
 * is still. The newest screencast frame stands in for a new capture while it demonstrably shows
 * the viewport now.
 */
import { Clock, Duration, Effect, Option, Schema, Sink, Stream } from "effect";

import { BrowserError, InvalidRequest, Timeout } from "../../BrowserError.ts";
import { Frame, Image, Screenshot } from "../../Frame.ts";
import { Region, type ScreenshotOptions, Zoom } from "../../Page.ts";
import type { Bridge } from "../page/bridge.ts";
import { failWith, type PageContext, reasonOf } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import * as Capture from "./capture.ts";
import * as BrowserClock from "./clock.ts";

/** Read a JPEG's dimensions from its start-of-frame marker. */
export const jpegSize = (
  bytes: Uint8Array,
): { readonly width: number; readonly height: number } | undefined => {
  let offset = 2;

  while (offset + 9 < bytes.length) {
    if (bytes[offset] !== 0xff) return undefined;
    const marker = bytes[offset + 1] ?? 0;
    const length = ((bytes[offset + 2] ?? 0) << 8) | (bytes[offset + 3] ?? 0);

    if (marker >= 0xc0 && marker <= 0xc3)
      return {
        height: ((bytes[offset + 5] ?? 0) << 8) | (bytes[offset + 6] ?? 0),
        width: ((bytes[offset + 7] ?? 0) << 8) | (bytes[offset + 8] ?? 0),
      };
    offset += 2 + length;
  }

  return undefined;
};

// Several 60 Hz frame intervals: while a page changes, its stream keeps delivering and its newest
// frame is reused; once the stream goes quiet, a real capture is taken. A lost final paint can be
// served for at most this long after the last frame that did arrive. Delivery time, not paint
// time, measures this, so a remote browser's transport delay does not disqualify every frame.
const currentPaintMillis = 250;

/** Measure this page's clock against the browser's, through its script's world. */
export const calibrator = (page: PageContext, bridge: Bridge) =>
  bridge.evaluateWithContext("calibrate", "version").pipe(
    Effect.flatMap(({ contextId }) =>
      BrowserClock.calibrate(page.cdp, page.clock, contextId).pipe(
        Effect.mapError(
          (failure) =>
            new BrowserError({
              operation: "calibrate",
              reason: reasonOf(failure.cause),
              dispatched: false,
            }),
        ),
      ),
    ),
    Effect.timeoutOrElse({
      duration: Duration.seconds(4),
      orElse: () =>
        Effect.fail(
          new BrowserError({
            operation: "calibrate",
            reason: new Timeout({ millis: 4000 }),
            dispatched: false,
          }),
        ),
    }),
    // The fastest probe's round trip: the transport's, plus a trivial script.
    Effect.tap((estimate) =>
      Effect.annotateCurrentSpan("roundTripMillis", Math.round(estimate.roundTripMillis * 10) / 10),
    ),
    page.span("Page.calibrateClock", {}, "Debug"),
    Effect.provideService(Clock.Clock, page.clock),
  );

export const make = Effect.fnUntraced(function* (
  page: PageContext,
  viewport: Viewport,
  calibrateClock: Effect.Effect<BrowserClock.Estimate, BrowserError>,
) {
  const { id, cdp, clock, playwright, settings, mapping, native, now, span, owned, lock } = page;
  const { activity } = page;

  // Input and capture share the owner's monotonic clock; caller-provided clocks cannot move it.
  // Registration measures nothing: a page that is busy while it opens, such as a popup running
  // its first script, must still be tracked. The browser's mapping serves every other page, so
  // only a browser with no estimate yet needs this page's renderer to answer.
  const capture = yield* Capture.make({
    id,
    cdp,
    clock,
    calibrate: mapping.refresh(calibrateClock),
    frameHistory: settings.frameHistory,
    viewport: Effect.suspend(() => viewport.viewportFor("screencast")),
    onClose: (listener) => {
      playwright.on("close", listener);
      if (playwright.isClosed()) listener();

      return () => {
        playwright.off("close", listener);
      };
    },
    imageSize: jpegSize,
    error: (cause) =>
      new BrowserError({ operation: "screencast", reason: reasonOf(cause), dispatched: false }),
  });

  // The newest screencast frame, only while it demonstrably shows the viewport now. Delivery can
  // be delayed, so its whole paint interval must follow the latest input, and no action may be
  // changing the page. A screencast sends only changes and can miss a page's final paint, so a
  // quiet stream is no evidence that its newest frame is still current: it must also have been
  // delivered recently, at the viewport's size.
  const currentPaint = Effect.gen(function* () {
    const frame = yield* capture.latest;
    const active = yield* capture.active;
    const known = viewport.knownViewport();

    return Option.filter(
      frame,
      (latest) =>
        active &&
        activity.changing === 0 &&
        latest.hostTime - latest.timing.uncertaintyMillis > activity.inputAt &&
        latest.receivedAt > now() - currentPaintMillis &&
        latest.width === known?.width &&
        latest.height === known.height,
    );
  });

  /** Where a picture came from: a frame the screencast had delivered, or a new capture. */
  const sourceOf = (reused: Option.Option<Frame>) =>
    Option.isSome(reused) ? "screencast" : "capture";

  const takeScreenshot = (screenshotOptions: ScreenshotOptions) =>
    Effect.gen(function* () {
      const quality = screenshotOptions.quality ?? 80;
      const timeout = Duration.toMillis(settings.actionTimeout);

      const data = yield* native(
        "screenshot",
        () =>
          playwright.screenshot({
            type: "jpeg",
            quality,
            scale: "css",
            timeout,
            ...(screenshotOptions.clip === undefined ? {} : { clip: screenshotOptions.clip }),
          }),
        timeout,
      );

      const size = jpegSize(data) ?? viewport.knownViewport() ?? { width: 0, height: 0 };

      return new Image({ data, mediaType: "image/jpeg", width: size.width, height: size.height });
    });

  const screenshot = (screenshotOptions: ScreenshotOptions = {}) =>
    Effect.gen(function* () {
      const reusable =
        screenshotOptions.fresh === true || screenshotOptions.clip !== undefined
          ? Option.none<Frame>()
          : yield* currentPaint;

      const image = Option.isSome(reusable)
        ? reusable.value.image
        : yield* takeScreenshot(screenshotOptions);

      yield* Effect.annotateCurrentSpan({ source: sourceOf(reusable), bytes: image.data.length });

      return image;
    }).pipe(span("Page.screenshot"), owned);

  // A new screenshot has no paint time, only the host interval in which it was taken.
  const currentFrame = Effect.gen(function* () {
    const reusable = yield* currentPaint;

    yield* Effect.annotateCurrentSpan("source", sourceOf(reusable));
    if (Option.isSome(reusable)) return reusable.value;
    const startedAt = now();
    const image = yield* takeScreenshot({});
    const finishedAt = now();

    return new Frame({
      page: id,
      data: image.data,
      timing: new Screenshot({
        hostTime: startedAt + (finishedAt - startedAt) / 2,
        uncertaintyMillis: (finishedAt - startedAt) / 2,
      }),
      receivedAt: finishedAt,
      width: image.width,
      height: image.height,
    });
  }).pipe(span("Page.currentFrame"), owned);

  const zoom = (requested: Region) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const region = yield* Schema.decodeEffect(Region)(requested).pipe(
            Effect.mapError(
              (error) =>
                new BrowserError({
                  operation: "zoom",
                  reason: new InvalidRequest({ detail: error.message }),
                  dispatched: false,
                }),
            ),
          );

          const size = yield* viewport.viewportFor("zoom");

          if (region.x + region.width > size.width || region.y + region.height > size.height)
            return yield* failWith(
              "zoom",
              new InvalidRequest({ detail: "the crop must fit entirely within the viewport" }),
            );
          const image = yield* screenshot({ clip: region });

          return new Zoom({ page: id, region, image });
        }),
      )
      .pipe(
        // Waiting behind another operation on this page counts against the deadline too.
        Effect.timeoutOrElse({
          duration: settings.actionTimeout,
          orElse: () =>
            failWith("zoom", new Timeout({ millis: Duration.toMillis(settings.actionTimeout) })),
        }),
        span("Page.zoom"),
        owned,
      );

  return { capture, screenshot, currentFrame, zoom };
});

export const waitForStill =
  (page: PageContext, capture: Capture.Controller) =>
  (stillOptions: { readonly quietMillis?: number; readonly timeout?: Duration.Input } = {}) => {
    const quiet = stillOptions.quietMillis ?? 600;
    const screencast = capture.stream;

    const still = <E>(frames: Stream.Stream<Frame, E>) =>
      frames.pipe(Stream.timeout(Duration.millis(quiet)), Stream.runDrain);

    // A running capture's silence already means the page is still. A new capture's first frame
    // can take longer than `quiet`, over half a second from a hosted browser, so the quiet counts
    // from that frame; Chrome sends one as a capture starts, even of a still page.
    return capture.active.pipe(
      Effect.flatMap((running) =>
        running
          ? still(screencast())
          : Stream.peel(screencast(), Sink.take(1)).pipe(
              Effect.flatMap(([, rest]) => still(rest)),
              Effect.scoped,
            ),
      ),
      Effect.timeoutOrElse({
        duration: stillOptions.timeout ?? Duration.seconds(15),
        orElse: () =>
          failWith(
            "waitForStill",
            new Timeout({
              millis: Duration.toMillis(stillOptions.timeout ?? Duration.seconds(15)),
            }),
          ),
      }),
      page.span("Page.waitForStill"),
      page.owned,
    );
  };
