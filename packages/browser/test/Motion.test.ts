import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Schema } from "effect";

import * as Motion from "../src/Motion.ts";

const plan = (from: Motion.Point, to: Motion.Point): Effect.Effect<ReadonlyArray<Motion.Sample>> =>
  Effect.flatMap(Motion.Motion, (motion) => motion.plan(from, to));

const checkPlan = (samples: ReadonlyArray<Motion.Sample>, to: Motion.Point) => {
  assert.isAbove(samples.length, 0);
  assert.isAtMost(samples.length, Motion.maximumSamples);
  assert.isTrue(samples.every(Schema.is(Motion.Sample)));
  assert.deepStrictEqual(
    samples.map((sample) => sample.afterMillis),
    samples.map((sample) => sample.afterMillis).toSorted((left, right) => left - right),
  );
  const last = samples.at(-1);

  assert.isDefined(last);
  assert.strictEqual(last!.x, to.x);
  assert.strictEqual(last!.y, to.y);
  assert.isAtMost(last!.afterMillis, Motion.maximumDurationMillis);
};

describe("Motion", () => {
  it.effect("provides a deterministic seeded default without a layer", () =>
    Effect.gen(function* () {
      const from = { x: 20, y: 40 };
      const to = { x: 620.25, y: 340.75 };
      const first = yield* plan(from, to).pipe(Random.withSeed("motion"));

      assert.deepStrictEqual(first, yield* plan(from, to).pipe(Random.withSeed("motion")));
      assert.notDeepEqual(first, yield* plan(from, to).pipe(Random.withSeed("another motion")));
      assert.isAbove(first.length, 6);
      checkPlan(first, to);

      const spacing = first
        .slice(1)
        .map((sample, index) => sample.afterMillis - first[index]!.afterMillis);

      assert.isTrue(spacing.every((millis) => Math.abs(millis - 16.7) < 1e-9));
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

      checkPlan(forward, to);
      checkPlan(backward, from);
      assert.strictEqual(forward.length, backward.length);
      for (const [index, sample] of forward.entries()) {
        const reversed = backward[index];

        assert.isDefined(reversed);
        assert.strictEqual(sample.afterMillis, reversed!.afterMillis);
        assert.closeTo(sample.x + reversed!.x, from.x + to.x, 1);
        assert.closeTo(sample.y + reversed!.y, from.y + to.y, 1);
      }
    }),
  );

  it.effect("keeps a homing correction after an early speed peak", () =>
    Effect.gen(function* () {
      // Fixed draws isolate the two-stroke geometry from distribution noise. This checks the
      // asymmetric mathematical shape, not whether a viewer or classifier finds it realistic.
      const samples = yield* plan({ x: 0, y: 0 }, { x: 600, y: 0 }).pipe(
        Effect.provideService(Random.Random, {
          nextIntUnsafe: () => 0,
          nextDoubleUnsafe: () => 0.5,
        }),
      );

      const lengths = samples
        .slice(1)
        .map((sample, index) =>
          Math.hypot(sample.x - samples[index]!.x, sample.y - samples[index]!.y),
        );

      const peak = lengths.indexOf(Math.max(...lengths));
      const late = samples[Math.floor((samples.length - 1) * 0.75)];

      checkPlan(samples, { x: 600, y: 0 });
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

        checkPlan(samples, to);
        assert.isAtLeast(samples.at(-1)!.afterMillis, 1000);
      }
      for (let seed = 0; seed < 32; seed++) {
        const to = { x: -1300.125, y: 850.5 };
        const samples = yield* plan({ x: 12, y: -16 }, to).pipe(Random.withSeed(seed));

        checkPlan(samples, to);
      }
    }),
  );
});
