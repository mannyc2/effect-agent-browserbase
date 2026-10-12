import { describe, expect, it as test } from "@effect/vitest";
// The replay player: a recording arriving, the visitor's controls and the video's own clock.
import { Option } from "effect";
import * as Scene from "foldkit/scene";
import { Command, given, message, model, story } from "foldkit/story";

import { Message } from "../src/player/message.ts";
import {
  init,
  Load,
  type Model,
  PauseVideo,
  PlayVideo,
  ScrollFeed,
  SeekVideo,
  SetPlaybackRate,
  SetSound,
  update,
  videoIdOf,
  WatchVideo,
} from "../src/player/player.ts";
import { view } from "../src/player/view.ts";
import { replay } from "./fixture.ts";

const loading = init("polymarket").model;

const ready = (now = replay.video.startsAt): Model => ({
  ...update(loading, Message.SucceededLoadReplay({ replay })).model,
  now,
});

const videoId = videoIdOf("polymarket");

describe("update", () => {
  test("a recording starts at its video's first frame, and a long one with no voice at double speed", () => {
    story(
      update,
      given(loading),
      message(Message.SucceededLoadReplay({ replay })),
      model((model) => {
        expect(model.load._tag).toBe("Ready");
        expect(model.now).toBe(1000);
        expect(model.speed).toBe(1);
      }),
    );
    story(
      update,
      given(loading),
      message(
        Message.SucceededLoadReplay({
          replay: { ...replay, video: { ...replay.video, durationMillis: 120_000 } },
        }),
      ),
      model((model) => expect(model.speed).toBe(1)),
    );
    story(
      update,
      given(loading),
      message(
        Message.SucceededLoadReplay({
          replay: {
            ...replay,
            narration: undefined,
            video: { ...replay.video, durationMillis: 120_000 },
          },
        }),
      ),
      model((model) => expect(model.speed).toBe(2)),
    );
  });

  test("a recording that is missing says so", () => {
    story(
      update,
      given(loading),
      message(Message.FailedLoadReplay({ reason: "polymarket has not been recorded yet" })),
      model((model) =>
        expect(model.load).toEqual(
          Load.Missing({ reason: "polymarket has not been recorded yet" }),
        ),
      ),
    );
  });

  test("play and pause drive the video, and play after the end starts over", () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedPlay()),
      Command.resolve(PlayVideo({ videoId, fromStart: false }), Message.SucceededPlayVideo()),
      message(Message.UpdatedPlayback({ playback: "Playing" })),
      message(Message.ClickedPause()),
      Command.resolve(PauseVideo, Message.CompletedPauseVideo()),
      message(Message.UpdatedPlayback({ playback: "Ended" })),
      message(Message.ClickedPlay()),
      Command.resolve(PlayVideo({ videoId, fromStart: true }), Message.SucceededPlayVideo()),
    );
  });

  test("the timeline seeks the video, held within the recording, and the feed follows", () => {
    story(
      update,
      given(ready()),
      message(Message.UpdatedTimeline({ value: "5000" })),
      Command.resolve(SeekVideo({ videoId, seconds: 5 }), Message.CompletedSeekVideo()),
      Command.resolve(ScrollFeed, Message.CompletedScrollFeed()),
      model((model) => expect(model.now).toBe(6000)),
      message(Message.UpdatedTimeline({ value: "99000" })),
      Command.resolve(SeekVideo({ videoId, seconds: 30 }), Message.CompletedSeekVideo()),
      Command.resolve(ScrollFeed, Message.CompletedScrollFeed()),
      model((model) => expect(model.now).toBe(31_000)),
    );
  });

  test("the playhead reaching the next entry scrolls the feed to it, and only then", () => {
    story(
      update,
      given(ready()),
      message(Message.UpdatedPlayhead({ seconds: 1.5 })),
      Command.resolve(ScrollFeed, Message.CompletedScrollFeed()),
      message(Message.UpdatedPlayhead({ seconds: 2 })),
      Command.expectNone(),
      model((model) => expect(model.now).toBe(3000)),
    );
  });

  test("captions and the narration's sound toggle", () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedCaptions()),
      model((model) => expect(model.captions).toBe("Hidden")),
      message(Message.ClickedSound()),
      Command.resolve(SetSound({ videoId, muted: true, volume: 1 }), Message.CompletedSetSound()),
      model((model) => expect(model.sound).toBe("Muted")),
    );
  });

  test("the volume slider sets the narration's volume, and at zero mutes it", () => {
    story(
      update,
      given(ready()),
      message(Message.UpdatedVolume({ value: "0.4" })),
      Command.resolve(
        SetSound({ videoId, muted: false, volume: 0.4 }),
        Message.CompletedSetSound(),
      ),
      message(Message.UpdatedVolume({ value: "0" })),
      Command.resolve(SetSound({ videoId, muted: true, volume: 0 }), Message.CompletedSetSound()),
      model((model) => expect(model.sound).toBe("Muted")),
      // Unmuting from zero brings the narration back at full volume.
      message(Message.ClickedSound()),
      Command.resolve(SetSound({ videoId, muted: false, volume: 1 }), Message.CompletedSetSound()),
      model((model) => {
        expect(model.sound).toBe("On");
        expect(model.volume).toBe(1);
      }),
    );
  });

  test("the speeds open from one button, and close on a choice, Escape or a click outside", () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedSpeed()),
      model((model) => expect(model.speeds).toBe("Open")),
      message(Message.SelectedSpeed({ speed: 1.5 })),
      Command.resolve(SetPlaybackRate({ videoId, rate: 1.5 }), Message.CompletedSetPlaybackRate()),
      model((model) => {
        expect(model.speed).toBe(1.5);
        expect(model.speeds).toBe("Closed");
      }),
      message(Message.ClickedSpeed()),
      message(Message.PressedKeyInSpeeds({ key: "ArrowDown" })),
      model((model) => expect(model.speeds).toBe("Open")),
      message(Message.PressedKeyInSpeeds({ key: "Escape" })),
      model((model) => expect(model.speeds).toBe("Closed")),
      message(Message.ClickedSpeed()),
      message(Message.DismissedSpeeds()),
      model((model) => expect(model.speeds).toBe("Closed")),
    );
  });

  test("a spoken line opens the frames its moment held", () => {
    story(
      update,
      given(ready()),
      message(Message.ClickedFrames({ moment: 0 })),
      model((model) => expect(model.maybeOpenMoment).toEqual(Option.some(0))),
      message(Message.ClickedFrames({ moment: 0 })),
      model((model) => expect(model.maybeOpenMoment).toEqual(Option.none())),
    );
  });
});

