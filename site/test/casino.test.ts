// The casino demo's slot maths, the session a seed deals, and the check of the agent's report.
import { assert, describe, it } from "@effect/vitest";

import { type Answer, grade, symbolOf } from "../demo/casino.ts";
import type { Spin } from "../demo/casino/site.ts";
import * as Slot from "../demo/casino/slot.ts";

/** A seed whose first six spins at $2 win four times, the last a big one. */
const goodSeed = 828;

/** A session's first spins at `bet`, as the game server deals them from `seed`. */
const session = (seed: number, bet: number, count: number): ReadonlyArray<Spin> => {
  const draw = Slot.random(seed);
  let balance = Slot.startingBalance;

  return Array.from({ length: count }, (_, index) => {
    const grid = Slot.stop(draw);
    const wins = Slot.evaluate(grid, bet);
    const win = wins.reduce((total, line) => total + line.pay, 0);

    balance += win - bet;

    return {
      session: "s",
      round: index + 1,
      roundId: String(index),
      bet,
      grid,
      wins,
      win,
      balance,
    };
  });
};

describe("Slot.evaluate", () => {
  it("pays a line left to right, with wilds standing in", () => {
    const grid: Slot.Grid = [
      ["TEN", "EMERALD", "JACK"],
      ["QUEEN", "EMERALD", "KING"],
      ["ACE", "WILD", "TEN"],
      ["JACK", "WILD", "QUEEN"],
      ["KING", "EMERALD", "ACE"],
    ];

    assert.deepStrictEqual(Slot.evaluate(grid, 200), [
      { line: 1, symbol: "EMERALD", count: 5, pay: 5000 },
    ]);
  });
});

describe("a seed", () => {
  it("deals the same spins every time", () => {
    const spins = session(goodSeed, 200, 6);

    assert.deepStrictEqual(
      spins.map((spin) => spin.win),
      [0, 200, 200, 400, 0, 5000],
    );
    assert.strictEqual(spins.at(-1)?.balance, 104_600);
  });
});

describe("grade", () => {
  const spins = session(goodSeed, 200, 6);

  const right: Answer = {
    fiveCrowns: 200,
    bet: 2,
    wins: [0, 2, 2, 4, 0, 50],
    balance: 1046,
    lowest: 998,
    biggest: { symbol: "Emeralds", count: 5 },
  };

  it("passes a report that matches every spin", () => {
    const checked = grade(right, spins);

    assert.isTrue(checked.pass);
    assert.strictEqual(checked.matched, 7);
  });

  // bea3a16 kept only the first maximum after switching takes to fresh random seeds.
  it("accepts either symbol tied for the biggest win", () => {
    const tied = session(7, 200, 6);

    const report = {
      ...right,
      wins: [2, 0, 0, 2, 0, 0],
      balance: 992,
      lowest: 992,
    };

    assert.isTrue(grade({ ...report, biggest: { symbol: "JACK", count: 3 } }, tied).pass);
    assert.isTrue(grade({ ...report, biggest: { symbol: "TEN", count: 3 } }, tied).pass);
  });

  it("misses a misread win and the balance it implies", () => {
    const checked = grade({ ...right, wins: [0, 2, 2, 4, 0, 23.08], balance: 1019.08 }, spins);

    assert.isFalse(checked.pass);
    assert.strictEqual(checked.matched, 5);
    assert.include(checked.detail, "MISS wins");
  });

  it("misses a lowest balance that was not the lowest after any spin", () => {
    assert.include(grade({ ...right, lowest: 1000 }, spins).detail, "MISS lowest balance");
  });

  it("counts only the last session's spins, as the game's balance does", () => {
    const earlier = session(goodSeed + 1, 100, 2).map((spin) => ({ ...spin, session: "old" }));

    assert.isTrue(grade(right, [...earlier, ...spins]).pass);
  });

  it("reads a symbol by any of its names", () => {
    assert.strictEqual(symbolOf("Emeralds"), "EMERALD");
    assert.strictEqual(symbolOf("10"), "TEN");
    assert.strictEqual(symbolOf("K"), "KING");
    assert.strictEqual(symbolOf("Opal Wild"), "WILD");
    assert.strictEqual(symbolOf("cherry"), undefined);
  });
});
