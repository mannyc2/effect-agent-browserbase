/**
 * A Yielded agent's tools for a TradingView chart on the tab `effect-agent-browser`'s
 * `BrowserTools` serves. `Reads` give the chart's state, its bars as numbers, and the viewport
 * points of times and prices, which the pointer tools take, so a drawing is still made with visible
 * input, only at exact places. `Writes` change the chart through its API, with no visible input.
 * `layer` serves both over the run's `BrowserTools.Controller`, beneath `BrowserTools`' own layer;
 * an agent's toolkit holds whichever the model may use. `methods` names the reads for a Code Mode
 * program, as `chart.state({})`, `chart.bars({ last })`, `chart.point({ points })` and
 * `chart.at({ positions })`.
 *
 * ```ts
 * const tools = BrowserTools.make();
 * const toolkit = Toolkit.merge(tools.toolkit, ChartTools.Reads);
 * const layer = ChartTools.layer.pipe(Layer.provideMerge(tools.layer({ page }, { task })));
 * ```
 *
 * @since 0.3.0
 */
import { BrowserUse } from "@yielded/agent";
import { Effect, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/BrowserTools";
import * as PageControl from "effect-agent-browser/PageControl";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";
import { Tool, Toolkit } from "effect/ai";

import * as Chart from "./Chart.ts";

// A parameter a model may leave out, or send as null, as models do for one they mean to leave out.
const optional = <S extends Schema.Top>(schema: S, description: string) =>
  Schema.optionalKey(Schema.NullOr(schema).annotate({ description }));

const chartTool = <
  const Name extends string,
  Parameters extends Schema.Struct.Fields,
  Success extends Schema.Top,
>(
  name: Name,
  description: string,
  parameters: Parameters,
  success: Success,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success,
    failure: BrowserUse.BrowserUseError,
    failureMode: "return",
  });

const Points = Schema.Array(Chart.Point).check(Schema.isMinLength(1), Schema.isMaxLength(20));

/** The tools that read the chart. */
export const Reads = Toolkit.make(
  // Without parameters, not with an empty struct, whose JSON Schema OpenAI refuses.
  Tool.make("chart_state", {
    description:
      "Read the chart's symbol, timeframe, the times of the first and last bars in view, the prices in view, and its studies and drawings.",
    parameters: Tool.EmptyParams,
    success: Chart.State,
    failure: BrowserUse.BrowserUseError,
    failureMode: "return",
  }),
  chartTool(
    "chart_bars",
    "Read the chart's bars as [time, open, high, low, close, volume], oldest first, times in UTC seconds: the last few, or those between two times, by default the bars in view.",
    {
      last: optional(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
        "The latest this many bars",
      ),
      from: optional(Schema.Finite, "From this time"),
      to: optional(Schema.Finite, "To this time"),
    },
    // Plain arrays, as a tuple's JSON Schema is one that Code Mode and some providers refuse.
    Schema.Array(Schema.Array(Schema.NullOr(Schema.Finite))),
  ),
  chartTool(
    "chart_point",
    "Give the viewport point of each time and price on the main pane, which click_at, hover and drag take, to draw or click exactly there; null where the chart cannot place it.",
    { points: Points },
    Schema.Array(Schema.NullOr(Chart.Position)),
  ),
  chartTool(
    "chart_at",
    "Give the time and price under each viewport point, on the main pane's scale; null where the chart has no time there.",
    {
      positions: Schema.Array(Chart.Position).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    },
    Schema.Array(Schema.NullOr(Chart.Point)),
  ),
);

