# effect-browser-tradingview

TradingView charts for `effect-browser`: read a chart's own data, find the exact screen point of a
time and price, and change the chart with its own toolbar, keys and dialogs, as a person does. It
finds the chart of pages that embed TradingView's Advanced Charts library and of tradingview.com.
Its `ChartTools` give a Yielded agent the same as tools, beside `effect-agent-browser`'s browser
tools.

It is checked live on the library's demo, where each change is made by visible input. tradingview.com
refuses drawings when signed out.

```sh
npm install effect-browser-tradingview@beta effect-browser@beta effect playwright-core
```

```ts
import { Effect } from "effect";
import * as Chart from "effect-browser-tradingview/Chart";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";

const program = Effect.gen(function* () {
  const page = yield* (yield* Browser).newPage("https://charting-library.tradingview-widget.com/");
  const last = yield* Chart.bars(page, { last: 20 });
  const average = last.reduce((sum, [, , , , close]) => sum + close, 0) / last.length;
  const [spot] = yield* Chart.point(page, [{ time: last[0]![0], price: average }]);

  // A visible click at the exact point of the average, on the first of the 20 bars.
  if (spot !== null) yield* page.click(spot);
}).pipe(Effect.scoped, Effect.provide(Chromium.layer()));
```

## Chart

Every function takes the page, once its chart has loaded.

- **Reads**, which are side-effect-free page reads: `state` (symbol, timeframe, the bars and prices in
  view, the studies with their inputs and latest values, and the drawings), `bars` (`[time, open, high,
  low, close, volume]`, the bars in view, the `last` few, or those `from` one time `to` another),
  `values` (a study's values on the same bars, in the order of its plots' titles), `point` (the
  viewport points of times and prices on the main pane, which pointer input takes) and `at` (the time
  and price under viewport points).
- **Changes through the API**, which are recorded actions with no visible input: `draw` (any drawing
  tool clicks finish, through its points, with a text drawing's text), `remove`, `move`, `range`,
  `symbol`, `timeframe`, `indicator` and `inputs`. `ChartInput` uses them to correct its input, and
  where the chart shows no control for a change.

Times are the bars' own, in UTC seconds. A page without a chart fails `BrowserError` with reason
`NotFound`. Neither the bars nor a time's x are in TradingView's documented API, and the library's demo
refuses its data export, so both come from the chart's model.

## ChartInput

The same changes as input a viewer sees, through a presenter's view of the page at a person's pace:

- `draw` picks the tool by its hotkey (Alt+H, Alt+V, Alt+C or Alt+J at the pointer, or Alt+T) or from
  its toolbar group's menu, then clicks each point; a text drawing's text is then typed. All 80
  drawing tools that clicks finish are reachable.
- `remove` clicks a drawing and presses Delete, or uses a study's Remove button in its legend row.
- `range` turns the wheel over the chart, to zoom and then scroll, until the asked bars are in view.
- `symbol` and `timeframe` type on the chart, as a person starts a search, and press Enter.
- `indicator` opens the indicator search with "/", types the name and picks the result; `inputs` types
  or chooses each value in the study's settings dialog.

After its input, each reads the chart back. Where the chart put a point elsewhere, or a control is
missing, the API corrects or makes the change, and the result says how through `via`: `"input"`,
`"corrected"` or `"api"`.

```ts
const drawn =
  yield *
  ChartInput.draw(page, {
    shape: "fib_retracement",
    points: [low, high],
  });
// drawn.via: "input" when the toolbar and two clicks made it where asked.
```

## ChartTools

For a Yielded agent, `effect-agent-browser` and `@yielded/agent` are needed too. `Reads` are the tools
`chart_state`, `chart_bars`, `chart_values`, `chart_point` and `chart_at`; `Writes` are `chart_draw`,
`chart_remove`, `chart_range`, `chart_symbol`, `chart_timeframe`, `chart_indicator` and
`chart_inputs`, which change the chart as `ChartInput` does and answer what they did, `via` which path,
and what followed. `layer` serves both over the run's `BrowserTools.Controller`, so they act on the tab
the model sees, with the run's task; an agent's toolkit holds whichever the model may use.

```ts
import { Layer } from "effect";
import * as BrowserTools from "effect-agent-browser/BrowserTools";
import * as ChartTools from "effect-browser-tradingview/ChartTools";
import type { Page } from "effect-browser/Page";
import { Toolkit } from "effect/ai";

const tools = BrowserTools.make();
const toolkit = Toolkit.merge(tools.toolkit, ChartTools.Reads, ChartTools.Writes);
const layer = (page: Page, task: string) =>
  ChartTools.layer.pipe(Layer.provideMerge(tools.layer({ page }, { task })));
```

`ChartTools.methods` names the same tools for a Code Mode program, as `chart.state({})`,
`chart.values({ study })` and `chart.draw({ shape, points })`; a program's changes are the same input
as the tools'. A program that only reads takes `state`, `bars`, `values`, `point` and `at`:

```ts
CodeMode.make("chart_program", {
  description: "Read and change the chart and operate the browser by writing a program.",
  tools: { chart: ChartTools.methods, browser: tools.toolkit.tools },
  limits,
});
```

## Measured

On the library's demo, in the repository's bench, ten chart tasks ran three times each with
gpt-6-luna. Browser tools alone passed 17 of 30. Adding `Reads`, with the pointer still acting,
passed 24. `Reads` with writes through the API, unseen, passed 26, for 40% less per task. The reads
in a program beside the browser tools passed all 30. With gpt-6-luna-pro at low reasoning in
Browserbase, the program passed 12 of 20 against the browser tools' 7. Its misses were drawings
made through the toolbar, which `Writes` now make.

The bench's scripted solutions make every change of its 16 demo tasks through `ChartInput`, on a
plain page and through a presenter, locally and in Browserbase. Watched, with gpt-6-luna-pro at low
reasoning in Browserbase on those 16 tasks twice, `methods` with the changes in a program passed 32
of 32, against 14 for the browser tools alone, for a sixth of their cost; `Reads` and `Writes` as
tools passed 25 of 31. Of the changes the models made, all but one were input; that one drew at a
time out of view, through the API. On air, a drawing took a median 7.5 seconds.

TradingView and its marks belong to TradingView, Inc. This package is not affiliated with it.
