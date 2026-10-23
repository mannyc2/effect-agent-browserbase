# effect-browser-tradingview

TradingView charts for `effect-browser`: read a chart's own data, find the exact screen point of a
time and price, and change the chart through its API. It works on pages that embed TradingView's
Advanced Charts library and on tradingview.com. Its `ChartTools` give a Yielded agent the same as
tools, beside `effect-agent-browser`'s browser tools.

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

- **Reads**, which are side-effect-free page reads: `state` (symbol, timeframe, the bars and prices in view,
  studies and drawings), `bars` (`[time, open, high, low, close, volume]`, the bars in view, the `last`
  few, or those `from` one time `to` another), `point` (the viewport points of times and prices on the
  main pane, which pointer input takes) and `at` (the time and price under viewport points).
- **Changes**, which are recorded actions with no visible input: `draw` (a horizontal, vertical or trend
  line), `range`, `symbol`, `timeframe` and `indicator`.

Times are the bars' own, in UTC seconds. A page without a chart fails `BrowserError` with reason
`NotFound`. Neither the bars nor a time's x are in TradingView's documented API, and the library's demo
refuses its data export, so both come from the chart's model.

## ChartTools

For a Yielded agent, `effect-agent-browser` and `@yielded/agent` are needed too. `Reads` are the tools
`chart_state`, `chart_bars`, `chart_point` and `chart_at`; `Writes` are `chart_draw`, `chart_range`,
`chart_symbol`, `chart_timeframe` and `chart_indicator`. `layer` serves both over the run's
`BrowserTools.Controller`, so they act on the tab the model sees, with the run's task; an agent's
toolkit holds whichever the model may use. On watched pages, `Reads` alone keep every change to the
chart a visible input: the model draws with the pointer at `chart_point`'s points.

```ts
import { Layer } from "effect";
import * as BrowserTools from "effect-agent-browser/BrowserTools";
import * as ChartTools from "effect-browser-tradingview/ChartTools";
import type { Page } from "effect-browser/Page";
import { Toolkit } from "effect/ai";

const tools = BrowserTools.make();
const toolkit = Toolkit.merge(tools.toolkit, ChartTools.Reads);
const layer = (page: Page, task: string) =>
  ChartTools.layer.pipe(Layer.provideMerge(tools.layer({ page }, { task })));
```

`ChartTools.methods` names the reads for a Code Mode program, as `chart.state({})`,
`chart.bars({ last })`, `chart.point({ points })` and `chart.at({ positions })`:

```ts
CodeMode.make("chart_program", {
  description: "Read the chart and operate the browser by writing a program.",
  tools: { chart: ChartTools.methods, browser: tools.toolkit.tools },
  limits,
});
```

TradingView and its marks belong to TradingView, Inc. This package is not affiliated with it.
