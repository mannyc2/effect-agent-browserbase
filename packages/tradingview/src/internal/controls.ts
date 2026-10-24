// The chart's visible changes besides drawings: the wheel to show a span of bars, typing on the chart
// for a symbol or a timeframe, the indicator search, and a study's settings for its inputs.
import { Effect, Schema } from "effect";
import type { Page } from "effect-browser/Page";

import * as Chart from "../Chart.ts";
import {
  awaiting,
  control,
  type Glance,
  invalid,
  look,
  notFound,
  quoted,
  ready,
  shown,
  taken,
  Untaken,
  until,
  type Via,
  within,
} from "./input.ts";

// --- The span in view ----------------------------------------------------------------------------

const Span = Schema.Struct({ first: Schema.Finite, last: Schema.Finite });

const Spanned = Schema.NullOr(
  Schema.Struct({
    shown: Span,
    wanted: Span,
    spacing: Schema.Finite,
    view: Schema.Struct({ from: Schema.Finite, to: Schema.Finite }),
  }),
);

// The bars in view and those a span asks for, as indices of the main series, with the pixels
// between bars. A time past the loaded bars counts on in bars, as `Chart.point` places it.
const spanOf = (span: { readonly from: number; readonly to: number }) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();
  const view = chart?.getVisibleBarsRange() ?? null;

  if (chart === undefined || view === null) return null;
  const model = chart.chartModel();
  const bars = model.mainSeries().bars();
  const first = bars.firstIndex();
  const last = bars.lastIndex();

  if (first === null || last === null) return null;
  const timeOf = (index: number) => bars.valueAt(index)?.[0] ?? Number.NaN;
  const step = timeOf(last) - timeOf(last - 1);

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

  const scale = model.timeScale();

  return {
    shown: { first: indexOf(view.from), last: indexOf(view.to) },
    wanted: { first: indexOf(span.from), last: indexOf(span.to) },
    spacing: scale.indexToCoordinate(last) - scale.indexToCoordinate(last - 1),
    view,
  };
};

const spanned = (page: Page, span: { readonly from: number; readonly to: number }) =>
  page
    .read(spanOf, { arg: span, result: Spanned })
    .pipe(
      Effect.flatMap(({ value }) =>
        value === null ? notFound("a TradingView chart") : Effect.succeed(value),
      ),
    );

// One wheel notch zooms the demo's chart about a tenth.
const notch = Math.log(1.1);

/**
 * Show the bars from one time to another as a person does, with the wheel over the chart: down to
 * zoom in, sideways to scroll, a step at a time until the bars in view are those asked for. Where
 * the wheel leaves the ends more than a bar or a twentieth of the span off, the API sets the view,
 * where the chart implements it. Gives the times of the first and last bars then in view.
 */
export const range = (page: Page, span: { readonly from: number; readonly to: number }) =>
  Effect.gen(function* () {
    if (!(span.to > span.from)) return yield* invalid("a span's end comes after its start");
    const { pane } = yield* look(page);

    const markOf = ({ view }: { readonly view: { readonly from: number; readonly to: number } }) =>
      `${view.from}:${view.to}`;

    let start: string | undefined;
    let previous = "";

    for (let step = 0; step < 40 && pane !== null; step++) {
      const now = yield* spanned(page, span);
      const count = now.wanted.last - now.wanted.first + 1;
      const notches = Math.round(Math.log((now.shown.last - now.shown.first + 1) / count) / notch);
      const shift = (now.wanted.first + now.wanted.last - now.shown.first - now.shown.last) / 2;
      const mark = markOf(now);

      start ??= mark;
      // The last turn of the wheel moved nothing, or nothing is left to move.
      if (mark === previous || (notches === 0 && Math.abs(shift) < 1)) break;
      previous = mark;
      const at = { x: pane.x + pane.width / 2, y: pane.y + pane.height / 2 };

      if (notches !== 0) yield* page.scroll({ at, dy: -100 * Math.max(-9, Math.min(9, notches)) });
      else yield* page.scroll({ at, dx: shift * now.spacing });
    }
    const now = yield* spanned(page, span);
    const slack = Math.max(1, (now.wanted.last - now.wanted.first + 1) / 20);

    const close =
      Math.abs(now.shown.first - now.wanted.first) <= slack &&
      Math.abs(now.shown.last - now.wanted.last) <= slack;

    if (close) return { view: now.view, via: "input" as Via };

    // tradingview.com does not implement setVisibleRange: the wheel's view stands there.
    const snapped = yield* Chart.range(page, span).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "Threw",
        () => Effect.succeed(false),
      ),
    );

    // The API corrected the wheel's view, or made it where the wheel moved nothing.
    return {
      view: (yield* Chart.state(page)).view,
      via: (snapped
        ? start !== undefined && markOf(now) !== start
          ? "corrected"
          : "api"
        : "input") as Via,
    };
  });

