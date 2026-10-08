/**
 * What happened in a browser, in order: pages and their documents, actions, pointer motion, and
 * the browser's own end.
 *
 * Every event carries `at`, host monotonic milliseconds from the owning browser’s Effect `Clock`.
 * This clock also stamps screencast frames’ `receivedAt` and moments, so wall-clock corrections
 * cannot disturb their order. Compare stamps only within the same browser clock, not across hosts.
 * A page is named by its CDP target id, which stays the same across reconnects, and every URL is
 * reported without its userinfo or known secret parameters.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import * as Motion from "./Motion.ts";

/** A page opened, and the page that opened it, as a link or `window.open` does, if one did. */
export class PageOpened extends Schema.TaggedClass<PageOpened>()("PageOpened", {
  at: Schema.Finite,
  page: Schema.String,
  url: Schema.String,
  opener: Schema.optional(Schema.String),
}) {}

/**
 * The page closed (`page`), or crashed and was closed (`crashed`). A page lost with its browser
 * has no event of its own: `Disconnected` stands for all of them.
 */
export class PageClosed extends Schema.TaggedClass<PageClosed>()("PageClosed", {
  at: Schema.Finite,
  page: Schema.String,
  cause: Schema.Literals(["page", "crashed"]),
}) {}

/**
 * A tab the site opened that the library could not track, as its registration failed with
 * `detail`. A tab that closed as it opened has no event.
 */
export class PageUntracked extends Schema.TaggedClass<PageUntracked>()("PageUntracked", {
  at: Schema.Finite,
  url: Schema.String,
  detail: Schema.String,
}) {}

/**
 * The page's main frame moved to `url`: into a new document, or within the current one
 * (`sameDocument`), as `pushState` and fragment links do. Frames carry the document they followed.
 */
export class Navigated extends Schema.TaggedClass<Navigated>()("Navigated", {
  at: Schema.Finite,
  page: Schema.String,
  url: Schema.String,
  /**
   * The page's documents counted from 0, the one it had when this browser began tracking it, one
   * more for each new document. The count belongs to the page within one `Browser` and starts at
   * 0 again on a new connection, so compare it only with the same page's in the same browser.
   */
  document: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  sameDocument: Schema.Boolean,
}) {}

/** The page's document finished parsing (`domcontentloaded`) or loading (`load`). */
export class PageLoaded extends Schema.TaggedClass<PageLoaded>()("PageLoaded", {
  at: Schema.Finite,
  page: Schema.String,
  state: Schema.Literals(["domcontentloaded", "load"]),
}) {}

/**
 * Why a browser was lost to its owner: its connection dropped (`connection`), its provider ended
 * its session, at or after the session's `expiresAt` (`session`), or its owner released it.
 */
export const DisconnectCause = Schema.Literals(["connection", "session", "released"]);

export type DisconnectCause = typeof DisconnectCause.Type;

/** The browser was lost to its owner, with every page in it. It happens once. */
export class Disconnected extends Schema.TaggedClass<Disconnected>()("Disconnected", {
  at: Schema.Finite,
  cause: DisconnectCause,
}) {}

/** The provider ends this browser's session at `expiresAt`, a wall-clock instant. */
export class SessionEnding extends Schema.TaggedClass<SessionEnding>()("SessionEnding", {
  at: Schema.Finite,
  expiresAt: Schema.DateTimeUtc,
}) {}

/**
 * The words around a subject that say which one it is, each bound to it in the page rather than
 * read off nearby text later. In a table, `row` is the row's header or first cell with text and
 * `column` the header over it; elsewhere, `label` is the words just before it in its row, item,
 * group or block, at most 40 characters. `heading` is the nearest heading above it, left out for
 * what is pinned to the viewport. Row, column and heading are at most 60 characters.
 */
export const SubjectContext = Schema.Struct({
  row: Schema.optional(Schema.String),
  column: Schema.optional(Schema.String),
  label: Schema.optional(Schema.String),
  heading: Schema.optional(Schema.String),
});

export type SubjectContext = typeof SubjectContext.Type;

/**
 * What an input acted on, or what `Page.find` found, as the page named it then: its role (null
 * when it has none), its accessible name (empty when it has none), its lowercase tag and its
 * context. For a point, it is the control under the point, or else the element painted there.
 * Unlike a ref, it keeps its meaning after the page changes.
 */
export class Subject extends Schema.Class<Subject>("effect-browser/Subject")({
  role: Schema.NullOr(Schema.String),
  name: Schema.String,
  tag: Schema.String,
  context: SubjectContext,
}) {}

const Button = Schema.Literals(["left", "right", "middle"]);

/** An element's box in viewport CSS pixels; it may lie partly or wholly outside the viewport. */
export const Box = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export type Box = typeof Box.Type;

/**
 * What else an action was asked, where it changes what the action does: a click's button, count
 * and hold, how `type` enters its text, how often and how long `press` holds its keys, how far
 * `scroll` moves, and the options `select` chose. Only a completed action records them.
 */
