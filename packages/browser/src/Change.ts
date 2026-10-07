/**
 * What visibly changed on a page over a window: text in view that changed, appeared, disappeared
 * or came and went, a field's value and the document's title, each with what it said at the start
 * of the window and at its end.
 *
 * The library's page script keeps a record of a document's main frame from the first time it is
 * asked for changes, so `Changes.from` says where the record is whole. It keeps up to 256 elements
 * and each one's last 32 changes for a minute; on a page busier than that, an element that keeps
 * changing gives way to news, and `Changes.truncated` counts what was not kept. A change counts as
 * visible when what changed was in the viewport as the page rendered it, so a change scrolled away
 * later is still told and one made out of view is not. What the script cannot read is not seen:
 * pictures, a canvas, frames, shadow roots, SVG, and anything shown or hidden by CSS alone, such as
 * a class that reveals a toast.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import { Subject } from "./BrowserEvent.ts";

/** `brief` is something that appeared and was gone again by the end of the window. */
export const Kind = Schema.Literals(["text", "appeared", "disappeared", "brief", "value", "title"]);

export type Kind = typeof Kind.Type;

/** Words around a change that say what it is; none for values and titles. */
export class Context extends Schema.Class<Context>("effect-browser/Change/Context")({
  /** A table cell's row, named by its first cell. */
  row: Schema.optional(Schema.String),
  /** A table cell's column, named by its header. */
  column: Schema.optional(Schema.String),
  /** The words just before it in its row, item or block, such as a label. */
  beside: Schema.optional(Schema.String),
  /** The heading above it. */
  heading: Schema.optional(Schema.String),
}) {}

export class Change extends Schema.Class<Change>("effect-browser/Change")({
  /** When it last changed in the window, in host monotonic milliseconds on the browser’s clock. */
  at: Schema.Finite,
  /** When it first changed in the window. */
  startedAt: Schema.Finite,
  kind: Kind,
  /**
   * What changed, as the page names it. An element's own words are what changed, so its name is
   * empty unless something else names it, such as a field's label.
   */
  subject: Subject,
  context: Context,
  /**
   * What it said at the start of the window; absent for what appeared, and when the record let
   * that go. What disappeared says what it said as it went. A secret field reads `••••`.
   */
  before: Schema.optional(Schema.String),
  /** What it said at the end of the window; absent for what disappeared. What came and went says what it showed. */
  after: Schema.optional(Schema.String),
  /** How many times it changed in the window. */
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  /**
   * When it last changed before the window, as far back as the record keeps; absent when it had
   * not. An element that was changing before is in flux rather than news.
   */
  earlier: Schema.optional(Schema.Finite),
}) {}

export class Changes extends Schema.Class<Changes>("effect-browser/Changes")({
  /** Where the record is whole: changes before it, if any, are unknown. */
  from: Schema.Finite,
  /** Where the window ends. */
  at: Schema.Finite,
  /** Changes in the window the record did not keep, at least; 0 when it kept them all. */
  truncated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Oldest first, by when each began to change. */
  changes: Schema.Array(Change),
}) {}
