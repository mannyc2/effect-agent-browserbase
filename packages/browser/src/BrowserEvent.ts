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

/** A step of humanized pointer motion, for drawing a cursor over captured frames. */
export class PointerMoved extends Schema.TaggedClass<PointerMoved>()("PointerMoved", {
  at: Schema.Finite,
  page: Schema.String,
  x: Schema.Finite,
  y: Schema.Finite,
}) {}

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
  PointerMoved,
  DialogShown,
]);

export type BrowserEvent = typeof BrowserEvent.Type;
