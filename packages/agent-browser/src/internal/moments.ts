/**
 * A run's thread as a recording of its page: before each turn, a `Moment` of the current tab
 * since the one before, placed after that turn's tool results, so the model reads its session in
 * order, each action followed by what the page did. The run's history never holds a moment:
 * context preparation places all of them again before every call, the same each time, since a
 * tool result cannot carry a picture to the model. A moment's account of what happened stays for
 * the whole run; its pictures only for the latest few, as pictures cost the most and the newest
 * show the page as it is.
 */
import type { RunContextHook } from "@yielded/agent/run-options";
import { Duration, Effect, Ref, Result } from "effect";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Image } from "effect-browser/Frame";
import * as Moment from "effect-browser/Moment";
import type * as Page from "effect-browser/Page";
import { Prompt } from "effect/ai";

/** Frames in a moment, spread over it and ending with the page as it is. */
const framesPerMoment = 3;

/** The moments whose pictures are shown: the latest. */
const pictured = 3;

/** At most this many crops are shown at once: the latest. */
const maxZooms = 8;

/** One moment where it sits in the thread, as the model is shown it with and without pictures. */
interface Placed {
  readonly turn: string;
  /** How many of the run's messages come before it. */
  readonly after: number;
  readonly page: string | undefined;
  readonly moment: Moment.Moment | undefined;
  readonly whole: ReadonlyArray<Prompt.UserMessagePart>;
  readonly told: ReadonlyArray<Prompt.UserMessagePart>;
}

const text = (value: string) => Prompt.makePart("text", { text: value });

const file = (image: Image) =>
  Prompt.makePart("file", { mediaType: image.mediaType, data: image.data });

/** The crops taken since the last turn as the model is shown them: the latest, each with its origin. */
export const cropped = (crops: ReadonlyArray<Page.Zoom>): ReadonlyArray<Prompt.UserMessagePart> => {
  const kept = crops.slice(-maxZooms);

  return [
    ...kept.flatMap(({ region, image }) => [
      text(
        `Zoom: viewport origin (${region.x}, ${region.y}), ${region.width}x${region.height} CSS pixels. Add this origin to a point in the crop for a viewport click.`,
      ),
      file(image),
    ]),
    ...(crops.length > kept.length
      ? [text(`${crops.length - kept.length} earlier crops were left out.`)]
      : []),
  ];
};

/** A moment as the model is shown it: whole, then, once older, its account alone. */
const shown = (
  taken: Result.Result<{ readonly page: string; readonly moment: Moment.Moment }, BrowserError>,
  crops: ReadonlyArray<Page.Zoom>,
) => {
  if (Result.isFailure(taken)) {
    const told = [text(`(No moment of the current tab: ${taken.failure.message})`)];

    return { page: undefined, moment: undefined, whole: told, told };
  }
  const { page, moment } = taken.success;
  // The moment's one message: its account of what happened, then each frame with its time.
  const [message] = Moment.toPrompt(moment).content;
  const [account, ...frames] = message?.role === "user" ? message.content : [];
  const last = moment.frames.at(-1);
  const shownCrops = cropped(crops);

  const whole = [
    ...(account === undefined ? [] : [account]),
    ...frames,
    ...(last === undefined
      ? []
      : [
          text(
            `These pictures are the tab's viewport, ${last.width}x${last.height}. Their pixel coordinates are viewport coordinates.`,
          ),
        ]),
    ...shownCrops,
  ];

  const pictures = moment.frames.length + shownCrops.filter((part) => part.type === "file").length;

  return {
    page,
    moment,
    whole,
    told: [
      ...(account === undefined ? [] : [account]),
      text(`(Its ${pictures} pictures are no longer shown.)`),
    ],
  };
};

/** The run's messages with each moment after the ones it followed, the latest with pictures. */
const woven = (source: Prompt.Prompt, placed: ReadonlyArray<Placed>) => {
  const messages: Array<Prompt.Message> = [];
  const firstPictured = placed.length - pictured;
  const end = source.content.length;

  const place = (at: number) =>
    placed.forEach((moment, index) => {
      if (Math.min(moment.after, end) === at)
        messages.push(
          Prompt.makeMessage("user", {
            content: index >= firstPictured ? moment.whole : moment.told,
          }),
        );
    });

  source.content.forEach((message, index) => {
    place(index);
    messages.push(message);
  });
  place(end);

  return Prompt.fromMessages(messages);
};

/**
 * Context preparation that shows the model, after each turn's tool results, the moment of the tab
 * `look` finds since the previous one, with the crops `crops` hands over; `onMoment` is called
 * with each moment as it is first shown. A turn tried again is shown the same moment.
 */
export const make = Effect.fnUntraced(function* (
  look: Effect.Effect<Page.Page, BrowserError>,
  crops: Effect.Effect<ReadonlyArray<Page.Zoom>>,
  onMoment: (moment: Moment.Moment) => Effect.Effect<void>,
) {
  const placed = yield* Ref.make<ReadonlyArray<Placed>>([]);

  const capture = (previous: Placed | undefined) =>
    Effect.flatMap(look, (page) =>
      Moment.capture(page, {
        // Consecutive moments of one tab neither repeat nor miss what happened between them.
        since:
          previous?.page === page.id && previous.moment !== undefined
            ? previous.moment
            : Duration.seconds(5),
        frames: framesPerMoment,
      }).pipe(Effect.map((moment) => ({ page: page.id, moment }))),
    );

  const prepare: RunContextHook["prepare"] = (request) =>
    Effect.gen(function* () {
      const known = yield* Ref.get(placed);

      if (known.some((moment) => moment.turn === request.turnId))
        return { prompt: woven(request.source, known) };

      const taken = yield* Effect.result(capture(known.at(-1)));
      const moment = shown(taken, yield* crops);

      const all = [
        ...known,
        { turn: request.turnId, after: request.source.content.length, ...moment },
      ];

      yield* Ref.set(placed, all);
      if (moment.moment !== undefined) yield* onMoment(moment.moment);

      return { prompt: woven(request.source, all) };
    });

  return { prepare } satisfies RunContextHook;
});
