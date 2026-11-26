/**
 * Element poses: one of the page's own elements moved, turned and scaled about a point, as a caller
 * says, frame by frame on held time or live, so that the page answers what touches it. A tab
 * squashes under a stomp, a box dips as something lands on it, a button tilts as it is pulled, a
 * field wiggles to ask for input. The library chooses no motion: each pose is a caller's.
 *
 * A pose is plain data, in viewport CSS pixels: moved by `dx` and `dy`, scaled by `sx` and `sy`,
 * and turned `rotate` degrees clockwise, each about `origin`, by default the middle of where the
 * page draws the element. As CSS writes it: `transform-origin: origin; transform: translate(dx, dy)
 * rotate(rotate) scale(sx, sy)`, applied around the element's own transform. Its own `translate`,
 * `rotate` and `scale` properties, which pages seldom set, give way while it is posed.
 *
 * A page's poses are one lease, for a scope; each `set` poses the elements it names and takes the
 * pose off every other, and the scope's end takes them all off. A pose sets no attribute and starts
 * none of the page's transitions, and the library's change record does not report it. Readers
 * report what is drawn: `Layout.measure`, `Snapshot.find` and the input's targets give a posed
 * element's box as posed, and a click lands where it is drawn. Only HTML elements take a pose, and
 * one inside another posed element is posed about its point as if the outer one were not. A new
 * document starts with none.
 *
 * @stability stable
 * @since 0.3.0
 */
import { type Effect, Schema, type Scope } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import { Point } from "./internal/geometry.ts";
import { functionsOf } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";

/**
 * How an element is posed. A part left out changes nothing: no move, a scale of 1, no turn.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export const Pose = Schema.Struct({
  /** The element, by a ref from the page's current document, such as a `Layout` place's. */
  ref: Schema.String,
  dx: Schema.optional(Schema.Finite),
  dy: Schema.optional(Schema.Finite),
  sx: Schema.optional(Schema.Finite),
  sy: Schema.optional(Schema.Finite),
  /** Degrees, clockwise. */
  rotate: Schema.optional(Schema.Finite),
  /** The point it turns and scales about, in the viewport. */
  origin: Schema.optional(Point),
});

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export type Pose = typeof Pose.Type;

/**
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Poses {
  /**
   * Pose these elements, in one call to the page, and take the pose off every other. A ref the
   * document no longer has fails with `StaleRef`, and posing nothing.
   */
  readonly set: (poses: ReadonlyArray<Pose>) => Effect.Effect<void, BrowserError>;
}

/**
 * Pose the page's own elements for the scope, moved, turned and scaled as a caller says, and put
 * back when the scope closes. One lease at a time: a second while one is open fails
 * `InvalidRequest`.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const make = (page: Page): Effect.Effect<Poses, BrowserError, Scope.Scope> =>
  functionsOf(page).poses;
