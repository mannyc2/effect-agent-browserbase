/**
 * Browser tools for any `effect/ai` language model.
 *
 * The model reads a page two ways. A snapshot is a text outline whose controls carry refs such as
 * `e12`. A screenshot is a picture whose pixel coordinates are viewport coordinates. It acts by
 * ref when a control has one, and by point when it does not, as on a canvas game or a chart.
 * Actions answer with short receipts. A turn's calls run as a `batch`: in order, stopping at the
 * first failure. `Agent` does that and appends one observation of the current tab after each
 * turn; a caller composing its own loop spreads a fresh `batch` into each model call, then
 * observes `page` and drains `takeZooms`.
 *
 * @since 0.3.0
 */
import {
  Cause,
  Context,
  Duration,
  Effect,
  Option,
  Ref,
  Result,
  Schema,
  Semaphore,
  Stream,
} from "effect";
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
    prose: Schema.optional(Schema.Boolean).annotate({
      description:
        "Allow corrected slips when humanized and replacing an explicit prose ref; sensitive fields stay exact",
    }),
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

/**
 * Options for one `generateText` call, from `LanguageModel` or `Chat`: spread them into the call.
 * `effect/ai` runs a response's tool calls concurrently unless `concurrency` is 1, so the toolkit
 * and that setting travel together.
 */
export interface Batch<T extends Record<string, Tool.Any>> {
  readonly toolkit: Toolkit.WithHandler<T>;
  readonly concurrency: 1;
}

/**
 * One turn of tool calls over a toolkit with handlers. Calls run one at a time in the order the
 * model made them. The first failure, or a successful call named in `endsBatch`, stops the batch:
 * every later call answers as not executed. Build a new batch for each turn.
 */
export function batch<T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>,
  options?: { readonly endsBatch?: ReadonlyArray<keyof T & string> | undefined },
): Effect.Effect<Batch<T>>;

export function batch<T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>,
  options: { readonly endsBatch?: ReadonlyArray<keyof T & string> | undefined } = {},
) {
  const ends = new Set<string>(options.endsBatch ?? []);

  return Effect.map(Ref.make(Option.none<string>()), (halted) => ({
    concurrency: 1 as const,
    toolkit: {
      tools: toolkit.tools,
      // With concurrency 1, each call starts after the previous one's final result.
      handle: <Name extends keyof T>(
        name: Name,
        params: Tool.ParametersEncoded<T[Name]>,
        id?: string,
      ) =>
        Effect.map(
          Ref.get(halted),
          Option.match({
            onSome: (reason) => Stream.succeed(failedResult("Not executed: " + reason)),
            onNone: () =>
              toolkit.handle(name, params, id).pipe(
                Stream.unwrap,
                Stream.catchCause((cause) => failedCall(toolkit.tools[name], cause)),
                Stream.tap((result) =>
                  result.preliminary
                    ? Effect.void
                    : result.isFailure
                      ? Ref.set(halted, Option.some(`${String(name)} failed.`))
                      : ends.has(String(name))
                        ? Ref.set(halted, Option.some(`${String(name)} ended the batch.`))
                        : Effect.void,
                ),
              ),
          }),
        ),
    },
  }));
}

const failedResult = (reason: string) => {
  const result: typeof Tool.ExecutionFailure.Type = { type: "execution-interrupted", reason };

  return { result, encodedResult: result, isFailure: true, preliminary: false };
};

/**
 * A tool with failure mode "error" fails its stream instead of returning a result. Answer it
 * with its failure encoded by the tool's own schema, saying whether the handler could have run:
 * rejected parameters never reach it. Defects and interruptions stay what they are.
 */
const failedCall = <Called extends Tool.Any, E>(tool: Called, cause: Cause.Cause<E>) => {
  const failure = Cause.findFail(cause);

  if (Result.isFailure(failure)) return Stream.failCause(failure.failure);
  const { error } = failure.success;

  const rejected =
    Context.get(Cause.reasonAnnotations(failure.success), Toolkit.FailureOrigin) === "parameters";

  return Stream.fromEffect(
    Schema.encodeUnknownEffect(Tool.failureResultSchema(tool))(error).pipe(
      Effect.map((encoded) => JSON.stringify(encoded)),
      // A failure outside the declared schema still reaches the model, unencoded.
      Effect.orElseSucceed(() => String(error)),
      Effect.map((detail) =>
        failedResult(
          (rejected
            ? "Not executed: its parameters are invalid: "
            : "The call failed and may have taken effect: ") + detail,
        ),
      ),
    ),
  );
};

