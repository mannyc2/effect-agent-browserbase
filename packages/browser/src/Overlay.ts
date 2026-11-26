/**
 * A layer over a page that the library draws a caller's content into, without knowing what it
 * shows: a pointer, a ring round what an agent is about to press, a caption, a character. It shows
 * in screenshots, screencasts and a live view alike. The library's own readers never read it:
 * `Snapshot`, `Layout`, `Text`, `Change`, `ready` and stillness see the page as if it were not
 * there, and input passes through it to the page.
 *
 * A page has one overlay at a time, for a scope. It sits above the page's own layers but beneath
 * its top layer (a modal dialog, a popover), in viewport CSS pixels, and undoes a zoom the page
 * sets on its root. Each new document starts without it, and it is drawn again there, with what
 * it last showed, once the document has loaded. It is gone when its scope closes.
 *
 * @since 0.3.0
 */
import { type Effect, type Option, Schema, type Scope } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import type { Box } from "./BrowserEvent.ts";
import { functionsOf } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";

/**
 * What the overlay shows. `Svg` is an SVG document sized to the viewport, whose own `viewBox` maps
 * any design space onto it; its scripts and event handlers are dropped. `Empty` shows nothing.
 */
export const Content = Schema.TaggedUnion({
  Svg: { markup: Schema.String },
  Empty: {},
});

export type Content = typeof Content.Type;

export interface Overlay {
  /**
   * Show `content` in place of what was shown, in one call to the page, after the actions asked
   * before it. Says where the drawing's top-level parts are, in viewport CSS pixels.
   */
  readonly draw: (content: Content) => Effect.Effect<ReadonlyArray<Box>, BrowserError>;
}

/**
 * A layer over the page to draw into, for the scope, that the library's readers never read.
 * One at a time: a second while one is open fails `InvalidRequest`.
 */
export const make = (page: Page): Effect.Effect<Overlay, BrowserError, Scope.Scope> =>
  functionsOf(page).overlay;

/**
 * Where the overlay's drawing was last drawn, in viewport CSS pixels, at no call to the page;
 * none with nothing shown.
 */
export const drawn = (page: Page): Effect.Effect<Option.Option<ReadonlyArray<Box>>> =>
  functionsOf(page).drawn;
