// The report's statistics, held to their definitions: exact McNemar, Holm, pass^k and Wilson.
import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Schema } from "effect";

import { holm, mcnemar, passHatK, wilson } from "../Stats.ts";

const count = Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 60 })));

const probability = Arbitrary.schema(
  Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
);

describe("mcnemar", () => {
  it("is twice the binomial tail of the smaller discordant count", () => {
    // Six discordant pairs, all one way: 2 × (1/2)^6.
    assert.closeTo(mcnemar(0, 6), 0.03125, 1e-12);
    // One against nine: 2 × (1 + 10) / 1024.
    assert.closeTo(mcnemar(9, 1), 22 / 1024, 1e-12);
    assert.strictEqual(mcnemar(0, 0), 1);
  });

  it.prop(
    "is the same either way round, at most 1, and 1 for equal counts",
    { first: count, second: count },
    ({ first, second }) => {
      const p = mcnemar(first, second);

      assert.strictEqual(p, mcnemar(second, first));
      assert.isAtMost(p, 1);
      assert.isAbove(p, 0);
      if (first === second) assert.strictEqual(p, 1);
    },
  );
});

describe("holm", () => {
  it("multiplies the k-th smallest p by the number not yet rejected, never decreasing", () => {
    assert.deepStrictEqual(holm([0.01, 0.04, 0.03]), [0.03, 0.06, 0.06]);
  });

  it.prop(
    "never lowers a p-value, caps it at 1, and keeps the order of the raw values",
    { pValues: Arbitrary.array(probability, { minLength: 1, maxLength: 12 }) },
    ({ pValues }) => {
      const adjusted = holm(pValues);

      for (const [index, p] of pValues.entries()) {
        const value = adjusted[index] ?? Number.NaN;

        assert.isAtLeast(value, p);
        assert.isAtMost(value, 1);

        for (const [other, q] of pValues.entries())
          if (q < p) assert.isAtMost(adjusted[other] ?? Number.NaN, value);
      }
    },
  );
});

describe("pass^k", () => {
  it("counts the ways k trials can all be passes, out of the ways to draw k", () => {
    // 3 passes of 4: C(3,2)/C(4,2) = 3/6.
    assert.closeTo(passHatK(3, 4, 2), 0.5, 1e-12);
    assert.strictEqual(passHatK(4, 4, 3), 1);
    assert.strictEqual(passHatK(2, 4, 3), 0);
    assert.isNaN(passHatK(2, 2, 3));
  });

  it.prop(
    "is the pass rate at k = 1 and never rises with k",
    {
      trials: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 40 }))),
      share: probability,
    },
    ({ trials, share }) => {
      const passes = Math.round(share * trials);

      assert.closeTo(passHatK(passes, trials, 1), passes / trials, 1e-12);
      for (let k = 2; k <= trials; k++)
        assert.isAtMost(passHatK(passes, trials, k), passHatK(passes, trials, k - 1) + 1e-12);
    },
  );
});

describe("wilson", () => {
  it.prop(
    "holds the observed rate and stays within 0 and 1",
    {
      trials: Arbitrary.schema(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 200 }))),
      share: probability,
    },
    ({ trials, share }) => {
      const passes = Math.round(share * trials);
      const { low, high } = wilson(passes, trials);

      assert.isAtLeast(low, 0);
      assert.isAtMost(high, 1);
      assert.isAtMost(low, passes / trials + 1e-12);
      assert.isAtLeast(high, passes / trials - 1e-12);
    },
  );

  it("is wide when there is little to go on", () => {
    const { low, high } = wilson(3, 3);

    // Three passes of three still allow a true rate near 44%.
    assert.closeTo(low, 0.4385, 1e-4);
    assert.strictEqual(high, 1);
  });
});
