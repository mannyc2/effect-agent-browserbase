/**
 * The page implementation behind `Page.Page`. `Browser` constructs pages and owns the state they
 * share (the clock mapping and event publication), so construction stays internal. A page is
 * assembled here from its domains: the script bridge, pictures, reading, its timeline, input and
 * navigation.
 * Features use the same documented Page contract as consumers.
 */
import { Effect, Option } from "effect";

import * as ActionPort from "../../ActionPort.ts";
import type { Frame } from "../../Frame.ts";
import { type Page, State } from "../../Page.ts";
import * as Url from "../../Url.ts";
import * as Actions from "../input/actions.ts";
import * as Pictures from "../pictures/pictures.ts";
import * as Reading from "../reading/reading.ts";
import * as Ready from "../reading/ready.ts";
import * as Changes from "../timeline/changes.ts";
import * as Window from "../timeline/window.ts";
import * as Bridge from "./bridge.ts";
import * as Context from "./context.ts";
import * as Navigation from "./navigation.ts";
import * as Scripts from "./scripts.ts";
import * as Viewport from "./viewport.ts";

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
  const viewports = lane.shared<Effect.Success<Page["viewport"]>>("viewport", true);

  // What the page's parts already know, asking it nothing: its documents as its own session saw
  // them, the newest frame, and the viewport's text as last read since the document began.
  const state = Effect.map(capture.latest, (latest) => {
    const { document, url } = bridge.frameTag();
    const committedAt = page.activity.documentAt;

    return new State({
      page: id,
      connection: page.connection,
      at: page.now(),
      url,
      document,
      committedAt: Number.isFinite(committedAt) ? committedAt : undefined,
      load: bridge.loaded(),
      frame: Option.getOrUndefined(latest),
      text: reading.viewedSince(committedAt),
    });
  });

  const current = (frame: Frame) =>
    capture.current(frame) &&
    bridge.frameTag().document === frame.document &&
    frame.hostTime - frame.timing.uncertaintyMillis > page.activity.documentAt;

  const afterInput: Page["afterInput"] = (effect) =>
    lane
      .read(
        "inputEnded",
        page.settings.navigationTimeout,
      )(Effect.andThen(input.perform.idle, effect))
      .pipe(within("inputEnded", page.settings.navigationTimeout), owned);

  const confirm = (frame: Frame) =>
    native("shown", () => page.protocol.send("Page.getFrameTree")).pipe(
      Effect.flatMap(() => capture.confirm(frame)),
      Effect.map((confirmed) => confirmed && current(frame)),
      within("shown", "2 seconds"),
      owned,
    );

  const perform = ActionPort.checked((action) =>
    ActionPort.execute({ ...input, ...navigation }, action),
  );

  const assembled: Page = {
    ...Scripts.make(page, bridge, input),
    ...ActionPort.methods(perform),
    perform,
    clock: page.clock,
    afterInput,
    until: reading.until,
    capture: (options) =>
      capture.open(options).pipe(
        Effect.map((lease) => ({
          ...lease,
          isCurrent: current,
          confirm,
          sync: capture.sync,
          stats: pictures.captureStats,
        })),
      ),
    id,
    url: Effect.sync(() => Url.redact(playwright.url())),
    title: titles("", navigation.title.pipe(within("title"))).pipe(span("Page.title"), owned),
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
    ready: Ready.make(page, bridge),
    screencast: capture.stream,
    captureStats: pictures.captureStats,
    recentFrames: capture.recent,
    recentEvents: options.recentEvents,
  };

  return assembled;
});
