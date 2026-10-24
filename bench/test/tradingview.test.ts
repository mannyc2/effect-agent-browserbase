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

type Point = { readonly time: number; readonly price: number };

const drawing = (
  id: string,
  name: string,
  points: ReadonlyArray<Point>,
  text: string | null = null,
) => ({
  id,
  name,
  points,
  text,
});

const line = (id: string, price: number) =>
  drawing(id, "horizontal_line", [{ time: high.time, price }]);

const trend = (points: ReadonlyArray<Point>) => ({ shapes: [drawing("a", "trend_line", points)] });

const vertical = (index: number) => ({
  shapes: [drawing("a", "vertical_line", [{ time: rows[index]![0]!, price: 150 }])],
});

const rsi = (id: string, length: number) => ({
  id,
  name: "Relative Strength Index",
  inputs: [{ id: "length", value: length }],
});

describe("TradingView graders", () => {
  it("switch passes Ethereum at four hours only", () => {
    assert.isTrue(grade("switch", { symbol: "BINANCE:ETHUSDT", resolution: "240" }));
    assert.isFalse(grade("switch", { symbol: "BINANCE:ETHUSDT", resolution: "60" }));
    assert.isFalse(grade("switch", { symbol: "BINANCE:BTCUSDT", resolution: "240" }));
  });

  it("rsi passes an added RSI of length 21 only", () => {
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

  it("average passes an added line within a quarter percent of the last twenty closes' mean", () => {
    // The last twenty closes are 181 to 200, a mean of 190.5.
    assert.isTrue(grade("average", { shapes: [line("a", 190.9)] }));
    assert.isFalse(grade("average", { shapes: [line("a", 191.5)] }));
    assert.isFalse(
      grade("average", { shapes: [line("a", 190.5)] }, "", {
        ...chart,
        shapes: [line("a", 190.5)],
      }),
    );
  });

  it("range passes a vertical line on the widest candle in view", () => {
    // The spike's candle spans 168 to 300; every other spans 4.
    assert.isTrue(grade("range", vertical(70)));
    assert.isFalse(grade("range", vertical(71)));
    assert.isFalse(grade("range", {}));
  });

  it("change passes the change from the leftmost open to the latest close, signed", () => {
    // From the open of 140 on the leftmost bar to the close of 200; its neighbours open at 139 and 141.
    assert.isTrue(grade("change", {}, "It rose 42.86%"));
    assert.isTrue(grade("change", {}, "+43.88"));
    assert.isFalse(grade("change", {}, "45"));
    assert.isFalse(grade("change", {}, "-42.86"));

    const fell: State = {
      ...chart,
      rows: rows.map((row, index) => (index === 99 ? [...row.slice(0, 4), 133] : row)),
    };

    assert.isTrue(grade("change", {}, "−5.00%", fell));
    assert.isFalse(grade("change", {}, "5.00%", fell));
  });

  it("says how far the closest drawing missed, in bars and in price", () => {
    const missed = (name: string, end: Partial<State>) =>
      task(name).grade(chart, { ...chart, ...end }, "").error;

    assert.deepStrictEqual(missed("trend", trend([{ time: rows[43]![0]!, price: 138 }, high])), {
      bars: 3,
      price: 0,
    });
    assert.deepStrictEqual(missed("level", { shapes: [line("a", 301), line("b", 310)] }), {
      bars: 0,
      price: 1,
    });
    assert.deepStrictEqual(missed("range", vertical(71)), { bars: 1, price: 0 });
    assert.isUndefined(missed("range", {}));
  });

  it("swing passes an added line between the lowest lows of the view's halves", () => {
    const left = low;
    const right = { time: rows[70]![0]!, price: 168 };

    assert.isTrue(grade("swing", trend([left, right])));
    assert.isTrue(grade("swing", trend([right, left])));
    // The lowest low to the latest bar's low is not the swing.
    assert.isFalse(grade("swing", trend([left, { time: rows[99]![0]!, price: 197 }])));
  });

  it("rsi-read passes the latest bar's RSI", () => {
    // Closes that rise 2 and fall 1 in turn, ending on a rise: once Wilder's averages settle, the
    // gains average 28/27 and the losses 13/27, an RSI of 100 × 28/41, about 68.29.
    const closes = Array.from(
      { length: 300 },
      (_, index) => 100 + Math.ceil(index / 2) * 2 - Math.floor(index / 2),
    );

    const zigzag: State = {
      ...chart,
      rows: closes.map((close, index) => [
        october + index * day,
        close,
        close + 1,
        close - 3,
        close,
      ]),
    };

    assert.isTrue(grade("rsi-read", {}, "The RSI is 68.29", zigzag));
    assert.isFalse(grade("rsi-read", {}, "68.6", zigzag));
    assert.isFalse(grade("rsi-read", {}, "", zigzag));
  });

  it("rsi-edit passes when every RSI on the chart has a length of 9", () => {
    const start = { ...chart, studies: [rsi("a", 14)] };

    assert.isTrue(grade("rsi-edit", { studies: [rsi("a", 9)] }, "", start));
    // Removed and added again, as a viewer sees it.
    assert.isTrue(grade("rsi-edit", { studies: [rsi("b", 9)] }, "", start));
    assert.isFalse(grade("rsi-edit", { studies: [rsi("a", 14), rsi("b", 9)] }, "", start));
    assert.isFalse(grade("rsi-edit", { studies: [] }, "", start));
  });

  it("fib passes an added retracement from the lowest low to the highest high", () => {
    const fib = (points: ReadonlyArray<Point>) => ({
      shapes: [drawing("a", "fib_retracement", points)],
    });

    assert.isTrue(grade("fib", fib([low, high])));
    assert.isTrue(grade("fib", fib([high, low])));
    assert.isFalse(grade("fib", fib([{ time: rows[43]![0]!, price: 138 }, high])));
    assert.isFalse(grade("fib", trend([low, high])));
  });

  it("box passes an added rectangle around the last ten candles, through either corners", () => {
    // Bars 90 to 99: lows from 188, highs to 201.
    const box = (first: number, top: number, last: number, bottom: number) => ({
      shapes: [
        drawing("a", "rectangle", [
          { time: rows[first]![0]!, price: top },
          { time: rows[last]![0]!, price: bottom },
        ]),
      ],
    });

    assert.isTrue(grade("box", box(90, 201, 99, 188)));
    assert.isTrue(grade("box", box(99, 188, 90, 201)));
    assert.isFalse(grade("box", box(90, 201, 96, 188)));
    assert.isFalse(grade("box", box(90, 205, 99, 188)));
  });

  it("remove passes the higher seeded line removed and the lower kept", () => {
    const start = { ...chart, shapes: [line("higher", 300), line("lower", 138)] };

    assert.isTrue(grade("remove", { shapes: [line("lower", 138)] }, "", start));
    assert.isFalse(grade("remove", { shapes: [line("higher", 300)] }, "", start));
    assert.isFalse(grade("remove", { shapes: [] }, "", start));
    assert.isFalse(grade("remove", { shapes: start.shapes }, "", start));
  });

  it("note passes an added drawing reading High at the highest high", () => {
    const note = (text: string, at: Point) => drawing("n", "text", [at], text);

    assert.isTrue(grade("note", { shapes: [note(" High", high)] }));
    assert.isTrue(grade("note", { shapes: [{ ...note("high", high), name: "callout" }] }));
    assert.isFalse(grade("note", { shapes: [note("Low", high)] }));
    assert.isFalse(grade("note", { shapes: [note("High", low)] }));
    assert.isFalse(
      grade("note", { shapes: [note("High", high)] }, "", {
        ...chart,
        shapes: [note("High", high)],
      }),
    );
  });

  it("read passes 1 October's close on a daily chart", () => {
    assert.isTrue(grade("read", {}, "It closed at 151.00"));
    assert.isFalse(grade("read", {}, "152"));
    assert.isFalse(grade("read", {}, "151", { ...chart, resolution: "60" }));
  });
});
