/**
 * TradingView charts on effect-browser pages, through the chart's own API: what it shows, its bars,
 * where on the screen a time and price lie, and changes to it. It works where TradingView's
 * Advanced Charts library is embedded, whose widget is `tvWidget`, and on tradingview.com, whose
 * widget is `TradingViewApi`.
 *
 * Reads are side-effect-free `Page.read`s. `state` includes each study's inputs and its plots'
 * values on the latest bar; `values` reads a study's plots bar by bar, as `bars` reads the bars.
 * `point` gives the viewport point of a time and price, in CSS pixels, so pointer input can draw or
 * click exactly there, in view; `at` gives the time and price under a viewport point. The changes,
 * `draw`, `remove`, `move`, `range`, `symbol`, `timeframe`, `indicator` and `inputs`, are recorded
 * `Page.act` actions: they change the chart through its API, exactly and with no visible input.
 * `ChartInput` makes the same changes as visible input. The documented API gives neither a time's
 * x nor, on the library's demo, the bars or a study's values, so they come from the chart's model,
 * which pages read as `chart.chartModel()`.
 *
 * Times are the bars' own, in UTC seconds. A page without a chart fails `NotFound`.
 *
 * @since 0.3.0
 */
import { Effect, Schema } from "effect";
import * as BrowserError from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";

import { drawings, shapes } from "./internal/drawings.ts";

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

/** A study's input value. */
export const InputValue = Schema.Union([Schema.Finite, Schema.String, Schema.Boolean]);

export type InputValue = typeof InputValue.Type;

/**
 * A study: its inputs, by id with the name its settings show, and each plot's value on the latest
 * bar, by the plot's title, null where it has none there.
 */
export const Study = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  inputs: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, value: InputValue }),
  ),
  latest: Schema.Record(Schema.String, Schema.NullOr(Schema.Finite)),
});

export type Study = typeof Study.Type;

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
  studies: Schema.Array(Study),
  drawings: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, points: Schema.Array(Point) }),
  ),
});

export type State = typeof State.Type;

// The part of TradingView's chart API this module calls. Page-side code below types the window
// with it; each function stands alone, as the page receives it as source text.
// The indices are null while the chart loads.
interface Bars {
  readonly firstIndex: () => number | null;
  readonly lastIndex: () => number | null;
  readonly valueAt: (index: number) => ArrayLike<number> | null;
}

interface Scale {
  readonly priceToCoordinate: (price: number) => number | null;
  readonly coordinateToPrice: (y: number) => number | null;
}

interface Plot {
  readonly id: string;
  readonly type: string;
}

// A study in the chart's model: its plots, and its values bar by bar as [time, ...plots].
interface Source {
  readonly id: () => unknown;
  readonly metaInfo: () => {
    readonly plots?: ReadonlyArray<Plot>;
    readonly styles?: Readonly<Record<string, { readonly title?: string } | undefined>>;
  };
  readonly data: () => Bars;
}

interface Input {
  readonly id: string;
  readonly value: unknown;
}

