/**
 * A page's own time, held and stepped, so what the page does by itself happens at times a caller
 * chooses: a visual test takes a transition at exactly 120 ms, a test skips a 30 second countdown
 * in one step, a recording's page moves one frame's worth per frame however long each takes.
 *
 * A browser opened with `pageTime` runs a page clock in each top document's main world, before
 * the page's own scripts. Until `Page.hold`, it keeps real time. Held, the page's timers and
 * intervals, its animation frames, `performance.now`, `Date.now`, `new Date()` and `Date()`, and
 * its CSS transitions, CSS animations and Web Animations stand still, and each `advance` runs what
 * falls due in time order, each timer at its own time, and then one animation frame at its end.
 * An animation the page starts while held starts at the page time it is held at. Workers, media,
 * `requestIdleCallback`, `MessageChannel`, events' `timeStamp` and frames' own documents keep real
 * time. A clock that has been held is a page script's to notice: it replaces those globals.
 *
 * Loading takes real time: a document that replaces a held one starts on real time, and is held
 * from the next `advance`. When the hold's scope closes, page time carries on from where it was,
 * never back, and what was left of each timer and frame runs in real time. `ready` and stillness
 * count an animation held part way as still running.
 *
 * @since 0.3.0
 */
import type { Duration, Effect } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import type { Point } from "./Geometry.ts";
import type { Content } from "./Overlay.ts";
import type { Pose } from "./Pose.ts";

/** What else changes with page time in the same call to the page. */
export interface Step {
  /** Scroll the document to this many CSS pixels down it first, at once. */
  readonly scroll?: number | undefined;
  /** Then pose these elements and take the pose off any other, as `Poses.set` does; the page's poses must be open. */
  readonly poses?: ReadonlyArray<Pose> | undefined;
  /** Then show this in the page's overlay, which must be open. */
  readonly overlay?: Content | undefined;
}

export interface Held {
  /**
   * Move page time on by `by`, in one call to the page, after the actions asked before it. Says
   * where the document is scrolled to after it.
   */
  readonly advance: (by: Duration.Input, step?: Step) => Effect.Effect<Point, BrowserError>;
  /** How far this hold has moved page time, across the documents it held. */
  readonly elapsed: Effect.Effect<Duration.Duration>;
}
