// When each narrator line is heard, and the voice's track and captions that follow from it. A
// line is spoken where the window it describes ends, the last frame the narrator saw, or once the
// line before has finished; a line that would start long after its window is stale and left
// unsaid. A live stream would hear each line when its words arrived, seconds later, with the
// screen moved on; a replay need not keep that delay.
import { Effect } from "effect";

import { sampleRate } from "./voice.ts";

/** A narrator's caption as the recording holds it, on the recording's host clock. */
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

/** How late a line may start after its window ends before it is stale, in milliseconds. */
export const staleAfter = 3000;

/**
 * Speaks captions in the order of their windows, each once it can be heard whole. `speak` gives a
 * caption's speech, or nothing to leave it unsaid, and is asked only for lines that are not stale.
 */
export const schedule = Effect.fnUntraced(function* <S extends { readonly millis: number }, E, R>(
  captions: ReadonlyArray<Caption>,
  speak: (caption: Caption) => Effect.Effect<S | undefined, E, R>,
) {
  const lines: Array<Line & { readonly speech: S }> = [];

  for (const caption of captions.toSorted((left, right) => left.until - right.until)) {
    const previous = lines.at(-1);
    const at = Math.max(caption.until, previous === undefined ? 0 : previous.end + breath);

    if (at - caption.until > staleAfter) continue;
    const speech = yield* speak(caption);

    if (speech !== undefined) lines.push({ ...caption, at, end: at + speech.millis, speech });
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

/** The lines as WebVTT captions, timed from host time `startsAt`, the video's first instant. */
export const captions = (lines: ReadonlyArray<Line>, startsAt: number) =>
  [
    "WEBVTT",
    ...lines.map(
      (line, index) =>
        `${index + 1}\n${stamp(line.at - startsAt)} --> ${stamp(line.end - startsAt)}\n${line.text.replace(/-->/g, "→")}`,
    ),
  ].join("\n\n") + "\n";
