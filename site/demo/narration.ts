// When each spoken line is heard, and the voice's track and captions that follow from it. A line
// is what the agent said beside one turn's tool calls, heard as that turn's actions start, or once
// the line before has finished, so every line is said in order and none talks over another.
import { Effect } from "effect";

import { captionChunks } from "../src/replay.ts";
import { sampleRate } from "./voice.ts";

/** A line to speak and the turn it belongs to, on the recording's host clock. */
export interface Caption {
  readonly text: string;
  readonly from: number;
  readonly until: number;
  readonly readyAt: number;
}

export interface Line extends Caption {
  readonly at: number;
  readonly end: number;
}

/** The pause between two lines, in milliseconds. */
export const breath = 250;

/** Speaks captions in the order of their windows, each once the one before has been heard whole. */
export const schedule = Effect.fnUntraced(function* <S extends { readonly millis: number }, E, R>(
  captions: ReadonlyArray<Caption>,
  speak: (caption: Caption) => Effect.Effect<S, E, R>,
) {
  const lines: Array<Line & { readonly speech: S }> = [];

  for (const caption of captions.toSorted((left, right) => left.until - right.until)) {
    const previous = lines.at(-1);
    const at = Math.max(caption.until, previous === undefined ? 0 : previous.end + breath);
    const speech = yield* speak(caption);

    lines.push({ ...caption, at, end: at + speech.millis, speech });
  }

  return lines;
});

/**
 * One track of 16-bit mono PCM, `millis` long from host time `startsAt`, with each line's speech
 * at its time. Lines never overlap, so each is copied rather than mixed.
 */
export const mixdown = (
  lines: ReadonlyArray<{ readonly at: number; readonly pcm: Uint8Array }>,
  startsAt: number,
  millis: number,
): Uint8Array => {
  const sample = (time: number) => Math.max(0, Math.round((time / 1000) * sampleRate)) * 2;
  const track = new Uint8Array(sample(millis));

  for (const line of lines) {
    const offset = sample(line.at - startsAt);

    track.set(line.pcm.subarray(0, Math.max(0, track.length - offset)), offset);
  }

  return track;
};

const stamp = (millis: number) => {
  const total = Math.max(0, Math.round(millis));
  const part = (value: number, width = 2) => String(value).padStart(width, "0");

  return `${part(Math.floor(total / 3_600_000))}:${part(Math.floor(total / 60_000) % 60)}:${part(Math.floor(total / 1000) % 60)}.${part(total % 1000, 3)}`;
};

/**
 * The lines as WebVTT captions, timed from host time `startsAt`, the video's first instant: each in
 * the pieces the player shows it in.
 */
export const captions = (lines: ReadonlyArray<Line>, startsAt: number) =>
  [
    "WEBVTT",
    ...lines
      .flatMap((line) => captionChunks(line.text, line.at, line.end))
      .map(
        (piece, index) =>
          `${index + 1}\n${stamp(piece.at - startsAt)} --> ${stamp(piece.end - startsAt)}\n${piece.text.replace(/-->/g, "→")}`,
      ),
  ].join("\n\n") + "\n";
