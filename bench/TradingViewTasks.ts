// TradingView tasks for an agent: switching symbols and timeframes, indicators, their settings and
// values, drawing at prices read off the chart, removing a drawing, zooming, reading values, and
// working with many candles' data at once. Each grades the chart's own state, read through the
// page's chart API, which the model never sees. They run on tradingview.com or on TradingView's
// Advanced Charts demo, the same chart without an account: signed out, tradingview.com refuses
// its drawing tools and indicator search. A signed-in chart opens on the account's own layout, so
// graders count only the indicators and drawings a run adds. A task may start from a study or
// drawings its setup adds through the API; its scripted solution makes its changes as
// `ChartInput` does, with the chart's own controls.
import { DateTime, Effect, Schedule, Schema } from "effect";
import * as Chart from "effect-browser-tradingview/Chart";
import * as ChartInput from "effect-browser-tradingview/ChartInput";
import type { RequestPolicy } from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";

import { BenchError } from "./Budget.ts";

export const sites = {
  demo: "https://charting-library.tradingview-widget.com/",
  tradingview: "https://www.tradingview.com/chart/?symbol=BINANCE%3ABTCUSDT&interval=1D",
} as const;

export type Site = keyof typeof sites;

const Point = Schema.Struct({ time: Schema.Finite, price: Schema.Finite });

/** What the chart holds: its symbol, timeframe, view, bars, indicators and drawings. */
export const State = Schema.Struct({
  symbol: Schema.String,
  resolution: Schema.String,
  range: Schema.Struct({ from: Schema.Finite, to: Schema.Finite }),
  /** Every loaded bar as [time, open, high, low, close]. */
  rows: Schema.Array(Schema.Array(Schema.Finite)),
  studies: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      inputs: Schema.Array(Schema.Struct({ id: Schema.String, value: Schema.Unknown })),
    }),
  ),
  shapes: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      name: Schema.String,
      points: Schema.Array(Point),
      /** What a drawing that shows text reads. */
      text: Schema.NullOr(Schema.String),
    }),
  ),
});

export type State = typeof State.Type;

// The part of TradingView's chart API the bench reads and, for its scripted solutions, calls.
interface Chart {
  readonly symbol: () => string;
  readonly resolution: () => string;
  readonly dataReady?: () => boolean;
  readonly getVisibleRange: () => { readonly from: number; readonly to: number };
  readonly chartModel: () => {
    readonly mainSeries: () => {
      readonly bars: () => {
        readonly firstIndex: () => number;
        readonly lastIndex: () => number;
        readonly valueAt: (index: number) => ArrayLike<number> | null;
      };
    };
  };
  readonly getAllStudies: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly getStudyById: (id: string) => {
    readonly getInputValues: () => ReadonlyArray<{ readonly id: string; readonly value: unknown }>;
  };
  readonly getAllShapes: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly getShapeById: (id: string) => {
    readonly getPoints: () => ReadonlyArray<{ readonly time: number; readonly price: number }>;
    readonly getProperties: () => { readonly text?: unknown };
  };
  readonly setSymbol: (symbol: string) => Promise<unknown>;
  readonly setResolution: (resolution: string) => Promise<unknown>;
  readonly getTimeScale: () => {
    readonly width: () => number;
    readonly setBarSpacing: (pixels: number) => void;
  };
  readonly createStudy: (
    name: string,
    overlay: boolean,
    lock: boolean,
    inputs?: Readonly<Record<string, unknown>>,
  ) => Promise<unknown>;
  readonly createShape: (point: Point, options: { shape: string }) => unknown;
  readonly createMultipointShape: (
    points: ReadonlyArray<Point>,
    options: { shape: string },
  ) => unknown;
}

type Point = typeof Point.Type;

// The demo names its widget `tvWidget`; tradingview.com its own `TradingViewApi`.
interface Charts {
  readonly tvWidget?: { readonly activeChart: () => Chart };
  readonly TradingViewApi?: { readonly activeChart: () => Chart };
}