// --- Symbol and timeframe ------------------------------------------------------------------------

const Searches = Schema.Struct({
  symbols: Schema.Array(Schema.String),
  indicators: Schema.Array(Schema.String),
});

type Searches = typeof Searches.Type;

// What the chart's searches list: the tickers of the symbol search's first results, and the titles
// of the indicator search's.
const searches = () => {
  const documents = [
    document,
    ...Array.from(document.querySelectorAll("iframe")).flatMap((frame) =>
      frame.contentDocument === null ? [] : [frame.contentDocument],
    ),
  ];

  const all = (selector: string, read: (element: Element) => string) =>
    documents.flatMap((inner) => Array.from(inner.querySelectorAll(selector), read));

  return {
    symbols: all(
      '[data-name="symbol-search-items-dialog"] [data-name="list-item-title"]',
      (element) => (element.textContent ?? "").trim(),
    ).slice(0, 5),
    indicators: all(
      '[data-name="indicators-dialog"] [data-role="list-item"][data-title]',
      (element) => element.getAttribute("data-title") ?? "",
    ).slice(0, 40),
  };
};

// Read the searches every 50 ms until `done` holds, for up to `millis`.
const listed = (page: Page, done: (seen: Searches) => boolean, millis: number) =>
  page.read(searches, { arg: undefined, result: Searches }).pipe(
    Effect.map(({ value }): Searches => value),
    Effect.repeat({ until: done, schedule: within(millis) }),
  );

const tickerOf = (name: string) => (name.split(":").at(-1) ?? name).trim().toUpperCase();

// A symbol typed on the chart, which opens the symbol search with it; Enter charts the first
// result once that is its ticker.
const searched = (page: Page, name: string) =>
  Effect.gen(function* () {
    const ticker = tickerOf(name);
    const first = (seen: Searches) => seen.symbols[0]?.toUpperCase() === ticker;

    yield* ready(page);
    yield* page.type(name);
    if (!first(yield* listed(page, first, 5_000)))
      return yield* new Untaken({ reason: `the symbol search listed no ${ticker}` });
    yield* page.press("Enter");
    yield* awaiting(page, (seen) => tickerOf(seen.symbol) === ticker, 8_000, "Enter missed");
  });

/**
 * Chart another symbol, such as "MSFT" or "BINANCE:ETHUSDT", typed on the chart, as opens its
 * symbol search, and chosen with Enter. Gives the symbol the chart then shows, once it has loaded.
 */
export const symbol = (page: Page, name: string) =>
  Effect.gen(function* () {
    const shows = (seen: Glance) => tickerOf(seen.symbol) === tickerOf(name);

    const via = shows(yield* look(page))
      ? ("input" as Via)
      : yield* searched(page, name).pipe(
          taken,
          Effect.as<Via>("input"),
          Effect.catchTag("Untaken", () =>
            page
              .press("Escape")
              .pipe(Effect.andThen(Chart.symbol(page, name)), Effect.as<Via>("api")),
          ),
        );

    return {
      symbol: (yield* until(page, (seen) => seen.loaded && shows(seen), 10_000)).symbol,
      via,
    };
  });

// A timeframe as the chart writes it, its count of one left out: "D" for "1D".
const plain = (resolution: string) =>
  resolution
    .trim()
    .toUpperCase()
    .replace(/^1(?=[A-Z])/, "");

/**
 * Chart another timeframe, as `State.resolution` writes it, typed on the chart, digit first as
 * opens its interval dialog, and applied with Enter. Gives the timeframe the chart then shows.
 */
export const timeframe = (page: Page, resolution: string) =>
  Effect.gen(function* () {
    const shows = (seen: Glance) => plain(seen.resolution) === plain(resolution);

    const typed = Effect.gen(function* () {
      yield* ready(page);
      // A letter first would open the symbol search instead: "1D", not "D".
      yield* page.type(/^\d/.test(resolution) ? resolution : `1${resolution}`);
      yield* page.press("Enter");
      yield* awaiting(page, shows, 6_000, `the chart took no ${resolution} timeframe`);
    });

    const via = shows(yield* look(page))
      ? ("input" as Via)
      : yield* typed.pipe(
          taken,
          Effect.as<Via>("input"),
          Effect.catchTag("Untaken", () =>
            page
              .press("Escape")
              .pipe(Effect.andThen(Chart.timeframe(page, resolution)), Effect.as<Via>("api")),
          ),
        );

    return {
      resolution: (yield* until(page, (seen) => seen.loaded && shows(seen), 10_000)).resolution,
      via,
    };
  });

