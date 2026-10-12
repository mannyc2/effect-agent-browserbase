/**
 * A run's thread as a recording of its page: before each turn, a `Moment` of the current tab
 * since the one before, placed after that turn's tool results, so the model reads its session in
 * order, each action followed by what the page did. Stable accounts belong to the prepared
 * thread, so Yielded can compact them. The latest few moments' pictures are labeled references
 * outside compaction coverage: retiring pictures never changes an already compacted prefix.
 */
import type { RunContextRequest } from "@yielded/agent/run-options";
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

/** One immutable account where it sits in the thread. No image data survives here. */
interface Placed {
  readonly turn: string;
  /** How many of the run's messages come before it. */
  readonly after: number;
  readonly message: Prompt.UserMessage;
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

/** A moment's stable account and its separately retained, time-labeled pictures. */
const shown = (
  taken: Result.Result<{ readonly page: string; readonly moment: Moment.Moment }, BrowserError>,
  crops: ReadonlyArray<Page.Zoom>,
  turn: number,
) => {
  const label = text(
    `Moment before turn ${turn}. Pictures mentioned below are separate references, shown only for the latest three moments.`,
  );

  if (Result.isFailure(taken)) {
    const account = Prompt.userMessage({
      content: [label, text(`(No moment of the current tab: ${taken.failure.message})`)],
    });

    return { previous: undefined, account, pictures: Prompt.userMessage({ content: [] }) };
  }
  const { moment } = taken.success;
  // The moment's one message: its account of what happened, then each frame with its time.
  const [message] = Moment.toPrompt(moment).content;
  const [account, ...frames] = message?.role === "user" ? message.content : [];
  const last = moment.frames.at(-1);
  const shownCrops = cropped(crops);

  const pictures = [
    label,
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

  return {
    // Window keeps the page-clock change cursor as well as the host timestamp. No image bytes
    // or input events are needed to start the next window exactly where this one ended.
    previous: new Moment.Window({
      page: moment.page,
      since: moment.since,
      until: moment.until,
      changes: moment.changes,
      frames: [],
      events: [],
      missing: [],
    }),
    pictures: Prompt.userMessage({ content: pictures }),
    account: Prompt.userMessage({ content: [label, ...(account === undefined ? [] : [account])] }),
  };
};

/** The run's messages with each account after the ones it followed. */
const woven = (source: Prompt.Prompt, placed: ReadonlyArray<Placed>) => {
  const messages: Array<Prompt.Message> = [];
  const end = source.content.length;
  let next = 0;

  const place = (at: number) => {
    let moment = placed[next];

    while (moment !== undefined && Math.min(moment.after, end) === at) {
      messages.push(moment.message);
      next++;
      moment = placed[next];
    }
  };

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
  const state = yield* Ref.make<{
    readonly placed: ReadonlyArray<Placed>;
    readonly recent: ReadonlyArray<Prompt.UserMessage>;
    readonly previous: Moment.Window | undefined;
  }>({ placed: [], recent: [], previous: undefined });

  const capture = (previous: Moment.Window | undefined) =>
    Effect.flatMap(look, (page) =>
      Moment.capture(page, {
        // Consecutive moments of one tab neither repeat nor miss what happened between them.
        since: previous?.page === page.id ? previous : Duration.seconds(5),
        frames: framesPerMoment,
      }).pipe(Effect.map((moment) => ({ page: page.id, moment }))),
    );

  const take = (request: RunContextRequest) =>
    Effect.gen(function* () {
      const known = yield* Ref.get(state);

      if (known.placed.some((moment) => moment.turn === request.turnId)) return known;

      const taken = yield* Effect.result(capture(known.previous));
      const moment = shown(taken, yield* crops, request.turn);

      const all = {
        placed: [
          ...known.placed,
          {
            turn: request.turnId,
            after: request.source.content.length,
            message: moment.account,
          },
        ],
        recent: [...known.recent, moment.pictures].slice(-pictured),
        previous: moment.previous,
      };

      yield* Ref.set(state, all);
      if (Result.isSuccess(taken)) yield* onMoment(taken.success.moment);

      return all;
    });

  return {
    hook: {
      prepare: (request: RunContextRequest) =>
        Effect.map(take(request), ({ placed }) => ({ prompt: woven(request.source, placed) })),
    },
    transientContext: {
      load: (request: RunContextRequest) =>
        Effect.map(take(request), ({ recent }) =>
          Prompt.fromMessages(recent.filter((message) => message.content.length > 0)),
        ),
    },
  };
});
