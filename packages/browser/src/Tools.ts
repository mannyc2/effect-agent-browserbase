/**
 * Browser tools for any `effect/ai` language model.
 *
 * The model reads a page two ways. A snapshot is a text outline whose controls carry refs such as
 * `e12`. A screenshot is a picture whose pixel coordinates are viewport coordinates. It acts by
 * ref when a control has one, and by point when it does not, as on a canvas game or a chart.
 * Actions answer with short receipts. `Agent` runs them in batches, halts on the first failure
 * and appends one observation of the current tab after each turn. Callers composing their own
 * loop can observe `page` once their batch ends.
 *
 * @since 0.3.0
 */
import { Duration, Effect, Option, Schema, Semaphore } from "effect";
import { Tool, Toolkit } from "effect/ai";

import { Browser } from "./Browser.ts";
import type { BrowserError } from "./BrowserError.ts";
import * as Page from "./Page.ts";

const ref = Schema.optional(Schema.String).annotate({
  description: "A ref from the latest snapshot, such as e12",
});

const x = Schema.optional(Schema.Finite).annotate({
  description: "Viewport x in screenshot pixels, when there is no ref",
});

const y = Schema.optional(Schema.Finite).annotate({
  description: "Viewport y in screenshot pixels, when there is no ref",
});

const tool = <const Name extends string, Parameters extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: Parameters,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  });

export const Navigate = tool("browser_navigate", "Open a URL in the current tab.", {
  url: Schema.String,
});

export const Back = tool("browser_back", "Go back to the previous page in the current tab.", {});

export const Snapshot = tool(
  "browser_snapshot",
  "Read the page as a text outline in which controls carry refs for the other tools. Covers the viewport unless full is set.",
  {
    full: Schema.optional(Schema.Boolean).annotate({
      description: "Read the whole page, not just the viewport",
    }),
    query: Schema.optional(Schema.String).annotate({
      description: "Keep only lines containing this text",
    }),
  },
);

export const Zoom = tool(
  "browser_zoom",
  "Read a small viewport region at full CSS resolution. Its image follows the batch; click coordinates stay in viewport space. At most 8 crops per observation.",
  Page.Region.fields,
);

export const Click = tool("browser_click", "Click an element by ref, or a point by x and y.", {
  ref,
  x,
  y,
  double: Schema.optional(Schema.Boolean),
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
});

export const Hover = tool(
  "browser_hover",
  "Move the pointer over an element by ref, or to a point by x and y.",
  {
    ref,
    x,
    y,
  },
);

export const Type = tool(
  "browser_type",
  "Type text. With a ref, that field is focused and its content replaced first; without one, the text goes to the focused element.",
  {
    text: Schema.String,
    ref,
    append: Schema.optional(Schema.Boolean).annotate({
      description: "Keep the field's content and add to it",
    }),
    submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter afterwards" }),
  },
);

export const Press = tool(
  "browser_press",
  "Press a key or chord, such as Enter, Escape, Space, ArrowDown or Control+A.",
  {
    keys: Schema.String,
    times: Schema.optional(Schema.Int).annotate({
      description: "Press it this many times; defaults to 1",
    }),
    holdMillis: Schema.optional(Schema.Finite).annotate({
      description: "Hold the keys down this long",
    }),
  },
);

export const Scroll = tool(
  "browser_scroll",
  "Scroll the page, or whatever is under a ref or point, such as a list or a chart.",
  {
    direction: Schema.Literals(["down", "up", "right", "left"]),
    pages: Schema.optional(Schema.Finite).annotate({
      description: "How far, in viewports; defaults to 0.8",
    }),
    ref,
    x,
    y,
  },
);

export const Drag = tool(
  "browser_drag",
  "Drag from one element or point to another, such as a slider or a chart range.",
  {
    fromRef: ref,
    fromX: x,
    fromY: y,
    toRef: ref,
    toX: x,
    toY: y,
  },
);

export const Select = tool(
  "browser_select",
  "Choose options of a select element by value or label.",
  {
    ref: Schema.String,
    values: Schema.Array(Schema.String),
  },
);

export const Wait = tool(
  "browser_wait",
  "Wait for text to appear, for the screen to stop moving (reels, animations, loading), or for some seconds.",
  {
    text: Schema.optional(Schema.String),
    still: Schema.optional(Schema.Boolean),
    seconds: Schema.optional(Schema.Finite).annotate({ description: "At most 30" }),
  },
);

