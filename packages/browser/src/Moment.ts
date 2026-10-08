/**
 * What a page showed, and what changed on it, over a window of time.
 *
 * `capture` gathers a page's screencast frames over a window, what visibly changed on it up to its
 * last frame, and its events in between, and on request its snapshot at the end. `toPrompt` turns
 * a moment into one user message for any `effect/ai` call: a structured answer from
 * `LanguageModel.generateObject`, a caption from `generateText`, or one turn of a `Chat` that
 * follows moment after moment. It leads with what changed, news before what keeps changing, and
 * names an action only as what a change followed, or where its effect is drawn rather than
 * written, as on a canvas, which only the screenshots show.
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
import {
  type Action,
  BrowserEvent,
  type Subject,
  type SubjectContext,
  TrackEvent,
} from "./BrowserEvent.ts";
import { type Change, Changes } from "./Change.ts";
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
  /**
   * What visibly changed after `from`, up to the last frame's paint; absent when the page could not
   * say, as while it navigated. A page's first moment starts its record, so it holds none.
   */
  changes: Schema.optional(Changes),
}) {}

const isMoment = Schema.is(Moment);

export interface CaptureOptions {
  /**
   * Where the window starts: a previous moment, so that consecutive moments neither repeat nor
   * miss an event or a change, or how far back from the last frame. Defaults to 5 seconds.
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
  /** Show what fields hold in the moment's changes; a secret field still reads `••••`. */
  readonly unmask?: boolean | undefined;
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
  const since = options.since ?? Duration.seconds(5);
  const start = startOf(since);

  if (start === undefined)
    return yield* invalid("since must be a moment or a finite duration that is not negative");

  const outline = options.snapshot ?? false;

  // The picture comes first, at no call with a running screencast, and the changes are read up to
  // its paint, from where the previous moment's ended, so they hold nothing it does not show. The
  // outline is taken alongside. A page that cannot say what changed still has a moment.
  const { picture, snapshot } = yield* Effect.all(
    {
      picture: Effect.flatMap(page.frame({ after: "input" }), (current) =>
        page
          .changes({
            since: isMoment(since)
              ? (since.changes ?? since.frames.at(-1) ?? since.at)
              : start(current.hostTime),
            until: current,
            unmask: options.unmask,
          })
          .pipe(
            Effect.option,
            Effect.map((changes) => ({ current, changes: Option.getOrUndefined(changes) })),
          ),
      ),
      snapshot:
        outline === false
          ? Effect.void
          : page.snapshot({ maxChars: 4000, ...(outline === true ? {} : outline) }),
    },
    { concurrency: 2 },
  );

  const { current, changes } = picture;
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
    changes,
  });
});

const seconds = (moment: Moment, at: number) => `${((at - moment.at) / 1000).toFixed(1)}s`;

const quoted = (value: string | undefined) => JSON.stringify(value ?? "");

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

/** An action as a step: `click button "Pay"`. */
const step = (event: Action): string => {
  const target = acted(event);
  const text = event.text === undefined ? "" : JSON.stringify(event.text);
  const outcome = event.ok ? "" : ` (failed: ${event.error ?? "unknown"})`;

  const what =
    event.name === "type" && target !== ""
      ? `${text} into ${target}`
      : event.name === "select" && target !== ""
        ? `${text} in ${target}`
        : `${target} ${text}`;

  return `${event.name} ${what}${outcome}`.replace(/\s+/g, " ").trim();
};

/** What is drawn rather than written, whose changes only the screenshots show. */
const drawn = new Set(["canvas", "iframe", "video", "embed", "object", "svg"]);

const onDrawn = (event: Action) =>
  event.ok && event.subject !== undefined && drawn.has(event.subject.role ?? event.subject.tag);

/** A change's context in words: `row "Ether", column "1h"` or `beside "Price", under "Bitcoin"`. */
const where = ({ row, column, label, heading }: SubjectContext, grouped = false) => {
  const parts = [
    row === undefined ? "" : `row ${quoted(row)}`,
    column === undefined || grouped ? "" : `column ${quoted(column)}`,
    label === undefined ? "" : `beside ${quoted(label)}`,
    heading === undefined || grouped ? "" : `under ${quoted(heading)}`,
  ].filter((part) => part !== "");

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
};

/** A change in words, such as `"$61,240" became "$62,010" (row "Bitcoin", column "Price")`. */
const describe = (change: Change, grouped = false): string => {
  const { subject, before, after, count, lowest, highest } = change;
  const context = where(subject.context, grouped);

  const range =
    lowest === undefined || highest === undefined ? "" : `, from ${lowest} to ${highest}`;

  const times = count > 1 ? ` (it changed ${count} times${range})` : "";

  switch (change.kind) {
    case "title":
      return `the title ${before === undefined ? "now reads" : `${quoted(before)} became`} ${quoted(after)}`;
    case "value": {
      const field = named(subject, undefined);

      if (after === "checked" || after === "not checked") return `${field} is now ${after}`;
      if (after === undefined || after === "") return `${field} was cleared`;

      return after === "••••" || before === undefined || before === ""
        ? `${field} was ${after === "••••" ? "edited" : `set to ${quoted(after)}`}`
        : `${field} changed from ${quoted(before)} to ${quoted(after)}`;
    }
    case "appeared":
      return `${quoted(after)} appeared${context}`;
    case "disappeared":
      return `${quoted(before)} disappeared${context}`;
    case "brief":
      return `${quoted(after)} appeared and went away again${context}`;
    case "text":
      return before === undefined
        ? `now reads ${quoted(after)}${context}${times}`
        : `${quoted(before)} became ${quoted(after)}${context}${times}`;
  }
};

