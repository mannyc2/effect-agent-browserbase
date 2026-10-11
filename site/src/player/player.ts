// A replay's player: loads a packed recording, plays its video with the narration, and follows the
// video's clock so the pointer, captions, timeline and feed show what happened at that instant.
// The video element is the one source of playback time; the Model mirrors it.
import { Effect, Option, Queue, Schema, Stream } from "effect";
import { HttpClient } from "effect/http";
import { Command, Http, Mount, type Update } from "foldkit";
import { defineTaggedUnion } from "foldkit/schema";
import { modifyFields } from "foldkit/struct";

import { Replay } from "../replay.ts";
import { currentEntry, Derived, derive } from "./derive.ts";
import { Message, Playback, Speed } from "./message.ts";

export { Message } from "./message.ts";

// MODEL

export const Load = defineTaggedUnion({
  Loading: {},
  Missing: { reason: Schema.String },
  Ready: { replay: Replay, derived: Derived },
});

export type Load = typeof Load.Type;

export const Model = Schema.Struct({
  id: Schema.String,
  load: Load,
  playback: Playback,
  /** The host time on screen. */
  now: Schema.Finite,
  speed: Speed,
  sound: Schema.Literals(["On", "Muted"]),
  captions: Schema.Literals(["Shown", "Hidden"]),
  /** The moment whose frames are open beneath its line. */
  maybeOpenMoment: Schema.Option(Schema.Int),
});

export type Model = typeof Model.Type;

/** Where a replay's files are served. */
export const baseOf = (id: string) => `/replays/${id}`;

export const videoIdOf = (id: string) => `replay-${id}-video`;

export const feedIdOf = (id: string) => `replay-${id}-feed`;

// COMMAND

export const LoadReplay = Command.define("LoadReplay", {
  args: { id: Schema.String },
  messages: [Message.SucceededLoadReplay, Message.FailedLoadReplay],
  execute: ({ id }) =>
    Effect.gen(function* () {
      const client = yield* HttpClient.HttpClient;
      const response = yield* client.get(`${baseOf(id)}/replay.json`);

      if (response.status !== 200 || response.headers["content-type"]?.includes("json") !== true)
        return Message.FailedLoadReplay({ reason: `${id} has not been recorded yet` });
      const replay = yield* Schema.decodeUnknownEffect(Replay)(yield* response.json);

      return Message.SucceededLoadReplay({ replay });
    }).pipe(
      Effect.orElseSucceed(() => Message.FailedLoadReplay({ reason: `${id} could not be read` })),
      Effect.provide(Http.layer),
    ),
});

const withVideo = <A>(videoId: string, use: (video: HTMLVideoElement) => A) =>
  Effect.sync(() => {
    const element = document.getElementById(videoId);

    return element instanceof HTMLVideoElement ? Option.some(use(element)) : Option.none();
  });

export const PlayVideo = Command.define("PlayVideo", {
  args: { videoId: Schema.String, fromStart: Schema.Boolean },
  messages: [Message.SucceededPlayVideo, Message.FailedPlayVideo],
  execute: ({ videoId, fromStart }) =>
    withVideo(videoId, (video) => {
      if (fromStart) video.currentTime = 0;

      return video;
    }).pipe(
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.succeed(Message.FailedPlayVideo({ reason: "No video on the page" })),
          onSome: (video) =>
            Effect.tryPromise(() => video.play()).pipe(
              Effect.as(Message.SucceededPlayVideo()),
              Effect.orElseSucceed(() =>
                Message.FailedPlayVideo({ reason: "The browser refused to play" }),
              ),
            ),
        }),
      ),
    ),
});

export const PauseVideo = Command.define("PauseVideo", {
  args: { videoId: Schema.String },
  messages: [Message.CompletedPauseVideo],
  execute: ({ videoId }) =>
    withVideo(videoId, (video) => video.pause()).pipe(Effect.as(Message.CompletedPauseVideo())),
});

export const SeekVideo = Command.define("SeekVideo", {
  args: { videoId: Schema.String, seconds: Schema.Finite },
  messages: [Message.CompletedSeekVideo],
  execute: ({ videoId, seconds }) =>
    withVideo(videoId, (video) => {
      video.currentTime = seconds;
    }).pipe(Effect.as(Message.CompletedSeekVideo())),
});