export const Tabs = tool(
  "browser_tabs",
  "List the tabs, switch to one, open a new one or close one.",
  {
    action: Schema.Literals(["list", "select", "new", "close"]),
    index: Schema.optional(Schema.Int).annotate({
      description: "The tab's number in the list, for select and close",
    }),
    url: Schema.optional(Schema.String).annotate({ description: "For new" }),
  },
);

export const BrowserToolkit = Toolkit.make(
  Navigate,
  Back,
  Snapshot,
  Zoom,
  Click,
  Hover,
  Type,
  Press,
  Scroll,
  Drag,
  Select,
  Wait,
  Tabs,
);

export type BrowserTools = typeof BrowserToolkit.tools;

export interface Options {
  /** Bound on each snapshot. Defaults to 8,000 characters. */
  readonly snapshotChars?: number | undefined;
}

export interface Tools {
  readonly handlers: Toolkit.HandlersFrom<BrowserTools>;
  /** The toolkit with its handlers, for `LanguageModel.generateText` or `Chat`. */
  readonly toolkit: Toolkit.WithHandler<BrowserTools>;
  /** The tab the tools act on. */
  readonly page: Effect.Effect<Page.Page, BrowserError>;
  /** Drain the requested crops, once per batch, to include beside the observation. */
  readonly takeZooms: Effect.Effect<ReadonlyArray<Page.Zoom>>;
}

const target = (op: {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}) =>
  op.ref !== undefined
    ? Effect.succeed<Page.Target>(op.ref)
    : op.x !== undefined && op.y !== undefined
      ? Effect.succeed<Page.Target>({ x: op.x, y: op.y })
      : Effect.fail("give a ref from the snapshot, or x and y from a screenshot");

const named = (op: {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}) => op.ref ?? `(${op.x}, ${op.y})`;

