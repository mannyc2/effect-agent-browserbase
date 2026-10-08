/**
 * What a page showed, and what changed on it, over a window of time.
 *
 * A page's timeline has three tracks on its browser's host clock: its events, what visibly changed
 * on it (`Change`), and its screencast frames. A `Window` holds the three from `since` to `until`,
 * and says why a part it could not read is missing rather than fail. `Page.window` takes one, which
 * can end in the past, at a frame a delayed consumer airs late, so that a line written now tells
 * what its viewers will see; `stillness` says how long a window's page had been still at its end.
 *
 * A `Moment` is a window that ends at a picture of the page now: `capture` takes the picture, then
 * the window up to it, and on request the page's outline. `toPrompt` turns a moment into one user
 * message for any `effect/ai` call: a structured answer from `LanguageModel.generateObject`, a
 * caption from `generateText`, or one turn of a `Chat` that follows moment after moment. It leads
 * with what changed, news before what keeps changing, and names an action as what a change
 * followed; as a step where changes followed it but none names it, or where its effect is drawn
 * rather than written, as on a canvas, which only the screenshots show; and claims nothing of what
 * changed where the record did not see, or of a part it could not read, which it names with why.
 *
 * Frames come from a running screencast, as far back as the browser's `frameHistory` keeps them.
 * A moment's picture is the newest frame if it was painted after the page's latest input and at
 * most 250 ms ago, else a new screenshot timed by its capture.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Option, Result, Schema } from "effect";
import { Prompt } from "effect/ai";

import { BrowserError, InvalidRequest } from "./BrowserError.ts";
import { type Action, BrowserEvent, type Subject, type SubjectContext } from "./BrowserEvent.ts";
import { type Change, Changes } from "./Change.ts";
import { Frame } from "./Frame.ts";
import { undispatched } from "./internal/page/context.ts";
import type * as Page from "./Page.ts";
import { Snapshot, type SnapshotOptions } from "./Snapshot.ts";

/** A page's events, changes and frames over one window of its browser's host clock. */
export class Window extends Schema.Class<Window>("effect-browser/Window")({
  page: Schema.String,
  /** Where the window starts, in host monotonic milliseconds on the owning browser’s clock. */
  since: Schema.Finite,
  /** Where it ends, never after it was taken. */
  until: Schema.Finite,
  /** The page's events after `since`, up to `until`, oldest first, without the input presentation track. */
  events: Schema.Array(BrowserEvent),
  /**
   * What visibly changed after `since`, up to `until`; absent where `missing` says why. A page's
   * first window starts its record, so the record sees none of it.
   */
  changes: Schema.optional(Changes),
  /** Screencast frames painted from `since` to `until`, oldest first, as far back as kept. */
  frames: Schema.Array(Frame),
  /**
   * Why each part that could not be read is missing: the read of its changes, by whatever
   * operation failed there, or a moment's picture (`frame`) or outline (`snapshot`).
   */
  missing: Schema.Array(BrowserError),
}) {}

/**
 * A window that ends at a picture of the page, its last frame, unless `missing` says why it has
 * none. Its frames are a few, spread over the window, so that it still begins where it starts.
 */
export class Moment extends Window.extend<Moment>("effect-browser/Moment")({
  /** The page's outline at the end of the window, when the capture asked for it. */
  snapshot: Schema.optional(Snapshot),
}) {}

