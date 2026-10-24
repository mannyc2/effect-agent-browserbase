// A stand-in for TradingView's widget on a blank page, with the chart in a frame of its own as the
// library's embeds have it: 100 hourly bars, the last 40 in view, ten pixels apart, and a price
// scale of two pixels to a dollar. The frame sits at (10, 20) and its pane at (40, 30) inside it.
// Every study takes a length and a smoothing, and plots its bar's index and twice that. Of the
// chart's own input, it answers only Alt+H, a level at the pointer, which its magnet puts on the
// nearest of that bar's prices.
import { Effect, Schema } from "effect";
import type { Page } from "effect-browser/Page";

export const start = 1_700_000_000;

export const hour = 3600;

/** The time of bar `index`. */
export const time = (index: number) => start + index * hour;

/** Where the stand-in puts bar `index` and a price, in viewport pixels. */
export const position = (index: number, price: number) => ({
  x: 10 + 40 + (index - 60) * 10 + 5,
  y: 20 + 30 + (200 - price) * 2,
});

const install = (first: number) => {
  const frame = document.createElement("iframe");

  frame.style.cssText =
    "position:absolute;left:10px;top:20px;width:1000px;height:600px;border:0;margin:0";
  document.body.style.margin = "0";
  document.body.append(frame);
  const inner = frame.contentDocument!;

  inner.body.style.margin = "0";
  inner.body.innerHTML =
    '<canvas data-name="pane-canvas" style="position:absolute;left:40px;top:30px;width:800px;height:400px"></canvas>';
  const timeOf = (index: number) => first + index * 3600;

  const shapes: Array<{
    id: string;
    name: string;
    points: Array<{ time: number; price: number }>;
  }> = [];

  const studies: Array<{ id: string; name: string; inputs: unknown }> = [];
  const values = new Map<string, Record<string, unknown>>();
  const calls: Array<unknown> = [];
  const clicks: Array<{ x: number; y: number }> = [];
  let symbol = "DEMO:AAPL";
  let resolution = "60";
  let pointer = { x: 0, y: 0 };

  inner.addEventListener("click", (event) => {
    clicks.push({ x: event.clientX + 10, y: event.clientY + 20 });
  });
  inner.addEventListener("mousemove", (event) => {
    pointer = { x: event.clientX - 40, y: event.clientY - 30 };
  });
  inner.addEventListener("keydown", (event) => {
    if (!event.altKey || event.code !== "KeyH") return;
    const index = Math.round((pointer.x - 5) / 10) + 60;
    const open = 100 + index;
    const price = 200 - pointer.y / 2;

    const [nearest] = [open, open + 2, open - 1, open + 1].sort(
      (a, b) => Math.abs(a - price) - Math.abs(b - price),
    );

    shapes.push({
      id: `shape${shapes.length + 1}`,
      name: "horizontal_line",
      points: [{ time: timeOf(index), price: nearest ?? price }],
    });
  });

  const info = [
    { id: "length", name: "length", localizedName: "Length", type: "integer", defval: 14 },
    { id: "smoothing", name: "smoothing", localizedName: "Smoothing", type: "text", defval: "SMA" },
    { id: "source", name: "source", type: "source", defval: "close", isHidden: true },
    { id: "symbol", name: "symbol", type: "symbol", defval: "" },
  ];

  // A study's plots: its value, a colourer, which holds none, and a second line of the same title.
  const source = (id: string) => ({
    id: () => id,
    metaInfo: () => ({
      plots: [
        { id: "plot_0", type: "line" },
        { id: "plot_1", type: "colorer" },
        { id: "plot_2", type: "line" },
      ],
      styles: { plot_0: { title: "Plot" }, plot_2: { title: "Plot" } },
    }),
    data: () => ({
      firstIndex: () => 0,
      lastIndex: () => 99,
      valueAt: (index: number) => [timeOf(index), index, 0, index * 2],
    }),
  });

  const scale = {
    priceToCoordinate: (price: number) => (200 - price) * 2,
    coordinateToPrice: (y: number) => 200 - y / 2,
  };

  const chart = {
    symbol: () => symbol,
    resolution: () => resolution,
    getVisibleBarsRange: () => ({ from: timeOf(60), to: timeOf(99) }),
    getVisiblePriceRange: () => ({ from: 150, to: 200 }),
    getAllStudies: () => studies.map(({ id, name }) => ({ id, name })),
    getAllShapes: () => shapes.map(({ id, name }) => ({ id, name })),
    getShapeById: (id: string) => ({
      getPoints: () => shapes.find((shape) => shape.id === id)!.points,
      setPoints: (points: Array<{ time: number; price: number }>) => {
        shapes.find((shape) => shape.id === id)!.points = points;
      },
      getProperties: () => ({}),
    }),
    getStudyById: (id: string) => ({
      getInputsInfo: () => info,
      getInputValues: () =>
        Object.entries(values.get(id) ?? {}).map(([input, value]) => ({ id: input, value })),
      setInputValues: (changed: Array<{ id: string; value: unknown }>) => {
        for (const { id: input, value } of changed) values.get(id)![input] = value;
      },
    }),
    removeEntity: (id: string) => {
      for (const list of [shapes, studies]) {
        const at = list.findIndex((entity) => entity.id === id);

        if (at >= 0) list.splice(at, 1);
      }
    },
    getPanes: () => [{ getMainSourcePriceScale: () => scale }],
    getTimeScale: () => ({
      coordinateToTime: (x: number) => {
        const index = Math.round((x - 5) / 10) + 60;

        return index >= 0 && index <= 99 ? timeOf(index) : null;
      },
    }),
    chartModel: () => ({
      mainSeries: () => ({
        bars: () => ({
          firstIndex: () => 0,
          lastIndex: () => 99,
          valueAt: (index: number) => {
            const open = 100 + index;

            return [
              timeOf(index),
              open,
              open + 2,
              open - 1,
              open + 1,
              index === 50 ? Number.NaN : 1000,
            ];
          },
        }),
      }),
      timeScale: () => ({ indexToCoordinate: (index: number) => (index - 60) * 10 + 5 }),
      dataSources: () => studies.map(({ id }) => source(id)),
    }),
    setVisibleRange: (range: unknown) => {
      calls.push({ range });

      return Promise.resolve();
    },
    setSymbol: (name: string) => {
      symbol = name;

      return Promise.resolve();
    },
    setResolution: (name: string) => {
      resolution = name;

      return Promise.resolve();
    },
    createStudy: (
      name: string,
      _overlay: boolean,
      _lock: boolean,
      inputs?: Record<string, unknown>,
    ) => {
      const id = `study${studies.length + 1}`;

      studies.push({ id, name, inputs });
      values.set(id, {
        ...Object.fromEntries(info.map((input) => [input.id, input.defval])),
        ...inputs,
      });

      return Promise.resolve(id);
    },
    createShape: (point: { time: number; price: number }, options: { shape: string }) => {
      const id = `shape${shapes.length + 1}`;

      shapes.push({ id, name: options.shape, points: [point] });

      return id;
    },
    createMultipointShape: (
      points: Array<{ time: number; price: number }>,
      options: { shape: string },
    ) => {
      const id = `shape${shapes.length + 1}`;

      shapes.push({ id, name: options.shape, points });

      return Promise.resolve(id);
    },
  };

  Object.assign(window, {
    tvWidget: { activeChart: () => chart, selectedLineTool: () => "cursor" },
    fixture: { studies, calls, clicks },
  });
};

/** Put the stand-in chart on a page's current document. */
export const chartOn = (page: Page) =>
  Effect.gen(function* () {
    yield* page.act(install, {
      document: (yield* page.state).document,
      arg: start,
      result: Schema.Void,
    });
  });

const Recorded = Schema.Struct({
  studies: Schema.Array(
    Schema.Struct({ id: Schema.String, name: Schema.String, inputs: Schema.Unknown }),
  ),
  calls: Schema.Array(Schema.Unknown),
  clicks: Schema.Array(Schema.Struct({ x: Schema.Finite, y: Schema.Finite })),
});

/** What the stand-in recorded: its studies' inputs, its other calls, and the clicks in its frame. */
export const recorded = (page: Page) =>
  page
    .read(() => (window as unknown as { fixture: unknown }).fixture, {
      arg: undefined,
      result: Recorded,
    })
    .pipe(Effect.map(({ value }) => value));
