/**
 * The page implementation behind `Page.Page`. `Browser` constructs pages and owns the state they
 * share (the browser-wide input lock, clock mapping, pointer and event publication), so
 * construction stays internal. A page is assembled here from its domains: the script bridge,
 * pictures, reading, input and navigation.
 */
import { Duration, Effect, Semaphore } from "effect";

import { Timeout } from "../../BrowserError.ts";
import type { Page } from "../../Page.ts";
import * as Actions from "../input/actions.ts";
import * as Pictures from "../pictures/pictures.ts";
import * as Reading from "../reading/reading.ts";
import * as Bridge from "./bridge.ts";
import * as Context from "./context.ts";
import * as Navigation from "./navigation.ts";
import * as Viewport from "./viewport.ts";

export const make = Effect.fnUntraced(function* (options: Context.MakeOptions) {
  const page = Context.make(options, yield* Semaphore.make(1));
  const { id, playwright, settings, native, owned } = page;
  const bridge = yield* Bridge.make(page);
  const viewport = Viewport.make(page, bridge);
  const calibrateClock = Pictures.calibrator(page, bridge);
  const input = Actions.make(page, bridge, viewport, calibrateClock);
  const pictures = yield* Pictures.make(page, viewport, calibrateClock);
  const reading = yield* Reading.make(page, bridge, pictures.screenshot);
  const navigation = Navigation.make(page, input.perform, input.preparePolicy);
  const { capture } = pictures;

  const assembled: Page = {
    id,
    playwright,
    url: Effect.sync(() => playwright.url()),
    title: native("title", () => playwright.title()),
    goto: navigation.goto,
    back: navigation.back,
    reload: navigation.reload,
    bringToFront: native("bringToFront", () => playwright.bringToFront()),
    close: Effect.tryPromise(() => playwright.close()).pipe(Effect.ignore),
    snapshot: reading.snapshot,
    screenshot: pictures.screenshot,
    currentFrame: pictures.currentFrame,
    zoom: pictures.zoom,
    viewport: viewport.viewportFor("viewport").pipe(
      Effect.timeoutOrElse({
        duration: settings.actionTimeout,
        orElse: () =>
          Context.failWith(
            "viewport",
            new Timeout({ millis: Duration.toMillis(settings.actionTimeout) }),
          ),
      }),
      owned,
    ),
    observe: reading.observe,
    find: reading.find,
    text: reading.text,
    click: input.click,
    hover: input.hover,
    drag: input.drag,
    type: input.type,
    press: input.press,
    scroll: input.scroll,
    select: input.select,
    waitForText: reading.waitForText,
    waitForStill: Pictures.waitForStill(page, capture),
    screencast: capture.stream,
    captureStats: capture.stats,
    latestFrame: capture.latest,
    recentFrames: capture.recent,
    recentEvents: options.recentEvents,
  };

  return assembled;
});