export interface CaptureOptions {
  /**
   * Where the window starts, as for `Page.window`: a previous window or moment, so that consecutive
   * ones neither repeat nor miss an event or a change, or a `Duration` back from the picture.
   * Defaults to 5 seconds.
   */
  readonly since?: Page.WindowOptions["since"] | undefined;
  /** Frames to keep, at least 1, spread over the window and ending with the picture. Defaults to 2. */
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

export const capture = Effect.fn("Moment.capture")(function* (
  page: Page.Page,
  options: CaptureOptions = {},
) {
  const count = options.frames ?? 2;

  if (!Number.isSafeInteger(count) || count < 1)
    return yield* undispatched(
      "moment",
      new InvalidRequest({ detail: "frames must be a positive safe integer" }),
    );
  const outline = options.snapshot ?? false;

  // The picture comes first, at no call with a running screencast, and the window ends at its
  // paint, so its changes hold nothing it does not show; without one, the window ends now. The
  // outline is taken alongside. What cannot be read is missing from the moment, not its end.
  const { pictured, outlined } = yield* Effect.all(
    {
      pictured: Effect.result(page.frame({ after: "input" })).pipe(
        Effect.flatMap((picture) =>
          Effect.map(
            page.window({
              since: options.since ?? Duration.seconds(5),
              until: Result.getOrUndefined(picture),
              unmask: options.unmask,
            }),
            (window) => ({ window, picture }),
          ),
        ),
      ),
      outlined: Effect.result(
        outline === false
          ? Effect.void
          : page.snapshot({ maxChars: 4000, ...(outline === true ? {} : outline) }),
      ),
    },
    { concurrency: 2 },
  );

  const { window, picture } = pictured;
  const shown = Result.getOrUndefined(picture);

  return new Moment({
    ...window,
    frames: spread(
      shown === undefined
        ? window.frames
        : [...window.frames.filter((frame) => frame !== shown), shown],
      count,
    ),
    snapshot: Result.getOrUndefined(outlined) ?? undefined,
    missing: [
      ...window.missing,
      ...Option.toArray(Result.getFailure(picture)),
      ...Option.toArray(Result.getFailure(outlined)),
    ],
  });
});

/** A window's record of changes, if it saw any of the window: a page's first has none. */
const recordOf = ({ changes }: Window) =>
  changes !== undefined && changes.from < changes.until ? changes : undefined;

/**
 * How long, in milliseconds, the window's page had been still at its end: since the last change in
 * view its record shows, or the last paint its screencast frames show, or else since the window,
 * or its record, began. Undefined where neither could tell, with no record of the window and no
 * painted frame: a screenshot shows the page, not when it last changed. Frames show paint only
 * while a capture runs, and the record does not see a canvas, so a canvas that keeps drawing with
 * no capture running reads as still.
 */
export const stillness = (window: Window): number | undefined => {
  const record = recordOf(window);

  const stirred = [
    ...(record?.changes ?? []).flatMap((change) => (change.kind === "title" ? [] : [change.at])),
    ...window.frames.flatMap((frame) =>
      frame.timing._tag === "BrowserPaint" ? [frame.hostTime] : [],
    ),
  ];

  return record === undefined && stirred.length === 0
    ? undefined
    : window.until - Math.max(window.since, record?.from ?? window.since, ...stirred);
};

const seconds = (moment: Moment, at: number) => `${((at - moment.until) / 1000).toFixed(1)}s`;

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

/**
 * An action as a step: `click button "Pay"`. A failed one says only that: its error is advice for
 * the caller that acted, which may name a ref, not a fact about the page.
 */
const step = (event: Action): string => {
  const target = acted(event);
  const text = event.text === undefined ? "" : JSON.stringify(event.text);

  const what =
    event.name === "type" && target !== ""
      ? `${text} into ${target}`
      : event.name === "select" && target !== ""
        ? `${text} in ${target}`
        : `${target} ${text}`;

  return `${event.name} ${what}${event.ok ? "" : " (failed)"}`.replace(/\s+/g, " ").trim();
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

/**
 * The changes as lines, news first, and the actions they name; cells of one column that changed
 * together as one line.
 */
const changed = (moment: Moment, record: Changes) => {
  const actions = moment.events.filter((event): event is Action => event._tag === "Action");
  const named = new Set<Action>();

  // The action whose input a change followed: one that ran while the input arrived, give or take
  // the clock's mapping, so input the library did not send names no action.
  const cause = (change: Change) => {
    const input = change.cause;

    const action =
      input === undefined
        ? undefined
        : actions.findLast((event) => event.startedAt <= input + 100 && event.at >= input - 100);

    if (action === undefined) return "";
    named.add(action);

    return `, after ${step(action)}`;
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

  return { lines, named };
};

/** What a part a moment could not read was, by the operation that failed: a window's one read is its changes. */
const parts = new Map([
  ["frame", "A picture of the moment"],
  ["snapshot", "The page's outline"],
]);

/** The moment's changes and events as lines, most notable first when its changes are recorded. */
const account = (moment: Moment): ReadonlyArray<string> => {
  const record = recordOf(moment);

  const { lines, named } =
    record === undefined
      ? { lines: new Array<Line>(), named: new Set<Action>() }
      : changed(moment, record);

  // Whether anything but a field's own edit changed after an action began.
  const followed = (event: Action) =>
    record?.changes.some((change) => change.kind !== "value" && change.at > event.startedAt) ===
    true;

  // With a record, an action is told as a step where changes followed it and none names it, so a
  // click whose effect a busy page leaves uncredited is not lost; where its effect is drawn; or
  // where it started before the record began, as on the document a click opened. An attempt that
  // nothing followed, a failed one, a hover and a scroll are left out.
  const told = (event: Action) =>
    !(event.ok && ["navigate", "back", "reload"].includes(event.name)) &&
    (record === undefined ||
      event.startedAt <= record.from ||
      (event.ok &&
        event.name !== "scroll" &&
        (onDrawn(event) || (event.name !== "hover" && !named.has(event) && followed(event)))));

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
  const begins = record === undefined ? moment.since : Math.max(moment.since, record.from);
  const unread = moment.missing.some((error) => !parts.has(error.operation));

  return [
    ...kept.map((line) => `${seconds(moment, line.at)} ${line.text}`),
    ...(ordered.length > maxLines ? [`…and ${ordered.length - maxLines} less notable`] : []),
    ...(record === undefined
      ? unread
        ? []
        : ["What changed on the page was not recorded."]
      : record.changes.length > 0
        ? []
        : [
            `No text in view changed${begins > moment.since ? ` after ${seconds(moment, begins)}` : ""}${drawing ? "; what is drawn, such as a canvas, shows only in the screenshots" : ""}.`,
          ]),
    ...(record !== undefined && record.dropped > 0
      ? [
          `The page changed too much to tell it all: at least ${record.dropped} changes are not told.`,
        ]
      : []),
    ...(begins > moment.since
      ? [`Changes before ${seconds(moment, begins)} are not all known.`]
      : []),
    ...moment.missing.map(
      (error) =>
        `${parts.get(error.operation) ?? "What changed on the page"} could not be read: ${error.reason.message}.`,
    ),
  ];
};

/**
 * The moment as one user message: the page's outline when the moment has one, what changed, most
 * notable first, with the actions that the changes followed, that changes followed though none
 * names them, or that drew what only the screenshots show, what could not be read and why, and its
 * frames captioned with their times, the last one "the moment" where it is the picture at its end.
 * Give a model its task with `Prompt.setSystem`, and add what the caller knows about the page as
 * more text.
 */
export const toPrompt = (moment: Moment): Prompt.Prompt => {
  const count = moment.frames.length;
  const last = count - 1;
  const pictured = moment.frames.at(-1)?.hostTime === moment.until;

  const following =
    count === 1 ? "One screenshot follows" : `${count} screenshots follow, oldest first`;

  return Prompt.fromMessages([
    Prompt.makeMessage("user", {
      content: [
        Prompt.makePart("text", {
          text: [
            "One moment of a browser session. Rely only on what this material shows, and prefer concrete details: numbers, names, colours, positions and motion.",
            "",
            ...(moment.snapshot === undefined ? [] : [moment.snapshot.rendered, ""]),
            `${recordOf(moment) === undefined ? "What happened" : "What changed, most notable first"} (seconds before the moment, over ${((moment.until - moment.since) / 1000).toFixed(1)}s):`,
            ...account(moment),
            ...(count === 0
              ? []
              : [
                  "",
                  `${following}${pictured ? (count === 1 ? ": the moment itself." : "; the last one is the moment itself.") : "."}`,
                ]),
          ].join("\n"),
        }),
        ...moment.frames.flatMap((frame, index) => [
          Prompt.makePart("text", {
            text:
              index === last && pictured ? "The moment:" : `${seconds(moment, frame.hostTime)}:`,
          }),
          Prompt.makePart("file", { mediaType: "image/jpeg", data: frame.data }),
        ]),
      ],
    }),
  ]);
};