// --- Studies -------------------------------------------------------------------------------------

const studyOf = (page: Page, id: string) =>
  Effect.flatMap(Chart.state(page), (state) => {
    const study = state.studies.find((candidate) => candidate.id === id);

    return study === undefined ? notFound(`study ${id}`) : Effect.succeed(study);
  });

const titled = (titles: ReadonlyArray<string>, name: string) => {
  const wanted = name.trim().toLowerCase();

  return (
    titles.find((title) => title.toLowerCase() === wanted) ??
    titles.find((title) => title.toLowerCase().includes(wanted))
  );
};

// A study from the indicator search, which "/" opens: its name typed, then a click on the result
// with that title. Gives the study's id.
const found = (page: Page, name: string, before: Glance) =>
  Effect.gen(function* () {
    const dialog = '[data-name="indicators-dialog"]';
    const fresh = (seen: Glance) => seen.studies.filter((id) => !before.studies.includes(id));

    yield* ready(page);
    yield* page.press("/");
    yield* shown(page, dialog, "indicator search", 2_000);
    yield* page.type(name);

    const results = yield* listed(
      page,
      (seen) => titled(seen.indicators, name) !== undefined,
      4_000,
    );

    const title = titled(results.indicators, name);

    if (title === undefined)
      return yield* new Untaken({ reason: `the indicator search listed no ${name}` });
    const result = `${dialog} [data-role="list-item"][data-title="${quoted(title)}"]`;

    yield* page.click((yield* control(page, result, `${title} result`)).ref);
    const seen = yield* awaiting(page, (seen) => fresh(seen).length > 0, 3_000, "no study added");

    yield* page.press("Escape");

    return fresh(seen).at(-1) ?? "";
  });

/**
 * Add a study by its name, such as "Relative Strength Index", from the indicator search, with
 * inputs by id set in its settings as `inputs` sets them. Gives the study as the chart then holds
 * it; an input it does not have is not set.
 */
export const indicator = (
  page: Page,
  request: {
    readonly name: string;
    readonly inputs?: Readonly<Record<string, Chart.InputValue>> | undefined;
  },
) =>
  Effect.gen(function* () {
    const added = yield* found(page, request.name, yield* look(page)).pipe(
      taken,
      Effect.map((id) => ({ id, via: "input" as Via })),
      Effect.catchTag("Untaken", () =>
        page.press("Escape").pipe(
          Effect.andThen(Chart.indicator(page, request)),
          Effect.map((id) => ({ id, via: "api" as Via })),
        ),
      ),
    );

    const study = yield* studyOf(page, added.id);

    // Through the API, the study took its inputs as it was added. Of the rest, those it has.
    const wanted = Object.entries(request.inputs ?? {}).filter(([id]) =>
      study.inputs.some((input) => input.id === id),
    );

    if (added.via === "api" || wanted.length === 0) return { ...study, via: added.via };
    const set = yield* inputs(page, { study: added.id, inputs: Object.fromEntries(wanted) });

    return { ...set, via: set.via === "input" ? set.via : ("corrected" as Via) };
  });

const Field = Schema.NullOr(
  Schema.Struct({ kind: Schema.Literals(["text", "list"]), x: Schema.Finite, y: Schema.Finite }),
);

// The settings dialog's field for an input, by the name it shares a row with: a text field or a
// list, and its centre in the viewport.
const fieldOf = (name: string) => {
  const frames = Array.from(document.querySelectorAll("iframe"));

  for (const inner of [document, ...frames.map((frame) => frame.contentDocument)]) {
    const dialog = inner?.querySelector('[data-name="indicator-properties-dialog"]') ?? null;

    if (inner === null || inner === undefined || dialog === null) continue;
    const offset = inner.defaultView?.frameElement?.getBoundingClientRect() ?? { x: 0, y: 0 };

    const fields = Array.from(
      dialog.querySelectorAll(
        'input:not([type="radio"]):not([type="checkbox"]), [role="combobox"]',
      ),
      (field) => ({ field, box: field.getBoundingClientRect() }),
    ).filter(({ box }) => box.width > 0);

    for (const label of Array.from(dialog.querySelectorAll("*"))) {
      if (label.children.length > 0 || (label.textContent ?? "").trim() !== name) continue;
      const box = label.getBoundingClientRect();
      const middle = box.y + box.height / 2;

      const [nearest] = fields
        .filter((candidate) => Math.abs(candidate.box.y + candidate.box.height / 2 - middle) < 14)
        .sort((one, other) => Math.abs(one.box.x - box.right) - Math.abs(other.box.x - box.right));

      if (nearest !== undefined)
        return {
          kind: nearest.field.getAttribute("role") === "combobox" ? "list" : "text",
          x: offset.x + nearest.box.x + nearest.box.width / 2,
          y: offset.y + nearest.box.y + nearest.box.height / 2,
        };
    }
  }

  return null;
};

