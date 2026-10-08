/**
 * The page implementation behind `Page.Page`. `Browser` constructs pages and owns the state they
 * share (the clock mapping and event publication), so construction stays internal. A page is
 * assembled here from its domains: the script bridge, pictures, reading, its timeline, input and
 * navigation.
 * What a presenter and a stage need of a page, and no caller should, it keeps out of sight.
 */
import { type Effect as Eff, Effect, Option } from "effect";

import type { BrowserError } from "../../BrowserError.ts";
import { type Page, State } from "../../Page.ts";
import * as Actions from "../input/actions.ts";
import * as Pictures from "../pictures/pictures.ts";
import * as Reading from "../reading/reading.ts";
import * as Ready from "../reading/ready.ts";
import * as Changes from "../timeline/changes.ts";
import * as Window from "../timeline/window.ts";
import * as Bridge from "./bridge.ts";
import * as Context from "./context.ts";
import * as Navigation from "./navigation.ts";
import * as Url from "./url.ts";
import * as Viewport from "./viewport.ts";

export interface Internals {
  /** The page's input, in any style. */
  readonly input: Actions.Input;
  /** Completes once the input asked of the page so far has ended, failing `Busy` if it lasts. */
  readonly inputEnded: Eff.Effect<void, BrowserError>;
  /** The page's documents so far, counted as `Navigated` counts them. */
  readonly document: () => number;
}

/** A page this library built: it keeps its internals where only this module reaches them. */
class Built {
  readonly #internals: Internals;

  constructor(internals: Internals) {
    this.#internals = internals;
  }

  static internalsOf(page: Page): Internals | undefined {
    return page instanceof Built ? page.#internals : undefined;
  }
}

/** What a page this library built keeps out of sight; nothing for any other `Page`. */
export const internalsOf = (page: Page) => Built.internalsOf(page);

export const make = Effect.fnUntraced(function* (options: Context.MakeOptions) {
  const page = Context.make(options, yield* Effect.scope);
  const { id, playwright, native, owned, within, lane, span } = page;
  const bridge = yield* Bridge.make(page);
  const viewport = Viewport.make(page, bridge);
  const input = Actions.make(page, bridge, viewport);
  const pictures = yield* Pictures.make(page, bridge, viewport);
  const reading = yield* Reading.make(page, bridge);
  const navigation = Navigation.make(page, input.perform, input.preparePolicy);
  const { capture } = pictures;
  const changes = Changes.make(page, bridge, pictures.estimate);
  const titles = lane.shared<string>("title", true);

  const viewports = lane.shared<{ readonly width: number; readonly height: number }>(
    "viewport",
    true,
  );

  // What the page's parts already know, asking it nothing: its documents as its own session saw
  // them, the newest frame, and the viewport's text as last read since the document began.
  const state = Effect.map(capture.latest, (latest) => {
    const { document, url } = bridge.frameTag();
    const committedAt = page.activity.documentAt;

    return new State({
      page: id,
      at: page.now(),
      url,
      document,
      committedAt: Number.isFinite(committedAt) ? committedAt : undefined,
      load: bridge.loaded(),
      frame: Option.getOrUndefined(latest),
      text: reading.viewedSince(committedAt),
    });
  });

  const assembled: Page = {
    id,
    playwright,
    url: Effect.sync(() => Url.redact(playwright.url())),
    title: titles("", navigation.title.pipe(within("title"))).pipe(span("Page.title"), owned),
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
    viewport: viewports("", viewport.viewportFor("viewport").pipe(within("viewport"))).pipe(
      span("Page.viewport"),
      owned,
    ),
    find: reading.find,
    text: reading.text,
    changes,
    window: Window.make(page, changes, capture.recent),
    state,
    click: (target, options) => input.click(target, options),
    hover: (target) => input.hover(target),
    drag: (from, to) => input.drag(from, to),
    type: (text, options) => input.type(text, options),
    press: (keys, options) => input.press(keys, options),
    scroll: (options) => input.scroll(options),
    select: input.select,
    waitForText: reading.waitForText,
    ready: Ready.make(page, bridge, capture),
    screencast: capture.stream,
    captureStats: pictures.captureStats,
    recentFrames: capture.recent,
    recentEvents: options.recentEvents,
  };

  const internals: Internals = {
    input,
    inputEnded: lane.read("inputEnded")(Effect.void).pipe(owned),
    document: () => bridge.frameTag().document,
  };

  return Object.assign(new Built(internals), assembled);
});
