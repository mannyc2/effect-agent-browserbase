// What the visible changes share: how they read the chart between inputs, wait on it, find its
// controls and give it the keys, and the failure that leaves a change to the API.
import { Data, Duration, Effect, Schedule, Schema } from "effect";
import * as BrowserError from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";

import * as Chart from "../Chart.ts";

/** How a change was made: by input alone, by input the API then corrected, or by the API. */
export type Via = "input" | "corrected" | "api";

// The chart did not take the input: a control was missing or did not answer. The change is then
// left to the API.
export class Untaken extends Data.TaggedError("Untaken")<{ readonly reason: string }> {}

// A missing, covered or changed control leaves the change to the API, as `Untaken` does. Any other
// failure, such as a policy's refusal or a closed page, stands.
export const taken = <A, R>(effect: Effect.Effect<A, BrowserError.BrowserError | Untaken, R>) =>
  Effect.mapError(effect, (error) =>
    error._tag === "BrowserError" &&
    !error.dispatched &&
    ["NotFound", "NotActionable", "StaleRef", "InvalidRequest"].includes(error.reason._tag)
      ? new Untaken({ reason: error.message })
      : error,
  );

export const notFound = (target: string) =>
  BrowserError.failWith("chart", new BrowserError.NotFound({ target }));

export const invalid = (detail: string) =>
  BrowserError.failWith("chart", new BrowserError.InvalidRequest({ detail }));

// A value inside a CSS attribute selector's quotes.
export const quoted = (value: string) => value.replace(/["\\]/g, "\\$&");

export const Box = Schema.Struct({
  x: Schema.Finite,
  y: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
});

export type Box = typeof Box.Type;

export const Glance = Schema.Struct({
  tool: Schema.NullOr(Schema.String),
  drawings: Schema.Array(Schema.String),
  studies: Schema.Array(Schema.String),
  selection: Schema.Array(Schema.String),
  symbol: Schema.String,
  resolution: Schema.String,
  loaded: Schema.Boolean,
  focused: Schema.Boolean,
  pane: Schema.NullOr(Box),
  axis: Schema.Finite,
});

export type Glance = typeof Glance.Type;

// What the changes check between inputs, in one read: the drawing tool, the drawings, studies and
// selection, what the chart shows and whether it has loaded, its main pane's box, the height of
// its time axis, and whether the chart's document takes the keys.
const glance = () => {
  const widget = globalThis.tvWidget ?? globalThis.TradingViewApi;
  const chart = widget?.activeChart();

  if (widget === undefined || chart === undefined) return null;

  const frame =
    Array.from(document.querySelectorAll("iframe")).find(
      (candidate) =>
        (candidate.contentDocument?.querySelector('canvas[data-name="pane-canvas"]') ?? null) !==
        null,
    ) ?? null;

  const home = frame?.contentDocument ?? document;
  const offset = frame?.getBoundingClientRect() ?? { x: 0, y: 0 };

  const panes = Array.from(home.querySelectorAll('canvas[data-name="pane-canvas"]'), (canvas) =>
    canvas.getBoundingClientRect(),
  );

  const main = panes[0];

  const editable = (element: Element | null) =>
    element !== null &&
    (element.matches("input, textarea, select") ||
      ("isContentEditable" in element && element.isContentEditable === true));

  const bars = chart.chartModel().mainSeries().bars();
  const first = bars.firstIndex();
  const last = bars.lastIndex();

  return {
    tool: widget.selectedLineTool?.() ?? null,
    drawings: chart.getAllShapes().map(({ id }) => id),
    studies: chart.getAllStudies().map(({ id }) => id),
    selection: (chart.selection?.().allSources() ?? []).map(String),
    symbol: chart.symbol(),
    resolution: chart.resolution(),
    loaded: (chart.dataReady?.() ?? true) && first !== null && last !== null && last >= first,
    focused:
      frame === null
        ? !editable(document.activeElement)
        : document.activeElement === frame && !editable(home.activeElement),
    pane:
      main === undefined
        ? null
        : { x: offset.x + main.x, y: offset.y + main.y, width: main.width, height: main.height },
    axis: offset.y + Math.max(0, ...panes.map((box) => box.bottom)) + 12,
  };
};

export const look = (page: Page) =>
  page
    .read(glance, { arg: undefined, result: Schema.NullOr(Glance) })
    .pipe(
      Effect.flatMap(({ value }) =>
        value === null ? notFound("a TradingView chart") : Effect.succeed(value),
      ),
    );

export const within = (millis: number) =>
  Schedule.spaced("50 millis").pipe(Schedule.upTo({ duration: Duration.millis(millis) }));

// Look every 50 ms until `done` holds, for up to `millis`: the last look, whether or not it holds.
export const until = (page: Page, done: (seen: Glance) => boolean, millis: number) =>
  Effect.repeat(look(page), { until: done, schedule: within(millis) });

// As `until`, failing `Untaken` for `reason` when it never holds.
export const awaiting = (
  page: Page,
  done: (seen: Glance) => boolean,
  millis: number,
  reason: string,
) => until(page, done, millis).pipe(Effect.filterOrFail(done, () => new Untaken({ reason })));

// The first element a selector finds visible in view, or in the whole document.
export const control = (
  page: Page,
  selector: string,
  what: string,
  scope: "viewport" | "document" = "viewport",
) =>
  Effect.flatMap(page.find({ selector, state: "visible", scope }), (found) =>
    found[0] === undefined
      ? Effect.fail(new Untaken({ reason: `the chart shows no ${what}` }))
      : Effect.succeed(found[0]),
  );

// As `control`, once a selector finds something or `millis` pass.
export const shown = (
  page: Page,
  selector: string,
  what: string,
  millis = 1_500,
  scope: "viewport" | "document" = "viewport",
) =>
  page
    .until({ selector, state: "visible", scope }, "some", millis)
    .pipe(Effect.andThen(control(page, selector, what, scope)));

export const inside = (pane: Box, { x, y }: Chart.Position) =>
  x > pane.x + 1 && x < pane.x + pane.width - 1 && y > pane.y + 1 && y < pane.y + pane.height - 1;

// The viewport points of chart points, every one in the main pane, as input can reach no other.
export const reach = (page: Page, points: ReadonlyArray<Chart.Point>, pane: Box | null) =>
  Effect.flatMap(Chart.point(page, points), (positions) => {
    const placed = positions.flatMap((position) =>
      position !== null && pane !== null && inside(pane, position) ? [position] : [],
    );

    return placed.length === points.length
      ? Effect.succeed(placed)
      : Effect.fail(new Untaken({ reason: "a point lies off the chart's pane" }));
  });

// Give the chart the keys, unless it has them, with a click on its time axis, which changes nothing.
export const focus = (page: Page, seen: Glance) =>
  seen.focused
    ? Effect.void
    : seen.pane === null
      ? Effect.fail(new Untaken({ reason: "the chart shows no pane" }))
      : Effect.asVoid(page.click({ x: seen.pane.x + seen.pane.width / 2, y: seen.axis }));

// Input starts from the chart's cursor with its keys: Escape leaves a drawing tool.
export const ready = (page: Page) =>
  Effect.gen(function* () {
    const seen = yield* look(page);

    yield* focus(page, seen);
    if (seen.tool === null || seen.tool === "cursor") return seen;
    yield* page.press("Escape");

    return yield* until(page, (next) => next.tool === "cursor", 1_000);
  });
