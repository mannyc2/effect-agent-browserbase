/** A bounded window of a page's events, visible changes and frames on the owning clock. */
import { Schema } from "effect";

import { BrowserError } from "./BrowserError.ts";
import { BrowserEvent } from "./BrowserEvent.ts";
import { Changes } from "./Change.ts";
import { Frame } from "./Frame.ts";

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
