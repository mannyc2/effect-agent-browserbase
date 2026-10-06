/**
 * What happened in a browser, in order: pages, navigations, actions and pointer motion.
 *
 * Every event carries `at`, host monotonic milliseconds from the owning browser’s Effect `Clock`.
 * This clock also stamps screencast frames’ `receivedAt` and moments, so wall-clock corrections
 * cannot disturb their order. Compare stamps only within the same browser clock, not across hosts.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import * as Motion from "./Motion.ts";

export class PageOpened extends Schema.TaggedClass<PageOpened>()("PageOpened", {
  at: Schema.Finite,
  page: Schema.String,
  url: Schema.String,
}) {}

export class PageClosed extends Schema.TaggedClass<PageClosed>()("PageClosed", {
  at: Schema.Finite,
  page: Schema.String,
}) {}

/** The page's main frame committed a new URL, including same-document navigations. */
export class Navigated extends Schema.TaggedClass<Navigated>()("Navigated", {
  at: Schema.Finite,
  page: Schema.String,
  url: Schema.String,
}) {}

/** One page operation ended. Point actions carry the viewport point they used. */
export class Action extends Schema.TaggedClass<Action>()("Action", {
  at: Schema.Finite,
  startedAt: Schema.Finite,
  page: Schema.String,
  name: Schema.String,
  target: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
  ok: Schema.Boolean,
  dispatched: Schema.Boolean,
  error: Schema.optional(Schema.String),
}) {}

const Sequence = Schema.Int.check(Schema.isGreaterThan(0));
const Button = Schema.Literals(["left", "right", "middle"]);

/** One whole glide, published before its first input. Offsets use the host monotonic clock. */
export class TrackPlanned extends Schema.TaggedClass<TrackPlanned>()("TrackPlanned", {
  at: Schema.Finite,
  page: Schema.String,
  from: Motion.Point,
  samples: Schema.Array(Motion.Sample),
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

/** A JavaScript dialog appeared and was answered (alerts accepted, others dismissed). */
export class DialogShown extends Schema.TaggedClass<DialogShown>()("DialogShown", {
  at: Schema.Finite,
  page: Schema.String,
  kind: Schema.String,
  message: Schema.String,
}) {}

export const BrowserEvent = Schema.Union([
  PageOpened,
  PageClosed,
  Navigated,
  Action,
  ...TrackEvent.members,
  DialogShown,
]);

export type BrowserEvent = typeof BrowserEvent.Type;

/** A position in the browser's one replayable event history. Sequences begin at one. */
export class RecordedEvent extends Schema.Class<RecordedEvent>("effect-browser/RecordedEvent")({
  sequence: Sequence,
  event: BrowserEvent,
}) {}
