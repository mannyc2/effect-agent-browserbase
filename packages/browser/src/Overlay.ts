/**
 * A layer over a page that the library draws a caller's content into, without knowing what it
 * shows: a pointer, a ring round what an agent is about to press, a caption, a character. It shows
 * in screenshots, screencasts and a live view alike. The library's own readers never read it:
 * `find`, `snapshot`, `layout`, `text`, `changes`, `ready` and stillness see the page as if it
 * were not there, and input passes through it to the page.
 *
 * A page has one overlay at a time, for a scope. It sits above the page's own layers but beneath
 * its top layer (a modal dialog, a popover), in viewport CSS pixels, and undoes a zoom the page
 * sets on its root. Each new document starts without it, and it is drawn again there, with what
 * it last showed, once the document has loaded. It is gone when its scope closes.
 *
 * @stability stable
 * @since 0.3.0
 */
import { type Effect, Schema } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import type { Box } from "./BrowserEvent.ts";

/**
 * What the overlay shows. `Svg` is an SVG document sized to the viewport, whose own `viewBox` maps
 * any design space onto it; its scripts and event handlers are dropped. `Empty` shows nothing.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const Content = Schema.TaggedUnion({
  Svg: { markup: Schema.String },
  Empty: {},
});

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Content = typeof Content.Type;

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Overlay {
  /**
   * Show `content` in place of what was shown, in one call to the page, after the actions asked
   * before it. Says where the drawing's top-level parts are, in viewport CSS pixels.
   */
  readonly draw: (content: Content) => Effect.Effect<ReadonlyArray<Box>, BrowserError>;
}
