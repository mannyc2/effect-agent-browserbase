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
  Predicate,
  Ref,
  Result,
  Schema,
  SchemaTransformation,
  Semaphore,
  Stream,
} from "effect";
import { Tool, Toolkit } from "effect/ai";

import { Browser } from "./Browser.ts";
import type { BrowserError } from "./BrowserError.ts";
import * as Url from "./internal/page/url.ts";
import * as Page from "./Page.ts";

// A parameter a model may leave out. Its JSON Schema allows null, as an optional one's does, and
// models send null for one they mean to leave out, so null reads as absent rather than refused.
const absent = <S extends Schema.Top>(
  schema: S,
  annotations: { readonly description?: string } = {},
) =>
  Schema.optionalKey(Schema.NullOr(schema).annotate(annotations)).pipe(
    Schema.decodeTo(
      Schema.optional(Schema.toType(schema)),
      SchemaTransformation.transformOptional<S["Type"] | undefined, S["Type"] | null>({
        decode: (input) => Option.filter(input, Predicate.isNotNullish),
        encode: (output) => Option.filter(output, Predicate.isNotUndefined),
      }),
    ),
  );

const ref = absent(Schema.String, {
  description: "A ref from the latest snapshot, such as e12",
});

const x = absent(Schema.Finite, {
  description: "Viewport x in screenshot pixels; with y, used instead of a ref",
});

const y = absent(Schema.Finite, {
  description: "Viewport y in screenshot pixels; with x, used instead of a ref",
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

// Without parameters, not with `Schema.Struct({})`: an empty struct's JSON Schema has no object
// root, which OpenAI's structured outputs reject for the whole request.
export const Back = Tool.make("browser_back", {
  description: "Go back to the previous page in the current tab.",
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
});

export const Snapshot = tool(
  "browser_snapshot",
  "Read the page as a text outline in which controls carry refs for the other tools. Covers the viewport unless full is set.",
  {
    full: absent(Schema.Boolean, {
      description: "Read the whole page, not just the viewport",
    }),
    query: absent(Schema.String, {
      description: "Keep only lines containing this text",
    }),
  },
);

export const Zoom = tool(
  "browser_zoom",
  "Crop a small viewport region at the viewport's own CSS pixel scale, without magnification. Its image follows the batch; click coordinates stay in viewport space. At most 8 crops per observation.",
  Page.Region.fields,
);

export const Click = tool("browser_click", "Click an element by ref, or a point by x and y.", {
  ref,
  x,
  y,
  double: absent(Schema.Boolean),
  button: absent(Schema.Literals(["left", "right", "middle"])),
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
    append: absent(Schema.Boolean, {
      description: "Keep the field's content and add to it",
    }),
    submit: absent(Schema.Boolean, { description: "Press Enter afterwards" }),
    prose: absent(Schema.Boolean, {
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
    times: absent(Schema.Int, {
      description: "Press it this many times; defaults to 1",
    }),
    holdMillis: absent(Schema.Finite, {
      description: "Hold the keys down this long",
    }),
  },
);

export const Scroll = tool(
  "browser_scroll",
  "Scroll the page, or whatever is under a ref or point, such as a list or a chart.",
  {
    direction: Schema.Literals(["down", "up", "right", "left"]),
    pages: absent(Schema.Finite, {
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
    text: absent(Schema.String),
    still: absent(Schema.Boolean),
    seconds: absent(Schema.Finite, { description: "At most 30" }),
  },
);

export const Tabs = tool(
  "browser_tabs",
  "List the tabs, switch to one, open a new one or close one.",
  {
    action: Schema.Literals(["list", "select", "new", "close"]),
    index: absent(Schema.Int, {
      description: "The tab's number in the list, for select and close",
    }),
    url: absent(Schema.String, { description: "For new" }),
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
 *
 * Each call, run or not, is a span of its own, `Tools.<name>`, with OpenTelemetry's GenAI tool
 * attributes. It keeps a browser tool's parameters without the text it types, and only the names
 * of another tool's parameters, which may hold anything.
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
        Effect.map(Ref.get(halted), (halt) => {
          const tool = String(name);
          const kept = traced(tool, params);

          const call = Option.isSome(halt)
            ? Stream.succeed(failedResult("Not executed: " + halt.value)).pipe(
                Stream.tap(() => Effect.annotateCurrentSpan("executed", false)),
              )
            : toolkit.handle(name, params, id).pipe(
                // effect/ai puts the raw parameters on the span around the call, which is this one.
                Effect.ensuring(Effect.annotateCurrentSpan("parameters", kept)),
                Stream.unwrap,
                Stream.catchCause((cause) => failedCall(toolkit.tools[name], cause)),
                Stream.tap((result) =>
                  result.preliminary
                    ? Effect.void
                    : result.isFailure
                      ? Ref.set(halted, Option.some(`${tool} failed.`)).pipe(
                          Effect.andThen(Effect.annotateCurrentSpan("error.type", "tool_error")),
                        )
                      : ends.has(tool)
                        ? Ref.set(halted, Option.some(`${tool} ended the batch.`))
                        : Effect.void,
                ),
              );

          return call.pipe(
            Stream.withSpan(`Tools.${tool}`, {
              attributes: {
                "gen_ai.operation.name": "execute_tool",
                "gen_ai.tool.name": tool,
                "gen_ai.tool.type": "function",
                ...(id === undefined ? {} : { "gen_ai.tool.call.id": id }),
                parameters: kept,
              },
              captureStackTrace: false,
            }),
          );
        }),
    },
  }));
}

/** What a span keeps of a call's parameters: a browser tool's without typed text, else names. */
const traced = (tool: string, params: unknown): unknown =>
  typeof params !== "object" || params === null
    ? params
    : !Object.hasOwn(BrowserToolkit.tools, tool)
      ? Object.keys(params)
      : "text" in params
        ? { ...params, text: Page.redacted }
        : params;

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
      Effect.tap(() => (rejected ? Effect.annotateCurrentSpan("executed", false) : Effect.void)),
    ),
  );
};

