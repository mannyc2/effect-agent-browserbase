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
import type * as Page from "effect-browser/Page";
import { Moment } from "effect-browser/timeline";
import { Prompt } from "effect/ai";

import * as Moments from "../Moments.ts";

/** Frames in a moment, spread over it and ending with the page as it is. */
const framesPerMoment = 3;

const text = (value: string) => Prompt.makePart("text", { text: value });

/** A moment's stable account and its separately retained, time-labeled pictures. */
const shown = (
  moment: Moment.Moment,
  shownCrops: ReadonlyArray<Prompt.UserMessagePart>,
  turn: number,
) => {
  const label = text(
    `Moment before turn ${turn}. Pictures mentioned below are separate references, shown only for the latest three moments.`,
  );

  // The moment's one message: its account of what happened, then each frame with its time.
  const [message] = Moment.toPrompt(moment).content;
  const [account, ...frames] = message?.role === "user" ? message.content : [];
  const last = moment.frames.at(-1);

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
 * `look` finds since the previous one, with the crops `crops` hands over for its page; `onMoment`
 * is called with each moment as it is first shown. A turn tried again is shown the same moment.
 */
export const make = Effect.fnUntraced(function* (
  look: Effect.Effect<Page.Page, BrowserError>,
  crops: (page: string) => Effect.Effect<ReadonlyArray<Prompt.UserMessagePart>>,
  onMoment: (moment: Moment.Moment) => Effect.Effect<void>,
  initial: Moments.Moments = Moments.make(),
) {
  const state = yield* Ref.make(initial);

  const capture = Effect.fnUntraced(
    function* (previous: Moment.Window | undefined) {
      const page = yield* look;

      const moment = yield* Moment.read(page, {
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
      const moment = shown(taken, yield* crops(taken.page), request.turn);

      const all = Moments.place(
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
          prompt: Moments.weave(request.source, placed),
        })),
    },
    transientContext: {
      load: (request: RunContextRequest) =>
        Effect.map(take(request), ({ recent }) => Prompt.fromMessages(recent)),
    },
  };
});
