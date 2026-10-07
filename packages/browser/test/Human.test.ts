import { assert, describe, it } from "@effect/vitest";
import { Effect, Random } from "effect";

import * as Human from "../src/internal/input/human.ts";

interface KeyEvent {
  readonly afterMillis: number;
  readonly phase: "down" | "up" | "insert";
  readonly key: string;
}

// Replay only text-producing effects. This catches an uncorrected typo independently of its
// choice of neighbouring key, and treats Unicode insertion as literal text rather than a shortcut.
const replay = (events: ReadonlyArray<KeyEvent>) => {
  const characters: Array<string> = [];

  for (const event of events) {
    if (event.phase === "insert") characters.push(...event.key);
    else if (event.phase === "down") {
      if (event.key === "Backspace") characters.pop();
      else characters.push(event.key);
    }
  }

  return characters.join("");
};

const average = (numbers: ReadonlyArray<number>) =>
  numbers.reduce((total, number) => total + number, 0) / numbers.length;

describe("Human typing", () => {
  // The requested planner seam needs deterministic distribution and ordering checks: browser
  // timing noise cannot reliably distinguish a 110ms hold from a shifted press/release deadline.
  it.effect("paces ordinary text near 75 WPM with 110ms overlapping key holds", () =>
    Effect.gen(function* () {
      const text =
        "Thoughtful pacing keeps each sentence readable while the next word starts with a short pause. ".repeat(
          4,
        );

      const rates: Array<number> = [];
      const holds: Array<number> = [];
      let overlaps = 0;

      for (const seed of [7, 19, 43, 83]) {
        const plan = yield* Human.typing(text, { prose: false }).pipe(Random.withSeed(seed));
        const pressed = new Map<string, number>();

        rates.push(text.length / 5 / (plan.durationMillis / 60_000));
        for (const event of plan.events) {
          if (event.phase === "down") {
            if (pressed.size > 0) overlaps += 1;
            assert.isFalse(pressed.has(event.key.toLowerCase()));
            pressed.set(event.key.toLowerCase(), event.afterMillis);
          } else if (event.phase === "up") {
            const began = pressed.get(event.key.toLowerCase());

            assert.isDefined(began);
            holds.push(event.afterMillis - began!);
            pressed.delete(event.key.toLowerCase());
          }
        }
        assert.strictEqual(pressed.size, 0);
        assert.strictEqual(replay(plan.events), text);
        assert.isAtMost(plan.durationMillis, Human.typingDuration(text));
      }

      assert.isAbove(average(rates), 70);
      assert.isBelow(average(rates), 85);
      const sortedHolds = [...holds].sort((left, right) => left - right);

      assert.closeTo(average(holds), 110, 5);
      assert.isAbove(sortedHolds[Math.floor(sortedHolds.length / 2)]!, 100);
      assert.isBelow(sortedHolds[Math.floor(sortedHolds.length / 2)]!, 115);
      assert.isAtLeast(sortedHolds[0]!, 60);
      assert.isAtMost(sortedHolds.at(-1)!, 220);
      assert.isAbove(sortedHolds.at(-1)!, 160);
      assert.isAbove(overlaps, 50);
    }),
  );

  it.effect("samples mouse holds near 80ms with occasional longer holds", () =>
    Effect.gen(function* () {
      const holds = yield* Effect.forEach(Array.from({ length: 512 }), () => Human.pressDelay).pipe(
        Random.withSeed("mouse-holds"),
      );

      const sorted = [...holds].sort((left, right) => left - right);

      assert.closeTo(average(holds), 80, 6);
      assert.isAbove(sorted[256]!, 65);
      assert.isBelow(sorted[256]!, 85);
      assert.isAtLeast(sorted[0]!, 35);
      assert.isAtMost(sorted.at(-1)!, 200);
      assert.isAbove(sorted.at(-1)!, 140);
    }),
  );

  it.effect(
    "adds word-start hesitation and releases the same physical key before another down",
    () =>
      Effect.gen(function* () {
        const word = yield* Human.typing("a b", { prose: false }).pipe(Random.withSeed(13));
        const joined = yield* Human.typing("a_b", { prose: false }).pipe(Random.withSeed(13));
        const wordStart = word.events.find((event) => event.phase === "down" && event.key === "b");

        const joinedStart = joined.events.find(
          (event) => event.phase === "down" && event.key === "b",
        );

        assert.isDefined(wordStart);
        assert.isDefined(joinedStart);
        assert.closeTo(wordStart!.afterMillis - joinedStart!.afterMillis, 60, 1e-9);

        const text = "aAaA11!!aA..>>";
        const plan = yield* Human.typing(text, { prose: false }).pipe(Random.withSeed(71));
        const held = new Set<string>();

        // These literal pairs share physical US keys even though their text differs.
        const physical = (key: string) => key.toLowerCase().replace("!", "1").replace(">", ".");

        for (const event of plan.events) {
          if (event.phase === "down") {
            assert.isFalse(held.has(physical(event.key)));
            held.add(physical(event.key));
          } else if (event.phase === "up") {
            assert.isTrue(held.has(physical(event.key)));
            held.delete(physical(event.key));
          }
        }
        assert.strictEqual(held.size, 0);
        assert.strictEqual(replay(plan.events), text);
        assert.deepStrictEqual(
          plan,
          yield* Human.typing(text, { prose: false }).pipe(Random.withSeed(71)),
        );
      }),
  );

  it.effect(
    "corrects rare prose typos, preserves literal Unicode, and stays inside its timeout bound",
    () =>
      Effect.gen(function* () {
        const text = "Please bring fresh bread to the garden party.";
        let corrected = 0;

        for (let seed = 0; seed < 24; seed++) {
          const prose = yield* Human.typing(text, { prose: true }).pipe(Random.withSeed(seed));
          const literal = yield* Human.typing(text, { prose: false }).pipe(Random.withSeed(seed));

          const corrections = prose.events.filter(
            (event) => event.phase === "down" && event.key === "Backspace",
          ).length;

          corrected += corrections;
          assert.isAtMost(corrections, 2);
          assert.strictEqual(replay(prose.events), text);
          assert.strictEqual(replay(literal.events), text);
          assert.isFalse(literal.events.some((event) => event.key === "Backspace"));
          assert.isTrue(
            prose.events.every(
              (event, index) =>
                Number.isFinite(event.afterMillis) &&
                event.afterMillis >= 0 &&
                (index === 0 || event.afterMillis >= prose.events[index - 1]!.afterMillis),
            ),
          );
          assert.strictEqual(prose.durationMillis, prose.events.at(-1)!.afterMillis);
          assert.isAtMost(prose.durationMillis, Human.typingDuration(text));
        }

        assert.isAbove(corrected, 0);
        const unicode = "Aé 👩‍💻\nline\t終";
        const plan = yield* Human.typing(unicode, { prose: false }).pipe(Random.withSeed(5));

        assert.strictEqual(replay(plan.events), unicode);
        assert.strictEqual(
          plan.events
            .filter((event) => event.phase === "insert")
            .map((event) => event.key)
            .join(""),
          "é👩‍💻\n\t終",
        );
        assert.isFalse(plan.events.some((event) => event.key === "Enter" || event.key === "Tab"));
        assert.deepStrictEqual(yield* Human.typing("", { prose: true }), {
          events: [],
          durationMillis: 0,
        });
        assert.strictEqual(Human.typingDuration(""), 0);
      }),
  );
});