// Page-side code: each function stands alone, as the page receives it as source text.
const readState = () => {
  const charts = window as unknown as Charts;
  const chart = (charts.tvWidget ?? charts.TradingViewApi)!.activeChart();
  const bars = chart.chartModel().mainSeries().bars();
  const rows: Array<Array<number>> = [];

  for (let index = bars.firstIndex(); index <= bars.lastIndex(); index++) {
    const bar = bars.valueAt(index);

    if (bar !== null) rows.push([bar[0]!, bar[1]!, bar[2]!, bar[3]!, bar[4]!]);
  }

  return {
    symbol: chart.symbol(),
    resolution: chart.resolution(),
    range: chart.getVisibleRange(),
    rows,
    studies: chart.getAllStudies().map(({ id, name }) => ({
      id,
      name,
      inputs: chart.getStudyById(id).getInputValues(),
    })),
    shapes: chart.getAllShapes().map(({ id, name }) => {
      // A drawing's points and text, none while the chart loads, when TradingView throws for them.
      try {
        const shape = chart.getShapeById(id);
        const text = shape.getProperties().text;

        return {
          id,
          name,
          points: shape.getPoints().map(({ time, price }) => ({ time, price })),
          text: typeof text === "string" ? text : null,
        };
      } catch {
        return { id, name, points: [], text: null };
      }
    }),
  };
};

const chartReady = () => {
  try {
    const charts = window as unknown as Charts;
    const chart = (charts.tvWidget ?? charts.TradingViewApi)!.activeChart();
    const bars = chart.chartModel().mainSeries().bars();

    return (chart.dataReady?.() ?? true) && bars.lastIndex() - bars.firstIndex() > 30;
  } catch {
    return false;
  }
};

export const state = (page: Page) =>
  page.read(readState, { arg: undefined, result: State }).pipe(Effect.map(({ value }) => value));

/** Wait up to a minute for the chart's bars, then a moment for it to paint them. */
export const chartLoaded = (page: Page) =>
  page.read(chartReady, { arg: undefined, result: Schema.Boolean }).pipe(
    Effect.flatMap(({ value }) =>
      value ? Effect.void : Effect.fail(new BenchError({ message: "the chart never loaded" })),
    ),
    Effect.retry({ schedule: Schedule.spaced("500 millis"), times: 120 }),
    Effect.andThen(Effect.sleep("1500 millis")),
  );

/**
 * Lets the page read, refusing anything else it sends TradingView, so that no run saves a layout,
 * an alert or a setting to a signed-in account. Chart data comes over a WebSocket, which this
 * leaves alone.
 */
export const readOnly: RequestPolicy = {
  patterns: ["*://*.tradingview.com/*"],
  decide: ({ method }) =>
    Effect.succeed(
      ["GET", "HEAD", "OPTIONS"].includes(method)
        ? { _tag: "Allowed" }
        : { _tag: "Refused", reason: "the bench leaves the TradingView account unchanged" },
    ),
};

// --- Grading -------------------------------------------------------------------------------------

export interface Grade {
  readonly pass: boolean;
  readonly detail: string;
  /**
   * For a drawing, how far the closest one the run added lies from where it belongs: its ends'
   * largest errors in bars and in price. Absent when the run drew none.
   */
  readonly error?: Miss | undefined;
}

interface Miss {
  readonly bars: number;
  readonly price: number;
}

const visible = (chart: State) =>
  chart.rows.filter((row) => row[0]! >= chart.range.from && row[0]! <= chart.range.to);

/** The lowest low among these bars. */
const lowest = (rows: State["rows"]) => {
  const low = rows.reduce((best, row) => (row[3]! < best[3]! ? row : best));

  return { time: low[0]!, price: low[3]! };
};

/** The highest high and lowest low among the bars in view. */
export const extremes = (chart: State) => {
  const rows = visible(chart);
  const high = rows.reduce((best, row) => (row[2]! > best[2]! ? row : best));

  return { high: { time: high[0]!, price: high[2]! }, low: lowest(rows) };
};

/** What a run added: those of the end's that the start did not hold. */
const added = <A extends { readonly id: string }>(start: ReadonlyArray<A>, end: ReadonlyArray<A>) =>
  end.filter((item) => !start.some((before) => before.id === item.id));

const within = (value: number, target: number, fraction: number) =>
  Math.abs(value - target) <= Math.abs(target) * fraction;

const barIndex = (chart: State, time: number) =>
  chart.rows.reduce(
    (best, row, index) =>
      Math.abs(row[0]! - time) < Math.abs(chart.rows[best]![0]! - time) ? index : best,
    0,
  );

