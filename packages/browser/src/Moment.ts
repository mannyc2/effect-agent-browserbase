/**
 * What a page showed, and what happened on it, around one point in time.
 *
 * `capture` gathers screencast frames from the last few seconds, a viewport snapshot and the
 * browser's events over the same window. `describe` gives all of it to a vision model in one call
 * and returns a structured account: by default a `Description`, or any schema the caller passes,
 * such as one with a field for a video prompt.
 *
 * Frames come from a running screencast. Without one, `capture` takes a single screenshot.
 *
 * @since 0.3.0
 */
import { Effect, Schema } from "effect";
import { type AiError, LanguageModel, Prompt } from "effect/ai";

import { Browser } from "./Browser.ts";
import type { BrowserError } from "./BrowserError.ts";
import { BrowserEvent, TrackEvent } from "./BrowserEvent.ts";
import { Frame, Screenshot } from "./Frame.ts";
import * as Usage from "./internal/usage.ts";
import type * as Page from "./Page.ts";
import { Snapshot } from "./Snapshot.ts";

const isTrackEvent = Schema.is(TrackEvent);

export class Moment extends Schema.Class<Moment>("effect-browser/Moment")({
  /** Host monotonic milliseconds on the owning browser’s clock. */
  at: Schema.Finite,
  page: Schema.String,
  /** Oldest first; the last frame is the page as it was at `at`. */
  frames: Schema.Array(Frame),
  snapshot: Snapshot,
  /** The page’s events in the window, oldest first, without the input presentation track. */
  events: Schema.Array(BrowserEvent),
}) {
  /** The events as lines of text, timed relative to `at`. */
  get timeline(): string {
    // A navigation that worked also appears as `Navigated`, which covers redirects and in-page moves.
    const shown = this.events
      .filter((event) => !isTrackEvent(event))
      .filter(
        (event) =>
          !(
            event._tag === "Action" &&
            event.ok &&
            ["navigate", "back", "reload"].includes(event.name)
          ),
      );

    const lines = shown.map((event) => {
      const when = `${((event.at - this.at) / 1000).toFixed(1)}s`;

      switch (event._tag) {
        case "Action": {
          const target =
            event.target ??
            (event.x === undefined
              ? ""
              : `(${Math.round(event.x)}, ${event.y === undefined ? "?" : Math.round(event.y)})`);

          const text = event.text === undefined ? "" : ` ${JSON.stringify(event.text)}`;
          const outcome = event.ok ? "" : ` (failed: ${event.error ?? "unknown"})`;

          return `${when} ${event.name} ${target}${text}${outcome}`.replace(/\s+/g, " ").trim();
        }
        case "Navigated":
          return `${when} navigated to ${event.url}`;
        case "PageOpened":
          return `${when} a tab opened at ${event.url}`;
        case "PageClosed":
          return `${when} the tab closed`;
        case "DialogShown":
          return `${when} a ${event.kind} dialog said ${JSON.stringify(event.message)}`;
      }
    });

    return lines.length === 0 ? "(nothing happened in the window)" : lines.join("\n");
  }
}

export interface CaptureOptions {
  /** How far back to look. Defaults to 5 seconds. */
  readonly windowMillis?: number | undefined;
  /** Frames to keep, spread evenly over the window and ending with the newest. Defaults to 2. */
  readonly frames?: number | undefined;
  /** Bound on the snapshot. Defaults to 4,000 characters. */
  readonly snapshotChars?: number | undefined;
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
  const browser = yield* Browser;
  const at = yield* browser.now;
  const since = at - (options.windowMillis ?? 5000);

  const recent = (yield* page.recentFrames).filter(
    (frame) => frame.hostTime >= since && frame.hostTime <= at,
  );

  const snapshot = yield* page.snapshot({ maxChars: options.snapshotChars ?? 4000 });
  let frames = spread(recent, options.frames ?? 2);

