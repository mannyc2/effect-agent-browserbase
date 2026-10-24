/**
 * TradingView chart changes made as a person makes them, with an effect-browser page's pointer and
 * keys:
 * - the toolbar's drawing tools and its hotkeys;
 * - typing on the chart for a symbol or a timeframe;
 * - the indicator search and a study's settings;
 * - a click and Delete to remove;
 * - the wheel to zoom and scroll.
 *
 * On a presenter's view they are performed for viewers, and a recorded walk keeps them. On a plain
 * page the same input runs at machine speed.
 *
 * Each change reads the chart to confirm what its input did, and the chart's API finishes what
 * input leaves short. It sets a drawing's points exactly once clicks have placed it, and the inputs
 * a study's settings have no field for. Where the chart has no control for a change, as an embed
 * without a toolbar, the pointer moves through the change's points and the API makes it.
 *
 * Each result's `via` says which: "input"; "corrected", when the API moved what input left more
 * than a nudge off; or "api".
 *
 * Like `Chart`'s, every function takes the page once its chart has loaded, and a page without a
 * chart fails `NotFound`. Input that a policy refuses, or a page that closes, fails as it would.
 *
 * @since 0.3.0
 */
import { Effect, Schema } from "effect";
import type { Found, Page } from "effect-browser/Page";

import * as Chart from "./Chart.ts";
import { drawings } from "./internal/drawings.ts";
import {
  awaiting,
  type Box,
  control,
  type Glance,
  inside,
  invalid,
  look,
  notFound,
  quoted,
  reach,
  ready,
  shown,
  taken,
  Untaken,
  until,
  type Via,
} from "./internal/input.ts";

export type { Via } from "./internal/input.ts";

// --- Drawings ------------------------------------------------------------------------------------

// The one-point lines TradingView draws at the pointer by a key.
const hotkeys: Partial<Record<Chart.Shape, string>> = {
  horizontal_line: "Alt+H",
  vertical_line: "Alt+V",
  cross_line: "Alt+C",
  horizontal_ray: "Alt+J",
};

const menuItem = (shape: Chart.Shape) =>
  `[data-role="menuitem"][data-name="LineTool${drawings[shape][1]}"]`;

// A menu item past the viewport's foot comes into view as its menu is wheeled, as a person would.
const scrolledTo = (page: Page, selector: string, entry: Found) =>
  Effect.gen(function* () {
    const { height } = yield* page.viewport;
    let current = entry;

    for (let turn = 0; turn < 4 && current.box.y + current.box.height > height - 2; turn++) {
      const last = (yield* page.find({ selector: '[data-role="menuitem"]', state: "visible" })).at(
        -1,
      );

      if (last === undefined) break;
      yield* page.scroll({ at: last.ref, dy: current.box.y + current.box.height - height + 40 });
      current = yield* control(page, selector, "drawing tool", "document");
    }

    return current.box.y + current.box.height > height - 2
      ? yield* new Untaken({ reason: "the drawing tool's item stayed out of view" })
      : current;
  });

// Choose a drawing tool as a person does, confirmed by the tool the chart then holds: Alt+T for a
// trend line, with the pointer at its first point, as the chart takes its keys only over the pane;
// otherwise the tool's item in its toolbar group's menu.
const pick = (page: Page, shape: Chart.Shape, first: Chart.Position) =>
  Effect.gen(function* () {
    const chosen = (seen: Glance) => seen.tool === shape;

    if (shape === "trend_line") {
      yield* page.hover(first);
      yield* page.press("Alt+T");
      if (chosen(yield* until(page, chosen, 1_000))) return;
    }
    const group = `[data-name="linetool-group-${drawings[shape][0]}"]`;

    yield* page.hover((yield* control(page, group, "drawing toolbar")).ref);
    // A group's menu opener shows while the group is hovered.
    yield* page.click((yield* shown(page, `${group} button[aria-pressed]`, "tool menu")).ref);
    const entry = yield* shown(page, menuItem(shape), `${shape} tool`, 1_500, "document");

    yield* page.click((yield* scrolledTo(page, menuItem(shape), entry)).ref);
    yield* awaiting(page, chosen, 1_500, `the toolbar did not choose ${shape}`);
  });

const TextOf = Schema.NullOr(Schema.String);

// A drawing's text, as a text drawing holds it.
const textOf = (id: string) => {
  const chart = (globalThis.tvWidget ?? globalThis.TradingViewApi)?.activeChart();
  const text = chart?.getShapeById(id).getProperties().text;

  return typeof text === "string" ? text : null;
};

interface Drawing {
  readonly shape: Chart.Shape;
  readonly points: ReadonlyArray<Chart.Point>;
  readonly text?: string | undefined;
}