// A drawn point counts within two bars and half a percent of its target.
const near = (chart: State, point: Point, target: Point) =>
  Math.abs(barIndex(chart, point.time) - barIndex(chart, target.time)) <= 2 &&
  within(point.price, target.price, 0.005);

// The drawings of this kind that a run added.
const drawn = (start: State, end: State, name: string) =>
  added(start.shapes, end.shapes).filter((shape) => shape.name === name);

// How far a drawn point lies from its target.
const off = (chart: State, point: Point, target: Point): Miss => ({
  bars: Math.abs(barIndex(chart, point.time) - barIndex(chart, target.time)),
  price: Math.abs(point.price - target.price),
});

// The closest miss, each weighed by what passes: two bars and half a percent of `around`.
const closest = (misses: ReadonlyArray<Miss>, around: number) => {
  const weight = (miss: Miss) => Math.max(miss.bars / 2, miss.price / (Math.abs(around) * 0.005));

  return misses.reduce<Miss | undefined>(
    (best, miss) => (best === undefined || weight(miss) < weight(best) ? miss : best),
    undefined,
  );
};

// How far the closest drawn line's ends lie from these two points, either way round.
const lineMiss = (chart: State, lines: State["shapes"], one: Point, other: Point) =>
  closest(
    lines.flatMap(({ points: [a, b] }) =>
      a === undefined || b === undefined
        ? []
        : [
            [off(chart, a, one), off(chart, b, other)] as const,
            [off(chart, a, other), off(chart, b, one)] as const,
          ].map(([x, y]) => ({
            bars: Math.max(x.bars, y.bars),
            price: Math.max(x.price, y.price),
          })),
    ),
    one.price,
  );

// How far the closest horizontal line lies from a price.
const levelMiss = (prices: ReadonlyArray<number>, target: number) =>
  closest(
    prices.map((at) => ({ bars: 0, price: Math.abs(at - target) })),
    target,
  );

// Whether a drawn line runs between these two points, either way round.
const joins = (chart: State, lines: State["shapes"], one: Point, other: Point) =>
  lines.some(({ points: [a, b] }) =>
    a === undefined || b === undefined
      ? false
      : (near(chart, a, one) && near(chart, b, other)) ||
        (near(chart, a, other) && near(chart, b, one)),
  );

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

const latestCloses = (chart: State) => chart.rows.slice(-20).map((row) => row[4]!);

// TradingView's default Bollinger Bands: a 20-bar mean of closes plus twice their population
// deviation, on the latest bar.
export const upperBand = (chart: State) => {
  const closes = latestCloses(chart);
  const middle = mean(closes);

  return middle + 2 * Math.sqrt(mean(closes.map((close) => (close - middle) ** 2)));
};

// TradingView's RSI on the latest bar: Wilder's averages of the closes' gains and losses, each
// first the mean of the first `length` changes, then a `length`-bar running average.
export const rsiOf = (chart: State, length = 14) => {
  const closes = chart.rows.map((row) => row[4]!);
  const moves = closes.slice(1).map((close, index) => close - closes[index]!);
  let gain = mean(moves.slice(0, length).map((move) => Math.max(move, 0)));
  let loss = mean(moves.slice(0, length).map((move) => Math.max(-move, 0)));

  for (const move of moves.slice(length)) {
    gain = (gain * (length - 1) + Math.max(move, 0)) / length;
    loss = (loss * (length - 1) + Math.max(-move, 0)) / length;
  }

  return loss === 0 ? 100 : 100 - 100 / (1 + gain / loss);
};

// The first number in a model's answer, with a typographic minus read as one.
const numberIn = (text: string) => {
  const match = /[-−]?\d[\d,]*(?:\.\d+)?/.exec(text);

  return match === null ? undefined : Number(match[0].replace("−", "-").replaceAll(",", ""));
};

const price = (value: number) => value.toFixed(2);

// --- Tasks ---------------------------------------------------------------------------------------

export interface Task {
  readonly name: string;
  readonly prompt: string;
  readonly maxSteps: number;
  readonly grade: (start: State, end: State, answer: string) => Grade;
  /** What the chart starts from besides its bars, added through the chart API before the run. */
  readonly setup?: ((page: Page) => Effect.Effect<void, BrowserError>) | undefined;
  /**
   * Reaches the graded state with the chart's own controls, as `ChartInput` makes changes,
   * showing the grader can pass. The page may be a presenter's view of it.
   */
  readonly solve: (page: Page, start: State) => Effect.Effect<string, BrowserError>;
}

