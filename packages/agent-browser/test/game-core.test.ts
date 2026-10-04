import { describe, expect, it } from "@effect/vitest";

import { createGameEngine, reelOutcome } from "./fixtures/GameCore.ts";

describe("seeded reel outcomes", () => {
  it("pins all six-by-five grids and moments independently of rendering or timing", () => {
    const outcomes = Array.from({ length: 10 }, (_, index) => reelOutcome(0, index + 1, 10));

    expect(outcomes.map((outcome) => [outcome.moment, outcome.win])).toEqual([
      ["near-miss", 0],
      ["ordinary", 0],
      ["big-win", 500],
      ["ordinary", 0],
      ["bonus", 120],
      ["ordinary", 0],
      ["losing-streak", 0],
      ["losing-streak", 0],
      ["losing-streak", 0],
      ["losing-streak", 0],
    ]);
    expect(
      outcomes.every(
        (outcome) =>
          outcome.grid.length === 6 && outcome.grid.every((column) => column.length === 5),
      ),
    ).toBe(true);
    expect(
      outcomes.every((outcome) => outcome.durationMillis >= 2000 && outcome.durationMillis <= 3500),
    ).toBe(true);
    expect(reelOutcome(0, 3, 20)).toEqual({ ...outcomes[2], win: 1000 });
    expect(reelOutcome(5, 1, 10)).not.toEqual(outcomes[0]);
    expect(reelOutcome(0, 1, 10)).toEqual({
      grid: [
        [2, 0, 0, 1, 0],
        [5, 1, 0, 4, 3],
        [5, 1, 0, 4, 2],
        [2, 2, 0, 5, 2],
        [2, 4, 0, 1, 5],
        [2, 2, 1, 0, 2],
      ],
      win: 0,
      moment: "near-miss",
      durationMillis: 3472,
    });
  });
});

describe("clock-driven reel machine", () => {
  it("debits once, refuses repeated or unaffordable spins and stops left to right", () => {
    const engine = createGameEngine(0, 1000, reelOutcome);
    const duration = reelOutcome(0, 1, 10).durationMillis;

    expect(engine.startSpin(100)).toBe(true);
    expect(engine.startSpin(101)).toBe(false);
    expect(engine.changeBet(1, 102)).toBe(false);
    expect(engine.state()).toMatchObject({ spin: 1, balance: 990, phase: "spinning", bet: 10 });
    engine.advance(100 + duration - 1001);
    expect(engine.state().stoppedReels).toBe(0);
    for (let reel = 0; reel < 6; reel++) {
      engine.advance(100 + duration - (5 - reel) * 200);
      expect(engine.state().grid[reel]).toEqual(reelOutcome(0, 1, 10).grid[reel]);
    }
    const events = engine.drainEvents();

    expect(events.map((event) => event.tag)).toEqual([
      "spinStart",
      "reelStop",
      "reelStop",
      "reelStop",
      "reelStop",
      "reelStop",
      "reelStop",
      "result",
      "idle",
    ]);
    expect(events.filter((event) => event.tag === "reelStop").map((event) => event.reel)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(engine.state()).toMatchObject({ phase: "idle", balance: 990, lastWin: 0 });
    const empty = createGameEngine(0, 9, reelOutcome);

    expect(empty.startSpin(0)).toBe(false);
    expect(empty.drainEvents()).toEqual([]);
  });

  it("keeps a winning result visible for exactly 1500 ms", () => {
    const engine = createGameEngine(2, 1000, reelOutcome);
    const duration = reelOutcome(2, 1, 10).durationMillis;

    engine.startSpin(0);
    engine.advance(duration);
    expect(engine.state()).toMatchObject({ phase: "result", lastWin: 500, banner: "big-win" });
    expect(engine.startSpin(duration)).toBe(false);
    engine.advance(duration + 1499);
    expect(engine.state().phase).toBe("result");
    engine.advance(duration + 1500);
    expect(engine.state()).toMatchObject({ phase: "idle", banner: null });
    expect(engine.drainEvents().filter((event) => event.tag === "bannerHidden")).toEqual([
      { tag: "bannerHidden", spin: 1, atMillis: duration + 1500 },
    ]);
  });

  it("preserves the exact ten-spin balance and bounds bet changes", () => {
    const engine = createGameEngine(0, 1000, reelOutcome);
    let atMillis = 0;

    for (let spin = 1; spin <= 10; spin++) {
      expect(engine.startSpin(atMillis)).toBe(true);
      atMillis += reelOutcome(0, spin, 10).durationMillis;
      engine.advance(atMillis);
      engine.advance(atMillis + 1500);
      atMillis += 1501;
    }
    expect(engine.state()).toMatchObject({ balance: 1520, spin: 10, phase: "idle" });
    const events = engine.drainEvents();

    expect(events.filter((event) => event.tag === "spinStart")).toHaveLength(10);
    expect(events.filter((event) => event.tag === "result")).toHaveLength(10);
    expect(
      events.filter((event) => event.tag === "bannerShown").map((event) => event.moment),
    ).toEqual(["big-win", "bonus"]);
    expect(events.filter((event) => event.tag === "bannerHidden")).toHaveLength(2);
    expect(engine.changeBet(-1, atMillis)).toBe(false);
    for (let step = 0; step < 20; step++) engine.changeBet(1, atMillis);
    expect(engine.state().bet).toBe(100);
  });
});
