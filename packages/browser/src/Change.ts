/**
 * What visibly changed on a page over a window, element by element: text that changed, appeared,
 * disappeared or came and went, a field's value, and the document's title. A change says what was
 * shown at the window's start and at its end, how often it changed between, where it is on the
 * page, and the input it followed, where it was that input's doing.
 *
 * `Page.changes` reads it. A page records once something reads its changes: from then, and from the
 * start of each later document once it is parsed, until nobody has read it for two minutes. A page
 * nobody reads records nothing. The record keeps 256 elements, each with its last 32 changes, for a
 * minute; an element that keeps changing gives way before news, and what gives way is counted in
 * `dropped`, with `from` moved past it. A change is told when it was in view as the page rendered
 * it, its style showing it, so one scrolled away later is still told, and something removed or
 * hidden only if it was in view before. What the record cannot see: pictures, a canvas, frames,
 * shadow roots and SVG; a value a script sets; and a class that reveals an element the record has
 * not seen before, such as a toast already on the page, though its later changes are seen.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import { Subject } from "./BrowserEvent.ts";

/**
 * `text` changed; `appeared` and `disappeared`, whether added or removed or shown or hidden;
 * `brief`, appeared and gone again by the window's end; `value`, a field's; `title`, the document's.
 */
export const Kind = Schema.Literals(["text", "appeared", "disappeared", "brief", "value", "title"]);

export type Kind = typeof Kind.Type;

export class Change extends Schema.Class<Change>("effect-browser/Change")({
  kind: Kind,
  /**
   * What changed, as the page names it now, or where it was for what went. Its own words are what
   * changed, so its name is empty unless something else names it, as a field's label does.
   */
  subject: Subject,
  /** When it first changed in the window, in host monotonic milliseconds on the browser's clock. */
  startedAt: Schema.Finite,
  /** When it last changed in the window. */
  at: Schema.Finite,
  /**
   * What it showed at the window's start; absent for what appeared and where the record let that go.
   * What disappeared says what it showed as it went. A field's value reads `••••` unless unmasked.
   */
  before: Schema.optional(Schema.String),
  /** What it showed at the window's end; absent for what disappeared. What came and went says what it showed. */
  after: Schema.optional(Schema.String),
  /** How many times what it showed changed in the window. */
  count: Schema.Int.check(Schema.isGreaterThan(0)),
  /** For a number that changed more than once, its lowest and highest, as shown. */
  lowest: Schema.optional(Schema.String),
  highest: Schema.optional(Schema.String),
  /** When it last changed before the window, as far back as the record keeps: in flux, not news. */
  earlier: Schema.optional(Schema.Finite),
  /**
   * When the trusted input it followed reached the page, where it was that input's doing: it had not
   * changed in the second before, and it changed within 500 ms, or within 3 s inside what the input
   * acted on or its row, form, dialog or controlled element. The page's `Action` that sent it holds
   * that time.
   */
  cause: Schema.optional(Schema.Finite),
}) {}

export class Changes extends Schema.Class<Changes>("effect-browser/Changes")({
  /** The page's document these changes belong to, as `Navigated` counts them. */
  document: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Where the record is whole: before it, changes may be missing. */
  from: Schema.Finite,
  /** Where the window ends: its `until`, or when the page was read. */
  until: Schema.Finite,
  /**
   * Where the window ends on the page's own clock. Give these changes as the next read's `since` and
   * the two windows meet exactly, whatever the clock mapping does meanwhile.
   */
  cursor: Schema.Finite,
  /** Changes in the window the record let go, at least; 0 when it kept them all. */
  dropped: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** Oldest first, by when each began to change. */
  changes: Schema.Array(Change),
}) {}