// Chart API calls as a recorded action on the page's current document, for a task's setup.
const apply = <Arg>(page: Page, script: (arg: Arg) => unknown, arg: Arg) =>
  Effect.gen(function* () {
    const { document, connection } = yield* page.read(() => true, {
      arg: undefined,
      result: Schema.Boolean,
    });

    yield* page.act(script, { arg, result: Schema.Unknown, document, connection });
    yield* Effect.sleep("1500 millis");
  });

// A drawing through the chart API: one point for a line across the chart, two for a trend line.
const shape = (page: Page, name: string, points: ReadonlyArray<Point>) =>
  apply(
    page,
    ({ name, points }: { readonly name: string; readonly points: ReadonlyArray<Point> }) => {
      const charts = window as unknown as Charts;
      const chart = (charts.tvWidget ?? charts.TradingViewApi)!.activeChart();

      return points.length === 1
        ? chart.createShape(points[0]!, { shape: name })
        : chart.createMultipointShape(points, { shape: name });
    },
    { name, points },
  );

// A study with its default inputs, through the chart API.
const study = (name: string) => (page: Page) =>
  apply(
    page,
    (name: string) => {
      const charts = window as unknown as Charts;
      const chart = (charts.tvWidget ?? charts.TradingViewApi)!.activeChart();

      return chart.createStudy(name, false, false);
    },
    name,
  );

// A drawing with the chart's own tools.
const draw = (page: Page, shape: Chart.Shape, points: ReadonlyArray<Point>, text?: string) =>
  ChartInput.draw(page, { shape, points, text }).pipe(Effect.as("drawn"));

// The prices of the horizontal lines a run added.
const levels = (start: State, end: State) =>
  drawn(start, end, "horizontal_line").map((line) => line.points[0]?.price ?? Number.NaN);

const ends = (lines: State["shapes"]) =>
  lines.map((line) => line.points.map((point) => price(point.price)).join("→")).join("; ") ||
  "none";

const switching = (ticker: string, symbol: string, name: string): Task => ({
  name: "switch",
  prompt: `On this TradingView chart, switch to ${name} (${ticker}) and set the timeframe to 4 hours. Then call done.`,
  maxSteps: 16,
  grade: (_start, end) => ({
    pass: end.symbol.split(":").at(-1) === ticker && end.resolution === "240",
    detail: `chart shows ${end.symbol} at ${end.resolution}`,
  }),
  solve: (page) =>
    ChartInput.symbol(page, symbol).pipe(
      Effect.andThen(ChartInput.timeframe(page, "240")),
      Effect.as("switched"),
    ),
});

// The API's RSI names its length `length`. tradingview.com's indicator search adds its Pine RSI
// instead, whose length is its first input, `in_0`.
const input = (study: State["studies"][number], id: string) =>
  study.inputs.find((candidate) => candidate.id === id);

const lengthOf = (study: State["studies"][number]) =>
  (input(study, "length") ?? input(study, "in_0"))?.value;

const isRsi = (study: { readonly name: string }) => /relative strength index/i.test(study.name);

const rsi: Task = {
  name: "rsi",
  prompt:
    "Add the Relative Strength Index (RSI) indicator to this TradingView chart, with its length set to 21 instead of the default 14. Then call done.",
  maxSteps: 20,
  grade: (start, end) => {
    const lengths = added(start.studies, end.studies).filter(isRsi).map(lengthOf);

    return {
      pass: lengths.includes(21),
      detail: lengths.length === 0 ? "no RSI on the chart" : `RSI lengths ${lengths.join(", ")}`,
    };
  },
  solve: (page) =>
    Effect.gen(function* () {
      const added = yield* ChartInput.indicator(page, { name: "Relative Strength Index" });
      const length = added.inputs.find(({ name }) => /^(rsi )?length$/i.test(name))?.id;

      yield* ChartInput.inputs(page, { study: added.id, inputs: { [length ?? "length"]: 21 } });

      return "added";
    }),
};

