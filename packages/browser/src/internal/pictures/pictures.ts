/**
 * Pictures of a page: screenshots, frames of a stated age, zooms, and its screencast with the clock
 * that times its frames. A new picture is taken on the page's own protocol session: one call where
 * a device pixel is a CSS pixel and nothing is cropped, and two otherwise, unless Playwright
 * emulates the viewport.
 */
import { Duration, Effect, Option, Schedule, Schema } from "effect";

import { BrowserError, Failed, InvalidRequest } from "../../BrowserError.ts";
import { Frame, Image, Screenshot } from "../../Frame.ts";
import { type FrameOptions, Region, type ScreenshotOptions, Zoom } from "../../Page.ts";
import type { Bridge } from "../page/bridge.ts";
import { decodeWith, failWith, type PageContext, reasonOf, undispatched } from "../page/context.ts";
import type { Viewport } from "../page/viewport.ts";
import * as Capture from "./capture.ts";
import * as BrowserClock from "./clock.ts";
import * as Transport from "./transport.ts";

interface Size {
  readonly width: number;
  readonly height: number;
}

/** Read a JPEG's dimensions from its start-of-frame marker. */
export const jpegSize = (bytes: Uint8Array): Size | undefined => {
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

// The part of `Page.getLayoutMetrics` a clip needs: the visual viewport's place in the document and
// its pinch scale, and the content's size in device and CSS pixels, whose ratio is the device's.
const LayoutMetrics = Schema.Struct({
  cssVisualViewport: Schema.Struct({
    pageX: Schema.Finite,
    pageY: Schema.Finite,
    scale: Schema.Finite.check(Schema.isGreaterThan(0)),
  }),
  contentSize: Schema.Struct({ width: Schema.Finite }),
  cssContentSize: Schema.Struct({ width: Schema.Finite }),
});

// A screencast frame shows the page as it was when it was painted, and a new picture costs a round
// trip, so by default a frame painted this recently is reused.
const defaultMaxAge = Duration.millis(250);

// Chromium answers this while the page has no surface to copy yet, as just after a navigation. The
// page has one from its first frame, so the picture is taken again a frame later, within the
// picture's own deadline.
const surfaceless = (error: BrowserError) =>
  error.reason._tag === "Failed" && error.reason.detail.includes("Unable to capture screenshot");

const untilPainted = <A, R>(capture: Effect.Effect<A, BrowserError, R>) =>
  capture.pipe(Effect.retry({ while: surfaceless, schedule: Schedule.spaced("16 millis") }));

/**
 * Measure this page's clock against the browser's, in a world without the page script: no DOM
 * markers, input, navigation or extra tabs. Each of three probes reads the browser's time between
 * two stamps of the owner's clock, and the fastest bounds the offset best. A busy page answers each
 * probe late, behind its own work, so the probes that answered within two seconds serve, and the
 * measurement fails only if none did: a wide estimate keeps a capture going, and a renewal while
 * its frames flow narrows it.
 */
const calibrator = (page: PageContext, bridge: Bridge) => {
  const { native, now, within } = page;
  const { send } = page.protocol;

  // A round trip to the page like any other read, so traced as one.
  const probe = (contextId: number) =>
    Effect.gen(function* () {
      const hostStart = now();

      const { result, exceptionDetails } = yield* native("calibrate", () =>
        send("Runtime.evaluate", {
          contextId,
          expression: "performance.timeOrigin + performance.now()",
          returnByValue: true,
        }),
      ).pipe(page.span("Page.evaluate", { function: "clock" }, "Trace"));

      const hostEnd = now();
      const browserTime: unknown = result.value;

      if (exceptionDetails !== undefined || typeof browserTime !== "number")
        return yield* failWith(
          "calibrate",
          new Failed({ detail: "the browser clock probe did not return a timestamp" }),
        );

      return { hostStart, hostEnd, browserTime };
    });

  const answered = (contextId: number) =>
    Effect.gen(function* () {
      const probes: Array<BrowserClock.Probe> = [];

      yield* Effect.forEach(
        [1, 2, 3],
        () => Effect.map(probe(contextId), (one) => probes.push(one)),
        {
          discard: true,
        },
      ).pipe(
        within("calibrate", Duration.seconds(2)),
        Effect.catch((error) => (probes.length === 0 ? Effect.fail(error) : Effect.void)),
      );

      return probes;
    });

  return bridge.bareWorld("calibrate").pipe(
    Effect.flatMap(answered),
    Effect.flatMap((probes) =>
      Option.match(BrowserClock.estimate(probes), {
        onNone: () =>
          failWith(
            "calibrate",
            new Failed({ detail: "the browser clock probes did not define a finite interval" }),
          ),
        onSome: Effect.succeed,
      }),
    ),
    within("calibrate", Duration.seconds(4)),
    // The fastest probe's round trip: the transport's, plus a trivial script.
    Effect.tap((estimate) =>
      Effect.annotateCurrentSpan("roundTripMillis", Math.round(estimate.roundTripMillis * 10) / 10),
    ),
    page.span("Page.calibrateClock", {}, "Debug"),
    page.owned,
  );
};

// A new picture in CSS pixels. Where a device pixel is not a CSS pixel, or for a crop, it is
// Playwright's clip over fresh layout metrics: document coordinates from the visual viewport's
// place, and its pinch scale divided by the device's. Chromium draws such a capture into a
// running screencast, so the capture leaves out what is painted meanwhile.
const camera = (page: PageContext, viewport: Viewport, capture: Capture.Controller) => {
  const { playwright, settings, native, within } = page;
  const { send } = page.protocol;
  const actionMillis = Duration.toMillis(settings.actionTimeout);
  // Device pixels per CSS pixel, as the page's layout metrics last gave it. A picture taken in one
  // call is checked by its size, so a page whose ratio changes is measured again.
  let ratio = 1;

  const decoded = (operation: string, data: Uint8Array) => {
    const size = jpegSize(data);

    return size === undefined
      ? failWith(operation, new Failed({ detail: "the browser's picture is not a JPEG" }))
      : Effect.succeed(new Image({ data, mediaType: "image/jpeg", ...size }));
  };

  const jpeg = (
    operation: string,
    quality: number,
    clip?: Size & { readonly x: number; readonly y: number; readonly scale: number },
  ) =>
    native(operation, () =>
      send("Page.captureScreenshot", {
        format: "jpeg",
        quality,
        ...(clip === undefined ? {} : { clip }),
      }),
    ).pipe(
      untilPainted,
      Effect.flatMap(({ data }) => decoded(operation, Buffer.from(data, "base64"))),
    );

  // Playwright's own picture, taken on the session where it emulates the viewport.
  const emulatedJpeg = (operation: string, quality: number, crop?: Region) =>
    native(
      operation,
      () =>
        playwright.screenshot({
          type: "jpeg",
          quality,
          scale: "css",
          timeout: actionMillis,
          ...(crop === undefined ? {} : { clip: crop }),
        }),
      actionMillis,
    ).pipe(
      untilPainted,
      Effect.flatMap((data) => decoded(operation, data)),
    );

  return (operation: string, quality: number, crop?: Region) =>
    Effect.gen(function* () {
      const known = viewport.knownViewport();
      let whole: Image | undefined;

      if (crop === undefined && ratio === 1) {
        whole = yield* jpeg(operation, quality);
        if (whole.width === known?.width && whole.height === known.height) return whole;
      }
      // A clipped capture restores its own session's device emulation afterwards, which would
      // clear the viewport Playwright emulates on its session, so there Playwright takes it.
      const emulated = playwright.viewportSize();

      if (emulated !== null) {
        if (whole !== undefined) ratio = whole.width / emulated.width;

        return yield* capture.excluding(emulatedJpeg(operation, quality, crop));
      }

      const metrics = yield* native(operation, () => send("Page.getLayoutMetrics")).pipe(
        Effect.flatMap(decodeWith(operation, LayoutMetrics)),
      );

      const measured = metrics.contentSize.width / metrics.cssContentSize.width;

      ratio = Number.isFinite(measured) && measured > 0 ? measured : 1;
      if (crop === undefined && ratio === 1) {
        const image = whole ?? (yield* jpeg(operation, quality));

        viewport.remember(image);

        return image;
      }
      const rect = crop ?? { x: 0, y: 0, ...(known ?? (yield* viewport.viewportFor(operation))) };
      const { pageX, pageY, scale } = metrics.cssVisualViewport;

      // A crop on this session draws its frames at the crop's own size, so only those leave the
      // capture, and the page's own keep flowing.
      return yield* capture.excluding(
        jpeg(operation, quality, {
          x: pageX + rect.x,
          y: pageY + rect.y,
          width: Math.floor(rect.width / scale + 1e-3),
          height: Math.floor(rect.height / scale + 1e-3),
          scale: scale / ratio,
        }),
        crop !== undefined,
      );
    }).pipe(within(operation));
};

// A duration in milliseconds, or NaN for an input that is no duration.
const millisOf = (input: Duration.Input) =>
  Option.match(Duration.fromInput(input), { onNone: () => Number.NaN, onSome: Duration.toMillis });

// The newest screencast frame, if it shows the page as the caller asked: painted at most `maxAge`
// ago at the earliest its timing allows, after the current document began, and with
// `after: "input"` after the page's latest input while no action is changing the page. It must
// have the viewport's size, as a new picture would. A screencast sends only changes and can miss a
// final paint, so a frame is only ever as current as its age, and a page that keeps painting while
// the next document loads leaves its own frames newest when the navigation returns.
const reuse =
  (page: PageContext, viewport: Viewport, capture: Capture.Controller) =>
  (operation: string, options: FrameOptions) =>
    Effect.gen(function* () {
      const maxAge = millisOf(options.maxAge ?? defaultMaxAge);

      if (!(maxAge >= 0))
        return yield* failWith(
          operation,
          new InvalidRequest({ detail: "maxAge must be a duration of zero or more" }),
        );
      const latest = yield* capture.latest;
      const known = viewport.knownViewport();
      const { activity } = page;

      return Option.filter(latest, (frame) => {
        const earliest = frame.hostTime - frame.timing.uncertaintyMillis;

        return (
          page.now() - earliest <= maxAge &&
          earliest > activity.documentAt &&
          (options.after !== "input" || (activity.changing === 0 && earliest > activity.inputAt)) &&
          frame.width === known?.width &&
          frame.height === known.height
        );
      });
    });

/** Where a picture came from: a frame the screencast had delivered, or a new screenshot. */
const sourceOf = (reused: Option.Option<Frame>) => (Option.isSome(reused) ? "frame" : "screenshot");

export const make = Effect.fnUntraced(function* (
  page: PageContext,
  bridge: Bridge,
  viewport: Viewport,
) {
  const { id, clock, settings, mapping, now, span, owned, lock, within } = page;
  const calibrateClock = calibrator(page, bridge);

  // A failure from a capture connection is already the capture's own.
  const error = (cause: unknown) =>
    Schema.is(BrowserError)(cause)
      ? cause
      : undispatched("screencast", reasonOf(cause, undefined, page.closedBy()));

  // Input and capture share the owner's monotonic clock; caller-provided clocks cannot move it.
  // Registration measures nothing: a page that is busy while it opens, such as a popup running
  // its first script, must still be tracked. The browser's mapping serves every other page, so
  // only a browser with no estimate yet needs this page's renderer to answer.
  const capture = yield* Capture.make({
    id,
    transport:
      page.capture === undefined
        ? Effect.succeed(Transport.own(page, bridge))
        : Transport.apart(page, bridge, page.capture, error, yield* Effect.scope),
    clock,
    // A capture starts once the page's own session keeps it painting behind other tabs, which a
    // renderer stuck in a script never confirms, and with the browser's clock mapped. Only a
    // browser's first capture waits for a measurement; every frame takes the newest estimate.
    calibrate: page.focused.pipe(within("focus"), Effect.andThen(mapping.current(calibrateClock))),
    latest: mapping.latest,
    // Once the estimate is ten seconds old, the page measures again while its frames flow. A
    // failure there shows in its `Page.calibrateClock` span, and the estimate stays.
    renew: mapping.renew(calibrateClock),
    // Frames are reused only after the current document began, which the page's own session sees
    // only with the Page domain on: a read turns it on, and so does a capture as it starts.
    watch: bridge.currentDocument("screencast"),
    frameHistory: settings.frameHistory,
    viewport: Effect.suspend(() => viewport.viewportFor("screencast")),
    imageSize: jpegSize,
    error,
  });

  const picture = camera(page, viewport, capture);
  const reusable = reuse(page, viewport, capture);

  // A caller that acts and then looks must see what its action did, so a screenshot reuses only a
  // frame painted after the page's latest input.
  const screenshot = (options: ScreenshotOptions = {}) =>
    Effect.gen(function* () {
      const reused =
        options.clip === undefined
          ? yield* reusable("screenshot", { maxAge: options.maxAge, after: "input" })
          : Option.none<Frame>();

      const image = Option.isSome(reused)
        ? reused.value.image
        : yield* picture("screenshot", options.quality ?? 80, options.clip);

      yield* Effect.annotateCurrentSpan({ source: sourceOf(reused), bytes: image.data.length });

      return image;
    }).pipe(span("Page.screenshot"), owned);

  // A new screenshot has no paint time, only the host interval in which it was taken.
  const frame = (options: FrameOptions = {}) =>
    Effect.gen(function* () {
      const reused = yield* reusable("frame", options);

      yield* Effect.annotateCurrentSpan("source", sourceOf(reused));
      if (Option.isSome(reused)) return reused.value;
      const startedAt = now();
      const image = yield* picture("frame", 80);
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
        ...bridge.frameTag(),
      });
    }).pipe(span("Page.frame"), owned);

  const zoom = (requested: Region) =>
    lock
      .withPermits(1)(
        Effect.gen(function* () {
          const region = yield* Schema.decodeEffect(Region)(requested).pipe(
            Effect.mapError((error) =>
              undispatched("zoom", new InvalidRequest({ detail: error.message })),
            ),
          );

          // The viewport's latest known size, as the pictures the region was chosen from had it.
          const size = viewport.knownViewport() ?? (yield* viewport.viewportFor("zoom"));

          if (region.x + region.width > size.width || region.y + region.height > size.height)
            return yield* failWith(
              "zoom",
              new InvalidRequest({ detail: "the crop must fit entirely within the viewport" }),
            );
          const image = yield* picture("zoom", 80, region);

          return new Zoom({ page: id, region, image });
        }),
      )
      .pipe(
        // Waiting behind another operation on this page counts against the deadline too.
        within("zoom"),
        span("Page.zoom"),
        owned,
      );

  const captureStats = (options: { readonly window?: Duration.Input | undefined } = {}) => {
    if (options.window === undefined) return capture.stats();
    const millis = millisOf(options.window);

    return millis > 0 && millis <= Duration.toMillis(Capture.countsKept)
      ? capture.stats(millis)
      : failWith(
          "captureStats",
          new InvalidRequest({ detail: "window must be over zero and at most a minute" }),
        );
  };

  // The browser's clock mapping, measured on this page only while the browser has none, as the
  // change record's times need it.
  const estimate = mapping.current(calibrateClock);

  return { capture, screenshot, frame, zoom, captureStats, estimate };
});