/** The tools that change the chart through its API, with no visible input. */
export const Writes = Toolkit.make(
  chartTool(
    "chart_draw",
    "Draw on the chart: a horizontal line at one point's price, a vertical line at its time, or a trend line through two points.",
    { shape: Chart.Shape, points: Points },
    BrowserTools.Receipt,
  ),
  chartTool(
    "chart_range",
    "Show the bars from one time to another.",
    { from: Schema.Finite, to: Schema.Finite },
    BrowserTools.Receipt,
  ),
  chartTool(
    "chart_symbol",
    "Chart another symbol, such as MSFT.",
    { symbol: Schema.NonEmptyString.check(Schema.isMaxLength(100)) },
    BrowserTools.Receipt,
  ),
  chartTool(
    "chart_timeframe",
    'Chart another timeframe, as chart_state writes it: "60" for an hour, "240" for four, "1D" for a day.',
    { resolution: Schema.NonEmptyString.check(Schema.isMaxLength(10)) },
    BrowserTools.Receipt,
  ),
  chartTool(
    "chart_indicator",
    "Add an indicator by its full name, such as Relative Strength Index, with inputs by id, such as length.",
    {
      name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
      inputs: optional(
        Schema.Array(
          Schema.Struct({
            id: Schema.String,
            value: Schema.Union([Schema.Finite, Schema.String, Schema.Boolean]),
          }),
        ),
        "Inputs to set; the rest keep their defaults",
      ),
    },
    BrowserTools.Receipt,
  ),
);

/** The reads as a Code Mode namespace's methods: `chart.state({})`, `chart.bars({})` and so on. */
export const methods = {
  state: Reads.tools.chart_state,
  bars: Reads.tools.chart_bars,
  point: Reads.tools.chart_point,
  at: Reads.tools.chart_at,
};

const handlers = Effect.gen(function* () {
  const controller = yield* BrowserTools.Controller;

  const read = <A>(run: (page: Page) => Effect.Effect<A, BrowserError>) =>
    Effect.flatMap(controller.current, run).pipe(
      Effect.mapError(PageControl.useError),
      controller.withTask,
    );

  const write = <A>(
    run: (page: Page) => Effect.Effect<A, BrowserError>,
    did: (value: A) => string,
  ) =>
    controller.perform(run).pipe(
      Effect.map(({ value, followed }) => ({ did: did(value), followed })),
      Effect.mapError(PageControl.useError),
    );

  return {
    reads: Reads.of({
      chart_state: () => read(Chart.state),
      chart_bars: ({ last, from, to }) =>
        read((page) =>
          Chart.bars(page, {
            last: last ?? undefined,
            from: from ?? undefined,
            to: to ?? undefined,
          }),
        ),
      chart_point: ({ points }) => read((page) => Chart.point(page, points)),
      chart_at: ({ positions }) => read((page) => Chart.at(page, positions)),
    }),
    writes: Writes.of({
      chart_draw: (drawing) =>
        write(
          (page) => Chart.draw(page, drawing),
          (id) => `Drew a ${drawing.shape.replace("_", " ")}, ${id}.`,
        ),
      chart_range: (span) =>
        write(
          (page) => Chart.range(page, span),
          () => `Showing ${span.from} to ${span.to}.`,
        ),
      chart_symbol: ({ symbol }) =>
        write(
          (page) => Chart.symbol(page, symbol),
          () => `Charting ${symbol}.`,
        ),
      chart_timeframe: ({ resolution }) =>
        write(
          (page) => Chart.timeframe(page, resolution),
          () => `Charting the ${resolution} timeframe.`,
        ),
      chart_indicator: ({ name, inputs }) =>
        write(
          (page) =>
            Chart.indicator(page, {
              name,
              inputs: Object.fromEntries((inputs ?? []).map(({ id, value }) => [id, value])),
            }),
          (id) => `Added ${name}, ${id}.`,
        ),
    }),
  };
});

/** Both toolkits' handlers, over the run's `BrowserTools.Controller`. */
export const layer = Layer.mergeAll(
  Reads.toLayer(Effect.map(handlers, ({ reads }) => reads)),
  Writes.toLayer(Effect.map(handlers, ({ writes }) => writes)),
);