interface Api {
  readonly symbol: () => string;
  readonly resolution: () => string;
  readonly getVisibleBarsRange: () => { readonly from: number; readonly to: number } | null;
  readonly getVisiblePriceRange: () => { readonly from: number; readonly to: number } | null;
  readonly getAllStudies: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly getAllShapes: () => ReadonlyArray<{ readonly id: string; readonly name: string }>;
  readonly getShapeById: (id: string) => {
    readonly getPoints: () => ReadonlyArray<Point>;
    readonly setPoints: (points: ReadonlyArray<Point>) => unknown;
    readonly getProperties: () => { readonly text?: unknown };
  };
  readonly getStudyById: (id: string) => {
    readonly getInputValues: () => ReadonlyArray<Input>;
    readonly getInputsInfo: () => ReadonlyArray<{
      readonly id: string;
      readonly name: string;
      readonly localizedName?: string;
      readonly type: string;
      readonly isHidden?: boolean;
    }>;
    readonly setInputValues: (inputs: ReadonlyArray<Input>) => unknown;
  };
  readonly getPanes: () => ReadonlyArray<{ readonly getMainSourcePriceScale: () => Scale | null }>;
  readonly getTimeScale: () => { readonly coordinateToTime: (x: number) => number | null };
  readonly chartModel: () => {
    readonly mainSeries: () => { readonly bars: () => Bars };
    readonly timeScale: () => { readonly indexToCoordinate: (index: number) => number };
    readonly dataSources: () => ReadonlyArray<Partial<Source>>;
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
  readonly createShape: (point: Point, options: ShapeOptions) => unknown;
  readonly createMultipointShape: (points: ReadonlyArray<Point>, options: ShapeOptions) => unknown;
  readonly removeEntity: (id: string) => void;
  readonly selection?: () => { readonly allSources: () => ReadonlyArray<unknown> };
  readonly dataReady?: () => boolean;
}

interface ShapeOptions {
  readonly shape: string;
  readonly text?: string;
}

interface Widget {
  readonly activeChart: () => Api;
  readonly selectedLineTool?: () => string;
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
  const first = bars.firstIndex() ?? 0;
  const last = bars.lastIndex() ?? -1;
  const view = chart.getVisibleBarsRange() ?? { from: 0, to: 0 };
  let inView = 0;

  for (let index = first; index <= last; index++) {
    const time = bars.valueAt(index)?.[0];

    if (time !== undefined && time >= view.from && time <= view.to) inView += 1;
  }

  const sources = chart.chartModel().dataSources();

  // A drawing's points, none while the chart loads, when TradingView throws for them.
  const pointsOf = (id: string) => {
    try {
      return chart
        .getShapeById(id)
        .getPoints()
        .map(({ time, price }) => ({ time, price }));
    } catch {
      return [];
    }
  };

  // A study's inputs as its settings show them, and its plots' values on the latest bar.
  const study = (id: string, name: string) => {
    const api = chart.getStudyById(id);

    const shown = new Map(
      api
        .getInputsInfo()
        .filter((input) => input.isHidden !== true && input.type !== "symbol")
        .map((input) => [input.id, input.localizedName ?? input.name]),
    );

    const inputs = api.getInputValues().flatMap(({ id, value }) => {
      const label = shown.get(id);

      return label !== undefined &&
        (typeof value === "string" ||
          typeof value === "boolean" ||
          (typeof value === "number" && Number.isFinite(value)))
        ? [{ id, name: label, value }]
        : [];
    });

    const source = sources.find((candidate) => String(candidate.id?.()) === id);
    const meta = source?.metaInfo?.();
    const data = source?.data?.();
    const at = data?.lastIndex() ?? null;
    const row = data === undefined || at === null ? [] : Array.from(data.valueAt(at) ?? []);
    const latest: Record<string, number | null> = {};

    // Row values follow the plots, after the bar's time; colourers and the like hold no value.
    (meta?.plots ?? []).forEach((plot, index) => {
      if (/colorer|alertcondition|offset/i.test(plot.type)) return;
      const title = meta?.styles?.[plot.id]?.title ?? plot.id;
      const value = row[index + 1];

      latest[title in latest ? `${title} ${plot.id}` : title] =
        value !== undefined && Number.isFinite(value) ? value : null;
    });

    return { id, name, inputs, latest };
  };

