/**
 * How input is sent: plainly, as fast as the page takes it, or performed for viewers, with a
 * pointer that glides, keys typed at a person's pace, held buttons and wheels in bursts. A page's
 * actions take one, and the input reaches the same controls either way; only its timing, and
 * what viewers see of it, differ. A presenter builds the performed one.
 */
import {
  Context,
  type Duration,
  Effect,
  type MutableRef,
  type Option,
  Random,
  Schema,
} from "effect";

import { undispatched, type BrowserError, InvalidRequest, refuse } from "./BrowserError.ts";
import type * as Motion from "./Geometry.ts";
import { normal } from "./Geometry.ts";
import * as Keys from "./internal/input/keys.ts";
import type { Point } from "./Page.ts";

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
  /** Own presentation only after policy allows input; wait options belong to the page. */
  readonly withInput?:
    | ((options: {
        readonly operation: string;
        readonly wait: Duration.Duration;
        readonly failFast: boolean;
      }) => <A, E, R>(effect: Effect.Effect<A, E, R>) => Effect.Effect<A, E | BrowserError, R>)
    | undefined;
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
  readonly hold: Effect.Effect<number, BrowserError>;
  /** The key events that type `text`, or one insertion of it under a guard, timed from the start. */
  readonly typing: (
    text: string,
    guarded: boolean,
  ) => Effect.Effect<ReadonlyArray<TypingEvent>, BrowserError>;
  /** The pause between repeated presses of the same keys. */
  readonly keyGap: Effect.Effect<number, BrowserError>;
  /** A wheel scroll as the wheel turns: in one step, or in notches and bursts. */
  readonly wheel: (dx: number, dy: number) => Effect.Effect<ReadonlyArray<WheelStep>, BrowserError>;
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
  return Math.max(minimum, Math.min(maximum, median * Math.exp(sigma * (yield* normal))));
});

/** A pause around `median`, as the research measured reactions: at most four times it. */
export const pause = (median: number, sigma: number) =>
  median <= 0 ? Effect.succeed(0) : lognormal(median, sigma, 0, median * 4);

// A mouse press about 80 ms long on average, a key about 110 ms, each now and then longer: their
// medians are the means times exp(-sigma^2 / 2).
const pressHold = lognormal(75.2, 0.35, 35, 200);
const keyHold = lognormal(107.8, 0.2, 60, 220);
const eventOrder = { up: 0, insert: 1, down: 2 };

/**
 * Plan the whole text before any key goes, so holds overlap without waiting on the network. A
 * physical key is never held twice, as with A and a, or ! and 1. The first key waits for the hand
 * to reach the keys, each later one follows the last by a gap drawn around `gap`, and a word's
 * first key comes 60 ms later.
 */
export const maximumDurationMillis = 10_000;

const Delay = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: maximumDurationMillis }));

const ordered = <A extends { readonly afterMillis: number }>(sample: Schema.Codec<A>) =>
  Schema.Array(sample).check(
    Schema.makeFilter(
      (samples) =>
        samples.every(
          (event, index) => event.afterMillis >= (samples[index - 1]?.afterMillis ?? 0),
        ),
      { expected: "nondecreasing input offsets" },
    ),
  );

const Typing = ordered(
  Schema.Struct({
    afterMillis: Delay,
    phase: Schema.Literals(["down", "up", "insert"]),
    key: Schema.String,
  }),
).check(
  Schema.makeFilter(
    (events) => {
      const held = new Set<string>();

      for (const event of events) {
        if (event.phase === "insert") continue;
        const code = Keys.description(event.key)?.code;

        if (code === undefined || (event.phase === "down") === held.has(code)) return false;
        if (event.phase === "down") held.add(code);
        else held.delete(code);
      }

      return held.size === 0;
    },
    { expected: "matched key holds" },
  ),
);

const Wheel = ordered(Schema.Struct({ afterMillis: Delay, dx: Schema.Finite, dy: Schema.Finite }));

const decode =
  <A>(schema: Schema.Codec<A>, operation: string) =>
  (value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.catch(() =>
        refuse(operation, "style must provide a finite bounded ordered input schedule"),
      ),
    );

/** Copy and validate custom schedules before their first input; planning uses the action bound. */
export const validated = (style: Style): Style => ({
  ...style,
  hold: style.hold.pipe(Effect.flatMap(decode(Delay, "click"))),
  keyGap: style.keyGap.pipe(Effect.flatMap(decode(Delay, "press"))),
  typing: (text, guarded) =>
    style.typing(text, guarded).pipe(Effect.flatMap(decode(Typing, "type"))),
  wheel: (dx, dy) => style.wheel(dx, dy).pipe(Effect.flatMap(decode(Wheel, "scroll"))),
});

const overBudget = (operation: string) =>
  undispatched(
    operation,
    new InvalidRequest({
      detail: `presentation must take at most ${maximumDurationMillis} milliseconds`,
    }),
  );

const typing = Effect.fnUntraced(function* (
  text: string,
  gap: number,
): Effect.fn.Return<ReadonlyArray<TypingEvent>, BrowserError> {
  const events: Array<TypingEvent> = [];
  const releases = new Map<string, number>();
  let due = text === "" ? 0 : yield* Random.nextBetween(150, 400);
  let previous = "";

  for (const character of text) {
    if (due > maximumDurationMillis) return yield* overBudget("type");
    if (/\s/u.test(previous) && /[\p{L}\p{N}]/u.test(character)) due += 60;
    const description = Keys.description(character);

    if (description === undefined)
      events.push({ afterMillis: due, phase: "insert", key: character });
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

  if (events.some((event) => event.afterMillis > maximumDurationMillis))
    return yield* overBudget("type");

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

  // Even the shortest possible schedule exceeds the cap; refuse before allocating it.
  if (notches > 1 + maximumDurationMillis / 30) return yield* overBudget("scroll");
  const steps: Array<WheelStep> = [];
  let due = 0;

  for (let index = 0; index < notches; index++) {
    if (index > 0)
      due += yield* index % 9 === 0 ? Random.nextBetween(600, 2600) : Random.nextBetween(30, 140);
    if (due > maximumDurationMillis) return yield* overBudget("scroll");
    steps.push({ dx: dx / notches, dy: dy / notches, afterMillis: due });
  }

  return steps;
});

/** Input performed for viewers, with this pointer and pace. */
export const performed = (options: {
  readonly pointer: MutableRef.MutableRef<Option.Option<Point>>;
  readonly motion: Motion.Planner;
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

/** Input style in this fiber; plain input is the default. */
export const Current = Context.Reference<Style>("effect-browser/Style", {
  defaultValue: () => plain,
});

/** Apply a style through page input, including pages selected later by a browser adapter. */
export const provide =
  (style: Style) =>
  <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provideService(effect, Current, style);
