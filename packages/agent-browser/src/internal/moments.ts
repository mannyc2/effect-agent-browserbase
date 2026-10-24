/**
 * A run's thread as a recording of its page: before each turn, a `Moment` of the current tab
 * since the one before, placed after that turn's tool results, so the model reads its session in
 * order, each action followed by what the page did. Stable accounts belong to the prepared
 * thread, so Yielded can compact them. The latest few moments' pictures are labeled references
 * outside compaction coverage: retiring pictures never changes an already compacted prefix.
 */
import { AgentInputError } from "@yielded/agent/agent-error";
import type { RunContextRequest } from "@yielded/agent/run-options";
import { Duration, Effect, Ref } from "effect";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Image } from "effect-browser/Frame";
import * as Moment from "effect-browser/Moment";
import type * as Page from "effect-browser/Page";
import { Prompt } from "effect/ai";

import * as AdapterState from "../AdapterState.ts";

/** Frames in a moment, spread over it and ending with the page as it is. */
const framesPerMoment = 3;

/** At most this many crops are shown at once: the latest. */
const maxZooms = 8;

const text = (value: string) => Prompt.makePart("text", { text: value });

const file = (image: Image) =>
  Prompt.makePart("file", { mediaType: image.mediaType, data: image.data });

/** The crops taken since the last turn as the model is shown them: the latest, each with its origin. */
export const cropped = (
  crops: ReadonlyArray<Page.Zoom>,
  page: string,
): ReadonlyArray<Prompt.UserMessagePart> => {
  const current = crops.filter((crop) => crop.page === page);
  const kept = current.slice(-maxZooms);

  return [
    ...kept.flatMap(({ region, image }) => [
      text(
        `Zoom: viewport origin (${region.x}, ${region.y}), ${region.width}x${region.height} CSS pixels. Add this origin to a point in the crop for a viewport click.`,
      ),
      file(image),
    ]),
    ...(current.length > kept.length
      ? [text(`${current.length - kept.length} earlier crops were left out.`)]
      : []),
  ];
};

/** A moment's stable account and its separately retained, time-labeled pictures. */
const shown = (moment: Moment.Moment, crops: ReadonlyArray<Page.Zoom>, turn: number) => {
  const label = text(
    `Moment before turn ${turn}. Pictures mentioned below are separate references, shown only for the latest three moments.`,
  );

  // The moment's one message: its account of what happened, then each frame with its time.
  const [message] = Moment.toPrompt(moment).content;
  const [account, ...frames] = message?.role === "user" ? message.content : [];
  const last = moment.frames.at(-1);
  const shownCrops = cropped(crops, moment.page);

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

/**
 * Context preparation that shows the model, after each turn's tool results, the moment of the tab
 * `look` finds since the previous one, with the crops `crops` hands over; `onMoment` is called
 * with each moment as it is first shown. A turn tried again is shown the same moment.
 */
export const make = Effect.fnUntraced(function* (
  look: Effect.Effect<Page.Page, BrowserError>,
  crops: Effect.Effect<ReadonlyArray<Page.Zoom>>,
  onMoment: (moment: Moment.Moment) => Effect.Effect<void>,
  initial: AdapterState.Moments = AdapterState.moments(),
) {
  const state = yield* Ref.make(initial);

  const capture = Effect.fnUntraced(
    function* (previous: Moment.Window | undefined) {
      const page = yield* look;

      const moment = yield* Moment.capture(page, {
        // Consecutive moments of one tab neither repeat nor miss what happened between them.
        since: previous?.page === page.id ? previous : Duration.seconds(5),
        frames: framesPerMoment,
      });

      // Core moments may carry partial read failures. A lost page or no picture cannot serve
      // as the evidence for another agent turn, even when older frames remain in the window.
      const unavailable = moment.missing.find(
        (error) => error.reason._tag === "Closed" || moment.frames.length === 0,
      );

      if (unavailable !== undefined) return yield* unavailable;

      return moment;
    },
    Effect.mapError((error) => new AgentInputError({ message: error.message })),
  );

  const take = (request: RunContextRequest) =>
    Effect.gen(function* () {
      const known = yield* Ref.get(state);

      if (known.placed.some((moment) => moment.turn === request.turnId)) return known;

      const taken = yield* capture(known.previous);
      const moment = shown(taken, yield* crops, request.turn);

      const all = AdapterState.place(
        known,
        {
          turn: request.turnId,
          after: request.source.content.length,
          message: moment.account,
        },
        moment.pictures,
        moment.previous,
      );

      yield* Ref.set(state, all);
      yield* onMoment(taken);

      return all;
    });

  return {
    hook: {
      prepare: (request: RunContextRequest) =>
        Effect.map(take(request), ({ placed }) => ({
          prompt: AdapterState.weave(request.source, placed),
        })),
    },
    transientContext: {
      load: (request: RunContextRequest) =>
        Effect.map(take(request), ({ recent }) => Prompt.fromMessages(recent)),
    },
  };
});