export interface Tools {
  readonly handlers: Toolkit.HandlersFrom<BrowserTools>;
  /** A fresh `batch` of the browser tools for one turn, to spread into a `generateText` call. */
  readonly batch: Effect.Effect<Batch<BrowserTools>>;
  /**
   * The tab the tools act on, after following any tab that opened since they last looked. Observe
   * it after each batch: once a tab opens, actions refuse to run until it has been returned here.
   */
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
  // Tabs the tools have looked at. Any other open tab opened since, perhaps after the receipt of
  // the action that opened it.
  const seen = new Set((yield* browser.pages).map((tab) => tab.id));
  // The current tab became a newly opened one that `page`, which observations use, has not
  // returned since. The model planned its batch on the old tab and sees nothing new until then.
  let unobserved = false;
  let zooms: Array<Page.Zoom> = [];
  const zoomLock = yield* Semaphore.make(1);

  const takeZooms = zoomLock.withPermits(1)(
    Effect.sync(() => {
      const captured = zooms;

      zooms = [];

      return captured;
    }),
  );

  /** Make the newest tab opened since the tools last looked the current one; true if one did. */
  const follow = Effect.gen(function* () {
    const open = yield* browser.pages;
    const opened = open.filter((tab) => !seen.has(tab.id)).at(-1);

    for (const tab of open) seen.add(tab.id);
    if (opened === undefined) return false;
    current = Option.some(opened);
    unobserved = true;
    yield* opened.bringToFront.pipe(Effect.ignore);

    return true;
  });

  /** The current tab, after following a newly opened one, and whether that just happened. */
  const resolve = Effect.gen(function* () {
    const followed = yield* follow;
    const open = yield* browser.pages;

    if (Option.isSome(current) && open.includes(current.value))
      return { tab: current.value, followed };
    const first = yield* browser.page;

    seen.add(first.id);
    current = Option.some(first);

    return { tab: first, followed };
  });

  const page: Effect.Effect<Page.Page, BrowserError> = Effect.map(resolve, ({ tab }) => {
    unobserved = false;

    return tab;
  });

  const switched = "A new tab opened and is now the current tab.";

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
      const { tab } = yield* resolve;

      // The call was planned on the tab the model last saw, so it must not run on a new one.
      if (unobserved)
        return yield* Effect.fail(
          `Not done: ${switched} It is ${yield* describeTab(tab)}. Look at it first.`,
        );
      const result = yield* run(tab);
      const receipt = typeof done === "string" ? done : done(result);

      // A tab that registers later is followed when the tools next look; either way, later
      // actions wait until it is observed.
      return (yield* follow) ? `${receipt}\n${switched}` : receipt;
    }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message)));

  const tabList = Effect.gen(function* () {
    const open = yield* browser.pages;
    const { tab: active } = yield* resolve;

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
      Effect.gen(function* () {
        const { tab, followed } = yield* resolve;
        const snapshot = yield* tab.snapshot({ full, query, maxChars: snapshotChars });

        return followed ? `${switched}\n${snapshot.rendered}` : snapshot.rendered;
      }).pipe(Effect.mapError((error) => error.message)),
    browser_zoom: (region) =>
      zoomLock.withPermits(1)(
        Effect.gen(function* () {
          if (zooms.length >= 8)
            return yield* Effect.fail(
              "At most 8 zoom crops can await an observation; finish the batch first.",
            );
          const { tab, followed } = yield* resolve;
          const zoom = yield* tab.zoom(region);

          zooms.push(zoom);

          return `${followed ? switched + "\n" : ""}Captured a zoom from page ${zoom.page} at viewport (${region.x}, ${region.y}), ${region.width}x${region.height}. The image follows the batch; click coordinates remain in viewport space.`;
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
    browser_type: ({ text, ref, append, submit, prose }) =>
      act(`Typed ${JSON.stringify(text)}${ref === undefined ? "" : ` into ${ref}`}.`, (tab) =>
        tab.type(text, { into: ref, replace: append !== true, submit, prose }),
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
        // Take in tabs opened since the last look first, so a selection is not overridden later.
        yield* follow;
        const open = yield* browser.pages;
        const chosen = index === undefined ? undefined : open[index - 1];

        if (action === "new") {
          const tab = yield* browser.newPage(url);

          seen.add(tab.id);
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
    batch: batch(toolkit),
    page,
    takeZooms,
  } satisfies Tools;
});
