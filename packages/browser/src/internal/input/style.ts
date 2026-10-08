/**
 * How input is sent: plainly, as fast as the page takes it, or performed for viewers, with a
 * pointer that glides, keys typed at a person's pace, held buttons and wheels in bursts. A page's
 * actions take one, and the input reaches the same controls either way; only its timing, and
 * what viewers see of it, differ. A presenter builds the performed one.
 */
import { Effect, type MutableRef, type Option, Random } from "effect";

import type * as Motion from "../../Motion.ts";
import type { Point } from "../../Page.ts";
import * as Keys from "./keys.ts";

export interface TypingEvent {
  /** From the start of the typing. */
  readonly afterMillis: number;
  readonly phase: "down" | "up" | "insert";
  readonly key: string;
}

export interface WheelStep {
  readonly dx: number;
  readonly dy: number;
  /** From the first step. */
  readonly afterMillis: number;
}

export interface Style {
  /**
   * Whether viewers watch the input: then the pointer clicks into a field before typing, finds
   * what lies under it as it scrolls, and scrolls to a target out of view with the wheel.
   */
  readonly shown: boolean;
  /** Where viewers last saw the pointer, which the next glide starts from; else the page's own. */
  readonly pointer: MutableRef.MutableRef<Option.Option<Point>> | undefined;
  /** The pointer's path to `to`, ending exactly there. */
  readonly glide: (
    from: Point,
    to: Point,
    dragging: boolean,
  ) => Effect.Effect<ReadonlyArray<Motion.Sample>>;
  /** How long a button stays down when a click does not say. */
  readonly hold: Effect.Effect<number>;
  /** The key events that type `text`, or one insertion of it under a guard, timed from the start. */
  readonly typing: (text: string, guarded: boolean) => Effect.Effect<ReadonlyArray<TypingEvent>>;
  /** The pause between repeated presses of the same keys. */
  readonly keyGap: Effect.Effect<number>;
  /** A wheel scroll as the wheel turns: in one step, or in notches and bursts. */
  readonly wheel: (dx: number, dy: number) => Effect.Effect<ReadonlyArray<WheelStep>>;
}

/** Each key as it comes, with no pause; a drag moves in eight short steps so its target sees it. */
export const plain: Style = {
  shown: false,
  pointer: undefined,
  glide: (from, to, dragging) =>
    Effect.succeed(
      dragging
        ? Array.from({ length: 8 }, (_, index) => ({
            x: index === 7 ? to.x : from.x + ((to.x - from.x) * (index + 1)) / 8,
            y: index === 7 ? to.y : from.y + ((to.y - from.y) * (index + 1)) / 8,
            afterMillis: (index + 1) * 8,
          }))
        : [{ ...to, afterMillis: 0 }],
    ),
  hold: Effect.succeed(0),
  typing: (text, guarded) =>
    Effect.succeed(
      guarded && text !== ""
        ? [{ afterMillis: 0, phase: "insert", key: text }]
        : [...text].flatMap((key): ReadonlyArray<TypingEvent> =>
            Keys.description(key) === undefined
              ? [{ afterMillis: 0, phase: "insert", key }]
              : [
                  { afterMillis: 0, phase: "down", key },
                  { afterMillis: 0, phase: "up", key },
                ],
          ),
    ),
  keyGap: Effect.succeed(0),
  wheel: (dx, dy) => Effect.succeed([{ dx, dy, afterMillis: 0 }]),
};

// A right-skewed draw, clamped so that cleanup and deadlines stay predictable; 1 - U keeps the
// logarithm defined when Random returns zero.
const lognormal = Effect.fnUntraced(function* (
  median: number,
  sigma: number,
  minimum: number,
  maximum: number,
) {
  const radius = Math.sqrt(-2 * Math.log(1 - (yield* Random.next)));
  const normal = radius * Math.cos(2 * Math.PI * (yield* Random.next));

  return Math.max(minimum, Math.min(maximum, median * Math.exp(sigma * normal)));
});

/** A pause around `median`, as the research measured reactions: at most four times it. */
export const pause = (median: number, sigma: number) =>
  median <= 0 ? Effect.succeed(0) : lognormal(median, sigma, 0, median * 4);

// A mouse press about 80 ms long, a key about 110 ms, each with an occasional longer one.
const pressHold = lognormal(80, 0.35, 35, 200);
const keyHold = lognormal(110, 0.2, 60, 220);
const eventOrder = { up: 0, insert: 1, down: 2 };

/**
 * Plan the whole text before any key goes, so holds overlap without waiting on the network. A
 * physical key is never held twice, as with A and a, or ! and 1. The first key waits for the hand
 * to reach the keys, each later one follows the last by a gap drawn around `gap`, and a word's
 * first key comes 60 ms later.
 */
const typing = Effect.fnUntraced(function* (
  text: string,
  gap: number,
): Effect.fn.Return<ReadonlyArray<TypingEvent>> {
  const events: Array<TypingEvent> = [];
  const releases = new Map<string, number>();
  let due = text === "" ? 0 : yield* Random.nextBetween(150, 400);
  let previous = "";

  for (const character of text) {
    if (/\s/u.test(previous) && /[\p{L}\p{N}]/u.test(character)) due += 60;
    const description = Keys.description(character);

    if (description === undefined) events.push({ afterMillis: due, phase: "insert", key: character });
    else {
      due = Math.max(due, (releases.get(description.code) ?? -1) + 1);
      const released = due + (yield* keyHold);

      events.push(
        { afterMillis: due, phase: "down", key: character },
        { afterMillis: released, phase: "up", key: character },
      );
      releases.set(description.code, released);
    }
    due += yield* Random.nextBetween(gap / 2, (gap * 3) / 2);
    previous = character;
  }

  return events.toSorted(
    (left, right) =>
      left.afterMillis - right.afterMillis || eventOrder[left.phase] - eventOrder[right.phase],
  );
});

/** A word is five characters; the gap leaves room for each word's later start. */
export const keyGap = (wordsPerMinute: number) => 12_000 / wordsPerMinute - 10;

/**
 * The wheel in 100 px notches, 30 to 140 ms apart, in bursts of at most nine, with 0.6 to 2.6 s
 * between bursts, as people scroll.
 */
const bursts = Effect.fnUntraced(function* (dx: number, dy: number) {
  const notches = Math.max(1, Math.ceil(Math.hypot(dx, dy) / 100));
  const steps: Array<WheelStep> = [];
  let due = 0;

  for (let index = 0; index < notches; index++) {
    if (index > 0)
      due += yield* index % 9 === 0
        ? Random.nextBetween(600, 2600)
        : Random.nextBetween(30, 140);
    steps.push({ dx: dx / notches, dy: dy / notches, afterMillis: due });
  }

  return steps;
});

/** Input performed for viewers, with this pointer and pace. */
export const performed = (options: {
  readonly pointer: MutableRef.MutableRef<Option.Option<Point>>;
  readonly motion: Motion.Service;
  readonly wordsPerMinute: number;
}): Style => {
  const gap = keyGap(options.wordsPerMinute);

  return {
    shown: true,
    pointer: options.pointer,
    glide: (from, to) => options.motion.plan(from, to),
    hold: pressHold,
    typing: (text) => typing(text, gap),
    keyGap: Random.nextBetween(gap / 2, (gap * 3) / 2),
    wheel: bursts,
  };
};
