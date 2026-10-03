import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  Narration,
  aggregate,
  grade,
  visibleText,
  wilson,
  type Sample,
} from "./bench/Understanding.ts";
import { tableMarkup, tableSite, tableTruth } from "./fixtures/TableSite.ts";

it("table truth separates hourly winners from daily winners and changes the visited ticker", () => {
  const first = tableTruth(0, 0);
  const next = tableTruth(0, 1);

  expect(first.facts).toEqual({
    ticker: "BTC",
    dailyWinner: "ETH",
    dailyChange: 9.25,
    weekDirection: "up",
    weeklyChange: 7.31,
  });
  expect(next.facts.ticker).toBe("ETH");
  expect(next.facts.weekDirection).toBe("down");
  expect(tableMarkup(first)).toContain("<th>1h</th><th>24h</th><th>7d</th>");
  expect(tableMarkup(first)).toContain("+18.75%");
  expect(tableMarkup(first)).toContain("+9.25%");
});

it.live("the table request ledger tracks real visits independently of model answers", () =>
  Effect.gen(function* () {
    const site = yield* tableSite(2);
    const first = yield* Effect.promise(async () => (await fetch(site.url)).text());
    const second = yield* Effect.promise(async () => (await fetch(site.url)).text());

    expect(site.visits()).toHaveLength(2);
    expect(first).toContain("Highlighted ticker: <strong>SOL</strong>");
    expect(second).toContain("Highlighted ticker: <strong>AAPL</strong>");
  }).pipe(Effect.scoped),
);

it("grades displayed precision while detecting signs, names, columns and unsupported claims", () => {
  const truth = {
    facts: { dailyWinner: "ETH", dailyChange: 9.25, weeklyChange: -9.02 },
    precision: { dailyChange: 0.005, weeklyChange: 0.005 },
    columns: { dailyWinner: ["BTC"], dailyChange: [18.75], weeklyChange: [-2.74] },
  };

  expect(
    grade(
      {
        caption: "Unscored prose",
        facts: { dailyWinner: "ETH", dailyChange: 9.254, weeklyChange: -9.02 },
      },
      truth,
    ),
  ).toMatchObject({ correct: 3, total: 3, anyFalseFact: false });
  expect(
    grade(
      {
        caption: "",
        facts: { dailyWinner: "BTC", dailyChange: 18.75, weeklyChange: 9.02, unrelated: "claim" },
      },
      truth,
    ),
  ).toMatchObject({
    correct: 0,
    total: 4,
    anyFalseFact: true,
    columnConfusion: true,
    extra: ["unrelated"],
  });
  expect(grade({ caption: "", facts: {} }, truth)).toMatchObject({
    correct: 0,
    total: 3,
    anyFalseFact: false,
  });
  expect(grade({ caption: "", facts: { dailyChange: 9.256 } }, truth).correct).toBe(0);
  expect(() =>
    Schema.decodeSync(Narration)({ caption: "", facts: { balance: Number.NaN } }),
  ).toThrow(/finite/);
});

it("money precision and false-run rate use the claimed facts, with Wilson intervals and measured cost", () => {
  const truth = {
    facts: { balance: 990, bet: 10, win: 0, notable: "near-miss" },
    money: ["balance", "bet", "win"],
  };

  const good = { caption: "A near miss.", facts: truth.facts };
  const bad = { caption: "A win.", facts: { ...truth.facts, balance: 1000, win: 10 } };

  const samples: Sample[] = [good, bad].map((output, index) => ({
    scene: "read-game",
    condition: "digest",
    index,
    output,
    truth,
    grade: grade(output, truth),
    latencyMillis: [10, 30][index] ?? 0,
    callLatencyMillis: [[10], [30]][index] ?? [],
  }));

  const metrics = aggregate(samples, {
    admitted: 2,
    settled: 2,
    refused: null,
    inputTokens: 20,
    cacheReadInputTokens: 0,
    cacheWriteInputTokens: 0,
    outputTokens: 10,
    reasoningTokens: 0,
    costMicrousd: 40,
    limitMicrousd: 100,
    overshootMicrousd: 0,
    status: "estimated-from-reported-usage",
  });

  expect(metrics).toMatchObject({
    factAccuracy: 0.75,
    anyFalseFactRate: 0.5,
    moneyFactAccuracy: 4 / 6,
    costMicrousd: 40,
    callLatencyMillis: { p50: 10, p95: 30 },
  });
  expect(wilson(0, 10)?.upper).toBeCloseTo(0.2775328);
  expect(wilson(10, 10)?.lower).toBeCloseTo(0.7224672);
  expect(wilson(0, 0)).toBeNull();
  expect(aggregate([], null).factAccuracy).toBeNull();
});

it("visible text is bounded in UTF-8 bytes without damaging a split character", () => {
  expect(visibleText("abc😀def", 6)).toBe("abc");
  expect(visibleText("abc😀def", 7)).toBe("abc😀");
  expect(Buffer.byteLength(visibleText("😀".repeat(2000), 4000))).toBe(4000);
});