const level: Task = {
  name: "level",
  prompt:
    "On this TradingView chart, draw a horizontal line at the highest high among the candles visible right now. It must be within 0.25% of that high: read the exact high from the chart before you draw, and adjust the line's price if needed. Then call done with the price you drew it at.",
  maxSteps: 24,
  grade: (start, end) => {
    const { high } = extremes(start);

    const prices = levels(start, end);

    return {
      pass: prices.some((at) => within(at, high.price, 0.0025)),
      detail: `highest visible high ${price(high.price)}; lines at ${prices.map(price).join(", ") || "none"}`,
      error: levelMiss(prices, high.price),
    };
  },
  solve: (page, start) =>
    draw(page, "horizontal_line", [extremes(start).high]).pipe(
      Effect.as(price(extremes(start).high.price)),
    ),
};

const trend: Task = {
  name: "trend",
  prompt:
    "On this TradingView chart, draw a trend line from the lowest low to the highest high among the candles visible right now: one end on the lowest candle's low, the other on the highest candle's high. Then call done.",
  maxSteps: 24,
  grade: (start, end) => {
    const { high, low } = extremes(start);
    const lines = drawn(start, end, "trend_line");

    return {
      pass: joins(start, lines, low, high),
      detail: `low ${price(low.price)}, high ${price(high.price)}; lines ${ends(lines)}`,
      error: lineMiss(start, lines, low, high),
    };
  },
  solve: (page, start) => draw(page, "trend_line", [extremes(start).low, extremes(start).high]),
};

const zoom: Task = {
  name: "zoom",
  prompt:
    "Zoom this TradingView chart in so that it shows only between 20 and 40 candles, with the most recent candle still on screen. Then call done.",
  maxSteps: 16,
  grade: (_start, end) => {
    const shown = visible(end).length;
    const latest = end.range.to >= end.rows.at(-1)![0]!;

    return {
      pass: shown >= 20 && shown <= 40 && latest,
      detail: `${shown} candles in view; latest ${latest ? "on" : "off"} screen`,
    };
  },
  solve: (page, start) =>
    ChartInput.range(page, { from: start.rows.at(-30)![0]!, to: start.rows.at(-1)![0]! }).pipe(
      Effect.as("zoomed"),
    ),
};

const bands: Task = {
  name: "bands",
  prompt:
    "Add Bollinger Bands (default settings) to this TradingView chart, then read the upper band's value on the most recent candle. Call done with that value as a number.",
  maxSteps: 20,
  grade: (start, end, answer) => {
    const shown = added(start.studies, end.studies).some((study) => /bollinger/i.test(study.name));
    const upper = upperBand(end);
    const said = numberIn(answer);

    return {
      pass: shown && said !== undefined && within(said, upper, 0.003),
      detail: `bands ${shown ? "on" : "not on"} the chart; upper ${price(upper)}; answered ${said ?? JSON.stringify(answer)}`,
    };
  },
  // The chart's own value, which the grader's reckoning must match.
  solve: (page) =>
    Effect.gen(function* () {
      const added = yield* ChartInput.indicator(page, { name: "Bollinger Bands" });
      const { plots, rows } = yield* Chart.values(page, { study: added.id, last: 1 });
      const at = plots.findIndex((plot) => /upper/i.test(plot));

      return price((at < 0 ? undefined : rows.at(-1)?.[at + 1]) ?? Number.NaN);
    }),
};

// Tasks over the chart's data: each needs many candles' values, which a model reads off the chart
// one at a time, adds an indicator for, or takes from the data, if it has the data.

const average: Task = {
  name: "average",
  prompt:
    "On this TradingView chart, draw a horizontal line at the average closing price of the 20 most recent candles, the latest included. It must be within 0.25% of that average. Then call done with the average.",
  maxSteps: 24,
  grade: (start, end) => {
    const target = mean(latestCloses(start));
    const prices = levels(start, end);

    return {
      pass: prices.some((at) => within(at, target, 0.0025)),
      detail: `average close ${price(target)}; lines at ${prices.map(price).join(", ") || "none"}`,
      error: levelMiss(prices, target),
    };
  },
  solve: (page, start) => {
    const target = mean(latestCloses(start));

    return draw(page, "horizontal_line", [{ time: start.rows.at(-1)![0]!, price: target }]).pipe(
      Effect.as(price(target)),
    );
  },
};

// The candles in view whose range from low to high is within 2% of the widest's, as ties.
const widest = (chart: State) => {
  const rows = visible(chart);
  const span = (row: ReadonlyArray<number>) => row[2]! - row[3]!;
  const most = Math.max(...rows.map(span));

  return rows.filter((row) => span(row) >= most * 0.98).map((row) => row[0]!);
};