export interface Tools {
  readonly handlers: Toolkit.HandlersFrom<BrowserTools>;
  /** A fresh `batch` of the browser tools for one turn, to spread into a `generateText` call. */
  readonly batch: Effect.Effect<Batch<BrowserTools>>;
  /**
   * The tab the tools act on, after following any tab that opened since they last looked. Observe
   * it after each batch: actions run only on the tab this last returned, so after a tab opens,
   * the current one closes or `browser_tabs` switches, they refuse until it is returned here.
   */
  readonly page: Effect.Effect<Page.Page, BrowserError>;
  /** Drain the requested crops, once per batch, to include beside the observation. */
  readonly takeZooms: Effect.Effect<ReadonlyArray<Page.Zoom>>;
  /**
   * Why the input policy refused each action since the last action it allowed, oldest first.
   * Hovering, scrolling and waiting count as neither.
   */
  readonly refusals: Effect.Effect<ReadonlyArray<string>>;
}

const target = (op: {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}) =>
  // A point is the more specific of the two, such as a spot on a canvas a ref names.
  op.x !== undefined && op.y !== undefined
    ? Effect.succeed<Page.Target>({ x: op.x, y: op.y })
    : op.ref !== undefined
      ? Effect.succeed<Page.Target>(op.ref)
      : Effect.fail("give a ref from the snapshot, or x and y from a screenshot");

