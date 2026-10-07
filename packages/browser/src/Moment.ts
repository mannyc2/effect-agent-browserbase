/**
 * What a page showed, and what happened on it, over a window of time.
 *
 * `capture` gathers a page's screencast frames over a window and its events in between, and on
 * request its snapshot at the end. `toPrompt` turns a moment into one user message for any
 * `effect/ai` call: a structured answer from `LanguageModel.generateObject`, a caption from
 * `generateText`, or one turn of a `Chat` that follows moment after moment.
 *
 * Frames come from a running screencast, as far back as the browser's `frameHistory` keeps them.
 * The last frame is the page now: the newest frame if it was painted after the page's latest input
 * and at most 250 ms ago, else a new screenshot timed by its capture.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Option, Schema } from "effect";
import { Prompt } from "effect/ai";

import { BrowserError, InvalidRequest } from "./BrowserError.ts";
import { type Action, BrowserEvent, type Subject, TrackEvent } from "./BrowserEvent.ts";
import { Frame } from "./Frame.ts";
import type * as Page from "./Page.ts";
import { Snapshot, type SnapshotOptions } from "./Snapshot.ts";

const isTrackEvent = Schema.is(TrackEvent);

export class Moment extends Schema.Class<Moment>("effect-browser/Moment")({
  page: Schema.String,
  /** Where the window starts, in host monotonic milliseconds on the owning browser’s clock. */
  from: Schema.Finite,
  /** Where it ends: the time of the last frame. */
  at: Schema.Finite,
  /** Oldest first; the last frame is the page at `at`. */
  frames: Schema.Array(Frame),
  /** The page at the end of the window, when the capture asked for it. */
  snapshot: Schema.optional(Snapshot),
  /** The page’s events after `from`, up to `at`, oldest first, without the input presentation track. */
  events: Schema.Array(BrowserEvent),
}) {}

const isMoment = Schema.is(Moment);

export interface CaptureOptions {
  /**
   * Where the window starts: a previous moment, so that consecutive moments neither repeat nor
   * miss an event, or how far back from the last frame. Defaults to 5 seconds.
   */
  readonly since?: Moment | Duration.Input | undefined;
  /** Frames to keep, at least 1, spread over the window and ending with the page now. Defaults to 2. */
  readonly frames?: number | undefined;
  /**
   * Whether to take the page's outline at the end, or its options; `true` means 4,000 characters.
   * Defaults to `false`: the frames and the timeline carry most moments, while an outline costs a
   * round trip to the page and can double a moment's tokens.
   */
  readonly snapshot?: SnapshotOptions | boolean | undefined;
}

/** Pick `count` frames spread evenly over `frames`, always including the last. */
const spread = (frames: ReadonlyArray<Frame>, count: number): ReadonlyArray<Frame> => {
  if (frames.length <= count) return frames;
  if (count <= 1) return frames.slice(-1);
  const step = (frames.length - 1) / (count - 1);

  return Array.from({ length: count }, (_, index) => frames[Math.round(index * step)]).filter(
    (frame): frame is Frame => frame !== undefined,
  );
};

/** Where a window that ends at `at` starts; undefined for a negative or unbounded duration. */
const startOf = (since: Moment | Duration.Input): ((at: number) => number) | undefined => {
  if (isMoment(since)) return () => since.at;

  const millis = Number.isNaN(since)
    ? Number.NaN
    : Option.match(Duration.fromInput(since), {
        onNone: () => Number.NaN,
        onSome: Duration.toMillis,
      });

  return Number.isFinite(millis) && millis >= 0 ? (at) => at - millis : undefined;
};

const invalid = (detail: string) =>
  new BrowserError({
    operation: "moment",
    reason: new InvalidRequest({ detail }),
    dispatched: false,
  });

export const capture = Effect.fn("Moment.capture")(function* (
  page: Page.Page,
  options: CaptureOptions = {},
) {
  const count = options.frames ?? 2;

  if (!Number.isSafeInteger(count) || count < 1)
    return yield* invalid("frames must be a positive safe integer");
  const start = startOf(options.since ?? Duration.seconds(5));

  if (start === undefined)
    return yield* invalid("since must be a moment or a finite duration that is not negative");

  const outline = options.snapshot ?? false;

  // The picture and the outline each take a round trip to the page, so they are taken together.
  const { current, snapshot } = yield* Effect.all(
    {
      current: page.frame({ after: "input" }),
      snapshot:
        outline === false
          ? Effect.void
          : page.snapshot({ maxChars: 4000, ...(outline === true ? {} : outline) }),
    },
    { concurrency: 2 },
  );

  const at = current.hostTime;
  const from = start(at);

  // The selection spans the whole window, so a two-frame moment still begins where the window does.
  const recent = (yield* page.recentFrames).filter(
    (frame) => frame !== current && frame.hostTime >= from && frame.hostTime <= at,
  );

  const events = (yield* page.recentEvents).filter(
    (event) => event.at > from && event.at <= at && !isTrackEvent(event),
  );

  return new Moment({
    page: page.id,
    from,
    at,
    frames: spread([...recent, current], count),
    snapshot: snapshot ?? undefined,
    events,
  });
});