// The ref of what a selector finds at a viewport point.
const refAt = (page: Page, selector: string, point: { readonly x: number; readonly y: number }) =>
  Effect.flatMap(page.find({ selector, state: "visible" }), (all) => {
    const hit = all.find(
      ({ box }) =>
        point.x >= box.x &&
        point.x <= box.x + box.width &&
        point.y >= box.y &&
        point.y <= box.y + box.height,
    );

    return hit === undefined
      ? Effect.fail(new Untaken({ reason: "a settings field has no ref" }))
      : Effect.succeed(hit.ref);
  });

// A list's option, chosen by its label; the list closes again when none has it.
const choose = (page: Page, list: string, value: string) =>
  Effect.gen(function* () {
    yield* page.click(list);
    yield* page.until({ selector: '[role="option"]', state: "visible" }, "some", 1_000);

    const option = (yield* page.find({ selector: '[role="option"]', state: "visible" })).find(
      ({ subject }) => subject.name.trim().toLowerCase() === value.trim().toLowerCase(),
    );

    yield* page.click(option?.ref ?? list);
  });

// A study's settings dialog, from its legend row's Settings button, with each named input typed or
// chosen, then Ok.
const configured = (
  page: Page,
  id: string,
  fields: ReadonlyArray<{ readonly name: string; readonly value: Chart.InputValue }>,
) =>
  Effect.gen(function* () {
    const row = `[data-qa-id="legend-source-item"][data-entity-id="${quoted(id)}"]`;
    const dialog = '[data-name="indicator-properties-dialog"]';

    yield* page.hover(
      (yield* control(page, `${row} [data-qa-id~="legend-source-title"]`, "legend row")).ref,
    );
    yield* page.click(
      (yield* shown(page, `${row} [data-qa-id="legend-settings-action"]`, "Settings button")).ref,
    );
    yield* shown(page, dialog, "settings dialog", 2_000);
    for (const { name, value } of fields) {
      const field = (yield* page.read(fieldOf, { arg: name, result: Field })).value;

      // A switch, or an input the dialog does not show, is left to the API.
      if (field === null || typeof value === "boolean") continue;
      const ref = yield* refAt(page, `${dialog} input, ${dialog} [role="combobox"]`, field);

      if (field.kind === "text") yield* page.type(String(value), { into: ref, replace: true });
      else yield* choose(page, ref, String(value));
    }
    yield* page.click((yield* control(page, `${dialog} [data-name="submit-button"]`, "Ok")).ref);
    yield* page.until({ selector: dialog, state: "visible" }, "none", 1_500);
  });

const holds = (study: Chart.Study, id: string, value: Chart.InputValue) =>
  study.inputs.some((input) => input.id === id && String(input.value) === String(value));

/**
 * Set a study's inputs by id, such as `{ length: 21 }`, in its settings dialog, which its legend
 * row opens: each typed into its field or chosen from its list by the name the dialog shows. The
 * API sets those the dialog has no field for, such as a switch. Gives the study as the chart then
 * holds it, and fails `InvalidRequest`, naming its inputs, for an input it does not have.
 */
export const inputs = (
  page: Page,
  request: { readonly study: string; readonly inputs: Readonly<Record<string, Chart.InputValue>> },
) =>
  Effect.gen(function* () {
    const study = yield* studyOf(page, request.study);
    const wanted = Object.entries(request.inputs);
    const unknown = wanted.filter(([id]) => !study.inputs.some((input) => input.id === id));

    if (unknown.length > 0)
      return yield* invalid(
        `${study.name} has no input ${unknown.map(([id]) => id).join(", ")}; its inputs are ${study.inputs.map(({ id, name }) => `${id} (${name})`).join(", ")}`,
      );
    if (wanted.every(([id, value]) => holds(study, id, value)))
      return { ...study, via: "input" as Via };

    const fields = wanted.flatMap(([id, value]) => {
      const name = study.inputs.find((input) => input.id === id)?.name;

      return name === undefined ? [] : [{ name, value }];
    });

    yield* configured(page, request.study, fields).pipe(
      taken,
      Effect.catchTag("Untaken", () => page.press("Escape")),
    );
    const held = yield* studyOf(page, request.study);
    const unset = wanted.filter(([id, value]) => !holds(held, id, value));

    if (unset.length === 0) return { ...held, via: "input" as Via };
    yield* Chart.inputs(page, { study: request.study, inputs: Object.fromEntries(unset) });

    return {
      ...(yield* studyOf(page, request.study)),
      via: (unset.length < wanted.length ? "corrected" : "api") as Via,
    };
  });
