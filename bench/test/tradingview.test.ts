// The TradingView graders on a made-up chart: each passes the state its task asks for and fails
// near misses, and none counts what the chart held before the run. No browser or model is used.
import { assert, describe, it } from "@effect/vitest";

import { type State, tasks } from "../TradingViewTasks.ts";

const day = 86_400;
const october = Date.UTC(2026, 9, 1) / 1000;

// A hundred daily bars rising one a day, the fiftieth on 1 October 2026, with a spike to 300 on
// the seventieth. The last sixty are in view: the lowest low is 138 on the first of them.
const rows = Array.from({ length: 100 }, (_, index) => {
  const open = 100 + index;

  return [october + (index - 50) * day, open, index === 70 ? 300 : open + 2, open - 2, open + 1];
});

const chart: State = {
  symbol: "BINANCE:BTCUSDT",
  resolution: "1D",
  range: { from: rows[40]![0]!, to: rows[99]![0]! },
  rows,
  studies: [],
  shapes: [],
};

const high = { time: rows[70]![0]!, price: 300 };
const low = { time: rows[40]![0]!, price: 138 };

const task = (name: string) => tasks.tradingview.find((candidate) => candidate.name === name)!;

const grade = (name: string, end: Partial<State>, answer = "", start: State = chart) =>
  task(name).grade(start, { ...start, ...end }, answer).pass;

const line = (id: string, price: number) => ({
  id,
  name: "horizontal_line",
  points: [{ time: high.time, price }],
});

describe("TradingView graders", () => {
  it("switch passes Ethereum at four hours only", () => {
    assert.isTrue(grade("switch", { symbol: "BINANCE:ETHUSDT", resolution: "240" }));
    assert.isFalse(grade("switch", { symbol: "BINANCE:ETHUSDT", resolution: "60" }));
    assert.isFalse(grade("switch", { symbol: "BINANCE:BTCUSDT", resolution: "240" }));
  });

  it("rsi passes an added RSI of length 21 only", () => {
    const rsi = (id: string, length: number) => ({
      id,
      name: "Relative Strength Index",
      inputs: [{ id: "length", value: length }],
    });

    assert.isTrue(grade("rsi", { studies: [rsi("a", 21)] }));
    assert.isFalse(grade("rsi", { studies: [rsi("a", 14)] }));
    assert.isFalse(
      grade("rsi", { studies: [rsi("a", 21)] }, "", { ...chart, studies: [rsi("a", 21)] }),
    );
  });

  it("rsi reads the Pine RSI's length from its first input", () => {
    // The Pine RSI's fifth input is its smoothing average's length.
    const pine = (length: number, smoothing: number) => ({
      id: "a",
      name: "Relative strength index",
      inputs: [
        { id: "pineId", value: "STD;RSI" },
        { id: "in_0", value: length },
        { id: "in_1", value: "close" },
        { id: "in_4", value: smoothing },
      ],
    });

    assert.isTrue(grade("rsi", { studies: [pine(21, 14)] }));
    assert.isFalse(grade("rsi", { studies: [pine(14, 21)] }));
  });

  it("level passes an added line within a quarter percent of the highest high in view", () => {
    assert.isTrue(grade("level", { shapes: [line("a", 300.5)] }));
    assert.isFalse(grade("level", { shapes: [line("a", 301)] }));
    // The latest bar's high, 201, is highest only without the spike.
    assert.isFalse(grade("level", { shapes: [line("a", 201)] }));
    assert.isFalse(
      grade("level", { shapes: [line("a", 300)] }, "", { ...chart, shapes: [line("a", 300)] }),
    );
  });

  it("trend passes an added line from the lowest low to the highest high, either way round", () => {
    const trend = (points: ReadonlyArray<{ time: number; price: number }>) => ({
      shapes: [{ id: "a", name: "trend_line", points }],
    });

    assert.isTrue(grade("trend", trend([low, high])));
    assert.isTrue(grade("trend", trend([high, { time: rows[42]![0]!, price: 138.5 }])));
    assert.isFalse(grade("trend", trend([{ time: rows[43]![0]!, price: 138 }, high])));
    assert.isFalse(grade("trend", trend([low, { ...high, price: 290 }])));
  });

  it("zoom passes 20 to 40 bars in view with the latest among them", () => {
    const view = (first: number, last: number) => ({
      range: { from: rows[first]![0]!, to: rows[last]![0]! },
    });

    assert.isTrue(grade("zoom", view(70, 99)));
    assert.isFalse(grade("zoom", view(40, 99)));
    assert.isFalse(grade("zoom", view(60, 89)));
  });

  it("bands passes added bands and the upper band's value on the latest bar", () => {
    const bands = { studies: [{ id: "b", name: "Bollinger Bands", inputs: [] }] };

    // The last twenty closes are 181 to 200: a mean of 190.5 and a deviation of about 5.77.
    assert.isTrue(grade("bands", bands, "The upper band is at 202.03"));
    assert.isFalse(grade("bands", bands, "190.5"));
    assert.isFalse(grade("bands", {}, "202.03"));
  });

  it("read passes 1 October's close on a daily chart", () => {
    assert.isTrue(grade("read", {}, "It closed at 151.00"));
    assert.isFalse(grade("read", {}, "152"));
    assert.isFalse(grade("read", {}, "151", { ...chart, resolution: "60" }));
  });
});