export const ActionOptions = Schema.Struct({
  button: Schema.optional(Button),
  clickCount: Schema.optional(Schema.Finite),
  holdMillis: Schema.optional(Schema.Finite),
  replace: Schema.optional(Schema.Boolean),
  submit: Schema.optional(Schema.Boolean),
  times: Schema.optional(Schema.Finite),
  dx: Schema.optional(Schema.Finite),
  dy: Schema.optional(Schema.Finite),
  values: Schema.optional(Schema.Array(Schema.String)),
});

export type ActionOptions = typeof ActionOptions.Type;

/**
 * One page operation ended, including one its caller interrupted (`error: "interrupted"`).
 * `target` is what the caller asked for: a ref, a point, a URL or keys, and `options` the rest.
 * `subject` is what an element or point action found there, and `to` where a drag ended; an
 * action that failed before finding its target has neither. Point actions carry the viewport
 * point they used. `correlation` is the id its caller gave it with `Page.correlate`, such as a
 * model's tool call id.
 */
export class Action extends Schema.TaggedClass<Action>()("Action", {
  at: Schema.Finite,
  startedAt: Schema.Finite,
  page: Schema.String,
  name: Schema.String,
  correlation: Schema.optional(Schema.String),
  target: Schema.optional(Schema.String),
  options: Schema.optional(ActionOptions),
  subject: Schema.optional(Subject),
  to: Schema.optional(Subject),
  /** For an action at a point, the box of what it found there. */
  box: Schema.optional(Box),
  text: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  ok: Schema.Boolean,
  dispatched: Schema.Boolean,
  error: Schema.optional(Schema.String),
}) {}

const Sequence = Schema.Int.check(Schema.isGreaterThan(0));

/** One whole glide, published before its first input. Offsets use the host monotonic clock. */
export class TrackPlanned extends Schema.TaggedClass<TrackPlanned>()("TrackPlanned", {
  at: Schema.Finite,
  page: Schema.String,
  from: Motion.Point,
  samples: Motion.Plan,
}) {}

/**
 * The submitted prefix of a glide. `plan` is its TrackPlanned envelope sequence; `dispatched`
 * counts samples. `complete` means every sample was submitted, not acknowledged by the browser.
 * The terminal point clips a canceled plan so a compositor never draws its unrealized future.
 */
export class TrackPerformed extends Schema.TaggedClass<TrackPerformed>()("TrackPerformed", {
  at: Schema.Finite,
  page: Schema.String,
  plan: Sequence,
  dispatched: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  x: Schema.Finite,
  y: Schema.Finite,
  complete: Schema.Boolean,
}) {}

export class PointerPressed extends Schema.TaggedClass<PointerPressed>()("PointerPressed", {
  at: Schema.Finite,
  page: Schema.String,
  x: Schema.Finite,
  y: Schema.Finite,
  button: Button,
  clickCount: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

export class PointerReleased extends Schema.TaggedClass<PointerReleased>()("PointerReleased", {
  at: Schema.Finite,
  page: Schema.String,
  x: Schema.Finite,
  y: Schema.Finite,
  button: Button,
  clickCount: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

export class WheelScrolled extends Schema.TaggedClass<WheelScrolled>()("WheelScrolled", {
  at: Schema.Finite,
  page: Schema.String,
  x: Schema.Finite,
  y: Schema.Finite,
  dx: Schema.Finite,
  dy: Schema.Finite,
}) {}

export class KeyChanged extends Schema.TaggedClass<KeyChanged>()("KeyChanged", {
  at: Schema.Finite,
  page: Schema.String,
  key: Schema.String,
  phase: Schema.Literals(["down", "up"]),
}) {}

/** Literal text insertion has no corresponding key events, including Unicode and newlines. */
export class TextInserted extends Schema.TaggedClass<TextInserted>()("TextInserted", {
  at: Schema.Finite,
  page: Schema.String,
  text: Schema.String,
}) {}

/** The target's CSS cursor, obtained during target resolution without another browser call. */
export class CursorChanged extends Schema.TaggedClass<CursorChanged>()("CursorChanged", {
  at: Schema.Finite,
  page: Schema.String,
  cursor: Schema.String,
}) {}

export const TrackEvent = Schema.Union([
  TrackPlanned,
  TrackPerformed,
  PointerPressed,
  PointerReleased,
  WheelScrolled,
  KeyChanged,
  TextInserted,
  CursorChanged,
]);

export type TrackEvent = typeof TrackEvent.Type;

/**
 * A JavaScript dialog appeared and was answered: an alert or a leave-page prompt accepted, a
 * confirm or a prompt dismissed, as if its Cancel were pressed.
 */
export class DialogShown extends Schema.TaggedClass<DialogShown>()("DialogShown", {
  at: Schema.Finite,
  page: Schema.String,
  kind: Schema.String,
  message: Schema.String,
  answer: Schema.Literals(["accepted", "dismissed"]),
}) {}

export const BrowserEvent = Schema.Union([
  PageOpened,
  PageClosed,
  PageUntracked,
  Navigated,
  PageLoaded,
  Action,
  ...TrackEvent.members,
  DialogShown,
  Disconnected,
  SessionEnding,
]);

export type BrowserEvent = typeof BrowserEvent.Type;

/** A position in the browser's one replayable event history. Sequences begin at one. */
export class RecordedEvent extends Schema.Class<RecordedEvent>("effect-browser/RecordedEvent")({
  sequence: Sequence,
  event: BrowserEvent,
}) {}
