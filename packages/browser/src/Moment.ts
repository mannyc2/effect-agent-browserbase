/**
 * What a page showed, and what changed on it, over a window of time.
 *
 * `capture` gathers a page's screencast frames over a window, what visibly changed on it and its
 * events in between, and on request its snapshot at the end. `toPrompt` turns a moment into one
 * user message for any `effect/ai` call: a structured answer from `LanguageModel.generateObject`,
 * a caption from `generateText`, or one turn of a `Chat` that follows moment after moment. It
 * leads with what changed, news before what keeps changing, and leaves out the steps that were
 * taken unless asked for them. Whether a model narrates better from changes than from steps is not
 * yet measured.
 *
 * Frames come from a running screencast, as far back as the browser's `frameHistory` keeps them.
 * The last frame is the page now: the newest frame while `Page.currentFrame` holds it current,
 * else a new screenshot timed by its capture.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Option, Schema } from "effect";
import { Prompt } from "effect/ai";

import { BrowserError, InvalidRequest } from "./BrowserError.ts";
import { type Action, BrowserEvent, type Subject, TrackEvent } from "./BrowserEvent.ts";
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
  /** What visibly changed after `from`, up to `at`; absent when the page could not say. */
  changes: Schema.optional(Changes),
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

  // The picture comes first and the changes are read up to it, so they end where it does; with a
  // running screencast it takes no round trip. The outline is taken alongside. A page that cannot
  // say what changed, such as one mid-navigation, still has a moment.
  const { picture, snapshot } = yield* Effect.all(
    {
      picture: page.currentFrame.pipe(
        Effect.flatMap((current) =>
          page
            .changes({
              // A moment that follows another continues its changes exactly where they ended.
              since:
                isMoment(options.since) && options.since.changes !== undefined
                  ? options.since.changes
                  : start(current.hostTime),
              until: current.hostTime,
            })
            .pipe(
              Effect.option,
              Effect.map((record) => ({ current, record })),
            ),
        ),
      ),
      snapshot:
        outline === false
          ? Effect.void
          : page.snapshot({ maxChars: 4000, ...(outline === true ? {} : outline) }),
    },
    { concurrency: 2 },
  );

  const { current, record } = picture;
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
    changes: Option.getOrUndefined(record),
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

/** Navigations are told by the `Navigated` event that follows them, which covers redirects. */
const navigating = (event: Action) => ["navigate", "back", "reload"].includes(event.name);

const quoted = (value: string | undefined) => JSON.stringify(value ?? "");

/** A change's context in words: `row "Ether", column "1h"` or `beside "Price", under "Bitcoin"`. */
const where = (change: Change, without?: "column") => {
  const { row, column, beside, heading } = change.context;

  const parts = [
    row === undefined ? "" : `row ${quoted(row)}`,
    column === undefined || without === "column" ? "" : `column ${quoted(column)}`,
    beside === undefined ? "" : `beside ${quoted(beside)}`,
    heading === undefined ? "" : `under ${quoted(heading)}`,
  ].filter((part) => part !== "");

  return parts.length === 0 ? "" : ` (${parts.join(", ")})`;
};

/** A change in words, such as `"$61,240" became "$62,010" (beside "Price")`. */
const describe = (change: Change, context = where(change)): string => {
  const { subject, before, after, count } = change;
  const label = subject.name === "" ? "" : `${named(subject, undefined)}: `;
  const shown = subject.role ?? subject.tag;
  const times = count > 1 ? ` (it changed ${count} times)` : "";

  switch (change.kind) {
    case "title":
      return before === undefined
        ? `the title now reads ${quoted(after)}`
        : `the title ${quoted(before)} became ${quoted(after)}`;
    case "value": {
      const field = named(subject, undefined);

      if (after === "checked" || after === "not checked") return `${field} is now ${after}`;
      if (after === "" || after === undefined) return `${field} was cleared`;

      return before === undefined || before === ""
        ? `${field} now reads ${quoted(after)}`
        : `${field} changed from ${quoted(before)} to ${quoted(after)}`;
    }
    case "appeared":
      return subject.role === null || subject.role === "heading"
        ? `${quoted(after)} appeared${context}`
        : `${shown}${subject.name === "" ? "" : ` ${quoted(subject.name)}`} appeared, reading ${quoted(after)}${context}`;
    case "disappeared":
      return `${quoted(before)} disappeared${context}`;
    case "brief":
      return `${quoted(after)} appeared and went away again${context}`;
    case "text":
      if (before === undefined || before === "")
        return `${label}now reads ${quoted(after)}${context}${times}`;
      if (before === after) return `${label}${quoted(after)} changed and changed back${context}`;

      return `${label}${quoted(before)} became ${quoted(after)}${context}${times}`;
  }
};

/** An element that changed more than once, or was already changing before the window. */
const inFlux = (change: Change) => change.count > 1 || change.earlier !== undefined;

