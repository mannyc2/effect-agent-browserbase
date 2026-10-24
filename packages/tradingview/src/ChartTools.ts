/**
 * A Yielded agent's tools for a TradingView chart on the tab `effect-agent-browser`'s
 * `BrowserTools` serves. `Reads` give the chart's state with its studies' inputs and latest
 * values, its bars and a study's values as numbers, and the viewport points of times and prices,
 * which the pointer tools take. `Writes` change the chart as `ChartInput` does, with TradingView's
 * own toolbar, hotkeys, searches and dialogs: on a presenter's page the viewers see each change
 * made. `layer` serves both over the run's `BrowserTools.Controller`, beneath `BrowserTools`' own
 * layer; an agent's toolkit holds whichever the model may use.
 *
 * `methods` holds the same tools as a Code Mode namespace's methods, named without `chart_`, as
 * `chart.state({})` and `chart.draw({ shape, points })`. A program's changes are the same input as
 * the tools'.
 *
 * ```ts
 * const tools = BrowserTools.make();
 * const toolkit = Toolkit.merge(tools.toolkit, ChartTools.Reads, ChartTools.Writes);
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
import * as ChartInput from "./ChartInput.ts";

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

const window = {
  last: optional(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 1_000 })),
    "The latest this many bars",
  ),
  from: optional(Schema.Finite, "From this time"),
  to: optional(Schema.Finite, "To this time"),
};

/** What a change did, how, with visible input or the chart's API, and what followed it. */
export const Changed = Schema.Struct({
  did: Schema.String,
  via: Schema.Literals(["input", "corrected", "api"]),
  followed: Schema.Array(Schema.String),
});

const Inputs = Schema.Array(Schema.Struct({ id: Schema.String, value: Chart.InputValue }));

const reads = {
  // Without parameters, not with an empty struct, whose JSON Schema OpenAI refuses.
  state: Tool.make("chart_state", {
    description:
      "Read the chart's symbol, timeframe, the times of the first and last bars in view, the prices in view, its studies with their inputs and latest values, and its drawings.",
    parameters: Tool.EmptyParams,
    success: Chart.State,
    failure: BrowserUse.BrowserUseError,
    failureMode: "return",
  }),
  bars: chartTool(
    "chart_bars",
    "Read the chart's bars as [time, open, high, low, close, volume], oldest first, times in UTC seconds: the last few, or those between two times, by default the bars in view.",
    window,
    // Plain arrays, as a tuple's JSON Schema is one that Code Mode and some providers refuse.
    Schema.Array(Schema.Array(Schema.NullOr(Schema.Finite))),
  ),
  values: chartTool(
    "chart_values",
    "Read a study's values by its id from chart_state, as rows of [time, ...each plot's value] in the order of its plots' titles: the last few bars', or those between two times, by default the bars in view.",
    { study: Schema.String, ...window },
    Chart.Values,
  ),
  point: chartTool(
    "chart_point",
    "Give the viewport point of each time and price on the main pane, which click_at, hover and drag take, to click exactly there; null where the chart cannot place it.",
    { points: Points },
    Schema.Array(Schema.NullOr(Chart.Position)),
  ),
  at: chartTool(
    "chart_at",
    "Give the time and price under each viewport point, on the main pane's scale; null where the chart has no time there.",
    {
      positions: Schema.Array(Chart.Position).check(Schema.isMinLength(1), Schema.isMaxLength(20)),
    },
    Schema.Array(Schema.NullOr(Chart.Point)),
  ),
};

const writes = {
  draw: chartTool(
    "chart_draw",
    "Draw with the chart's own drawing tools through exact times and prices, one point per click the tool takes: one for horizontal_line, vertical_line, cross_line, horizontal_ray, long_position, short_position, text and the arrows and flags; two for trend_line, ray, extended, rectangle, circle, fib_retracement, price_range, date_range and most others; three for parallel_channel, pitchfork, triangle and fib_trend_ext.",
    {
      shape: Chart.Shape,
      points: Points,
      text: optional(
        Schema.NonEmptyString.check(Schema.isMaxLength(500)),
        "A text drawing's words",
      ),
    },
    Changed,
  ),
  remove: chartTool(
    "chart_remove",
    "Remove a drawing or a study by its id from chart_state.",
    { id: Schema.NonEmptyString },
    Changed,
  ),
  range: chartTool(
    "chart_range",
    "Show the bars from one time to another, zooming and scrolling the chart.",
    { from: Schema.Finite, to: Schema.Finite },
    Changed,
  ),
  symbol: chartTool(
    "chart_symbol",
    "Chart another symbol, such as MSFT.",
    { symbol: Schema.NonEmptyString.check(Schema.isMaxLength(100)) },
    Changed,
  ),
  timeframe: chartTool(
    "chart_timeframe",
    'Chart another timeframe, as chart_state writes it: "60" for an hour, "240" for four, "1D" for a day.',
    { resolution: Schema.NonEmptyString.check(Schema.isMaxLength(10)) },
    Changed,
  ),
  indicator: chartTool(
    "chart_indicator",
    "Add an indicator by its full name, such as Relative Strength Index, with inputs by id, such as length.",
    {
      name: Schema.NonEmptyString.check(Schema.isMaxLength(100)),
      inputs: optional(Inputs, "Inputs to set; the rest keep their defaults"),
    },
    Changed,
  ),
  inputs: chartTool(
    "chart_inputs",
    "Change a study's inputs, by its id and their ids from chart_state, such as length.",
    { study: Schema.NonEmptyString, inputs: Inputs.check(Schema.isMinLength(1)) },
    Changed,
  ),
};