  if (frames.length === 0) {
    const startedAt = yield* browser.now;
    const image = yield* page.screenshot({ fresh: true });
    const finishedAt = yield* browser.now;

    frames = [
      new Frame({
        page: page.id,
        data: image.data,
        timing: new Screenshot({
          hostTime: startedAt + (finishedAt - startedAt) / 2,
          uncertaintyMillis: Math.max(0, (finishedAt - startedAt) / 2),
        }),
        receivedAt: finishedAt,
        width: image.width,
        height: image.height,
      }),
    ];
  }

  const events = (yield* browser.recentEvents).filter(
    (event) =>
      event.at >= since && !isTrackEvent(event) && "page" in event && event.page === page.id,
  );

  return new Moment({ at, page: page.id, frames, snapshot, events });
});

export class Description extends Schema.Class<Description>("effect-browser/Description")({
  summary: Schema.String.annotate({
    description: "One or two sentences: what the screen shows and what is happening on it",
  }),
  activity: Schema.String.annotate({
    description: "What the person or agent at the browser is doing right now",
  }),
  change: Schema.String.annotate({
    description: "What changed over the frames and events, or 'nothing'",
  }),
  subjects: Schema.Array(Schema.String).annotate({
    description: "The most important things on screen, most prominent first",
  }),
  mood: Schema.String.annotate({
    description: "The feel of the moment, such as tense, celebratory or calm",
  }),
}) {}

export interface DescribeOptions {
  /** What the description is for, and anything to pay special attention to. */
  readonly instructions?: string | undefined;
}

const prompt = (moment: Moment, instructions: string | undefined): Prompt.Prompt => {
  const last = moment.frames.length - 1;

  return Prompt.fromMessages([
    Prompt.makeMessage("system", {
      content: [
        "You describe one moment of a browser session from screenshots, the page's text and a timeline of what was done.",
        "Describe only what the material shows. Prefer concrete details: numbers, names, colours, positions and motion.",
        ...(instructions === undefined ? [] : [instructions]),
      ].join("\n"),
    }),
    Prompt.makeMessage("user", {
      content: [
        Prompt.makePart("text", {
          text: [
            moment.snapshot.rendered,
            "",
            "Timeline (seconds before the moment):",
            moment.timeline,
            "",
            `${moment.frames.length} screenshot${moment.frames.length === 1 ? "" : "s"} follow, oldest first; the last one is the moment itself.`,
          ].join("\n"),
        }),
        ...moment.frames.flatMap((frame, index) => [
          Prompt.makePart("text", {
            text:
              index === last
                ? "The moment:"
                : `${((frame.hostTime - moment.at) / 1000).toFixed(1)}s:`,
          }),
          Prompt.makePart("file", { mediaType: "image/jpeg", data: frame.data }),
        ]),
      ],
    }),
  ]);
};

/** A model's account of a moment, and what the call cost. */
export interface Described<A> {
  readonly value: A;
  readonly usage: Usage.Usage;
}

/** Describe a moment as a `Description`. */
export function describe(
  moment: Moment,
  options?: DescribeOptions,
): Effect.Effect<Described<Description>, AiError.AiError, LanguageModel.LanguageModel>;

/** Describe a moment in the shape of `schema`. */
export function describe<A, I extends Record<string, unknown>>(
  moment: Moment,
  options: DescribeOptions & { readonly schema: Schema.Codec<A, I> },
): Effect.Effect<Described<A>, AiError.AiError, LanguageModel.LanguageModel>;

export function describe(
  moment: Moment,
  options: DescribeOptions & {
    readonly schema?: Schema.Codec<unknown, Record<string, unknown>>;
  } = {},
) {
  return LanguageModel.generateObject({
    prompt: prompt(moment, options.instructions),
    schema: options.schema ?? Description,
    objectName: "moment",
  }).pipe(
    Effect.map((response) => ({
      value: response.value,
      usage: Usage.add(Usage.empty, response.usage),
    })),
    Effect.withSpan("Moment.describe"),
  );
}

/** Capture the page's current moment and describe it. */
export const describeNow = (
  page: Page.Page,
  options: CaptureOptions & DescribeOptions = {},
): Effect.Effect<
  Described<Description>,
  AiError.AiError | BrowserError,
  Browser | LanguageModel.LanguageModel
> => capture(page, options).pipe(Effect.flatMap((moment) => describe(moment, options)));
