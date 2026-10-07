/**
 * What a page showed, and what changed on it, over a window of time.
 *
 * `capture` gathers a page's screencast frames over a window, what visibly changed on it and its
 * events in between, and on request its snapshot at the end. `toPrompt` turns a moment into one
 * user message for any `effect/ai` call: a structured answer from `LanguageModel.generateObject`,
 * a caption from `generateText`, or one turn of a `Chat` that follows moment after moment. It
 * leads with what changed, most notable first, and names an action only as the cause of a change,
 * so a model retells what happened rather than the steps that were taken.
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
import { Change } from "./Change.ts";
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
  /** What visibly changed after `from`, up to `at`, oldest first; absent when the page could not say. */
  changes: Schema.optional(Schema.Array(Change)),
  /** Where the record of changes begins when that is after `from`: earlier changes are unknown. */
  changesFrom: Schema.optional(Schema.Finite),
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

  // The picture, the changes and the outline each take a round trip to the page, so they are taken
  // together. A page that cannot say what changed, such as one mid-navigation, still has a moment.
  const { current, snapshot, record } = yield* Effect.all(
    {
      current: page.currentFrame,
      snapshot:
        outline === false
          ? Effect.void
          : page.snapshot({ maxChars: 4000, ...(outline === true ? {} : outline) }),
      record: page
        .changes(isMoment(options.since) ? options.since.at : undefined)
        .pipe(Effect.option),
    },
    { concurrency: 3 },
  );

  const at = current.hostTime;
  const from = start(at);
  const changesFrom = Option.map(record, (changes) => changes.from);

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
    changes: Option.getOrUndefined(
      Option.map(record, (changes) =>
        changes.changes.filter((change) => change.at > from && change.at <= at),
      ),
    ),
    changesFrom: Option.getOrUndefined(Option.filter(changesFrom, (begins) => begins > from)),
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

/** An action as the cause of what followed it: `a click on button "Refresh"`. */
const cause = (event: Action): string => {
  const target = acted(event);
  const on = target === "" ? "" : ` ${target}`;

  switch (event.name) {
    case "click":
      return `a click${target === "" ? "" : ` on ${target}`}`;
    case "hover":
      return `hovering${target === "" ? "" : ` over ${target}`}`;
    case "press":
      return `pressing ${event.target ?? "a key"}`;
    case "type":
      return `typing${target === "" ? "" : ` into ${target}`}`;
    case "select":
      return `choosing ${JSON.stringify(event.text ?? "")}${target === "" ? "" : ` in ${target}`}`;
    case "scroll":
      return "a scroll";
    case "drag":
      return `dragging${on}`;
    default:
      return `${event.name}${on}`;
  }
};

/** Navigations are told by the `Navigated` event that follows them, which covers redirects. */
const navigating = (event: Action) => ["navigate", "back", "reload"].includes(event.name);

/** An action on one of these shows its effect only in pictures, which no change records. */
const opaque = new Set(["canvas", "iframe", "video", "embed", "object", "svg"]);

/** How long after an action ends a change can still be its effect. */
const causeMillis = 1000;

/** One element's changes over the window: what it said at the start, then each later value. */
interface Chain {
  readonly first: Change;
  readonly values: Array<string | undefined>;
  last: Change;
  count: number;
}

const sameElement = (left: Change, right: Change) =>
  left.kind === right.kind &&
  left.context === right.context &&
  left.subject.role === right.subject.role &&
  left.subject.name === right.subject.name &&
  left.subject.tag === right.subject.tag;

/**
 * Gather each element's successive changes, so a price that ticked becomes one line of values.
 * A change continues a chain only where the chain's last value is its first, so two elements that
 * read alike stay apart. Appearances and disappearances are each their own.
 */
const chains = (changes: ReadonlyArray<Change>): ReadonlyArray<Chain> => {
  const all: Array<Chain> = [];

  for (const change of changes) {
    const chain =
      change.kind === "appeared" || change.kind === "disappeared"
        ? undefined
        : all.findLast(
            (open) => sameElement(open.last, change) && open.values.at(-1) === change.before,
          );

    if (chain === undefined)
      all.push({
        first: change,
        values: [change.before, change.after],
        last: change,
        count: change.count,
      });
    else {
      chain.values.push(change.after);
      chain.last = change;
      chain.count += change.count;
    }
  }

  return all;
};

const quoted = (value: string | undefined) => JSON.stringify(value ?? "");

/** A run of values, eliding the middle past five of them: `"1" became "2", then "3"`. */
const run = (values: ReadonlyArray<string | undefined>): string => {
  const [first, ...later] = values;
  const last = later.at(-1);
  const middle = later.slice(0, -1);

  const between =
    middle.length <= 3
      ? middle.map((value) => `${quoted(value)}, then `).join("")
      : `${middle
          .slice(0, 2)
          .map((value) => `${quoted(value)}, then `)
          .join("")}… then `;

  return first === undefined
    ? `now reads ${quoted(last)}`
    : `${quoted(first)} became ${between}${quoted(last)}`;
};

