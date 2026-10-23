/**
 * TradingView charts on effect-browser pages, through the chart's own API: what it shows, its bars,
 * where on the screen a time and price lie, and changes to it. It works where TradingView's
 * Advanced Charts library is embedded, whose widget is `tvWidget`, and on tradingview.com, whose
 * widget is `TradingViewApi`.
 *
 * Reads are side-effect-free `Page.read`s. `point` gives the viewport point of a time and price, in
 * CSS pixels, so pointer input can draw or click exactly there, in view; `at` gives the time and
 * price under a viewport point. The changes, `draw`, `range`, `symbol`, `timeframe` and
 * `indicator`, are recorded `Page.act` actions: they change the chart with no visible input. The
 * documented API gives neither a time's x nor, on the library's demo, the bars, so both come from
 * the chart's model, which pages read as `chart.chartModel()`.
 *
 * Times are the bars' own, in UTC seconds. A page without a chart fails `NotFound`.
 *
 * @since 0.3.0
 */
import { Effect, Schema } from "effect";
import * as BrowserError from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";

/** A time, in the bars' UTC seconds, and a price. */
export const Point = Schema.Struct({ time: Schema.Finite, price: Schema.Finite });

export type Point = typeof Point.Type;

/** A viewport point, in CSS pixels. */
export const Position = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });

export type Position = typeof Position.Type;

/** A bar: its time, open, high, low and close, and its volume where the data has one. */
export const Bar = Schema.Tuple([
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.Finite,
  Schema.NullOr(Schema.Finite),
]);

export type Bar = typeof Bar.Type;

const Span = Schema.Struct({ from: Schema.Finite, to: Schema.Finite });

/** What the chart shows: its symbol, timeframe, bars and prices in view, studies and drawings. */
export const State = Schema.Struct({
  symbol: Schema.String,
  /** The timeframe, as TradingView writes it: "60" for an hour, "240" for four, "1D" for a day. */
  resolution: Schema.String,
  /** The times of the first and last bars in view. */
  view: Span,
  /** The prices the main pane spans. */
  prices: Span,
  /** How many bars are loaded, and how many of them are in view. */
  bars: Schema.Struct({ loaded: Schema.Int, inView: Schema.Int }),
  studies: Schema.Array(Schema.Struct({ id: Schema.String, name: Schema.String })),
  drawings: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, points: Schema.Array(Point) }),
  ),
});

export type State = typeof State.Type;

// The part of TradingView's chart API this module calls. Page-side code below types the window
// with it; each function stands alone, as the page receives it as source text.
interface Bars {
  readonly firstIndex: () => number;
  readonly lastIndex: () => number;
  readonly valueAt: (index: number) => ArrayLike<number> | null;
}

interface Scale {
  readonly priceToCoordinate: (price: number) => number | null;
  readonly coordinateToPrice: (y: number) => number | null;
}

interface Api {
  readonly symbol: () => string;
  readonly resolution: () => string;
  readonly getVisibleBarsRange: () => { readonly from: number; readonly to: number } | null;
  readonly getVisiblePriceRange: () => { readonly from: number; readonly to: number } | null;
  readonly getAllStudies: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly getAllShapes: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly getShapeById: (id: string) => { readonly getPoints: () => ReadonlyArray<Point> };
  readonly getPanes: () => ReadonlyArray<{ readonly getMainSourcePriceScale: () => Scale | null }>;
  readonly getTimeScale: () => { readonly coordinateToTime: (x: number) => number | null };
  readonly chartModel: () => {
    readonly mainSeries: () => { readonly bars: () => Bars };
    readonly timeScale: () => { readonly indexToCoordinate: (index: number) => number };
  };
  readonly setVisibleRange: (range: { readonly from: number; readonly to: number }) => unknown;
  readonly setSymbol: (symbol: string) => unknown;
  readonly setResolution: (resolution: string) => unknown;
  readonly createStudy: (
    name: string,
    forceOverlay: boolean,
    lock: boolean,
    inputs?: Readonly<Record<string, unknown>>,
  ) => unknown;
  readonly createShape: (point: Point, options: { readonly shape: string }) => unknown;
  readonly createMultipointShape: (
    points: ReadonlyArray<Point>,
    options: { readonly shape: string },
  ) => unknown;
}

interface Widget {
  readonly activeChart: () => Api;
}

declare global {
  // The widget an embed of TradingView's library names `tvWidget`, and tradingview.com's own.
  var tvWidget: Widget | undefined;
  var TradingViewApi: Widget | undefined;
}

