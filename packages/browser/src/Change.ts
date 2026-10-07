/**
 * What visibly changed on a page over a window: text in view that changed, appeared, disappeared
 * or came and went, a field's value and the document's title, each with what it said at the start
 * of the window and at its end.
 *
 * The library's page script keeps a record of a document's main frame from the first time it is
 * asked for changes, so `Changes.from` says where the record is whole. It keeps up to 256
 * elements and each one's last 32 changes for a minute; on a page busier than that, an element
 * that keeps changing gives way to news, and `Changes.truncated` counts what was not kept. A
 * change counts as visible when what changed was in the viewport as the page rendered it, and
 * neither transparent nor hidden by `visibility`, so a change scrolled away later is still told
 * and one made out of view is not. A removal the record had not watched is judged by what moves
 * into its place, so one out of the flow, or with nothing after it, is not told. Words are what
 * a viewer could read: text inside a hidden part of what changed, or a closed disclosure, is
 * left out, and text whose style must say whether it shows waits until the page has rendered to
 * be told. What changes in a scrolling element just after it scrolled is taken for the scroll,
 * not new content, when it looks like a virtual list: sibling rows showing the words of rows
 * beyond them in the way it scrolled, or new words when it scrolled past them all, or rows
 * swapped for others that arrive on the side it scrolled toward. Those are counted in
 * `Changes.scrolled`, and anything else, such as one price or a new message, is told as ever.
 * Known limits: a list that scrolls with the page itself, or sideways, is not recognised, nor
 * one scrolled down and back within 300 ms; and a re-sort that moves rows the way a list
 * scrolls, such as a leader dropping to last as it scrolls down, or a chat followed down as it
 * adds and trims messages, is taken for the scroll. What the script cannot read is not seen:
 * pictures, a canvas, frames, shadow roots, SVG, and anything shown or hidden by CSS alone, such
 * as a class that reveals a toast.
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
  /** A table cell's table, named by its label, its caption or the heading above it. */
  table: Schema.optional(Schema.String),
  /** A table cell's row, named by its first cell. */
  row: Schema.optional(Schema.String),
  /** A table cell's column, named by its header. */
  column: Schema.optional(Schema.String),
  /** The words just before it in its row, item or block, such as a label. */
  beside: Schema.optional(Schema.String),
  /** The heading above it in the page; none for what is pinned to the viewport, such as a toast. */
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
  /**
   * What it said at the end of the window; absent for what disappeared. What came and went says
   * what it showed.
   */
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
  /** Where the window ends: its `until`, or when the page was read. */
  at: Schema.Finite,
  /**
   * Where the window ends on the page's own clock. Give these changes as the next read's `since`
   * and the two windows meet exactly, so consecutive reads neither miss nor repeat a change.
   */
  cursor: Schema.Finite,
  /** Changes in the window the record did not keep, at least; 0 when it kept them all. */
  truncated: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /**
   * Changes in the window taken for a list's scroll, such as rows a virtual list rewrote or swapped
   * as it scrolled, and so not told.
   */
  scrolled: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Oldest first, by when each began to change. */
  changes: Schema.Array(Change),
}) {}