const seconds = (moment: Moment, at: number) => `${((at - moment.at) / 1000).toFixed(1)}s`;

const pointOf = (x: number | undefined, y: number | undefined) =>
  x === undefined || y === undefined ? undefined : `(${Math.round(x)}, ${Math.round(y)})`;

/** A subject in words, such as `button "Play"`; one without a name says where it was. */
const named = (subject: Subject, point: string | undefined) => {
  const kind = subject.role ?? subject.tag;

  if (subject.name !== "") return `${kind} ${JSON.stringify(subject.name)}`;

  return point === undefined ? kind : `${kind} at ${point}`;
};

/**
 * What an action acted on. Without a subject the action failed before finding it, and a ref it was
 * given is left out: refs are reused, so the page's outline may give it to something else by now.
 */
const acted = (event: Action): string => {
  const point = pointOf(event.x, event.y);

  if (event.subject === undefined)
    return event.target === undefined || /^e\d+$|"e\d+"/.test(event.target)
      ? (point ?? "")
      : event.target;
  // A drag's point is where it ended.
  if (event.to !== undefined)
    return `${named(event.subject, undefined)} to ${named(event.to, point)}`;

  return named(event.subject, point);
};

/** The events as lines of text, timed in seconds before the moment. */
const timeline = (moment: Moment): ReadonlyArray<string> =>
  moment.events.flatMap((event) => {
    // The input presentation track shows how input looked, not what it did.
    if (isTrackEvent(event)) return [];
    const when = seconds(moment, event.at);

    switch (event._tag) {
      case "Action": {
        // A navigation that worked also appears as `Navigated`, which covers redirects and in-page moves.
        if (event.ok && ["navigate", "back", "reload"].includes(event.name)) return [];

        const target = acted(event);
        const text = event.text === undefined ? "" : JSON.stringify(event.text);
        const outcome = event.ok ? "" : ` (failed: ${event.error ?? "unknown"})`;

        const what =
          event.name === "type" && target !== ""
            ? `${text} into ${target}`
            : event.name === "select" && target !== ""
              ? `${text} in ${target}`
              : `${target} ${text}`;

        return [`${when} ${event.name} ${what}${outcome}`.replace(/\s+/g, " ").trim()];
      }
      case "Navigated":
        return [`${when} navigated to ${event.url}`];
      case "PageOpened":
        return [`${when} a tab opened at ${event.url}`];
      case "PageClosed":
        return [`${when} the tab closed`];
      case "DialogShown":
        return [`${when} a dialog (${event.kind}) said ${JSON.stringify(event.message)}`];
    }
  });

/**
 * The moment as one user message: the page's outline when the moment has one, a timeline of its
 * events naming what each action acted on, and its frames captioned with their times, the last
 * one "the moment". Give a model its task with
 * `Prompt.setSystem`, and add what the caller knows about the page as more text.
 */
export const toPrompt = (moment: Moment): Prompt.Prompt => {
  const events = timeline(moment);
  const count = moment.frames.length;
  const last = count - 1;

  return Prompt.fromMessages([
    Prompt.makeMessage("user", {
      content: [
        Prompt.makePart("text", {
          text: [
            "One moment of a browser session. Rely only on what this material shows, and prefer concrete details: numbers, names, colours, positions and motion.",
            "",
            ...(moment.snapshot === undefined ? [] : [moment.snapshot.rendered, ""]),
            `Timeline (seconds before the moment, over ${((moment.at - moment.from) / 1000).toFixed(1)}s):`,
            events.length === 0 ? "(nothing happened in the window)" : events.join("\n"),
            "",
            count === 1
              ? "One screenshot follows: the moment itself."
              : `${count} screenshots follow, oldest first; the last one is the moment itself.`,
          ].join("\n"),
        }),
        ...moment.frames.flatMap((frame, index) => [
          Prompt.makePart("text", {
            text: index === last ? "The moment:" : `${seconds(moment, frame.hostTime)}:`,
          }),
          Prompt.makePart("file", { mediaType: "image/jpeg", data: frame.data }),
        ]),
      ],
    }),
  ]);
};