const describe = (chain: Chain): string => {
  const { first, last, values } = chain;
  const where = first.context === "" ? "" : ` (${first.context})`;
  const subject = first.subject;
  const label = subject.name === "" ? "" : `${named(subject, undefined)}: `;
  const shown = subject.role ?? subject.tag;

  switch (first.kind) {
    case "title":
      return `the title ${run(values)}`;
    case "value": {
      const after = last.after ?? "";
      const field = named(subject, undefined);

      if (after === "checked" || after === "not checked") return `${field} is now ${after}`;
      if (after === "") return `${field} was cleared`;

      return values[0] === undefined || values[0] === ""
        ? `${field} now reads ${quoted(after)}`
        : `${field} changed from ${quoted(values[0])} to ${quoted(after)}`;
    }
    case "appeared":
      return subject.role === null || subject.role === "heading"
        ? `${quoted(last.after)} appeared${where}`
        : `${shown}${subject.name === "" ? "" : ` ${quoted(subject.name)}`} appeared, reading ${quoted(last.after)}${where}`;
    case "disappeared":
      return `${quoted(first.before)} disappeared${where}`;
    case "text": {
      const changes = values.length - 1;
      const times = chain.count > changes ? ` (it changed ${chain.count} times)` : "";

      return `${label}${run(values)}${where}${times}`;
    }
  }
};

/** Most notable first: pages and navigation, dialogs, text, then fields and what came and went. */
const rank = (kind: Change["kind"]): number => (kind === "text" || kind === "title" ? 2 : 3);

export interface PromptOptions {
  /**
   * How actions appear. `"causes"`, the default, names an action only as the cause of a change that
   * followed it, and lists on its own only one whose effect no change could show, such as a click
   * on a canvas. `"all"` lists every action as a step too, and `"none"` leaves actions out. Where
   * the moment has no record of changes, actions are listed as steps unless `"none"`.
   */
  readonly actions?: "causes" | "all" | "none" | undefined;
}

/** Whether the moment's record of changes covers enough of it to tell; a new document's may not. */
const isRecorded = (moment: Moment) =>
  moment.changes !== undefined && moment.at - (moment.changesFrom ?? moment.from) >= 100;

/** At most this many lines of what changed; the least notable are counted, not listed. */
const maxLines = 24;

/** The moment's changes and events as lines of text, most notable first. */
const account = (moment: Moment, options: PromptOptions) => {
  const mode = options.actions ?? "causes";
  const watchedFrom = moment.changesFrom ?? moment.from;
  const recorded = isRecorded(moment);
  const watched = (at: number) => recorded && at > watchedFrom;
  const events = moment.events.filter((event) => !isTrackEvent(event));

  const actions = events.filter(
    (event): event is Action => event._tag === "Action" && event.page === moment.page,
  );

  const causes = new Set<Action>();

  // The latest action begun by `at`, when it worked and ended no more than `causeMillis` before.
  const causeOf = (at: number): Action | undefined => {
    if (mode === "none") return undefined;
    const latest = actions.findLast((action) => action.startedAt <= at);

    if (
      latest === undefined ||
      !latest.ok ||
      !latest.dispatched ||
      navigating(latest) ||
      at - latest.at > causeMillis
    )
      return undefined;
    causes.add(latest);

    return latest;
  };

  const after = (at: number) => {
    const action = causeOf(at);

    return action === undefined ? "" : `, after ${cause(action)}`;
  };

  const lines: Array<{ readonly at: number; readonly rank: number; readonly text: string }> = [];

  for (const chain of chains(moment.changes ?? []))
    lines.push({
      at: chain.first.startedAt,
      rank: rank(chain.first.kind),
      // A field's new value already says what was typed or chosen.
      text: `${describe(chain)}${chain.first.kind === "value" ? "" : after(chain.first.startedAt)}`,
    });

  for (const event of events)
    switch (event._tag) {
      case "Navigated":
        lines.push({
          at: event.at,
          rank: 0,
          text: `the tab went to ${event.url}${after(event.at)}`,
        });
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
          text: `a dialog (${event.kind}) said ${JSON.stringify(event.message)}${after(event.at)}`,
        });
        break;
      case "Action":
    }

  for (const action of actions) {
    if (mode === "none" || (action.ok && navigating(action))) continue;
    if (mode === "causes" && causes.has(action)) continue;

    const blind =
      action.ok &&
      action.subject !== undefined &&
      opaque.has(action.subject.role ?? action.subject.tag);

    if (mode === "all" || !watched(action.at) || blind)
      lines.push({ at: action.at, rank: 4, text: step(action) });
  }

  // Without a record of changes the lines are steps and events, which read best in order.
  const ordered = lines.toSorted((left, right) =>
    recorded ? left.rank - right.rank || left.at - right.at : left.at - right.at,
  );

  const kept = ordered.slice(0, maxLines);
  const more = ordered.length - kept.length;

  const changed = (moment.changes ?? []).map((change) => change.at);
  const last = Math.max(...changed);

  const stillness = !recorded
    ? "What changed on the page was not recorded; the screenshots show it."
    : changed.length === 0
      ? `No text in view changed${moment.changesFrom === undefined ? " in the window" : ` after ${seconds(moment, watchedFrom)}`}.`
      : `The text in view last changed at ${seconds(moment, last)}.`;

  return [
    ...kept.map((line) => `${seconds(moment, line.at)} ${line.text}`),
    ...(kept.length === 0 && !recorded ? ["(no events in the window)"] : []),
    ...(more > 0 ? [`…and ${more} less notable`] : []),
    stillness,
    ...(recorded && moment.changesFrom !== undefined
      ? [`Changes before ${seconds(moment, moment.changesFrom)} were not recorded.`]
      : []),
  ];
};

/**
 * The moment as one user message: the page's outline when the moment has one, what changed, most
 * notable first, with the actions that caused it, and its frames captioned with their times, the
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
            `${isRecorded(moment) ? "What changed, most notable first" : "What happened"} (seconds before the moment, over ${((moment.at - moment.from) / 1000).toFixed(1)}s):`,
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
