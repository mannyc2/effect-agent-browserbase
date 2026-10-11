// What happens to a replay's player: its recording arriving, the visitor's controls and the video
// element's own events.
import { Schema } from "effect";
import { defineMessageUnion } from "foldkit/message";

import { Replay } from "../replay.ts";

export const Playback = Schema.Literals(["Paused", "Playing", "Ended"]);
export type Playback = typeof Playback.Type;

export const Speed = Schema.Literals([1, 2, 4]);
export type Speed = typeof Speed.Type;

export const Message = defineMessageUnion({
  SucceededLoadReplay: { replay: Replay },
  FailedLoadReplay: { reason: Schema.String },
  ClickedPlay: {},
  ClickedPause: {},
  SucceededPlayVideo: {},
  FailedPlayVideo: { reason: Schema.String },
  CompletedPauseVideo: {},
  CompletedSeekVideo: {},
  CompletedSetPlaybackRate: {},
  CompletedSetSound: {},
  CompletedScrollFeed: {},
  LoadedVideo: {},
  UpdatedPlayhead: { seconds: Schema.Finite },
  UpdatedPlayback: { playback: Playback },
  UpdatedTimeline: { value: Schema.String },
  SelectedSpeed: { speed: Speed },
  ClickedSound: {},
  UpdatedVolume: { value: Schema.String },
  ClickedCaptions: {},
  ClickedEntry: { at: Schema.Finite },
  ClickedFrames: { moment: Schema.Int },
});

export type Message = typeof Message.Type;