  return {
    symbol: chart.symbol(),
    resolution: chart.resolution(),
    view,
    prices: chart.getVisiblePriceRange() ?? { from: 0, to: 0 },
    bars: { loaded: last - first + 1, inView },
    studies: chart.getAllStudies().map(({ id, name }) => study(id, name)),
    drawings: chart.getAllShapes().map(({ id, name }) => ({ id, name, points: pointsOf(id) })),
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

  for (let index = bars.firstIndex() ?? 0; index <= (bars.lastIndex() ?? -1); index++) {
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

// A study's plots bar by bar, in the window `readBars` takes: their titles, and a row per bar of
// its time and each plot's value. Colourers and the like hold no value and are left out.
const readValues = (request: {
  readonly study: string;
  readonly last?: number | undefined;
  readonly from?: number | undefined;
  readonly to?: number | undefined;
}) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();

  if (chart === undefined) return { missing: "a TradingView chart" };

  const source = chart
    .chartModel()
    .dataSources()
    .find((candidate) => String(candidate.id?.()) === request.study);

  const meta = source?.metaInfo?.();
  const data = source?.data?.();
  const name = chart.getAllStudies().find(({ id }) => id === request.study)?.name;

  if (meta === undefined || data === undefined || name === undefined)
    return { missing: `study ${request.study}` };
  const titles = new Set<string>();

  const plots = (meta.plots ?? []).flatMap((plot, index) => {
    if (/colorer|alertcondition|offset/i.test(plot.type)) return [];
    const title = meta.styles?.[plot.id]?.title ?? plot.id;
    const unique = titles.has(title) ? `${title} ${plot.id}` : title;

    titles.add(unique);

    return [{ at: index + 1, title: unique }];
  });

  const view = request.last === undefined ? chart.getVisibleBarsRange() : null;
  const from = request.from ?? view?.from ?? Number.NEGATIVE_INFINITY;
  const to = request.to ?? view?.to ?? Number.POSITIVE_INFINITY;
  const rows: Array<Array<number | null>> = [];

  for (let index = data.firstIndex() ?? 0; index <= (data.lastIndex() ?? -1); index++) {
    const row = data.valueAt(index);
    const time = row?.[0];

    if (row !== null && time !== undefined && time >= from && time <= to)
      rows.push([
        time,
        ...plots.map(({ at }) => {
          const value = row[at];

          return value !== undefined && Number.isFinite(value) ? value : null;
        }),
      ]);
  }

  return {
    value: {
      id: request.study,
      name,
      plots: plots.map(({ title }) => title),
      rows: request.last === undefined ? rows : rows.slice(-request.last),
    },
  };
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

  if (first === null || last === null) return null;
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

// What a page function gives that may not find its target: the value, or what it missed.
const Outcome = <S extends Schema.Top>(value: S) =>
  Schema.Union([Schema.Struct({ missing: Schema.String }), Schema.Struct({ value })]);

const outcome = <A>(result: { readonly missing: string } | { readonly value: A }) =>
  "missing" in result
    ? BrowserError.failWith("chart", new BrowserError.NotFound({ target: result.missing }))
    : Effect.succeed(result.value);

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

/** A study's plots bar by bar: their titles, and rows of each bar's time and the plots' values. */
export const Values = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  plots: Schema.Array(Schema.String),
  /** `[time, ...values]`, oldest first, in the plots' order; null where a plot has no value. */
  rows: Schema.Array(Schema.Array(Schema.NullOr(Schema.Finite))),
});

export type Values = typeof Values.Type;

/**
 * A study's values, as `bars` gives the bars: the `last` few bars', or those `from` one time `to`
 * another, by default the bars in view. A study that is not on the chart fails `NotFound`.
 */
export const values = (
  page: Page,
  request: {
    readonly study: string;
    readonly last?: number | undefined;
    readonly from?: number | undefined;
    readonly to?: number | undefined;
  },
) =>
  page
    .read(readValues, { arg: request, result: Outcome(Values) })
    .pipe(Effect.flatMap(({ value }) => outcome(value)));

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

/**
 * A drawing tool by its name in the chart API: "horizontal_line", "trend_line", "rectangle",
 * "fib_retracement", "parallel_channel", "long_position", "text" and every other tool that clicks
 * finish, one click a point.
 */
export const Shape = Schema.Literals(shapes);

export type Shape = typeof Shape.Type;

/** How many points a shape takes: one for a horizontal line, two for a trend line, and so on. */
export const points = (shape: Shape): number => drawings[shape][2];

type Change =
  | {
      readonly kind: "draw";
      readonly shape: Shape;
      readonly points: ReadonlyArray<Point>;
      readonly text?: string | undefined;
    }
  | { readonly kind: "remove"; readonly id: string }
  | { readonly kind: "move"; readonly id: string; readonly points: ReadonlyArray<Point> }
  | { readonly kind: "range"; readonly from: number; readonly to: number }
  | { readonly kind: "symbol"; readonly name: string }
  | { readonly kind: "timeframe"; readonly resolution: string }
  | {
      readonly kind: "indicator";
      readonly name: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    }
  | {
      readonly kind: "inputs";
      readonly study: string;
      readonly inputs: Readonly<Record<string, unknown>>;
    };

// A change through the chart API: what it made, a drawing's or a study's id, or what it missed.
const write = async (change: Change) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();