const range: Task = {
  name: "range",
  prompt:
    "On this TradingView chart, find the candle with the widest range from its low to its high among the candles visible right now, and draw a vertical line on that candle. Then call done.",
  maxSteps: 24,
  grade: (start, end) => {
    const times = widest(start);
    const marked = drawn(start, end, "vertical_line").map((line) => line.points[0]?.time ?? 0);

    const day = (time: number) => DateTime.formatIso(DateTime.makeUnsafe(time * 1000)).slice(0, 16);

    return {
      pass: marked.some((time) =>
        times.some((candle) => barIndex(start, time) === barIndex(start, candle)),
      ),
      detail: `widest candle at ${times.map(day).join(" or ")}; lines at ${marked.map(day).join(", ") || "none"}`,
      error: closest(
        marked.map((time) => ({
          bars: Math.min(
            ...times.map((candle) => Math.abs(barIndex(start, time) - barIndex(start, candle))),
          ),
          price: 0,
        })),
        1,
      ),
    };
  },
  // At the latest close, a price in view, as the pointer can reach no other.
  solve: (page, start) =>
    draw(page, "vertical_line", [{ time: widest(start)[0]!, price: start.rows.at(-1)![4]! }]),
};

// The change from the leftmost candle's open to the latest close, in percent. The leftmost candle
// can be cut by the chart's edge, so its neighbours count too.
const changes = (chart: State) => {
  const first = chart.rows.findIndex((row) => row[0]! >= chart.range.from);
  const close = chart.rows.at(-1)![4]!;

  return chart.rows
    .slice(Math.max(first - 1, 0), first + 2)
    .map((row) => ((close - row[1]!) / row[1]!) * 100);
};

const change: Task = {
  name: "change",
  prompt:
    "On this TradingView chart, work out the percentage change from the open of the first candle on screen, at the left edge, to the close of the latest candle. Call done with it as a signed number of percent, negative for a fall.",
  maxSteps: 20,
  grade: (start, _end, answer) => {
    const values = changes(start);
    const said = numberIn(answer);

    return {
      pass: said !== undefined && values.some((value) => Math.abs(said - value) <= 0.05),
      detail: `change ${values.map((value) => value.toFixed(2)).join(", ")}%, by which candle counts as first; answered ${said ?? JSON.stringify(answer)}`,
    };
  },
  solve: (_page, start) => Effect.succeed(changes(start)[1]!.toFixed(2)),
};

// The lowest lows of the left and right halves of the candles in view.
const halves = (chart: State) => {
  const rows = visible(chart);
  const half = Math.floor(rows.length / 2);

  return { left: lowest(rows.slice(0, half)), right: lowest(rows.slice(half)) };
};

const swing: Task = {
  name: "swing",
  prompt:
    "On this TradingView chart, split the candles visible right now into a left half and a right half. Draw a trend line from the lowest low in the left half to the lowest low in the right half. Then call done.",
  maxSteps: 24,
  grade: (start, end) => {
    const { left, right } = halves(start);
    const lines = drawn(start, end, "trend_line");

    return {
      pass: joins(start, lines, left, right),
      detail: `left low ${price(left.price)}, right low ${price(right.price)}; lines ${ends(lines)}`,
      error: lineMiss(start, lines, left, right),
    };
  },
  solve: (page, start) => draw(page, "trend_line", [halves(start).left, halves(start).right]),
};

// A daily candle found by its date, read through the chart's crosshair legend.
const october = Date.UTC(2026, 9, 1) / 1000;

const candleOf = (chart: State) =>
  chart.rows.find((row) => row[0]! >= october && row[0]! < october + 86_400);

const read: Task = {
  name: "read",
  prompt:
    "This TradingView chart shows daily candles. Find the candle for 1 October 2026 and read its closing price. Call done with that price as a number.",
  maxSteps: 16,
  grade: (start, _end, answer) => {
    const candle = candleOf(start);
    const said = numberIn(answer);

    if (!["D", "1D"].includes(start.resolution))
      return { pass: false, detail: `the chart opened at ${start.resolution}, not daily` };

    return candle === undefined
      ? { pass: false, detail: "no 1 October candle loaded" }
      : {
          pass: said !== undefined && within(said, candle[4]!, 0.001),
          detail: `1 October close ${price(candle[4]!)}; answered ${said ?? JSON.stringify(answer)}`,
        };
  },
  solve: (_page, start) => Effect.succeed(price(candleOf(start)?.[4] ?? Number.NaN)),
};