// A drawing by visible input: a hotkey at the pointer, or the tool and a click at each point; a
// text drawing's text is then typed, and a click on the time axis commits it.
const drawn = (page: Page, drawing: Drawing, before: Glance) =>
  Effect.gen(function* () {
    if (drawing.text !== undefined && drawing.shape !== "text")
      return yield* new Untaken({ reason: "only a text drawing takes typed text" });
    yield* ready(page);
    const positions = yield* reach(page, drawing.points, before.pane);
    const [first] = positions;
    const fresh = (seen: Glance) => seen.drawings.filter((id) => !before.drawings.includes(id));
    const hotkey = hotkeys[drawing.shape];

    if (first === undefined) return yield* new Untaken({ reason: "a drawing takes a point" });

    if (hotkey === undefined) {
      yield* pick(page, drawing.shape, first);
      for (const [index, position] of positions.entries()) {
        yield* page.click(position);
        if (index === 0)
          yield* awaiting(page, (seen) => fresh(seen).length > 0, 1_500, "a click drew nothing");
      }
    } else {
      yield* page.hover(first);
      yield* page.press(hotkey);
    }

    const seen = yield* awaiting(
      page,
      (seen) =>
        fresh(seen).length > 0 &&
        (drawing.shape === "text" || seen.tool === null || seen.tool === "cursor"),
      2_000,
      `the chart drew no ${drawing.shape}`,
    );

    const id = fresh(seen).at(-1) ?? "";

    if (drawing.shape !== "text") return id;
    yield* page.type(drawing.text ?? "");
    yield* page.click({ x: first.x, y: seen.axis });
    if ((yield* page.read(textOf, { arg: id, result: TextOf })).value !== drawing.text)
      return yield* new Untaken({ reason: "the text drawing did not take the text" });

    return id;
  });

// Leave what a failed attempt began: Escape ends a tool or a dialog, and the API removes what it
// drew.
const undo = (page: Page, before: Glance) =>
  Effect.gen(function* () {
    yield* page.press("Escape");
    for (const id of (yield* look(page)).drawings)
      if (!before.drawings.includes(id)) yield* Chart.remove(page, id);
  });

// The API's drawing, after the pointer moves through its points in the pane, so viewers see where
// it goes.
const glided = (page: Page, drawing: Drawing, before: Glance) =>
  Effect.gen(function* () {
    for (const position of yield* Chart.point(page, drawing.points))
      if (position !== null && before.pane !== null && inside(before.pane, position))
        yield* page.hover(position);

    return yield* Chart.draw(page, drawing);
  });

/** A drawing as the chart holds it, and how it was made. */
export interface Drawn {
  readonly id: string;
  readonly name: string;
  readonly points: ReadonlyArray<Chart.Point>;
  readonly via: Via;
}

// The drawing as the chart holds it, its points set exactly where clicks left them off: on the bar
// clicked, at the price asked. More than two pixels off counts as a correction.
const exact = (page: Page, drawing: Drawing, id: string, via: Via) =>
  Effect.gen(function* () {
    const held = (yield* Chart.state(page)).drawings.find((candidate) => candidate.id === id);

    if (held === undefined) return yield* notFound(`drawing ${id}`);
    const count = drawing.points.length;

    if (via === "api" || held.points.length < count) return { ...held, via };

    const [now, wanted] = yield* Effect.all([
      Chart.point(page, held.points.slice(0, count)),
      Chart.point(page, drawing.points),
    ]);

    const bar = (index: number) => Math.abs((now[index]?.x ?? 0) - (wanted[index]?.x ?? 0)) < 0.5;

    const off = (index: number) =>
      Math.hypot(
        (now[index]?.x ?? Number.POSITIVE_INFINITY) - (wanted[index]?.x ?? 0),
        (now[index]?.y ?? Number.POSITIVE_INFINITY) - (wanted[index]?.y ?? 0),
      );

    const points = drawing.points.map((point, index) => ({
      time: bar(index) ? (held.points[index]?.time ?? point.time) : point.time,
      price: point.price,
    }));

    if (points.every((point, index) => bar(index) && point.price === held.points[index]?.price))
      return { ...held, via };
    yield* Chart.move(page, { id, points: [...points, ...held.points.slice(count)] });
    const moved = (yield* Chart.state(page)).drawings.find((candidate) => candidate.id === id);

    return {
      ...(moved ?? held),
      via: drawing.points.some((_, index) => off(index) > 2) ? ("corrected" as const) : via,
    };
  });

