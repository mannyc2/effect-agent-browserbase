import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Schema } from "effect";

import * as Motion from "../src/Motion.ts";

const plan = (from: Motion.Point, to: Motion.Point): Effect.Effect<ReadonlyArray<Motion.Sample>> =>
  Effect.flatMap(Motion.Motion, (motion) => motion.plan(from, to));

const tick = 16.7;

// Every default sample moves the pointer to a new integer position; only the exact endpoint, at
// the model's end time, may repeat the position before it.
const checkPlan = (from: Motion.Point, samples: ReadonlyArray<Motion.Sample>, to: Motion.Point) => {
  assert.isTrue(Schema.is(Motion.Plan)(samples));
  const last = samples.at(-1);

  assert.isDefined(last);
  assert.strictEqual(last!.x, to.x);
  assert.strictEqual(last!.y, to.y);
  for (const [index, sample] of samples.slice(0, -1).entries()) {
    const previous = samples[index - 1] ?? from;

    assert.isTrue(sample.x !== previous.x || sample.y !== previous.y);
    assert.isTrue(Number.isInteger(sample.x) && Number.isInteger(sample.y));
  }
  for (const [index, sample] of samples.entries()) {
    assert.closeTo(sample.afterMillis / tick, Math.round(sample.afterMillis / tick), 1e-9);
    if (index > 0) assert.isAbove(sample.afterMillis, samples[index - 1]!.afterMillis);
  }
};

// The position a plan holds at `millis`: its latest sample by then, or where it started.
const positionAt = (
  from: Motion.Point,
  samples: ReadonlyArray<Motion.Sample>,
  millis: number,
): Motion.Point => samples.findLast((sample) => sample.afterMillis <= millis + 1e-6) ?? from;

// The pointer position at every 16.7ms tick of the model, from its start to its end.
const ticks = (from: Motion.Point, samples: ReadonlyArray<Motion.Sample>) =>
  Array.from({ length: Math.round(samples.at(-1)!.afterMillis / tick) + 1 }, (_, index) =>
    positionAt(from, samples, index * tick),
  );

describe("Motion", () => {
  it.effect("provides a deterministic seeded default without a layer", () =>
    Effect.gen(function* () {
      const from = { x: 20, y: 40 };
      const to = { x: 620.25, y: 340.75 };
      const first = yield* plan(from, to).pipe(Random.withSeed("motion"));

      assert.deepStrictEqual(first, yield* plan(from, to).pipe(Random.withSeed("motion")));
      assert.notDeepEqual(first, yield* plan(from, to).pipe(Random.withSeed("another motion")));
      assert.isAbove(first.length, 6);
      checkPlan(from, first, to);
    }),
  );

  it.effect("lands exactly on coincident and subpixel targets without consuming randomness", () =>
    Effect.gen(function* () {
      const from = { x: -7.125, y: 4.75 };

      for (const to of [from, { x: -6.625, y: 5.25 }]) {
        const [samples, next] = yield* Effect.gen(function* () {
          const samples = yield* plan(from, to);

          return [samples, yield* Random.next] as const;
        }).pipe(Random.withSeed("tiny"));

        assert.deepStrictEqual(samples, [{ ...to, afterMillis: 0 }]);
        assert.strictEqual(next, yield* Random.next.pipe(Random.withSeed("tiny")));
      }
    }),
  );

  it.effect("rotates the same seeded shape when the movement reverses", () =>
    Effect.gen(function* () {
      const from = { x: 20, y: 40 };
      const to = { x: 620, y: 340 };
      const forward = yield* plan(from, to).pipe(Random.withSeed("reverse"));
      const backward = yield* plan(to, from).pipe(Random.withSeed("reverse"));

      checkPlan(from, forward, to);
      checkPlan(to, backward, from);
      assert.strictEqual(forward.at(-1)!.afterMillis, backward.at(-1)!.afterMillis);
      const reversed = ticks(to, backward);

      for (const [index, point] of ticks(from, forward).entries()) {
        assert.closeTo(point.x + reversed[index]!.x, from.x + to.x, 1);
        assert.closeTo(point.y + reversed[index]!.y, from.y + to.y, 1);
      }
    }),
  );

  it.effect("keeps a homing correction after an early speed peak", () =>
    Effect.gen(function* () {
      // Fixed draws isolate the two-stroke geometry from distribution noise. This checks the
      // asymmetric mathematical shape, not whether a viewer or classifier finds it realistic.
      const from = { x: 0, y: 0 };

      const samples = yield* plan(from, { x: 600, y: 0 }).pipe(
        Effect.provideService(Random.Random, {
          nextIntUnsafe: () => 0,
          nextDoubleUnsafe: () => 0.5,
        }),
      );

      const positions = ticks(from, samples);

      const lengths = positions
        .slice(1)
        .map((point, index) =>
          Math.hypot(point.x - positions[index]!.x, point.y - positions[index]!.y),
        );

      const peak = lengths.indexOf(Math.max(...lengths));
      const late = positions[Math.floor((positions.length - 1) * 0.75)];

      checkPlan(from, samples, { x: 600, y: 0 });
      assert.isBelow(peak / lengths.length, 0.45);
      assert.isTrue(samples.some((sample) => Math.abs(sample.y) > 10));
      assert.isDefined(late);
      assert.isAbove(Math.hypot(600 - late!.x, late!.y), 1);
      assert.isAbove(
        lengths.slice(-Math.ceil(lengths.length / 4)).reduce((a, b) => a + b, 0),
        1,
      );
    }),
  );

  it.effect("bounds work and coordinates even for extreme finite inputs and random tails", () =>
    Effect.gen(function* () {
      const cases = [
        [
          { x: 0, y: 0 },
          { x: 1_000_000, y: -1_000_000 },
        ],
        [
          { x: Number.MAX_VALUE, y: -Number.MAX_VALUE },
          { x: -Number.MAX_VALUE, y: Number.MAX_VALUE },
        ],
        [
          { x: 0, y: 0 },
          { x: 2, y: 0 },
        ],
      ] as const;

      for (const [from, to] of cases) {
        const samples = yield* plan(from, to).pipe(
          Effect.provideService(Random.Random, {
            nextIntUnsafe: () => 0,
            nextDoubleUnsafe: () => 1 - Number.EPSILON,
          }),
        );

        checkPlan(from, samples, to);
        assert.isAtLeast(samples.at(-1)!.afterMillis, 1000);
      }
      for (let seed = 0; seed < 32; seed++) {
        const to = { x: -1300.125, y: 850.5 };
        const samples = yield* plan({ x: 12, y: -16 }, to).pipe(Random.withSeed(seed));

        checkPlan({ x: 12, y: -16 }, samples, to);
      }
    }),
  );

  it.effect("emits only pointer movement and keeps the model's dwell before the endpoint", () =>
    Effect.gen(function* () {
      let dwells = 0;

      for (const distance of [3, 10, 40, 100, 300, 1000, 2000]) {
        for (let seed = 0; seed < 60; seed++) {
          const from = { x: 640.5, y: 360 };
          const angle = seed * 0.37;

          const to = {
            x: Math.round(from.x + distance * Math.cos(angle)),
            y: Math.round(from.y + distance * Math.sin(angle)),
          };

          const samples = yield* plan(from, to).pipe(Random.withSeed(`${distance}:${seed}`));

          checkPlan(from, samples, to);
          const [before, last] = samples.slice(-2);

          // Holding still before the exact endpoint stays part of the schedule's timing.
          if (before !== undefined && last!.afterMillis - before.afterMillis > 2 * tick) dwells++;
        }
      }
      assert.isAbove(dwells, 0);
    }),
  );
});