/** The tools that read the chart. */
export const Reads = Toolkit.make(...Object.values(reads));

/** The tools that change the chart, with visible input the chart's API completes. */
export const Writes = Toolkit.make(...Object.values(writes));

/**
 * The tools as a Code Mode namespace's methods, named without `chart_`: `chart.state({})`,
 * `chart.values({ study })`, `chart.draw({ shape, points })` and so on. A program that only reads
 * takes the reads: `state`, `bars`, `values`, `point` and `at`.
 */
export const methods = { ...reads, ...writes };

const price = (value: number) => String(Math.round(value * 1e6) / 1e6);

const listed = (inputs: Chart.Study["inputs"]) =>
  inputs.map(({ id, value }) => `${id}=${String(value)}`).join(", ");

// What an added study did not take: the inputs asked for that it does not have.
const untaken = (asked: ReadonlyArray<{ readonly id: string }>, study: Chart.Study) => {
  const missing = asked.filter(({ id }) => !study.inputs.some((input) => input.id === id));

  return missing.length === 0
    ? ""
    : ` It has no input ${missing.map(({ id }) => id).join(", ")}; its inputs are ${study.inputs.map(({ id, name }) => `${id} (${name})`).join(", ")}.`;
};

const handlers = Effect.gen(function* () {
  const controller = yield* BrowserTools.Controller;

  const read = <A>(run: (page: Page) => Effect.Effect<A, BrowserError>) =>
    Effect.flatMap(controller.current, run).pipe(
      Effect.mapError(PageControl.useError),
      controller.withTask,
    );

  const write = <A extends { readonly via: ChartInput.Via }>(
    run: (page: Page) => Effect.Effect<A, BrowserError>,
    did: (value: A) => string,
  ) =>
    controller.perform(run).pipe(
      Effect.map(({ value, followed }) => ({ did: did(value), via: value.via, followed })),
      Effect.mapError(PageControl.useError),
    );

  const byId = (inputs: ReadonlyArray<{ readonly id: string; readonly value: Chart.InputValue }>) =>
    Object.fromEntries(inputs.map(({ id, value }) => [id, value]));

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
      chart_values: ({ study, last, from, to }) =>
        read((page) =>
          Chart.values(page, {
            study,
            last: last ?? undefined,
            from: from ?? undefined,
            to: to ?? undefined,
          }),
        ),
      chart_point: ({ points }) => read((page) => Chart.point(page, points)),
      chart_at: ({ positions }) => read((page) => Chart.at(page, positions)),
    }),
    writes: Writes.of({
      chart_draw: ({ shape, points, text }) =>
        write(
          (page) => ChartInput.draw(page, { shape, points, text: text ?? undefined }),
          (drawn) =>
            `Drew ${drawn.name} ${drawn.id} through ${drawn.points.map((point) => `${price(point.price)} at ${point.time}`).join(", ")}.`,
        ),
      chart_remove: ({ id }) =>
        write(
          (page) => ChartInput.remove(page, id),
          () => `Removed ${id}.`,
        ),
      chart_range: (span) =>
        write(
          (page) => ChartInput.range(page, span),
          ({ view }) => `Showing ${view.from} to ${view.to}.`,
        ),
      chart_symbol: ({ symbol }) =>
        write(
          (page) => ChartInput.symbol(page, symbol),
          (shown) => `Charting ${shown.symbol}.`,
        ),
      chart_timeframe: ({ resolution }) =>
        write(
          (page) => ChartInput.timeframe(page, resolution),
          (shown) => `Charting the ${shown.resolution} timeframe.`,
        ),
      chart_indicator: ({ name, inputs }) =>
        write(
          (page) => ChartInput.indicator(page, { name, inputs: byId(inputs ?? []) }),
          (study) =>
            `Added ${study.name}, ${study.id}: ${listed(study.inputs) || "no inputs"}.${untaken(inputs ?? [], study)}`,
        ),
      chart_inputs: ({ study, inputs }) =>
        write(
          (page) => ChartInput.inputs(page, { study, inputs: byId(inputs) }),
          (held) => `${held.name} ${held.id} has ${listed(held.inputs)}.`,
        ),
    }),
  };
});

/** Both toolkits' handlers, over the run's `BrowserTools.Controller`. */
export const layer = Layer.mergeAll(
  Reads.toLayer(Effect.map(handlers, ({ reads }) => reads)),
  Writes.toLayer(Effect.map(handlers, ({ writes }) => writes)),
);