export const SetPlaybackRate = Command.define("SetPlaybackRate", {
  args: { videoId: Schema.String, rate: Speed },
  messages: [Message.CompletedSetPlaybackRate],
  execute: ({ videoId, rate }) =>
    withVideo(videoId, (video) => {
      video.defaultPlaybackRate = rate;
      video.playbackRate = rate;
    }).pipe(Effect.as(Message.CompletedSetPlaybackRate())),
});

export const SetMuted = Command.define("SetMuted", {
  args: { videoId: Schema.String, muted: Schema.Boolean },
  messages: [Message.CompletedSetMuted],
  execute: ({ videoId, muted }) =>
    withVideo(videoId, (video) => {
      video.muted = muted;
    }).pipe(Effect.as(Message.CompletedSetMuted())),
});

/** Keeps the current entry a third of the way down the feed, scrolling the feed alone. */
export const ScrollFeed = Command.define("ScrollFeed", {
  args: { feedId: Schema.String, index: Schema.Int },
  messages: [Message.CompletedScrollFeed],
  execute: ({ feedId, index }) =>
    Effect.sync(() => {
      const feed = document.getElementById(feedId);
      const item = feed?.children[index];

      feed?.scrollTo({
        top: item instanceof HTMLElement ? item.offsetTop - feed.clientHeight / 3 : 0,
        behavior: "smooth",
      });

      return Message.CompletedScrollFeed();
    }),
});

// MOUNT

type Watched =
  | typeof Message.UpdatedPlayhead.Type
  | typeof Message.UpdatedPlayback.Type
  | typeof Message.LoadedVideo.Type;

/**
 * Follows the video element while it is in the page: its time on every animation frame that
 * moved it, and its play, pause and end events.
 */
export const WatchVideo = Mount.defineStream("WatchVideo", {
  messages: [Message.UpdatedPlayhead, Message.UpdatedPlayback, Message.LoadedVideo],
  execute: ({ element }) => {
    if (!(element instanceof HTMLVideoElement)) return Stream.empty;
    const video = element;

    const events = Stream.callback<Watched>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const send = (message: Watched) => () => Queue.offerUnsafe(queue, message);

          const listeners = [
            ["play", send(Message.UpdatedPlayback({ playback: "Playing" }))],
            [
              "pause",
              () => !video.ended && send(Message.UpdatedPlayback({ playback: "Paused" }))(),
            ],
            ["ended", send(Message.UpdatedPlayback({ playback: "Ended" }))],
            ["loadedmetadata", send(Message.LoadedVideo())],
            ["seeked", () => send(Message.UpdatedPlayhead({ seconds: video.currentTime }))()],
          ] as const;

          const state = { frame: 0, last: -1 };

          const tick = () => {
            if (video.currentTime !== state.last) {
              state.last = video.currentTime;
              send(Message.UpdatedPlayhead({ seconds: video.currentTime }))();
            }
            state.frame = requestAnimationFrame(tick);
          };

          for (const [name, listener] of listeners) video.addEventListener(name, listener);
          state.frame = requestAnimationFrame(tick);

          return { listeners, state };
        }),
        ({ listeners, state }) =>
          Effect.sync(() => {
            cancelAnimationFrame(state.frame);
            for (const [name, listener] of listeners) video.removeEventListener(name, listener);
          }),
      ).pipe(Effect.andThen(Effect.never)),
    );

    return events;
  },
});

// INIT

export const init = (id: string) => ({
  model: Model.make({
    id,
    load: Load.Loading(),
    playback: "Paused",
    now: 0,
    speed: 1,
    sound: "On",
    captions: "Shown",
    maybeOpenMoment: Option.none(),
  }),
  commands: [LoadReplay({ id })],
});

// UPDATE

type UpdateReturn = Update.Return<Model, Message>;