/** Where a model may go: web addresses, inline data and a blank page, never local files. */
const destination = (input: string) => {
  const url = Url.parse(input);

  return url !== null &&
    (url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "data:" ||
      url.href === "about:blank")
    ? Effect.succeed(url.href)
    : Effect.fail(
        `${JSON.stringify(input)} was not opened: the browser tools open http and https addresses, data: URLs and about:blank.`,
      );
};

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
  // The tab `page`, which observations use, last returned. The model plans a batch on what it
  // saw there, so actions run only on that tab; another current tab must be observed first.
  let observed: string | undefined;
  // Why the current tab last changed, for that refusal.
  let changed = "";
  let zooms: Array<Page.Zoom> = [];
  let refusals: ReadonlyArray<string> = [];
  const zoomLock = yield* Semaphore.make(1);

  const takeZooms = zoomLock.withPermits(1)(
    Effect.sync(() => {
      const captured = zooms;

      zooms = [];

      return captured;
    }),
  );

  const opened = "A new tab opened and is now the current tab.";
  const closed = "The tab in use closed, and another is now the current tab.";

  const become = (tab: Page.Page, why: string) => {
    current = Option.some(tab);
    changed = why;
  };

  /** Make the newest tab opened since the tools last looked the current one; true if one did. */
  const follow = Effect.gen(function* () {
    const open = yield* browser.pages;
    const newest = open.filter((tab) => !seen.has(tab.id)).at(-1);

    for (const tab of open) seen.add(tab.id);
    if (newest === undefined) return false;
    become(newest, opened);
    yield* newest.bringToFront.pipe(Effect.ignore);

    return true;
  });

  /** The current tab, after following a newly opened one, and what this look changed. */
  const resolve = Effect.gen(function* () {
    const followed = yield* follow;
    const open = yield* browser.pages;
    const kept = Option.filter(current, (tab) => open.includes(tab));
    const lost = Option.isSome(current) && Option.isNone(kept);
    const tab = Option.isSome(kept) ? kept.value : yield* browser.page;

    seen.add(tab.id);
    if (lost) become(tab, closed);
    current = Option.some(tab);
    // Before the first look nothing was planned on any tab.
    observed ??= tab.id;

    return { tab, note: lost ? closed : followed ? opened : undefined };
  });

  const page: Effect.Effect<Page.Page, BrowserError> = Effect.map(resolve, ({ tab }) => {
    observed = tab.id;

    return tab;
  });

  const describeTab = (tab: Page.Page) =>
    tab.title.pipe(
      Effect.orElseSucceed(() => ""),
      Effect.flatMap((title) =>
        Effect.map(tab.url, (url) => `${title === "" ? "(untitled)" : title} — ${url}`),
      ),
    );

  /** Note a refusal, and forget them all once the policy allows an action it decides on. */
  const tally = <A>(action: Effect.Effect<A, BrowserError | string>, judged: boolean) =>
    action.pipe(
      Effect.tapError((error) =>
        Effect.sync(() => {
          if (
            typeof error !== "string" &&
            (error.reason._tag === "PolicyDenied" || error.reason._tag === "PolicyTimeout")
          )
            refusals = [...refusals, error.reason.message];
        }),
      ),
      Effect.tap(() =>
        Effect.sync(() => {
          if (judged) refusals = [];
        }),
      ),
    );

  /**
   * Run an action on the current tab, follow a tab it opens, then answer with a receipt. A
   * `judged` action, one the input policy decides on, ends a run of refusals when it goes through.
   */
  const act = <A>(
    done: string | ((result: A) => string),
    run: (tab: Page.Page) => Effect.Effect<A, BrowserError | string>,
    judged = true,
  ) =>
    Effect.gen(function* () {
      const { tab } = yield* resolve;

      // The call was planned on the tab the model last saw: refs restart on every tab, and
      // coordinates belong to its picture, so it must not run on another one.
      if (tab.id !== observed)
        return yield* Effect.fail(
          `Not done: ${changed} It is ${yield* describeTab(tab)}. Look at it first.`,
        );
      const result = yield* tally(run(tab), judged);
      const receipt = typeof done === "string" ? done : done(result);

      // A tab that registers later is followed when the tools next look; either way, later
      // actions wait until it is observed.
      return (yield* follow) ? `${receipt}\n${opened}` : receipt;
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
    browser_navigate: ({ url }) =>
      Effect.flatMap(destination(url), (address) =>
        act(`Opened ${address}.`, (tab) => tab.goto(address)),
      ),
    browser_back: () => act("Went back.", (tab) => tab.back),
    browser_snapshot: ({ full, query }) =>
      Effect.gen(function* () {
        const { tab, note } = yield* resolve;
        const snapshot = yield* tab.snapshot({ full, query, maxChars: snapshotChars });

        return note === undefined ? snapshot.rendered : `${note}\n${snapshot.rendered}`;
      }).pipe(Effect.mapError((error) => error.message)),
    browser_zoom: (region) =>
      zoomLock.withPermits(1)(
        Effect.gen(function* () {
          if (zooms.length >= 8)
            return yield* Effect.fail(
              "At most 8 zoom crops can await an observation; finish the batch first.",
            );
          const { tab, note } = yield* resolve;
          const zoom = yield* tab.zoom(region);

          zooms.push(zoom);

          return `${note === undefined ? "" : note + "\n"}Captured a zoom from page ${zoom.page} at viewport (${region.x}, ${region.y}), ${region.width}x${region.height}. The image follows the batch; click coordinates remain in viewport space.`;
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
      act(`Hovered over ${named(op)}.`, (tab) => Effect.flatMap(target(op), tab.hover), false),
    browser_type: ({ text, ref, append, submit, prose }) =>
      act(`Typed ${JSON.stringify(text)}${ref === undefined ? "" : ` into ${ref}`}.`, (tab) =>
        tab.type(text, { into: ref, replace: append !== true, submit, prose }),
      ),
    browser_press: ({ keys, times, holdMillis }) =>
      act(`Pressed ${keys}${times === undefined || times === 1 ? "" : ` ${times} times`}.`, (tab) =>
        tab.press(keys, { times, holdMillis }),
      ),
    browser_scroll: (op) =>
      act(
        `Scrolled ${op.direction}.`,
        (tab) =>
          Effect.gen(function* () {
            const at = op.ref === undefined && op.x === undefined ? undefined : yield* target(op);
            const viewport = yield* tab.viewport;
            const pages = op.pages ?? 0.8;
            const vertical = op.direction === "down" ? 1 : op.direction === "up" ? -1 : 0;
            const horizontal = op.direction === "right" ? 1 : op.direction === "left" ? -1 : 0;

            yield* tab.scroll({
              at,
              dy: Math.round(vertical * pages * viewport.height),
              dx: Math.round(horizontal * pages * viewport.width),
            });
          }),
        false,
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
        false,
      ),
    browser_tabs: ({ action, index, url }) =>
      Effect.gen(function* () {
        // Take in tabs opened since the last look first, so a selection is not overridden later.
        yield* follow;
        const open = yield* browser.pages;
        const chosen = index === undefined ? undefined : open[index - 1];

        if (action === "new") {
          const tab = yield* url === undefined
            ? browser.newPage()
            : Effect.flatMap(destination(url), (address) => tally(browser.newPage(address), true));

          seen.add(tab.id);
          become(tab, "browser_tabs opened a new tab and made it current.");
          yield* tab.bringToFront;
        } else if (action === "select" || action === "close") {
          if (chosen === undefined)
            return yield* Effect.fail(`there is no tab ${index ?? "(no index given)"}`);
          if (action === "select") {
            become(chosen, "browser_tabs made another tab current.");
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
    refusals: Effect.sync(() => refusals),
  } satisfies Tools;
});