/**
 * Draw a shape through chart points, one click each, as many as `Chart.points` gives, with its
 * text for a text drawing. One-point lines are drawn by their hotkeys at the pointer, the trend
 * line's tool chosen by Alt+T, and every other tool from its toolbar group's menu. Gives the
 * drawing as the chart then holds it.
 */
export const draw = (page: Page, drawing: Drawing) =>
  Effect.gen(function* () {
    const wanted = Chart.points(drawing.shape);

    if (drawing.points.length !== wanted)
      return yield* invalid(
        `${drawing.shape} takes ${wanted} point${wanted === 1 ? "" : "s"}, not ${drawing.points.length}`,
      );
    if (drawing.shape === "text" && (drawing.text ?? "") === "")
      return yield* invalid("a text drawing takes its text");
    const before = yield* look(page);

    const made = yield* drawn(page, drawing, before).pipe(
      taken,
      Effect.map((id) => ({ id, via: "input" as Via })),
      Effect.catchTag("Untaken", () =>
        undo(page, before).pipe(
          Effect.andThen(glided(page, drawing, before)),
          Effect.map((id) => ({ id, via: "api" as Via })),
        ),
      ),
    );

    return (yield* exact(page, drawing, made.id, made.via)) satisfies Drawn;
  });

// Where a click lands on a drawing: on a line across the pane, at its price or its time; along the
// way between its first two points, which a straight drawing passes on screen, from the middle, as
// another drawing may lie over part of it; or at its one point.
const grips = (page: Page, drawing: Chart.State["drawings"][number], pane: Box | null) =>
  Effect.gen(function* () {
    if (pane === null) return [];

    const [a, b] = (yield* Chart.point(page, drawing.points)).flatMap((at) =>
      at === null ? [] : [at],
    );

    if (a === undefined) return [];

    const spots =
      drawing.name === "horizontal_line"
        ? [{ x: pane.x + pane.width / 2, y: a.y }]
        : drawing.name === "vertical_line"
          ? [{ x: a.x, y: pane.y + pane.height / 2 }]
          : drawing.name === "horizontal_ray"
            ? [{ x: a.x + 24, y: a.y }]
            : b === undefined
              ? [a, { x: a.x + 6, y: a.y + 6 }]
              : [0.5, 0.25, 0.75, 0].map((at) => ({
                  x: a.x + (b.x - a.x) * at,
                  y: a.y + (b.y - a.y) * at,
                }));

    return spots.filter((spot) => inside(pane, spot));
  });

// A drawing removed as a person removes it: a click on it to select it, then Delete.
const erased = (page: Page, drawing: Chart.State["drawings"][number], before: Glance) =>
  Effect.gen(function* () {
    const selected = (seen: Glance) => seen.selection.includes(drawing.id);

    yield* ready(page);
    for (const spot of yield* grips(page, drawing, before.pane)) {
      yield* page.click(spot);
      if (!selected(yield* until(page, selected, 500))) continue;
      yield* page.press("Delete");
      yield* awaiting(page, (seen) => !seen.drawings.includes(drawing.id), 1_500, "Delete missed");

      return;
    }

    return yield* new Untaken({ reason: "no click selected the drawing" });
  });

const legendRow = (id: string) =>
  `[data-qa-id="legend-source-item"][data-entity-id="${quoted(id)}"]`;

// A study removed by its legend row's Remove button, which shows while the row is hovered.
const unlisted = (page: Page, id: string) =>
  Effect.gen(function* () {
    const row = legendRow(id);

    yield* page.hover(
      (yield* control(page, `${row} [data-qa-id~="legend-source-title"]`, "legend row")).ref,
    );
    yield* page.click(
      (yield* shown(page, `${row} [data-qa-id="legend-delete-action"]`, "Remove button")).ref,
    );
    yield* awaiting(page, (seen) => !seen.studies.includes(id), 1_500, "Remove left the study");
  });

/**
 * Remove a drawing, with a click on it and Delete, or a study, with its legend row's Remove
 * button.
 */
export const remove = (page: Page, id: string) =>
  Effect.gen(function* () {
    const state = yield* Chart.state(page);
    const drawing = state.drawings.find((candidate) => candidate.id === id);

    if (drawing === undefined && !state.studies.some((study) => study.id === id))
      return yield* notFound(`drawing or study ${id}`);
    const before = yield* look(page);

    const via = yield* (
      drawing === undefined ? unlisted(page, id) : erased(page, drawing, before)
    ).pipe(
      taken,
      Effect.as<Via>("input"),
      Effect.catchTag("Untaken", () =>
        page.press("Escape").pipe(Effect.andThen(Chart.remove(page, id)), Effect.as<Via>("api")),
      ),
    );

    return { via };
  });

export { range, symbol, timeframe, indicator, inputs } from "./internal/controls.ts";
