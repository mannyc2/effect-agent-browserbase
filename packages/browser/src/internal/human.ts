/**
 * Bounded key timing, mouse holds and presentation pauses, separate from functional page waits.
 */
import { Effect, Random } from "effect";

import * as Keys from "./keys.ts";

/** Base inter-key cadence; word starts and rare corrections bring prose near 75 WPM. */
export const keyDelay = Random.nextBetween(70, 220);

// Right-skewed holds retain occasional hesitation. Clamping makes both cleanup and the action
// timeout budget predictable; 1 - U keeps the logarithm defined even when Random returns zero.
const hold = Effect.fnUntraced(function* (
  mean: number,
  sigma: number,
  minimum: number,
  maximum: number,
) {
  const radius = Math.sqrt(-2 * Math.log(1 - (yield* Random.next)));
  const normal = radius * Math.cos(2 * Math.PI * (yield* Random.next));

  return Math.max(minimum, Math.min(maximum, mean * Math.exp(sigma * normal - sigma ** 2 / 2)));
});

/** The pause between pressing and releasing a mouse button. */
export const pressDelay = hold(80, 0.35, 35, 200);

const keyHold = hold(110, 0.2, 60, 220);

export interface TypingEvent {
  /** Absolute offset from the start of this typing action. */
  readonly afterMillis: number;
  readonly phase: "down" | "up" | "insert";
  readonly key: string;
}

export interface TypingPlan {
  readonly events: ReadonlyArray<TypingEvent>;
  readonly durationMillis: number;
}

const keyboardRows = ["qwertyuiop", "asdfghjkl", "zxcvbnm"];
const eventOrder = { up: 0, insert: 1, down: 2 };

/**
 * Plan the whole input before dispatch so holds can overlap without accumulating network latency.
 * A physical key cannot be held twice, including shifted literals such as A/a and !/1.
 * Only the caller can authorize prose corrections after inspecting the editable field.
 */
export const typing = Effect.fnUntraced(function* (
  text: string,
  options: { readonly prose: boolean },
): Effect.fn.Return<TypingPlan> {
  const events: Array<TypingEvent> = [];
  const releases = new Map<string, number>();
  let due = 0;
  let previous = "";
  let index = 0;
  let corrections = 0;
  let lastCorrection = -12;

  const key = Effect.fnUntraced(function* (character: string) {
    const description = Keys.description(character);

    if (description === undefined) {
      events.push({ afterMillis: due, phase: "insert", key: character });

      return due;
    }

    due = Math.max(due, (releases.get(description.code) ?? -1) + 1);
    const released = due + (yield* keyHold);

    events.push(
      { afterMillis: due, phase: "down", key: character },
      { afterMillis: released, phase: "up", key: character },
    );
    releases.set(description.code, released);

    return released;
  });

  for (const character of text) {
    if (/\s/u.test(previous) && /[\p{L}\p{N}]/u.test(character)) due += 60;
    const lower = character.toLowerCase();
    const row = keyboardRows.find((candidate) => candidate.includes(lower));

    if (
      options.prose &&
      row !== undefined &&
      /^[A-Za-z]$/.test(character) &&
      corrections < Math.ceil(text.length / 40) &&
      index - lastCorrection >= 12 &&
      (yield* Random.next) < 0.015
    ) {
      const position = row.indexOf(lower);
      const neighbours = row.charAt(position - 1) + row.charAt(position + 1);
      const wrong = neighbours.charAt((yield* Random.next) < 0.5 ? 0 : neighbours.length - 1);

      yield* key(character === lower ? wrong : wrong.toUpperCase());
      due += yield* Random.nextBetween(160, 260);
      const released = yield* key("Backspace");

      due = released + (yield* Random.nextBetween(35, 75));
      corrections += 1;
      lastCorrection = index;
    }

    yield* key(character);
    due += yield* keyDelay;
    previous = character;
    index += 1;
  }

  events.sort(
    (left, right) =>
      left.afterMillis - right.afterMillis || eventOrder[left.phase] - eventOrder[right.phase],
  );

  return { events, durationMillis: events.at(-1)?.afterMillis ?? 0 };
});

/**
 * Budget for the slowest sampled cadence, every word boundary and the bounded correction count.
 * UTF-16 length deliberately overestimates astral text, which dispatches once per code point.
 */
export const typingDuration = (text: string): number =>
  text.length === 0 ? 0 : text.length * 281 + Math.ceil(text.length / 40) * 600 + 220;

const pauses = {
  action: [80, 350],
  focus: [70, 250],
  scroll: [25, 65],
} as const;

/** Human hesitation is separate from waiting for the page to reach its required state. */
export const pause = (kind: keyof typeof pauses) => {
  const [minimum, maximum] = pauses[kind];

  return Random.nextBetween(minimum, maximum);
};