/** Moves to host time `at`, held within the recording, and brings the feed's entry for it into view. */
const seek = (model: Model, at: number): UpdateReturn =>
  Load.match(model.load, {
    Loading: () => ({ model }),
    Missing: () => ({ model }),
    Ready: ({ replay, derived }) => {
      const { startsAt, durationMillis } = replay.video;
      const offset = Math.min(durationMillis, Math.max(0, at - startsAt));
      const before = currentEntry(derived.entries, model.now);
      const after = currentEntry(derived.entries, startsAt + offset);

      return {
        model: modifyFields(model, { now: () => startsAt + offset }),
        commands: [
          SeekVideo({ videoId: videoIdOf(model.id), seconds: offset / 1000 }),
          ...(before === after ? [] : [ScrollFeed({ feedId: feedIdOf(model.id), index: after })]),
        ],
      };
    },
  });

const followPlayhead = (model: Model, seconds: number): UpdateReturn =>
  Load.match(model.load, {
    Loading: () => ({ model }),
    Missing: () => ({ model }),
    Ready: ({ replay, derived }) => {
      const now = replay.video.startsAt + seconds * 1000;
      const before = currentEntry(derived.entries, model.now);
      const after = currentEntry(derived.entries, now);
      const next = modifyFields(model, { now: () => now });

      return before === after
        ? { model: next }
        : { model: next, commands: [ScrollFeed({ feedId: feedIdOf(model.id), index: after })] };
    },
  });

export const update = (model: Model, message: Message) =>
  Message.match<UpdateReturn>(message, {
    SucceededLoadReplay: ({ replay }) => ({
      model: modifyFields(model, {
        load: () => Load.Ready({ replay, derived: derive(replay) }),
        now: () => replay.video.startsAt,
        // A long agent run is mostly the model thinking; it starts at double speed.
        speed: () => (replay.video.durationMillis > 90_000 ? 2 : 1),
      }),
    }),
    FailedLoadReplay: ({ reason }) => ({
      model: modifyFields(model, { load: () => Load.Missing({ reason }) }),
    }),
    ClickedPlay: () => ({
      model,
      commands: [
        PlayVideo({ videoId: videoIdOf(model.id), fromStart: model.playback === "Ended" }),
      ],
    }),
    ClickedPause: () => ({ model, commands: [PauseVideo({ videoId: videoIdOf(model.id) })] }),
    SucceededPlayVideo: () => ({ model }),
    FailedPlayVideo: () => ({ model }),
    CompletedPauseVideo: () => ({ model }),
    CompletedSeekVideo: () => ({ model }),
    CompletedSetPlaybackRate: () => ({ model }),
    CompletedSetMuted: () => ({ model }),
    CompletedScrollFeed: () => ({ model }),
    LoadedVideo: () => ({
      model,
      commands: [
        SetPlaybackRate({ videoId: videoIdOf(model.id), rate: model.speed }),
        SetMuted({ videoId: videoIdOf(model.id), muted: model.sound === "Muted" }),
      ],
    }),
    UpdatedPlayhead: ({ seconds }) => followPlayhead(model, seconds),
    UpdatedPlayback: ({ playback }) => ({
      model: modifyFields(model, { playback: () => playback }),
    }),
    UpdatedTimeline: ({ value }) =>
      Load.match(model.load, {
        Loading: () => ({ model }),
        Missing: () => ({ model }),
        Ready: ({ replay }) => seek(model, replay.video.startsAt + Number(value)),
      }),
    SelectedSpeed: ({ speed }) => ({
      model: modifyFields(model, { speed: () => speed }),
      commands: [SetPlaybackRate({ videoId: videoIdOf(model.id), rate: speed })],
    }),
    ClickedSound: () => {
      const sound = model.sound === "On" ? "Muted" : "On";

      return {
        model: modifyFields(model, { sound: () => sound }),
        commands: [SetMuted({ videoId: videoIdOf(model.id), muted: sound === "Muted" })],
      };
    },
    ClickedCaptions: () => ({
      model: modifyFields(model, {
        captions: (captions) => (captions === "Shown" ? "Hidden" : "Shown"),
      }),
    }),
    ClickedEntry: ({ at }) => seek(model, at),
    ClickedFrames: ({ moment }) => ({
      model: modifyFields(model, {
        maybeOpenMoment: (open) =>
          Option.contains(open, moment) ? Option.none() : Option.some(moment),
      }),
    }),
  });
