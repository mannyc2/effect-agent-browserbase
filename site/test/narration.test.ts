// When spoken lines are heard and how they become a track and captions: a line waits for the
// one before and is always said, and the speech lands at its time in the track.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { breath, captions, type Caption, mixdown, schedule } from "../demo/narration.ts";
import { sampleRate } from "../demo/voice.ts";

const caption = (until: number, text = `line at ${until}`): Caption => ({
  text,
  from: until - 5000,
  until,
  readyAt: until + 4000,
});

const speaking = (millis: number) => (_caption: Caption) => Effect.succeed({ millis });

describe("schedule", () => {
  it.effect("speaks a line where its window ends, or after the line before and a breath", () =>
    Effect.gen(function* () {
      const lines = yield* schedule([caption(10_000), caption(12_000)], speaking(4000));

      assert.deepStrictEqual(
        lines.map((line) => [line.at, line.end]),
        [
          [10_000, 14_000],
          [14_000 + breath, 18_000 + breath],
        ],
      );
    }),
  );

  it.effect("says a late line after the one before, however long that one runs", () =>
    Effect.gen(function* () {
      const lines = yield* schedule(
        [caption(1000), caption(2000), caption(3000)],
        speaking(10_000),
      );

      assert.deepStrictEqual(
        lines.map((line) => line.at),
        [1000, 11_000 + breath, 21_000 + 2 * breath],
      );
    }),
  );
});

describe("mixdown", () => {
  it("places each line's speech at its time and cuts what runs past the end", () => {
    const pcm = new Uint8Array([1, 2, 3, 4]);
    const track = mixdown([{ at: 1500, pcm }], 1000, (1000 / sampleRate) * 2 + 500);
    const offset = (sampleRate / 2) * 2;

    assert.strictEqual(track.length, offset + 4);
    assert.deepStrictEqual([...track.subarray(offset)], [1, 2, 3, 4]);
    assert.deepStrictEqual(mixdown([{ at: 1000, pcm }], 1000, 1000 / sampleRate).length, 2);
  });
});

describe("captions", () => {
  it("times each line from the video's start, as WebVTT", () => {
    const text = captions(
      [{ ...caption(0, "Odds --> 71 percent"), at: 65_432, end: 3_725_001 }],
      1000,
    );

    assert.strictEqual(text, "WEBVTT\n\n1\n00:01:04.432 --> 01:02:04.001\nOdds → 71 percent\n");
  });
});