// Tasks on what a chart already holds, and on its other drawing tools: a study's value, a study's
// settings, a drawing to remove, and drawings besides lines.

const rsiRead: Task = {
  name: "rsi-read",
  prompt:
    "This TradingView chart shows the Relative Strength Index (RSI). Read the RSI's value on the most recent candle, and call done with it as a number.",
  maxSteps: 16,
  setup: study("Relative Strength Index"),
  grade: (_start, end, answer) => {
    const value = rsiOf(end);
    const said = numberIn(answer);

    return {
      pass: said !== undefined && Math.abs(said - value) <= 0.15,
      detail: `RSI ${value.toFixed(2)}; answered ${said ?? JSON.stringify(answer)}`,
    };
  },
  // The chart's own value, which the grader's reckoning must match.
  solve: (page) =>
    Chart.state(page).pipe(
      Effect.map(({ studies }) => {
        const [value] = Object.values(studies.find(isRsi)?.latest ?? {});

        return typeof value === "number" ? value.toFixed(2) : "none";
      }),
    ),
};

const rsiEdit: Task = {
  name: "rsi-edit",
  prompt:
    "This TradingView chart shows the Relative Strength Index (RSI) with a length of 14. Change its length to 9. Then call done.",
  maxSteps: 16,
  setup: study("Relative Strength Index"),
  // What a viewer sees: every RSI on the chart at 9, whether changed or added again.
  grade: (_start, end) => {
    const lengths = end.studies.filter(isRsi).map(lengthOf);

    return {
      pass: lengths.length > 0 && lengths.every((length) => length === 9),
      detail: lengths.length === 0 ? "no RSI on the chart" : `RSI lengths ${lengths.join(", ")}`,
    };
  },
  solve: (page, start) => {
    const shown = start.studies.find(isRsi);

    return shown === undefined
      ? Effect.succeed("no RSI")
      : ChartInput.inputs(page, {
          study: shown.id,
          inputs: { [input(shown, "length") === undefined ? "in_0" : "length"]: 9 },
        }).pipe(Effect.as("changed"));
  },
};

const fib: Task = {
  name: "fib",
  prompt:
    "On this TradingView chart, draw a Fibonacci retracement from the lowest low to the highest high among the candles visible right now: one end on the lowest candle's low, the other on the highest candle's high. Then call done.",
  maxSteps: 24,
  grade: (start, end) => {
    const { high, low } = extremes(start);
    const retracements = drawn(start, end, "fib_retracement");

    return {
      pass: joins(start, retracements, low, high),
      detail: `low ${price(low.price)}, high ${price(high.price)}; retracements ${ends(retracements)}`,
      error: lineMiss(start, retracements, low, high),
    };
  },
  solve: (page, start) =>
    draw(page, "fib_retracement", [extremes(start).low, extremes(start).high]),
};

// The ten latest candles' box: from the first's time to the latest's, their lowest low to their
// highest high, as its lower and upper corners.
const lastTen = (chart: State) => {
  const rows = chart.rows.slice(-10);

  return {
    lower: { time: rows[0]![0]!, price: Math.min(...rows.map((row) => row[3]!)) },
    upper: { time: rows.at(-1)![0]!, price: Math.max(...rows.map((row) => row[2]!)) },
  };
};

// A rectangle's lower and upper corners, whichever two it was drawn through.
const corners = ({ points: [a, b] }: State["shapes"][number]) =>
  a === undefined || b === undefined
    ? undefined
    : {
        lower: { time: Math.min(a.time, b.time), price: Math.min(a.price, b.price) },
        upper: { time: Math.max(a.time, b.time), price: Math.max(a.price, b.price) },
      };

