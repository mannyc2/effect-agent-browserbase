/** A bounded window of a page's events, visible changes and frames on the owning clock. */
import { type Duration, type Effect, Function, Schema } from "effect";

import { BrowserError } from "./BrowserError.ts";
import { BrowserEvent } from "./BrowserEvent.ts";
import { Changes } from "./Change.ts";
import { Frame } from "./Frame.ts";
import { functionsOf } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";

/** A page's events, changes and frames over one window of its browser's host clock. */
export class Window extends Schema.Class<Window>("effect-browser/Window")({
  page: Schema.String,
  /** Where the window starts, in host monotonic milliseconds on the owning browser’s clock. */
  since: Schema.Finite,
  /** Where it ends, never after it was taken. */
  until: Schema.Finite,
  /** The page's events after `since`, up to `until`, oldest first, without the input presentation track. */
  events: Schema.Array(BrowserEvent),
  /**
   * What visibly changed after `since`, up to `until`; absent where `missing` says why. A page's
   * first window starts its record, so the record sees none of it.
   */
  changes: Schema.optional(Changes),
  /** Screencast frames painted from `since` to `until`, oldest first, as far back as kept. */
  frames: Schema.Array(Frame),
  /**
   * Why each part that could not be read is missing: the read of its changes, by whatever
   * operation failed there, or a moment's picture (`frame`) or outline (`snapshot`).
   */
  missing: Schema.Array(BrowserError),
}) {}

/** The window `read` reads, and whether to show what fields hold. */
export interface WindowOptions {
  /**
   * Where the window starts: a previous window, to continue exactly where it ended; a frame, at its
   * paint; host monotonic milliseconds; or a `Duration` back from `until`. A start after `until`
   * leaves the window empty there.
   */
  readonly since: Window | Frame | Duration.Duration | number;
  /**
   * Where it ends: a frame, at its paint, such as one a delayed consumer airs now; or host
   * monotonic milliseconds. Defaults to now, and is never later.
   */
  readonly until?: Frame | number | undefined;
  /** Show what fields hold in its changes; a secret field still reads `••••`. Defaults to false. */
  readonly unmask?: boolean | undefined;
}

/**
 * The page's events, changes and frames over a window: the frames and events it keeps, at no
 * call, and its changes, in one call, the first starting its record as `Change.read` does. A part
 * that cannot be read is missing, with why; the window fails only for bounds that are not finite.
 */
export const read: {
  (options: WindowOptions): (page: Page) => Effect.Effect<Window, BrowserError>;
  (page: Page, options: WindowOptions): Effect.Effect<Window, BrowserError>;
} = Function.dual(2, (page: Page, options: WindowOptions) => functionsOf(page).window(options));
