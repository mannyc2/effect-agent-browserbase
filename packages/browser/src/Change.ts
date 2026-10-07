/**
 * What visibly changed on a page: text in view that changed, appeared or disappeared, a field's
 * value and the document's title, each with what it said before and after.
 *
 * The library's page script notes changes in a page's main document from the first time the
 * library reads or acts on that document, so a new document's earliest changes can be missing;
 * `Changes.from` says where the record is whole. Changes settle into bursts: a value that ticks
 * several times within a moment of quiet is one change with a `count`. What the script cannot
 * read is not seen: pictures, a canvas, frames, shadow roots and SVG.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import { Subject } from "./BrowserEvent.ts";

export const Kind = Schema.Literals(["text", "appeared", "disappeared", "value", "title"]);

export type Kind = typeof Kind.Type;

export class Change extends Schema.Class<Change>("effect-browser/Change")({
  /** When it last changed, in host monotonic milliseconds on the owning browser’s clock. */
  at: Schema.Finite,
  /** When the burst began; the same as `at` for a single change. */
  startedAt: Schema.Finite,
  kind: Kind,
  /**
   * What changed, as the page names it. An element's own words are what changed, so its name is
   * empty unless something else names it, such as a field's label. A disappearance names the
   * element it left.
   */
  subject: Subject,
  /**
   * Words around it that say what it is, such as its table row and column, the text just before
   * it and the heading above it. Empty when there are none, and for values and titles.
   */
  context: Schema.String,
  /** What it said before; absent when unknown and for what appeared. A secret field reads `••••`. */
  before: Schema.optional(Schema.String),
  /** What it says now; absent for what disappeared. */
  after: Schema.optional(Schema.String),
  /** How many changes the burst gathered. */
  count: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

export class Changes extends Schema.Class<Changes>("effect-browser/Changes")({
  /** Where the record is whole: changes before it, if any, are unknown. */
  from: Schema.Finite,
  /** When the page was read. */
  at: Schema.Finite,
  /** Oldest first. */
  changes: Schema.Array(Change),
}) {}
