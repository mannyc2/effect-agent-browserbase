import { Recording } from "bench/Recording.ts";
// A packed recording, as the player reads it: the bench's Recording with its frames encoded into
// one video, and what that recording shows at any host time: where the pointer is, what was just
// pressed or scrolled, and which page owned the screen.
import { Schema } from "effect";
import type { RecordedEvent } from "effect-browser/BrowserEvent";

const { frames: _frames, ...kept } = Recording.fields;

export class Replay extends Schema.Class<Replay>("demos/Replay")({
  ...kept,
  video: Schema.Struct({
    file: Schema.String,
    /** The host time of the video's first instant. */
    startsAt: Schema.Finite,
    durationMillis: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
    frames: Schema.Int,
  }),
}) {}

/**
 * The frames to show, oldest first: each from the page the latest event concerned, so a page
 * painting in the background never flashes into view. Before any event, and after the shown
 * page closes, every page's frames qualify.
 */
export const shownFrames = <F extends { readonly page: string; readonly hostTime: number }>(
  frames: ReadonlyArray<F>,
  events: ReadonlyArray<RecordedEvent>,
): Array<F> => {
  const ordered = events.toSorted((left, right) => left.event.at - right.event.at);
  const shown: Array<F> = [];
  let active: string | undefined;
  let next = 0;

  for (const frame of frames.toSorted((left, right) => left.hostTime - right.hostTime)) {
    for (let record = ordered[next]; record !== undefined && record.event.at <= frame.hostTime;) {
      active = record.event._tag === "PageClosed" ? undefined : record.event.page;
      record = ordered[++next];
    }
    if (active === undefined || frame.page === active) shown.push(frame);
  }

  return shown;
};

interface Keyframe {
  readonly at: number;
  readonly x: number;
  readonly y: number;
  /** Positions within one glide are interpolated; anything else jumps, as the input did. */
  readonly glide: number | undefined;
}

export interface Mark {
  readonly at: number;
  readonly x: number;
  readonly y: number;
}

export interface Track {
  readonly keyframes: ReadonlyArray<Keyframe>;
  readonly presses: ReadonlyArray<Mark>;
  readonly wheels: ReadonlyArray<Mark & { readonly dy: number }>;
}

/** The pointer and keyboard as recorded: planned glides, presses, wheels and keys. */
export const track = (events: ReadonlyArray<RecordedEvent>): Track => {
  const keyframes: Array<Keyframe> = [];
  const presses: Array<Mark> = [];
  const wheels: Array<Mark & { dy: number }> = [];
  const glides: Array<{ start: number; end: number }> = [];

  for (const { sequence, event } of events) {
    switch (event._tag) {
      case "TrackPlanned": {
        for (const sample of event.samples)
          keyframes.push({ at: event.at + sample.afterMillis, ...sample, glide: sequence });
        glides.push({ start: event.at, end: event.at + (event.samples.at(-1)?.afterMillis ?? 0) });
        break;
      }
      case "TrackPerformed": {
        if (event.complete) break;

        // A canceled glide stops where its submitted prefix ended; never draw its future.
        for (let index = keyframes.length - 1; index >= 0; index--) {
          const keyframe = keyframes[index];

          if (keyframe?.glide === event.plan && keyframe.at > event.at) keyframes.splice(index, 1);
        }
        keyframes.push({ at: event.at, x: event.x, y: event.y, glide: event.plan });
        break;
      }
      case "PointerPressed": {
        presses.push(event);
        keyframes.push({ ...event, glide: undefined });
        break;
      }
      case "PointerReleased": {
        keyframes.push({ ...event, glide: undefined });
        break;
      }
      case "WheelScrolled": {
        wheels.push(event);
        keyframes.push({ ...event, glide: undefined });
        break;
      }
      case "Action":
      case "KeyChanged":
      case "TextInserted":
      case "CursorChanged":
      case "DialogShown":
      case "Navigated":
      case "PageClosed":
      case "PageOpened":
    }
  }

  // An action that jumped straight to its point has no glide; show the pointer arriving there.
  for (const { event } of events) {
    if (event._tag !== "Action" || event.x === undefined || event.y === undefined) continue;
    const { startedAt, at, x, y } = event;

    if (glides.some((glide) => glide.start <= at && glide.end >= startedAt)) continue;
    if (presses.some((press) => press.at >= startedAt && press.at <= at)) continue;
    keyframes.push({ at: startedAt, x, y, glide: undefined });
  }

  return {
    keyframes: keyframes.toSorted((left, right) => left.at - right.at),
    presses,
    wheels,
  };
};

/** The index of the last item at or before `at` in a list ordered by time, or -1. */
const lastAtOrBefore = (items: ReadonlyArray<{ readonly at: number }>, at: number) => {
  let low = 0;
  let high = items.length - 1;
  let found = -1;

  while (low <= high) {
    const middle = (low + high) >> 1;

    if ((items[middle]?.at ?? Infinity) <= at) {
      found = middle;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  return found;
};

/** Where the pointer is at host time `at`, in CSS pixels; undefined before it first moves. */
export const pointerAt = (recorded: Track, at: number): Mark | undefined => {
  const index = lastAtOrBefore(recorded.keyframes, at);
  const previous = recorded.keyframes[index];

  if (previous === undefined) return undefined;
  const next = recorded.keyframes[index + 1];

  if (next === undefined || next.glide === undefined || next.glide !== previous.glide)
    return { at, x: previous.x, y: previous.y };
  const progress = next.at === previous.at ? 1 : (at - previous.at) / (next.at - previous.at);

  return {
    at,
    x: previous.x + (next.x - previous.x) * progress,
    y: previous.y + (next.y - previous.y) * progress,
  };
};

/** The latest mark within `windowMillis` before `at`, with how far through that window it is. */
export const recentMark = <M extends Mark>(
  marks: ReadonlyArray<M>,
  at: number,
  windowMillis: number,
): { readonly mark: M; readonly progress: number } | undefined => {
  const mark = marks[lastAtOrBefore(marks, at)];

  return mark === undefined || at - mark.at > windowMillis
    ? undefined
    : { mark, progress: (at - mark.at) / windowMillis };
};