const box: Task = {
  name: "box",
  prompt:
    "On this TradingView chart, draw a rectangle around the 10 most recent candles: from the first of them to the latest, and from their lowest low to their highest high. Then call done.",
  maxSteps: 24,
  grade: (start, end) => {
    const target = lastTen(start);
    const boxes = drawn(start, end, "rectangle").flatMap((shape) => corners(shape) ?? []);

    return {
      pass: boxes.some(
        (at) => near(start, at.lower, target.lower) && near(start, at.upper, target.upper),
      ),
      detail: `box ${price(target.lower.price)}→${price(target.upper.price)}; rectangles ${boxes.map((at) => `${price(at.lower.price)}→${price(at.upper.price)}`).join("; ") || "none"}`,
      error: closest(
        boxes.map((at) => {
          const [lower, upper] = [
            off(start, at.lower, target.lower),
            off(start, at.upper, target.upper),
          ];

          return {
            bars: Math.max(lower.bars, upper.bars),
            price: Math.max(lower.price, upper.price),
          };
        }),
        target.upper.price,
      ),
    };
  },
  solve: (page, start) => {
    const { lower, upper } = lastTen(start);

    return draw(page, "rectangle", [
      { time: lower.time, price: upper.price },
      { time: upper.time, price: lower.price },
    ]);
  },
};

// The two levels the setup draws, at the highest high and the lowest low in view.
const twoLevels = (page: Page) =>
  Effect.gen(function* () {
    const { high, low } = extremes(yield* state(page));

    yield* shape(page, "horizontal_line", [high]);
    yield* shape(page, "horizontal_line", [low]);
  });

// The setup's levels on a chart: the higher, to remove, and the lower, to keep.
const seededLevels = (chart: State) => {
  const lines = chart.shapes.filter((shape) => shape.name === "horizontal_line");
  const { high, low } = extremes(chart);

  const at = (target: number) =>
    lines.find((line) => within(line.points[0]?.price ?? Number.NaN, target, 1e-4));

  return { higher: at(high.price), lower: at(low.price) };
};

const remove: Task = {
  name: "remove",
  prompt:
    "This TradingView chart has two horizontal lines. Remove the higher one, and keep the lower one. Then call done.",
  maxSteps: 16,
  setup: twoLevels,
  grade: (start, end) => {
    const { higher, lower } = seededLevels(start);

    if (higher === undefined || lower === undefined)
      return { pass: false, detail: "the chart did not start with both lines" };
    const kept = (line: { readonly id: string }) => end.shapes.some(({ id }) => id === line.id);

    return {
      pass: !kept(higher) && kept(lower),
      detail: `higher line ${kept(higher) ? "kept" : "removed"}, lower line ${kept(lower) ? "kept" : "removed"}`,
    };
  },
  solve: (page, start) => {
    const { higher } = seededLevels(start);

    return higher === undefined
      ? Effect.succeed("no line")
      : ChartInput.remove(page, higher.id).pipe(Effect.as("removed"));
  },
};

const note: Task = {
  name: "note",
  prompt:
    'On this TradingView chart, add a text note that reads "High", anchored at the highest high among the candles visible right now. Then call done.',
  maxSteps: 20,
  // Any drawing that reads High counts, whichever text tool made it.
  grade: (start, end) => {
    const { high } = extremes(start);
    const texts = added(start.shapes, end.shapes).filter(({ text }) => text !== null);
    const notes = texts.filter(({ text }) => text?.trim().toLowerCase() === "high");
    const anchors = notes.flatMap(({ points }) => points.slice(0, 1));

    return {
      pass: anchors.some((point) => near(start, point, high)),
      detail: `high ${price(high.price)}; texts ${texts.map(({ text, points }) => `${JSON.stringify(text)} at ${points[0] === undefined ? "?" : price(points[0].price)}`).join(", ") || "none"}`,
      error: closest(
        anchors.map((point) => off(start, point, high)),
        high.price,
      ),
    };
  },
  solve: (page, start) => draw(page, "text", [extremes(start).high], "High"),
};

/** Each site's tasks: the demo charts Apple hourly, tradingview.com Bitcoin daily. */
export const tasks: { readonly [S in Site]: ReadonlyArray<Task> } = {
  demo: [
    switching("MSFT", "MSFT", "Microsoft"),
    rsi,
    level,
    trend,
    zoom,
    bands,
    average,
    range,
    change,
    swing,
    rsiRead,
    rsiEdit,
    fib,
    box,
    remove,
    note,
  ],
  tradingview: [
    switching("ETHUSDT", "BINANCE:ETHUSDT", "Ethereum against Tether on Binance"),
    rsi,
    level,
    trend,
    zoom,
    bands,
    read,
    average,
    range,
    change,
    swing,
    rsiRead,
    rsiEdit,
    fib,
    box,
    remove,
    note,
  ],
};