interface Line {
  readonly at: number;
  readonly rank: number;
  readonly text: string;
}

/** At most this many lines of what happened; the least notable are counted, not listed. */
const maxLines = 24;

/** The changes as lines, news first; cells of one column that changed together as one line. */
const changed = (moment: Moment, record: Changes): ReadonlyArray<Line> => {
  const actions = moment.events.filter((event): event is Action => event._tag === "Action");

  // The action whose input a change followed: the latest to start before the input arrived.
  const cause = (change: Change) => {
    const input = change.cause;

    const action =
      input === undefined ? undefined : actions.findLast((event) => event.startedAt <= input + 100);

    return action === undefined ? "" : `, after ${step(action)}`;
  };

  const columns = Map.groupBy(
    record.changes.filter(
      (change) => change.kind === "text" && change.subject.context.column !== undefined,
    ),
    ({ subject: { context } }) => JSON.stringify([context.heading, context.column]),
  );

  const lines: Array<Line> = [];
  const collapsed = new Set<Change>();

  for (const [first, ...cells] of columns.values())
    if (first !== undefined && cells.length >= 2) {
      for (const cell of [first, ...cells]) collapsed.add(cell);
      lines.push({
        at: first.startedAt,
        rank: 3,
        text: `${cells.length + 1} cells in column ${quoted(first.subject.context.column)}${where({ heading: first.subject.context.heading })} changed, such as ${describe(first, true)}`,
      });
    }
  for (const change of record.changes)
    if (!collapsed.has(change))
      lines.push({
        at: change.startedAt,
        rank: change.count > 1 || change.earlier !== undefined ? 3 : 2,
        text: describe(change) + cause(change),
      });

  return lines;
};

/** The moment's changes and events as lines, most notable first when its changes are recorded. */
const account = (moment: Moment): ReadonlyArray<string> => {
  const record = moment.changes;
  const lines = [...(record === undefined ? [] : changed(moment, record))];

  // With a record, an action is told only where its effect is drawn, or the record began after it.
  const told = (event: Action) =>
    !(event.ok && ["navigate", "back", "reload"].includes(event.name)) &&
    (record === undefined ||
      event.at <= record.from ||
      (onDrawn(event) && event.name !== "scroll"));

  for (const event of moment.events)
    if (event._tag === "Action" && event.page === moment.page && told(event))
      lines.push({ at: event.at, rank: 4, text: step(event) });
    else if (event._tag === "Navigated")
      lines.push({
        at: event.at,
        rank: 0,
        text: `${event.sameDocument ? "moved within the page" : "navigated"} to ${event.url}`,
      });
    else if (event._tag === "PageOpened")
      lines.push({ at: event.at, rank: 0, text: `a tab opened at ${event.url}` });
    else if (event._tag === "PageClosed")
      lines.push({
        at: event.at,
        rank: 0,
        text: `the tab ${event.cause === "crashed" ? "crashed" : "closed"}`,
      });
    else if (event._tag === "DialogShown")
      lines.push({
        at: event.at,
        rank: 1,
        text: `a dialog (${event.kind}) said ${JSON.stringify(event.message)}`,
      });

  const ordered = lines.toSorted((left, right) =>
    record === undefined ? left.at - right.at : left.rank - right.rank || left.at - right.at,
  );

  const kept = ordered.slice(0, maxLines);
  const drawing = moment.events.some((event) => event._tag === "Action" && onDrawn(event));
  const begins = record === undefined ? moment.from : Math.max(moment.from, record.from);

  return [
    ...kept.map((line) => `${seconds(moment, line.at)} ${line.text}`),
    ...(ordered.length > maxLines ? [`…and ${ordered.length - maxLines} less notable`] : []),
    ...(record === undefined
      ? [
          kept.length === 0
            ? "(nothing happened in the window)"
            : "What changed on the page was not recorded.",
        ]
      : record.changes.length > 0
        ? []
        : [
            `No text in view changed${drawing ? "; what is drawn, such as a canvas, shows only in the screenshots" : ""}.`,
          ]),
    ...(record !== undefined && record.dropped > 0
      ? [
          `The page changed too much to tell it all: at least ${record.dropped} changes are not told.`,
        ]
      : []),
    ...(begins > moment.from
      ? [`Changes before ${seconds(moment, begins)} are not all known.`]
      : []),
  ];
};

/**
 * The moment as one user message: the page's outline when the moment has one, what changed, most
 * notable first, with the actions that the changes followed or that drew what only the
 * screenshots show, and its frames captioned with their times, the last one "the moment". Give a
 * model its task with `Prompt.setSystem`, and add what the caller knows about the page as more text.
 */
export const toPrompt = (moment: Moment): Prompt.Prompt => {
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
            `${moment.changes === undefined ? "What happened" : "What changed, most notable first"} (seconds before the moment, over ${((moment.at - moment.from) / 1000).toFixed(1)}s):`,
            ...account(moment),
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
