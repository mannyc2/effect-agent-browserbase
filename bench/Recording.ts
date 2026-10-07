// A recorded trial, for replay: every browser event, every screencast frame, the agent's turns
// and the moments shown to a model, on the browser's one host clock, with the trial's outcome.
// This module has no Node imports, so a player in a web page can decode the same schema.
import { Schema } from "effect";
import type * as Agent from "effect-browser/Agent";
import { RecordedEvent } from "effect-browser/BrowserEvent";
import type * as Moment from "effect-browser/Moment";

/** What a task reports to a recorder as it runs; the recorder stamps each entry on arrival. */
export type Trace =
  | { readonly _tag: "Step"; readonly step: Agent.Step }
  | {
      readonly _tag: "Moment";
      readonly moment: Moment.Moment;
      readonly question: string;
      /** An understand task's truth for the moment. */
      readonly expected?: unknown;
      /** A narrator's caption of the moment. */
      readonly caption?: string;
    };

/** One screencast frame, as a JPEG file relative to the recording. */
export class RecordedFrame extends Schema.Class<RecordedFrame>("bench/RecordedFrame")({
  page: Schema.String,
  file: Schema.String,
  hostTime: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
}) {}

/** A page's viewport in CSS pixels, the space of pointer events, as recording began on it. */
export class RecordedViewport extends Schema.Class<RecordedViewport>("bench/RecordedViewport")({
  page: Schema.String,
  width: Schema.Finite,
  height: Schema.Finite,
}) {}

/** One model call: what it said, the tools it called and what they returned. */
export class RecordedStep extends Schema.Class<RecordedStep>("bench/RecordedStep")({
  at: Schema.Finite,
  step: Schema.Int,
  text: Schema.String,
  calls: Schema.Array(Schema.Struct({ name: Schema.String, params: Schema.Unknown })),
  results: Schema.Array(
    Schema.Struct({ name: Schema.String, result: Schema.Unknown, isFailure: Schema.Boolean }),
  ),
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  rejected: Schema.optional(Schema.String),
}) {}

/**
 * The pictures a model was shown in one call, as JPEG files: an understand task's question with
 * what the page held then, or a narrator's caption. A moment can end with a fresh screenshot the
 * screencast never delivered, so these are its own. `readyAt` is when the call's result arrived.
 */
export class RecordedMoment extends Schema.Class<RecordedMoment>("bench/RecordedMoment")({
  at: Schema.Finite,
  from: Schema.Finite,
  frames: Schema.Array(Schema.Struct({ file: Schema.String, hostTime: Schema.Finite })),
  question: Schema.String,
  expected: Schema.optional(Schema.Unknown),
  caption: Schema.optional(Schema.String),
  readyAt: Schema.Finite,
}) {}

/**
 * A finished span of the trial's trace: what the time between events went to, such as a model
 * call, a tool call, a page script's round trip or opening the browser.
 */
export class RecordedSpan extends Schema.Class<RecordedSpan>("bench/RecordedSpan")({
  id: Schema.String,
  parent: Schema.NullOr(Schema.String),
  name: Schema.String,
  start: Schema.Finite,
  end: Schema.Finite,
  attributes: Schema.Record(Schema.String, Schema.Unknown),
  failed: Schema.Boolean,
}) {}

export class Recording extends Schema.Class<Recording>("bench/Recording")({
  version: Schema.Literal(1),
  task: Schema.Struct({
    name: Schema.String,
    kind: Schema.Literals(["operate", "understand"]),
    summary: Schema.String,
    prompt: Schema.String,
  }),
  run: Schema.Struct({
    trial: Schema.Int,
    seed: Schema.Int,
    model: Schema.NullOr(Schema.String),
    reasoning: Schema.NullOr(Schema.String),
    browser: Schema.String,
    humanize: Schema.Boolean,
    commit: Schema.NullOr(Schema.String),
    dirty: Schema.NullOr(Schema.Boolean),
  }),
  /** Host monotonic milliseconds: compare only with the other stamps in this recording. */
  startedAt: Schema.Finite,
  endedAt: Schema.Finite,
  events: Schema.Array(RecordedEvent),
  frames: Schema.Array(RecordedFrame),
  viewports: Schema.Array(RecordedViewport),
  steps: Schema.Array(RecordedStep),
  moments: Schema.Array(RecordedMoment),
  /**
   * The trial's spans, oldest first, on the same host clock; opening the browser comes before
   * `startedAt`. Absent from recordings made without a trace.
   */
  spans: Schema.optional(Schema.Array(RecordedSpan)),
  /** Frames or events the recorder lost; an empty list means it kept everything it received. */
  problems: Schema.Array(Schema.String),
  outcome: Schema.Struct({
    status: Schema.String,
    reason: Schema.String,
    pass: Schema.NullOr(Schema.Boolean),
    detail: Schema.String,
    answer: Schema.Unknown,
    calls: Schema.Int,
    knownUsd: Schema.Finite,
    seconds: Schema.Finite,
  }),
}) {}

/** The longest string a step keeps from a tool's parameters or result. */
export const maxTextLength = 8000;

/**
 * A tool's parameters or result as plain JSON: bytes become their length and long text is cut,
 * so a recording stays small and never embeds a picture twice.
 */
export const plain = (value: unknown): unknown =>
  JSON.parse(
    JSON.stringify(value, (_key, item: unknown) =>
      item instanceof Uint8Array
        ? { bytes: item.length }
        : typeof item === "string" && item.length > maxTextLength
          ? `${item.slice(0, maxTextLength)}… [${item.length - maxTextLength} more characters]`
          : typeof item === "bigint"
            ? item.toString()
            : item,
    ) ?? "null",
  );