describe("view", () => {
  const watched = Scene.Mount.resolve(WatchVideo, Message.UpdatedPlayback({ playback: "Paused" }));

  test("shows the line being spoken as a caption until captions are turned off", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready(7000)),
      watched,
      Scene.expect(Scene.testId("caption")).toHaveText(
        "The Iran ceasefire market shows October 12 at 97%.",
      ),
      Scene.click(Scene.role("button", { name: "Captions" })),
      Scene.expect(Scene.testId("caption")).not.toExist(),
      Scene.expect(Scene.role("button", { name: "Captions" })).toHaveAttr("aria-pressed", "false"),
    );
  });

  test("marks what the agent is doing over the video, with what it last decided", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready(10_500)),
      watched,
      Scene.expect(Scene.testId("activity")).toContainText("Thinking"),
      Scene.expect(Scene.testId("activity")).toContainText("1.1s"),
    );
    Scene.scene(
      { update, view },
      Scene.given(ready(12_500)),
      watched,
      Scene.expect(Scene.testId("activity")).toContainText("Opening the ceasefire market."),
      Scene.expect(Scene.text("Thought for 2.6s")).toExist(),
    );
  });

  test("keeps the speeds behind the one showing", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready()),
      watched,
      Scene.expect(Scene.role("menu", { name: "Playback speed" })).not.toExist(),
      Scene.click(Scene.role("button", { name: "Playback speed, 1×" })),
      Scene.expect(Scene.role("menuitemradio", { name: "1×" })).toHaveAttr("aria-checked", "true"),
      Scene.click(Scene.role("menuitemradio", { name: "2×" })),
      Scene.Command.resolve(SetPlaybackRate, Message.CompletedSetPlaybackRate()),
      Scene.expect(Scene.role("menu", { name: "Playback speed" })).not.toExist(),
      Scene.expect(Scene.role("button", { name: "Playback speed, 2×" })).toExist(),
    );
  });

  test("follows the video with its chapter and a transcript, then says what was found", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready()),
      watched,
      Scene.expect(Scene.role("region", { name: "Transcript" })).toExist(),
      Scene.expect(Scene.text("Opening the ceasefire market.")).toExist(),
      Scene.expect(Scene.text("polymarket.com")).toExist(),
      Scene.expect(Scene.text("What the agent found")).toExist(),
      Scene.expect(Scene.text("Every market matched Polymarket's API")).toExist(),
      Scene.expect(Scene.text("openai/gpt-audio-mini, voice marin")).toExist(),
    );
  });

  test("a missing recording points to recording one", () => {
    Scene.scene(
      { update, view },
      Scene.given(update(loading, Message.FailedLoadReplay({ reason: "not recorded" })).model),
      Scene.expect(Scene.text("not recorded", { exact: false })).toExist(),
    );
  });
});
