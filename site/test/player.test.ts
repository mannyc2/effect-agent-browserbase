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
  test("a recording starts at its video's first frame, and a long one at double speed", () => {
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

  test("a narrator line opens the frames its moment held", () => {
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

  test("lists the agent's steps and the narrator's lines, and the checked result", () => {
    Scene.scene(
      { update, view },
      Scene.given(ready()),
      watched,
      Scene.expect(Scene.text("Opening the ceasefire market.")).toExist(),
      Scene.expect(Scene.text("Narrator", { exact: false })).toExist(),
      Scene.expect(Scene.text("✓ Checked")).toExist(),
      Scene.expect(Scene.text("Every market matched Polymarket's API")).toExist(),
      Scene.expect(Scene.text("voice: openai/gpt-audio-mini · marin", { exact: false })).toExist(),
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
