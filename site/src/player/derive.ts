// What a loaded replay shows besides its video, worked out once when it loads: the pointer's
// track, the actions on the timeline and the feed of narrator lines and agent steps, each with the
// host time it belongs to. Every time is on the recording's host clock, in milliseconds.
import { Option, Schema } from "effect";
import { defineTaggedUnion } from "foldkit/schema";

import { describeCall, doing } from "../present.ts";
import { type Replay, track } from "../replay.ts";

const Point = { at: Schema.Finite, x: Schema.Finite, y: Schema.Finite };

/** `Track` from replay.ts, as a schema, so the player's Model can hold it. */
export const Track = Schema.Struct({
  keyframes: Schema.Array(Schema.Struct({ ...Point, glide: Schema.UndefinedOr(Schema.Finite) })),
  presses: Schema.Array(Schema.Struct(Point)),
  wheels: Schema.Array(Schema.Struct({ ...Point, dy: Schema.Finite })),
});

export type Track = typeof Track.Type;

/** One browser action on the timeline, and the status line said while it runs. */
export const Span = Schema.Struct({
  start: Schema.Finite,
  end: Schema.Finite,
  label: Schema.String,
  ok: Schema.Boolean,
});

export type Span = typeof Span.Type;

export const CallWords = Schema.Struct({
  text: Schema.String,
  failed: Schema.Boolean,
  why: Schema.optional(Schema.String),
  technical: Schema.optional(Schema.String),
  answer: Schema.optional(Schema.Unknown),
});

export type CallWords = typeof CallWords.Type;

/**
 * The feed's entries. A line is the narrator's: spoken from `at` when the replay has a voice,
 * otherwise shown when its moment was captured; `moment` is the index of the moment it captioned,
 * whose frames the narrator saw. Steps fold repeats of the same turn into one entry.
 */
export const Entry = defineTaggedUnion({
  Line: { at: Schema.Finite, end: Schema.Finite, text: Schema.String, moment: Schema.Int },
  Steps: {
    at: Schema.Finite,
    first: Schema.Int,
    last: Schema.Int,
    said: Schema.String,
    calls: Schema.Array(CallWords),
    rejected: Schema.Option(Schema.String),
  },
});

export type Entry = typeof Entry.Type;

/** How long a caption stays up when the replay has no voice to time it. */
const silentLineMillis = 4000;

export const Derived = Schema.Struct({
  track: Track,
  spans: Schema.Array(Span),
  entries: Schema.Array(Entry),
});

export type Derived = typeof Derived.Type;

const lines = (replay: Replay): ReadonlyArray<Entry> =>
  replay.narration === undefined
    ? replay.moments.flatMap((moment, index) =>
        moment.caption === undefined
          ? []
          : [
              Entry.Line({
                at: moment.readyAt,
                end: moment.readyAt + silentLineMillis,
                text: moment.caption,
                moment: index,
              }),
            ],
      )
    : replay.narration.lines.map((line) =>
        Entry.Line({
          at: line.at,
          end: line.end,
          text: line.text,
          moment: replay.moments.findIndex((moment) => moment.at === line.until),
        }),
      );

/**
 * The names the page gave the targets of a step's actions, by ref: from the actions the browser
 * performed between the step's start and the next one's.
 */
const subjectsOf = (replay: Replay, from: number, until: number) => {
  const named = new Map<string, string>();

  for (const { event } of replay.events)
    if (
      event._tag === "Action" &&
      event.startedAt >= from &&
      event.startedAt < until &&
      event.target !== undefined &&
      typeof event.subject?.name === "string" &&
      event.subject.name !== ""
    )
      named.set(event.target, event.subject.name);

  return (ref: string) => named.get(ref);
};

const steps = (replay: Replay): ReadonlyArray<Entry> =>
  replay.steps.map((step, index) =>
    Entry.Steps({
      at: step.at,
      first: step.step,
      last: step.step,
      said: step.text.trim(),
      calls: step.calls.map((call, order) =>
        describeCall(
          call,
          step.results[order],
          subjectsOf(replay, step.at - 500, replay.steps[index + 1]?.at ?? Infinity),
        ),
      ),
      rejected: step.rejected === undefined ? Option.none() : Option.some(step.rejected),
    }),
  );

const sameSteps = (left: Entry, right: Entry) =>
  left._tag === "Steps" &&
  right._tag === "Steps" &&
  left.said === right.said &&
  JSON.stringify(left.rejected) === JSON.stringify(right.rejected) &&
  JSON.stringify(left.calls) === JSON.stringify(right.calls);

/** Lines and steps in time order, with a run of identical steps folded into one entry. */
const feed = (replay: Replay): ReadonlyArray<Entry> =>
  [...lines(replay), ...steps(replay)]
    .toSorted((left, right) => left.at - right.at)
    .reduce<ReadonlyArray<Entry>>((folded, entry) => {
      const previous = folded.at(-1);

      return previous !== undefined && previous._tag === "Steps" && sameSteps(previous, entry)
        ? [...folded.slice(0, -1), { ...previous, last: entry._tag === "Steps" ? entry.last : 0 }]
        : [...folded, entry];
    }, []);

export const derive = (replay: Replay): Derived => ({
  track: track(replay.events),
  spans: replay.events.flatMap(({ event }) =>
    event._tag === "Action"
      ? [{ start: event.startedAt, end: event.at, label: doing(event), ok: event.ok }]
      : [],
  ),
  entries: feed(replay),
});

/** The index of the last entry at or before `now`, or -1 before the first. */
export const currentEntry = (entries: ReadonlyArray<Entry>, now: number) =>
  entries.findLastIndex((entry) => entry.at <= now);

/** The line being spoken or shown at `now`. */
export const lineAt = (entries: ReadonlyArray<Entry>, now: number) =>
  entries.findLast(
    (entry): entry is Extract<Entry, { _tag: "Line" }> =>
      entry._tag === "Line" && entry.at <= now && now < entry.end,
  );

/** What the browser is doing at `now`, for the status line over the video. */
export const statusAt = (
  replay: Replay,
  spans: ReadonlyArray<Span>,
  now: number,
): { readonly text: string; readonly tone: "act" | "fail" | "wait" } | undefined => {
  const action = spans.findLast((span) => span.start <= now && span.end >= now);

  if (action !== undefined) return { text: action.label, tone: action.ok ? "act" : "fail" };
  const lastStep = replay.steps.at(-1);

  return lastStep !== undefined && now < lastStep.at && replay.run.model !== null
    ? { text: "Deciding the next step…", tone: "wait" }
    : undefined;
};

/** The viewport the pointer moved in, in CSS pixels; the video covers exactly this area. */
export const viewportOf = (replay: Replay) => {
  const viewport = replay.viewports[0];

  return viewport === undefined
    ? { width: replay.video.width, height: replay.video.height }
    : { width: viewport.width, height: viewport.height };
};