/** Build the tools over the `Browser` in context, acting on its first tab to begin with. */
export const make = Effect.fn("Tools.make")(function* (options: Options = {}) {
  const browser = yield* Browser;
  const snapshotChars = options.snapshotChars ?? 8000;
  let current = Option.none<Page.Page>();
  let zooms: Array<Page.Zoom> = [];
  const zoomLock = yield* Semaphore.make(1);

  const takeZooms = zoomLock.withPermits(1)(
    Effect.sync(() => {
      const captured = zooms;

      zooms = [];

      return captured;
    }),
  );

  const page: Effect.Effect<Page.Page, BrowserError> = Effect.gen(function* () {
    const open = yield* browser.pages;

    if (Option.isSome(current) && open.includes(current.value)) return current.value;
    const first = yield* browser.page;

    current = Option.some(first);

    return first;
  });

  const describeTab = (tab: Page.Page) =>
    tab.title.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((title) =>
        Effect.map(tab.url, (url) => `${title === "" ? "(untitled)" : title} — ${url}`),
      ),
    );

  /** Run an action on the current tab, follow a tab it opens, then answer with a receipt. */
  const act = <A>(
    done: string | ((result: A) => string),
    run: (tab: Page.Page) => Effect.Effect<A, BrowserError | string>,
  ) =>
    Effect.gen(function* () {
      const tab = yield* page;
      const before = yield* browser.pages;

      const result = yield* run(tab);
      const receipt = typeof done === "string" ? done : done(result);
      const opened = (yield* browser.pages).filter((other) => !before.includes(other));
      const newest = opened.at(-1);

      if (newest === undefined) return receipt;
      current = Option.some(newest);
      yield* newest.bringToFront.pipe(Effect.ignore);

      return `${receipt}\nA new tab opened and is now the current tab.`;
    }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message)));

  const tabList = Effect.gen(function* () {
    const open = yield* browser.pages;
    const active = yield* page;

    const lines = yield* Effect.forEach(open, (tab, index) =>
      Effect.map(
        describeTab(tab),
        (where) => `${index + 1}. ${tab === active ? "[current] " : ""}${where}`,
      ),
    );

    return lines.join("\n");
  });

  const handlers = BrowserToolkit.of({
    browser_navigate: ({ url }) => {
      const address = /^[a-z][a-z0-9+.-]*:/i.test(url) ? url : `https://${url}`;

      return act(`Opened ${address}.`, (tab) => tab.goto(address));
    },
    browser_back: () => act("Went back.", (tab) => tab.back),
    browser_snapshot: ({ full, query }) =>
      page.pipe(
        Effect.flatMap((tab) => tab.snapshot({ full, query, maxChars: snapshotChars })),
        Effect.map((snapshot) => snapshot.rendered),
        Effect.mapError((error) => error.message),
      ),
    browser_zoom: (region) =>
      zoomLock.withPermits(1)(
        Effect.gen(function* () {
          if (zooms.length >= 8)
            return yield* Effect.fail(
              "At most 8 zoom crops can await an observation; finish the batch first.",
            );
          const tab = yield* page;
          const zoom = yield* tab.zoom(region);

          zooms.push(zoom);

          return `Captured a zoom from page ${zoom.page} at viewport (${region.x}, ${region.y}), ${region.width}x${region.height}. The image follows the batch; click coordinates remain in viewport space.`;
        }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message))),
      ),
    browser_click: (op) =>
      act(
        (resolved: Page.ResolvedTarget) =>
          `Clicked ${resolved.element} at (${resolved.point.x}, ${resolved.point.y}).`,
        (tab) =>
          Effect.flatMap(target(op), (to) =>
            tab.click(to, { button: op.button, clickCount: op.double === true ? 2 : 1 }),
          ),
      ),
    browser_hover: (op) =>
      act(`Hovered over ${named(op)}.`, (tab) => Effect.flatMap(target(op), tab.hover)),
    browser_type: ({ text, ref, append, submit }) =>
      act(`Typed ${JSON.stringify(text)}${ref === undefined ? "" : ` into ${ref}`}.`, (tab) =>
        tab.type(text, { into: ref, replace: append !== true, submit }),
      ),
    browser_press: ({ keys, times, holdMillis }) =>
      act(`Pressed ${keys}${times === undefined || times === 1 ? "" : ` ${times} times`}.`, (tab) =>
        tab.press(keys, { times, holdMillis }),
      ),
    browser_scroll: (op) =>
      act(`Scrolled ${op.direction}.`, (tab) =>
        Effect.gen(function* () {
          const at = op.ref === undefined && op.x === undefined ? undefined : yield* target(op);
          const viewport = tab.playwright.viewportSize() ?? { width: 1280, height: 720 };
          const pages = op.pages ?? 0.8;
          const vertical = op.direction === "down" ? 1 : op.direction === "up" ? -1 : 0;
          const horizontal = op.direction === "right" ? 1 : op.direction === "left" ? -1 : 0;

          yield* tab.scroll({
            at,
            dy: Math.round(vertical * pages * viewport.height),
            dx: Math.round(horizontal * pages * viewport.width),
          });
        }),
      ),
    browser_drag: (op) => {
      const from = { ref: op.fromRef, x: op.fromX, y: op.fromY };
      const to = { ref: op.toRef, x: op.toX, y: op.toY };

      return act(`Dragged from ${named(from)} to ${named(to)}.`, (tab) =>
        Effect.all([target(from), target(to)]).pipe(
          Effect.flatMap(([start, end]) => tab.drag(start, end)),
        ),
      );
    },
    browser_select: ({ ref, values }) =>
      Effect.gen(function* () {
        let chosen = "";

        const result = yield* act(`Chose options in ${ref}.`, (tab) =>
          Effect.map(tab.select(ref, values), (labels) => {
            chosen = labels;
          }),
        );

        return result.replace(`Chose options in ${ref}.`, `Chose ${chosen} in ${ref}.`);
      }),
    browser_wait: ({ text, still, seconds }) =>
      act(
        text !== undefined
          ? `Saw ${JSON.stringify(text)}.`
          : still === true
            ? "The screen is still."
            : "Waited.",
        (tab) =>
          text !== undefined
            ? tab.waitForText(text)
            : still === true
              ? tab.waitForStill()
              : Effect.sleep(Duration.seconds(Math.min(Math.max(seconds ?? 1, 0), 30))),
      ),
    browser_tabs: ({ action, index, url }) =>
      Effect.gen(function* () {
        const open = yield* browser.pages;
        const chosen = index === undefined ? undefined : open[index - 1];

        if (action === "new") {
          const tab = yield* browser.newPage(url);

          current = Option.some(tab);
          yield* tab.bringToFront;
        } else if (action === "select" || action === "close") {
          if (chosen === undefined)
            return yield* Effect.fail(`there is no tab ${index ?? "(no index given)"}`);
          if (action === "select") {
            current = Option.some(chosen);
            yield* chosen.bringToFront;
          } else yield* chosen.close;
        }

        return yield* tabList;
      }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message))),
  });

  const toolkit = yield* BrowserToolkit.pipe(Effect.provide(BrowserToolkit.toLayer(handlers)));

  return {
    handlers,
    toolkit,
    page,
    takeZooms,
  } satisfies Tools;
});
