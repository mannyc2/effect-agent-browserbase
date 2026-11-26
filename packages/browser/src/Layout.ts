/**
 * Where things are on a page, as data: a box for each thing a caller picks, in the viewport and in
 * the document, unrounded, with the boxes of words inside it, and the viewport, scroll and scale
 * read with them in one call. A rehearsal measures things that exist only after an interaction,
 * and puts the page back.
 *
 * @stability stable
 * @since 0.3.0
 */
import { Effect, Exit, Function, Schema } from "effect";

import type { Action } from "./Action.ts";
import type { BrowserError } from "./BrowserError.ts";
import { Box, Subject } from "./BrowserEvent.ts";
import { Point } from "./internal/geometry.ts";
import { functionsOf } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";
import type { FindQuery } from "./Snapshot.ts";

/**
 * A match of a pick's `words`, by its box in the viewport and in the document.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Word extends Schema.Class<Word>("effect-browser/Layout/Word")({
  text: Schema.String,
  box: Box,
  page: Box,
}) {}

/**
 * What one pick found.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Place extends Schema.Class<Place>("effect-browser/Layout/Place")({
  /** The pick's own name. */
  id: Schema.String,
  ref: Schema.String,
  subject: Subject,
  /** Its box in viewport CSS pixels, unrounded, as an `at` point or a frame's pixels place it. */
  box: Box,
  /** The same box in document CSS pixels: `box` moved by the scroll it was read at. */
  page: Box,
  /** It keeps its place in the viewport as the page scrolls, so `page` holds only at this scroll. */
  fixed: Schema.Boolean,
  /** The matches of the pick's `words`, when it gave them, in text order. */
  words: Schema.optional(Schema.Array(Word)),
}) {}

/**
 * A page's picked places, and the viewport, scroll and scale they were read at.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Layout extends Schema.Class<Layout>("effect-browser/Layout")({
  page: Schema.String,
  /** The tracking connection that owns the document counter. */
  connection: Schema.String,
  /** The document it read, as `Navigated` counts them. */
  document: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  url: Schema.String,
  /** Host monotonic milliseconds, when it was read. */
  at: Schema.Finite,
  /** The viewport's size in CSS pixels. */
  viewport: Schema.Struct({ width: Schema.Finite, height: Schema.Finite }),
  /** How far the document was scrolled, in CSS pixels. */
  scroll: Point,
  /** Device pixels to a CSS pixel: a `scale: "device"` picture's pixels per CSS pixel. */
  scale: Schema.Finite,
  /** One for each pick that found something, in the order the picks were given. */
  places: Schema.Array(Place),
  /** The picks that found nothing. */
  missing: Schema.Array(Schema.String),
}) {}

/**
 * A `Snapshot.find` query that names one thing. Its scope defaults to the whole document. Every
 * element it finds is a candidate, and `choose` takes one: the first in tree order (the default),
 * the last, or the smallest or largest by area. With a selector, the candidates are what it
 * selects that shows and meets the other rules, a drawing's elements among them, which
 * `Snapshot.find` leaves out.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Pick extends FindQuery {
  readonly choose?: "first" | "last" | "smallest" | "largest" | undefined;
  /**
   * Words to box inside it: text, found ignoring case, or a pattern; each match gets its own box,
   * across the elements the text is split into. At most 200 for a pick.
   */
  readonly words?: string | RegExp | undefined;
}

/**
 * Picks by the names their places will carry.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Picks = Readonly<Record<string, Pick>>;

/**
 * Where each pick is, in one call to the page: its box unrounded, in the viewport and in the
 * document, the boxes of words in it, and the viewport, scroll and scale they were read at. A
 * pick that finds nothing is listed as missing, not a failure.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const measure: {
  (picks: Picks): (page: Page) => Effect.Effect<Layout, BrowserError>;
  (page: Page, picks: Picks): Effect.Effect<Layout, BrowserError>;
} = Function.dual(2, (page: Page, picks: Picks) => functionsOf(page).layout(picks));

/**
 * The place a pick named, if it found one.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const place = (layout: Layout, id: string): Place | undefined =>
  layout.places.find((each) => each.id === id);

/**
 * What a rehearsal does, measures, and does to put the page back.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Rehearsal {
  readonly act: ReadonlyArray<Action>;
  readonly picks: Picks;
  readonly undo: ReadonlyArray<Action>;
}

/**
 * Measure what exists only after an interaction: perform `act`, wait for the page to be ready,
 * read the layout, then perform `undo`, which runs whether or not acting and reading succeeded,
 * and is not interrupted. A failure to act or read is the rehearsal's; otherwise one to undo is.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const rehearse = (page: Page, rehearsal: Rehearsal): Effect.Effect<Layout, BrowserError> =>
  Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const measured = yield* Effect.exit(
        restore(
          Effect.forEach(rehearsal.act, page.perform, { discard: true }).pipe(
            Effect.andThen(page.ready()),
            Effect.andThen(measure(page, rehearsal.picks)),
          ),
        ),
      );

      const undone = yield* Effect.exit(
        Effect.forEach(rehearsal.undo, page.perform, { discard: true }),
      );

      return yield* Exit.isFailure(measured) || Exit.isSuccess(undone)
        ? measured
        : Exit.failCause(undone.cause);
    }),
  );
