/**
 * The page implementation behind `Page.Page`. `Browser` constructs pages and owns the state they
 * share (the browser-wide input lock, clock mapping, pointer and event publication), so
 * construction stays internal. A page is assembled here from its domains: the script bridge,
 * pictures, reading, input and navigation.
 */
import { Effect, Semaphore } from "effect";

import type { Page } from "../../Page.ts";
import * as Actions from "../input/actions.ts";
import * as Pictures from "../pictures/pictures.ts";
import * as Reading from "../reading/reading.ts";
import * as Ready from "../reading/ready.ts";
import * as Changes from "../timeline/changes.ts";
import * as Bridge from "./bridge.ts";
import * as Context from "./context.ts";
import * as Navigation from "./navigation.ts";
import * as Url from "./url.ts";
import * as Viewport from "./viewport.ts";

export const make = Effect.fnUntraced(function* (options: Context.MakeOptions) {
  const page = Context.make(options, yield* Semaphore.make(1));
  const { id, playwright, native, owned, within } = page;
  const bridge = yield* Bridge.make(page);
  const viewport = Viewport.make(page, bridge);
  const input = Actions.make(page, bridge, viewport);
  const pictures = yield* Pictures.make(page, bridge, viewport);
  const reading = yield* Reading.make(page, bridge, () => pictures.screenshot());
  const navigation = Navigation.make(page, input.perform, input.preparePolicy);
  const { capture } = pictures;

  const assembled: Page = {
    id,
    playwright,
    url: Effect.sync(() => Url.redact(playwright.url())),
    title: native("title", () => playwright.title()),
    goto: navigation.goto,
    back: navigation.back,
    reload: navigation.reload,
    bringToFront: native("bringToFront", () => playwright.bringToFront()),
    // Playwright answers once the page has closed, and at once for one already closed.
    close: native("close", () => playwright.close()),
    snapshot: reading.snapshot,
    screenshot: pictures.screenshot,
    frame: pictures.frame,
    zoom: pictures.zoom,
    viewport: viewport.viewportFor("viewport").pipe(within("viewport"), owned),
    observe: reading.observe,
    find: reading.find,
    text: reading.text,
    changes: Changes.make(page, bridge, pictures.estimate),
    click: input.click,
    hover: input.hover,
    drag: input.drag,
    type: input.type,
    press: input.press,
    scroll: input.scroll,
    select: input.select,
    waitForText: reading.waitForText,
    ready: Ready.make(page, bridge, capture),
    screencast: capture.stream,
    captureStats: pictures.captureStats,
    latestFrame: capture.latest,
    recentFrames: capture.recent,
    recentEvents: options.recentEvents,
  };

  return assembled;
});
