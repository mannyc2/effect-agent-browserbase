import { Schema } from "effect";

import { ClockSample } from "./Telemetry.ts";

/**
 * The wire protocol between the host and the page's stagehand script.
 *
 * The library lets a page call the host, never the reverse, so the page polls:
 * each call carries a `Report` of what it just finished and returns the next
 * `Cue`. Both directions are decoded by the binding before any handler runs.
 */

/** How long one call may wait for work before it is answered `Idle`. */
export const PollMillis = 10_000;

const Pixels = Schema.Finite.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));
const Millis = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 60_000 }));
const CueId = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000_000 }));

export const Point = Schema.Struct({ x: Pixels, y: Pixels });

export const Box = Schema.Struct({ x: Pixels, y: Pixels, width: Pixels, height: Pixels });

/** What the page can see of itself: where the pointer is drawn and how far it can scroll. */
export const Stage = Schema.Struct({
  pointer: Point,
  viewport: Schema.Struct({ width: Pixels, height: Pixels }),
  scroll: Schema.Struct({ top: Pixels, maximumTop: Pixels }),
});

export type Stage = typeof Stage.Type;

/** A minute of motion at display rate is far more than one cue ever carries. */
const MaximumSamples = 1024;

export const Cue = Schema.TaggedUnion({
  /** Nothing to do yet; poll again. Keeps every call well inside its deadline. */
  Idle: {},
  Locate: { id: CueId, selector: Schema.NonEmptyString.check(Schema.isMaxLength(1024)) },
  Glide: {
    id: CueId,
    path: Schema.Array(Schema.Struct({ x: Pixels, y: Pixels, atMillis: Millis })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MaximumSamples),
    ),
  },
  Scroll: {
    id: CueId,
    track: Schema.Array(Schema.Struct({ top: Pixels, atMillis: Millis })).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(MaximumSamples),
    ),
  },
  Caption: { id: CueId, text: Schema.String.check(Schema.isMaxLength(120)) },
});

export type Cue = typeof Cue.Type;

export const Report = Schema.TaggedUnion({
  /** A document's first call, and every call that follows an `Idle`. */
  Waiting: { stage: Stage },
  Located: { id: CueId, box: Box, stage: Stage },
  Missing: { id: CueId },
  Played: { id: CueId, stage: Stage },
});

export type Report = typeof Report.Type;

/** The reports that answer a cue, as opposed to the one that only asks for work. */
export type Answer = Exclude<Report, { readonly _tag: "Waiting" }>;

/**
 * What actually crosses the binding. Every call doubles as a clock comparison:
 * the reply carries the host's two timestamps, and the page returns the
 * finished four-timestamp sample with its next call. Frame source times are on
 * the browser's clock, so without this a hosted capture latency is a guess.
 */
export const Call = Schema.Struct({
  report: Report,
  clock: Schema.optionalKey(ClockSample),
});

export const Reply = Schema.Struct({
  cue: Cue,
  hostReceivedMillis: Schema.Finite,
  hostRepliedMillis: Schema.Finite,
});