  if (chart === undefined) return { missing: "a TradingView chart" };
  const drawing = (id: string) => chart.getAllShapes().some((shape) => shape.id === id);
  const study = (id: string) => chart.getAllStudies().some((candidate) => candidate.id === id);

  switch (change.kind) {
    case "draw": {
      const [only, ...more] = change.points;

      const options =
        change.text === undefined
          ? { shape: change.shape }
          : { shape: change.shape, text: change.text };

      return {
        value: String(
          await (only !== undefined && more.length === 0
            ? chart.createShape(only, options)
            : chart.createMultipointShape(change.points, options)),
        ),
      };
    }
    case "remove":
      if (!drawing(change.id) && !study(change.id))
        return { missing: `drawing or study ${change.id}` };
      chart.removeEntity(change.id);

      return { value: "" };
    case "move":
      if (!drawing(change.id)) return { missing: `drawing ${change.id}` };
      await chart.getShapeById(change.id).setPoints(change.points);

      return { value: "" };
    case "range":
      await chart.setVisibleRange({ from: change.from, to: change.to });

      return { value: "" };
    case "symbol":
      await chart.setSymbol(change.name);

      return { value: "" };
    case "timeframe":
      await chart.setResolution(change.resolution);

      return { value: "" };
    case "indicator":
      return {
        value: String(await chart.createStudy(change.name, false, false, change.inputs)),
      };
    case "inputs":
      if (!study(change.study)) return { missing: `study ${change.study}` };
      await chart
        .getStudyById(change.study)
        .setInputValues(Object.entries(change.inputs).map(([id, value]) => ({ id, value })));

      return { value: "" };
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
      .act(write, { arg: request, result: Outcome(Schema.String), document, connection })
      .pipe(Effect.flatMap(outcome));
  });

/**
 * Draw through chart points, as many as the shape takes, with its text for one that shows text;
 * gives the drawing's id.
 */
export const draw = (
  page: Page,
  drawing: {
    readonly shape: Shape;
    readonly points: ReadonlyArray<Point>;
    readonly text?: string | undefined;
  },
) => change(page, { kind: "draw", ...drawing });

/** Remove a drawing or a study by its id. */
export const remove = (page: Page, id: string) =>
  Effect.asVoid(change(page, { kind: "remove", id }));

/** Set a drawing's points, all of them, in its own order. */
export const move = (
  page: Page,
  drawing: { readonly id: string; readonly points: ReadonlyArray<Point> },
) => Effect.asVoid(change(page, { kind: "move", ...drawing }));

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

/** Set a study's inputs by id, such as `{ length: 21 }`; the rest keep their values. */
export const inputs = (
  page: Page,
  request: { readonly study: string; readonly inputs: Readonly<Record<string, unknown>> },
) => Effect.asVoid(change(page, { kind: "inputs", ...request }));
