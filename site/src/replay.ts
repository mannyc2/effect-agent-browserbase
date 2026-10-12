import { Recording, type RecordedSpan } from "bench/Recording.ts";
// A packed recording, as the player reads it: the bench's Recording with its frames encoded into
// one video, the narrator's lines as they were spoken over it, and what the recording shows at any
// host time: where the pointer is, what was just pressed or scrolled, and which page owned the
// screen. Every time is on the recording's host clock, in milliseconds.
import { Schema } from "effect";
import type { RecordedEvent } from "effect-browser/BrowserEvent";

// A recording's trace spans stay out of what is published: the player does not read them, and a
// hosted run's carry its Browserbase session id in the API requests' URLs.
const { frames: _frames, spans: _spans, ...kept } = Recording.fields;

/**
 * One narrator line as a viewer hears it. The narrator captioned a moment, the screen from `from`
 * to `until`; its words arrived at `readyAt`, and the voice speaks them from `at` to `end`: where
 * the window ends, or once the line before has finished.
 */
export class NarrationLine extends Schema.Class<NarrationLine>("site/NarrationLine")({
  text: Schema.String,
  from: Schema.Finite,
  until: Schema.Finite,
  readyAt: Schema.Finite,
  at: Schema.Finite,
  end: Schema.Finite,
}) {}

export const ActivityKind = Schema.Literals(["think", "look", "act", "wait", "report"]);

export type ActivityKind = typeof ActivityKind.Type;

/**
 * What the agent was doing over a stretch of the run, from its trace: thinking is a model call;
 * looking, a screenshot it took or a tool that reads the page; acting, a tool that works the page;
 * waiting, one that watches it; reporting, its answer.
 */
export class Activity extends Schema.Class<Activity>("site/Activity")({
  kind: ActivityKind,
  /** The tool it ran, for all but a model call and a screenshot. */
  tool: Schema.optional(Schema.String),
  start: Schema.Finite,
  end: Schema.Finite,
  failed: Schema.Boolean,
}) {}

/** What each tool does to the page, where it does not work it. */
const toolKinds: Readonly<Record<string, ActivityKind>> = {
  observe: "look",
  inspect: "look",
  snapshot: "look",
  screenshot: "look",
  zoom: "look",
  find_text: "look",
  wait: "wait",
  wait_still: "wait",
  done: "report",
  give_up: "report",
};

/** What a tool does: looks at the page, waits on it, reports, or else acts on it. */
export const kindOfTool = (tool: string): ActivityKind =>
  toolKinds[tool.replace(/^browser_/, "")] ?? "act";

/**
 * The agent's activity from a recording's trace spans, oldest first: only what it did and when,
 * none of the spans' attributes, which can carry a hosted session's id.
 */
export const activityOf = (spans: ReadonlyArray<RecordedSpan>): ReadonlyArray<Activity> => {
  const byId = new Map(spans.map((span) => [span.id, span]));

  const agents = (span: RecordedSpan) => {
    for (let parent = byId.get(span.parent ?? ""); parent !== undefined;) {
      if (parent.name.startsWith("invoke_agent")) return true;
      parent = byId.get(parent.parent ?? "");
    }

    return false;
  };

  return spans
    .flatMap((span) => {
      const tool = span.name.match(/^execute_tool (.+)$/)?.[1];

      const kind =
        span.name === "AgentRuntime.model"
          ? "think"
          : span.name === "Page.screenshot" && agents(span)
            ? "look"
            : tool === undefined
              ? undefined
              : kindOfTool(tool);

      return kind === undefined
        ? []
        : [new Activity({ kind, tool, start: span.start, end: span.end, failed: span.failed })];
    })
    .toSorted((left, right) => left.start - right.start);
};

/** The most words a caption shows at once: two short lines. */
const captionWords = 14;

/**
 * A spoken line as captions a viewer reads at a glance: pieces of at most two short lines, broken
 * after a sentence or a clause where one ends near enough, each timed by its share of the line's
 * letters from `at` to `end`.
 */
export const captionChunks = (
  text: string,
  at: number,
  end: number,
): ReadonlyArray<{ readonly text: string; readonly at: number; readonly end: number }> => {
  const words = text.split(/\s+/).filter((word) => word !== "");
  const pieces: Array<Array<string>> = [];
  let piece: Array<string> = [];

  const clauseEnds = (word: string) => /[,;:—]["”’)]*$/.test(word);

  for (const [index, word] of words.entries()) {
    piece.push(word);
    const left = words.length - index - 1;
    const sentence = /[.?!…]["”’)]*$/.test(word) && piece.length >= 2;

    if (left === 0) break;
    if (sentence || (clauseEnds(word) && piece.length >= 8)) {
      pieces.push(piece);
      piece = [];
    } else if (piece.length >= captionWords) {
      // A full piece ends at its last clause, if it has one far enough in, and carries the rest.
      const cut = piece.findLastIndex((each, at) => at >= 4 && clauseEnds(each)) + 1;

      pieces.push(cut > 0 ? piece.slice(0, cut) : piece);
      piece = cut > 0 ? piece.slice(cut) : [];
    }
  }
  if (piece.length > 0) pieces.push(piece);

  const total = words.join(" ").length || 1;
  let done = 0;

  return pieces.map((part) => {
    const said = part.join(" ");
    const from = at + ((end - at) * done) / total;

    done += said.length + 1;

    return { text: said, at: from, end: Math.min(end, at + ((end - at) * done) / total) };
  });
};

export class Replay extends Schema.Class<Replay>("site/Replay")({
  ...kept,
  video: Schema.Struct({
    /** H.264, with the narration as its AAC audio track when there is one. */
    file: Schema.String,
    /** The host time of the video's first instant. */
    startsAt: Schema.Finite,
    durationMillis: Schema.Finite,
    width: Schema.Finite,
    height: Schema.Finite,
    frames: Schema.Int,
  }),
  /** What the agent was doing when; absent from a replay packed before it was kept. */
  activity: Schema.optional(Schema.Array(Activity)),
  /** Absent from a replay packed without a voice. */
  narration: Schema.optional(
    Schema.Struct({
      /** The voice's model and name, as the site credits it. */
      voice: Schema.String,
      /** The lines as WebVTT, timed from the video's start. */
      captions: Schema.String,
      lines: Schema.Array(NarrationLine),
    }),
  ),
}) {}

/**
 * The frames to show, oldest first: each from the page the latest event concerned, so a page
 * painting in the background never flashes into view. A page that only finished loading, or an
 * event of the whole browser, concerns no page shown. Before any event, and after the shown page
 * closes, every page's frames qualify.
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
      const { event } = record;

      if (event._tag === "PageClosed") active = undefined;
      else if ("page" in event && event._tag !== "PageLoaded") active = event.page;
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
      case "PageLoaded":
      case "PageUntracked":
      case "Disconnected":
      case "SessionEnding":
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