const readState = () => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();

  if (chart === undefined) return null;
  const bars = chart.chartModel().mainSeries().bars();
  const view = chart.getVisibleBarsRange() ?? { from: 0, to: 0 };
  let inView = 0;

  for (let index = bars.firstIndex(); index <= bars.lastIndex(); index++) {
    const time = bars.valueAt(index)?.[0];

    if (time !== undefined && time >= view.from && time <= view.to) inView += 1;
  }

  return {
    symbol: chart.symbol(),
    resolution: chart.resolution(),
    view,
    prices: chart.getVisiblePriceRange() ?? { from: 0, to: 0 },
    bars: { loaded: bars.lastIndex() - bars.firstIndex() + 1, inView },
    studies: chart.getAllStudies().map(({ id, name }) => ({ id, name })),
    drawings: chart.getAllShapes().map(({ id, name }) => ({
      id,
      name,
      points: chart
        .getShapeById(id)
        .getPoints()
        .map(({ time, price }) => ({ time, price })),
    })),
  };
};

const readBars = (request: {
  readonly last?: number | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();

  if (chart === undefined) return null;
  const bars = chart.chartModel().mainSeries().bars();
  // Without a window or a count, the bars in view.
  const view = request.last === undefined ? chart.getVisibleBarsRange() : null;
  const from = request.from ?? view?.from ?? Number.NEGATIVE_INFINITY;
  const to = request.to ?? view?.to ?? Number.POSITIVE_INFINITY;
  const rows: Array<Array<number | null>> = [];

  for (let index = bars.firstIndex(); index <= bars.lastIndex(); index++) {
    const [time, open, high, low, close, volume] = Array.from(bars.valueAt(index) ?? []);

    if (
      time !== undefined &&
      open !== undefined &&
      high !== undefined &&
      low !== undefined &&
      close !== undefined &&
      time >= from &&
      time <= to
    )
      rows.push([
        time,
        open,
        high,
        low,
        close,
        volume !== undefined && Number.isFinite(volume) ? volume : null,
      ]);
  }

  return request.last === undefined ? rows : rows.slice(-request.last);
};

// Between the chart's coordinates and the viewport's: the main pane's canvas, in the page or in a
// frame of its own origin, gives the offset, its price scale y, the model's time scale x.
const place = (request: {
  readonly points?: ReadonlyArray<Point> | undefined;
  readonly positions?: ReadonlyArray<Position> | undefined;
}) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();

  if (chart === undefined) return null;

  const documents = [
    { document, x: 0, y: 0 },
    ...Array.from(document.querySelectorAll("iframe")).flatMap((frame) => {
      const box = frame.getBoundingClientRect();

      // A frame of another origin has no document to read; the chart is not in it.
      return frame.contentDocument === null
        ? []
        : [{ document: frame.contentDocument, x: box.x, y: box.y }];
    }),
  ];

  const panes = documents.flatMap(({ document, x, y }) =>
    Array.from(document.querySelectorAll('canvas[data-name="pane-canvas"]')).map((canvas) => {
      const box = canvas.getBoundingClientRect();

      return { x: x + box.x, y: y + box.y, height: box.height };
    }),
  );

  const pane = panes[0];
  const scale = chart.getPanes()[0]?.getMainSourcePriceScale();

  if (pane === undefined || scale === undefined || scale === null) return null;
  const bars = chart.chartModel().mainSeries().bars();
  const first = bars.firstIndex();
  const last = bars.lastIndex();
  const timeOf = (index: number) => bars.valueAt(index)?.[0] ?? Number.NaN;
  const step = timeOf(last) - timeOf(last - 1);

  // The index of the bar at a time: the nearest loaded one, or past either end, as many steps on.
  const indexOf = (time: number) => {
    if (time <= timeOf(first)) return first - Math.round((timeOf(first) - time) / step);
    if (time >= timeOf(last)) return last + Math.round((time - timeOf(last)) / step);
    let low = first;
    let high = last;

    while (high - low > 1) {
      const middle = Math.floor((low + high) / 2);

      if (timeOf(middle) <= time) low = middle;
      else high = middle;
    }

    return time - timeOf(low) <= timeOf(high) - time ? low : high;
  };

  const timeScale = chart.chartModel().timeScale();

  return {
    positions: (request.points ?? []).map(({ time, price }) => {
      const x = timeScale.indexToCoordinate(indexOf(time));
      const y = scale.priceToCoordinate(price);

      return Number.isFinite(x) && y !== null && Number.isFinite(y)
        ? { x: pane.x + x, y: pane.y + y }
        : null;
    }),
    points: (request.positions ?? []).map(({ x, y }) => {
      const time = chart.getTimeScale().coordinateToTime(x - pane.x);
      const price = scale.coordinateToPrice(y - pane.y);

      return time !== null && price !== null && Number.isFinite(time) && Number.isFinite(price)
        ? { time, price }
        : null;
    }),
  };
};