export interface PromptOptions {
  /**
   * How actions appear. By default only those that the record of changes does not cover, such as
   * every action when the moment has none, are listed, as steps. `"all"` lists every action, and
   * then tells the whole moment in order of time, so a model can see what followed each one.
   */
  readonly actions?: "uncovered" | "all" | undefined;
}

/** Whether the moment's record of changes covers enough of it to tell; a new document's may not. */
const isRecorded = (moment: Moment) =>
  moment.changes !== undefined && moment.at - moment.changes.from >= 100;

/** At most this many lines of what changed; the least notable are counted, not listed. */
const maxLines = 24;

/** Text that changed in this many cells of one column or more is told as one line. */
const collapsedCells = 3;

/** The moment's changes and events as lines of text, most notable first. */
const account = (moment: Moment, options: PromptOptions) => {
  const all = options.actions === "all";
  const record = isRecorded(moment) ? moment.changes : undefined;
  const events = moment.events.filter((event) => !isTrackEvent(event));
  const lines: Array<{ readonly at: number; readonly rank: number; readonly text: string }> = [];

  // News first: what changed once and was not changing before; then what keeps changing, with the
  // cells of a table column that changed together told as one line.
  const columns = Map.groupBy(
    (record?.changes ?? []).filter(
      (change) => change.kind === "text" && change.context.column !== undefined,
    ),
    (change) => change.context.column ?? "",
  );

  const collapsed = new Set<Change>();

  for (const [column, cells] of columns) {
    const [first] = cells;

    if (cells.length < collapsedCells || first === undefined) continue;
    for (const cell of cells) collapsed.add(cell);
    lines.push({
      at: first.startedAt,
      rank: 3,
      text: `${cells.length} cells in column ${quoted(column)} changed, such as ${describe(first, where(first, "column"))}`,
    });
  }

  for (const change of record?.changes ?? [])
    if (!collapsed.has(change))
      lines.push({
        at: change.startedAt,
        rank: change.kind === "text" && inFlux(change) ? 3 : 2,
        text: describe(change),
      });

  for (const event of events)
    switch (event._tag) {
      case "Navigated":
        lines.push({ at: event.at, rank: 0, text: `the tab went to ${event.url}` });
        break;
      case "PageOpened":
        lines.push({ at: event.at, rank: 0, text: `a tab opened at ${event.url}` });
        break;
      case "PageClosed":
        lines.push({ at: event.at, rank: 0, text: "the tab closed" });
        break;
      case "DialogShown":
        lines.push({
          at: event.at,
          rank: 1,
          text: `a dialog (${event.kind}) said ${JSON.stringify(event.message)}`,
        });
        break;
      case "Action":
        if (
          event.page === moment.page &&
          !(event.ok && navigating(event)) &&
          (all || record === undefined || event.at <= record.from)
        )
          lines.push({ at: event.at, rank: 4, text: step(event) });
    }

  // Steps, and the whole moment when every step is told, read best in order of time.
  const ordered = lines.toSorted((left, right) =>
    record === undefined || all ? left.at - right.at : left.rank - right.rank || left.at - right.at,
  );

  const kept = ordered.slice(0, maxLines);
  const more = ordered.length - kept.length;
  const changed = (record?.changes ?? []).map((change) => change.at);
  const begins = record === undefined ? moment.from : Math.max(moment.from, record.from);

  const stillness =
    record === undefined
      ? "What changed on the page was not recorded; the screenshots show it."
      : changed.length === 0
        ? `No text in view changed${begins > moment.from ? ` after ${seconds(moment, begins)}` : " in the window"}.`
        : `The text in view last changed at ${seconds(moment, Math.max(...changed))}.`;

  return [
    ...kept.map((line) => `${seconds(moment, line.at)} ${line.text}`),
    ...(kept.length === 0 && record === undefined ? ["(no events in the window)"] : []),
    ...(more > 0 ? [`…and ${more} less notable`] : []),
    stillness,
    ...(record !== undefined && record.truncated > 0
      ? [
          `The page changed too much to keep: at least ${record.truncated} more changes are not told.`,
        ]
      : []),
    ...(record !== undefined && begins > moment.from
      ? [`Changes before ${seconds(moment, begins)} were not recorded.`]
      : []),
  ];
};

/**
 * The moment as one user message: the page's outline when the moment has one, what changed, most
 * notable first, the steps the record does not cover, and its frames captioned with their times, the
 * last one "the moment". Give a model its task with `Prompt.setSystem`, and add what the caller
 * knows about the page as more text.
 */
export const toPrompt = (moment: Moment, options: PromptOptions = {}): Prompt.Prompt => {
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
            `${isRecorded(moment) && options.actions !== "all" ? "What changed, most notable first" : "What happened"} (seconds before the moment, over ${((moment.at - moment.from) / 1000).toFixed(1)}s):`,
            ...account(moment, options),
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