const missing = BrowserError.failWith(
  "chart",
  new BrowserError.NotFound({ target: "a TradingView chart" }),
);

const found = <A>({ value }: { readonly value: A | null }) =>
  value === null ? missing : Effect.succeed(value);

/** What the chart shows now. */
export const state = (page: Page) =>
  page
    .read(readState, { arg: undefined, result: Schema.NullOr(State) })
    .pipe(Effect.flatMap(found));

/**
 * Loaded bars, oldest first: the `last` few, or those from `from` to `to`, by default the bars in
 * view.
 */
export const bars = (
  page: Page,
  request: {
    readonly last?: number | undefined;
    readonly from?: number | undefined;
    readonly to?: number | undefined;
  } = {},
) =>
  page
    .read(readBars, { arg: request, result: Schema.NullOr(Schema.Array(Bar)) })
    .pipe(Effect.flatMap(found));

const Placed = Schema.NullOr(
  Schema.Struct({
    positions: Schema.Array(Schema.NullOr(Position)),
    points: Schema.Array(Schema.NullOr(Point)),
  }),
);

const placed = (page: Page, request: Parameters<typeof place>[0]) =>
  page.read(place, { arg: request, result: Placed }).pipe(Effect.flatMap(found));

/**
 * The viewport points of times and prices on the main pane, null where the chart cannot place one.
 * A time between bars is the nearest bar's; one past the loaded bars, as many bars on. A point may
 * lie outside the pane, off screen.
 */
export const point = (page: Page, points: ReadonlyArray<Point>) =>
  Effect.map(placed(page, { points }), ({ positions }) => positions);

/**
 * The times and prices under viewport points, on the main pane's scale; null where the chart has
 * no time there.
 */
export const at = (page: Page, positions: ReadonlyArray<Position>) =>
  Effect.map(placed(page, { positions }), ({ points }) => points);

/** A drawing: a horizontal line at one point's price, a vertical line at its time, or a trend line. */
export const Shape = Schema.Literals(["horizontal_line", "vertical_line", "trend_line"]);

type Change =
  | {
      readonly kind: "draw";
      readonly shape: typeof Shape.Type;
      readonly points: ReadonlyArray<Point>;
    }
  | { readonly kind: "range"; readonly from: number; readonly to: number }
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "timeframe"; readonly resolution: string }
  | {
      readonly kind: "indicator";
      readonly name: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    };

// A change through the chart API; what it made, a drawing's or a study's id, or nothing.
const write = async (change: Change) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();

  if (chart === undefined) return null;
  switch (change.kind) {
    case "draw": {
      const [only, ...more] = change.points;
      const shape = { shape: change.shape };

      return String(
        await (only !== undefined && more.length === 0
          ? chart.createShape(only, shape)
          : chart.createMultipointShape(change.points, shape)),
      );
    }
    case "range":
      await chart.setVisibleRange({ from: change.from, to: change.to });

      return "";
    case "symbol":
      await chart.setSymbol(change.name);

      return "";
    case "timeframe":
      await chart.setResolution(change.resolution);

      return "";
    case "indicator":
      return String(await chart.createStudy(change.name, false, false, change.inputs));
  }
};

// A change as a recorded action on the document a read just found.
const change = (page: Page, request: Change) =>
  Effect.gen(function* () {
    const { document, connection } = yield* page.read(() => true, {
      arg: undefined,
      result: Schema.Boolean,
    });

    return yield* page
      .act(write, { arg: request, result: Schema.NullOr(Schema.String), document, connection })
      .pipe(Effect.flatMap((value) => found({ value })));
  });

/** Draw a shape through chart points, as many as it takes; gives its id. */
export const draw = (
  page: Page,
  drawing: { readonly shape: typeof Shape.Type; readonly points: ReadonlyArray<Point> },
) => change(page, { kind: "draw", ...drawing });

/** Show the bars from one time to another. */
export const range = (page: Page, span: { readonly from: number; readonly to: number }) =>
  Effect.asVoid(change(page, { kind: "range", ...span }));

/** Chart another symbol, such as "MSFT" or "BINANCE:ETHUSDT". */
export const symbol = (page: Page, name: string) =>
  Effect.asVoid(change(page, { kind: "symbol", name }));

/** Chart another timeframe, as `State.resolution` writes it. */
export const timeframe = (page: Page, resolution: string) =>
  Effect.asVoid(change(page, { kind: "timeframe", resolution }));

/** Add a study by its name, such as "Relative Strength Index", with inputs by id; gives its id. */
export const indicator = (
  page: Page,
  study: { readonly name: string; readonly inputs?: Readonly<Record<string, unknown>> | undefined },
) => change(page, { kind: "indicator", name: study.name, inputs: study.inputs ?? {} });
