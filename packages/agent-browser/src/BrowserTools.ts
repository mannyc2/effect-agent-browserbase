/**
 * Browser tools for a Yielded agent on effect-browser, over `PageControl`'s controller: `observe`
 * and `act` on the refs of an observed page; the `Control` tools, which inspect, navigate, scroll,
 * wait, press keys and select tabs; and the `Pointer` tools for what has no ref, such as a canvas
 * game or a chart: clicking, hovering and dragging at viewport points, typing and pressing keys
 * into focus, zooming, waiting for the screen to go still, and going back. The ref and `Control`
 * tools keep the names, parameters and descriptions Yielded Agent gave them before 0.1.0-beta.174
 * replaced them with Code Mode over CDP, but that their optional parameters read null as left out.
 *
 * With `vision`, the default, the model sees a screenshot of the current tab before each turn, and
 * the crops `zoom` took since its last, as context the run never keeps, so only the current picture
 * is ever in a request. Its pixel coordinates are viewport coordinates, which the pointer tools
 * take. The pictures are `RunContextPreparation`'s transient context, which a run's own
 * `transientContext` option replaces. With `vision: "ask"`, the screenshot comes only before a turn
 * after the model called `look`; with `vision: "page"`, also after pointer input and while the
 * viewport shows a canvas, a video or another site's frame. `Look` is that tool, for the agent's
 * toolkit beside `make`'s. With `vision: "moments"`, the model's thread holds, after
 * each turn's tool results, a moment of the current tab since the turn before: what happened, what
 * changed. These stable accounts can be compacted. The latest three moments' pictures follow as
 * reference messages labeled by turn, with their frame times. A run's own `context` option
 * replaces the accounts' hook; its `transientContext` replaces the pictures.
 *
 * `make` gives the toolkit to put in an agent, and `layer`, which provides every tool's handler
 * and the pictures for one run, on a page or a browser's tabs.
 *
 * @since 0.3.0
 */
import { BrowserUse } from "@yielded/agent";
import { RunContextPreparation } from "@yielded/agent/run-options";
import { Effect, Layer, Option, Predicate, Ref, Schema, SchemaTransformation } from "effect";
import { Action } from "effect-browser/Action";
import type { BrowserError } from "effect-browser/BrowserError";
import type * as Moment from "effect-browser/Moment";
import * as Page from "effect-browser/Page";
import * as Stillness from "effect-browser/Stillness";
import { Prompt, Tool, Toolkit } from "effect/ai";

import type * as AdapterState from "./AdapterState.ts";
import * as Moments from "./internal/moments.ts";
import * as PageControl from "./PageControl.ts";

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

const pixel = (axis: "x" | "y") =>
  Schema.Finite.annotate({ description: `Viewport ${axis} in screenshot pixels` });

const ref = absent(Schema.String, {
  description: "A ref from the latest observation, such as e12",
});

/** What a pointer tool did, and what followed on its page while it ran. */
export const Receipt = Schema.Struct({
  did: Schema.String,
  action: Schema.optional(Action),
  followed: Schema.Array(Schema.String),
});

const pointerTool = <const Name extends string, Parameters extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: Parameters,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: Receipt,
    failure: BrowserUse.BrowserUseError,
    failureMode: "return",
  });

/** Tools for what has no ref, by viewport point and by keyboard focus. */
export const Pointer = Toolkit.make(
  pointerTool("click_at", "Click a point of the screenshot, such as on a canvas game or a chart.", {
    x: pixel("x"),
    y: pixel("y"),
    double: absent(Schema.Boolean),
    button: absent(Schema.Literals(["left", "right", "middle"])),
  }),
  pointerTool("hover", "Move the pointer over an observed ref, or to a point of the screenshot.", {
    ref,
    x: absent(pixel("x")),
    y: absent(pixel("y")),
  }),
  pointerTool(
    "drag",
    "Drag from one ref or point to another, such as a slider or a chart's range.",
    {
      fromRef: ref,
      fromX: absent(pixel("x")),
      fromY: absent(pixel("y")),
      toRef: ref,
      toX: absent(pixel("x")),
      toY: absent(pixel("y")),
    },
  ),
  pointerTool(
    "type_text",
    "Type text into whatever has focus, such as a field just clicked. To type into an observed field, act with fill.",
    {
      text: Schema.String,
      submit: absent(Schema.Boolean, { description: "Press Enter afterwards" }),
    },
  ),
  pointerTool(
    "press_keys",
    "Press a key or chord on whatever has focus, such as ArrowLeft, Space or Control+A, as a game control might need.",
    {
      keys: Schema.String,
      times: absent(Schema.Int, { description: "Press it this many times; defaults to 1" }),
      holdMillis: absent(Schema.Finite, { description: "Hold the keys down this long" }),
    },
  ),
  pointerTool(
    "zoom",
    "Crop a small region of the viewport, shown on its own before your next turn at the viewport's own scale: a closer look at small text, not a magnification. Click coordinates stay in viewport space.",
    Page.Region.fields,
  ),
  pointerTool(
    "wait_still",
    "Wait for the screen to stop moving, as reels coming to rest or a chart that loads; what was already moving before your last input, such as an idle animation, does not count.",
    { seconds: absent(Schema.Finite, { description: "At most this long; defaults to 15" }) },
  ),
  // Without parameters, not with an empty struct: an empty struct's JSON Schema has no object root,
  // which OpenAI's structured outputs reject for the whole request.
  Tool.make("back", {
    description: "Go back to the previous page in this tab.",
    parameters: Tool.EmptyParams,
    success: Receipt,
    failure: BrowserUse.BrowserUseError,
    failureMode: "return",
  }),
);

/**
 * The tool that asks for a screenshot before the next turn, for `vision: "ask"` and `"page"`, which
 * otherwise show none on some turns. The layer serves it whether or not the agent has it.
 */
export const Look = Toolkit.make(
  Tool.make("look", {
    description: "See a screenshot of the current tab before your next turn.",
    parameters: Tool.EmptyParams,
    success: Receipt,
    failure: BrowserUse.BrowserUseError,
    failureMode: "return",
  }),
);

const Selector = Schema.NonEmptyString.check(Schema.isMaxLength(1_024));

const Delta = Schema.Int.check(Schema.isBetween({ minimum: -100_000, maximum: 100_000 }));

const pageTool = <
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

/** Tools that inspect, navigate, scroll, wait, press keys on refs and select tabs. */
export const Control = Toolkit.make(
  pageTool(
    "inspect",
    "Inspect the main page or an observed frame and CSS scope, including open shadow roots. Other frames are listed with inspected=false; inspect one when it contains the missing controls. Narrow a truncated observation with selector, frame or optionFilter before acting.",
    {
      selector: absent(Selector),
      frame: absent(PageControl.Ref),
      optionFilter: absent(Schema.NonEmptyString.check(Schema.isMaxLength(300))),
    },
    PageControl.Observation,
  ),
  pageTool(
    "navigate",
    "Navigate the current browser to a host-authorized URL. Input receipt is independent of the returned observation; never replay uncertain navigation.",
    { url: Schema.String.check(Schema.isMaxLength(8_192)) },
    PageControl.ActionResult,
  ),
  pageTool(
    "scroll",
    "Scroll the viewport or an observed scroll container by CSS pixels and inspect the result.",
    { ref: absent(PageControl.Ref), deltaX: Delta, deltaY: Delta },
    PageControl.ActionResult,
  ),
  pageTool(
    "wait",
    "Wait for an asynchronous condition using standard CSS and observed DOM/attribute evidence in the current frame. Optional text qualifies every state, case-sensitively; hidden with text waits until no visible match contains that text. Control kinds are semantic roles, not necessarily HTML tags. Returns a fresh observation; do not wait for an already satisfied condition or use fixed sleeps.",
    {
      selector: Selector,
      frame: absent(PageControl.Ref),
      state: Schema.Literals(["visible", "hidden", "enabled", "text"]),
      text: absent(Schema.String.check(Schema.isMaxLength(1_024))),
      timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 15_000 })),
    },
    PageControl.Observation,
  ),
  pageTool(
    "press",
    "Press a bounded native keyboard key on an observed focusable control, including keyboard-only links with pointerEvents=none and tabindex=0. Revalidates identity, visible state and native focus; a pointer hit is not required. Never replay uncertain input.",
    {
      ref: PageControl.Ref,
      key: Schema.Literals([
        "Enter",
        "Escape",
        "Tab",
        "ArrowDown",
        "ArrowUp",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "Space",
        "Backspace",
        "Delete",
      ]),
    },
    PageControl.ActionResult,
  ),
  pageTool(
    "select_tab",
    "Select an observed tab or popup in this browser context and inspect it. References from the previous page expire.",
    { ref: PageControl.Ref },
    PageControl.Observation,
  ),
);

const observe = Tool.make("observe", {
  description: "Read the visible page and controls. Only observed controls may receive actions.",
  parameters: Tool.EmptyParams,
  success: PageControl.Observation,
  failure: BrowserUse.BrowserUseError,
  failureMode: "return",
});

// `act` takes one action, or up to eight in order.
const single = Toolkit.make(
  observe,
  pageTool(
    "act",
    "Perform one action on an observed ref and return the next observation. Never repeat an acknowledged action because its observation failed.",
    { action: PageControl.Action },
    PageControl.ActionResult,
  ),
);

const batched = Toolkit.make(
  observe,
  pageTool(
    "act",
    "Perform 1–8 sequential actions on already observed controls. Stop at page/dialog transitions. completed counts acknowledged actions; never replay them.",
    {
      actions: Schema.Array(PageControl.Action).check(Schema.isMinLength(1), Schema.isMaxLength(8)),
    },
    PageControl.ActionResult,
  ),
);

/** What the model sees of the page; see `LayerOptions`. */
export type Vision = boolean | "ask" | "page" | "moments";

export interface LayerOptions extends PageControl.Options {
  readonly initialMoments?: AdapterState.Moments | undefined;
  readonly initialZooms?: ReadonlyArray<Page.Zoom> | undefined;
  /**
   * What the model sees of the page: `true`, the default, a screenshot of the current tab before
   * each turn; `"ask"`, one only before a turn after `look`; `"page"`, one also after pointer input
   * and while the viewport shows a canvas, a video or another site's frame; `"moments"`, in its
   * thread, what the tab did since its previous turn, with frames from a running screencast, or one
   * screenshot without one; `false`, no pictures.
   */
  readonly vision?: Vision | undefined;
  /** With moments, called with each moment as the model is first shown it, as for a recording. */
  readonly onMoment?: ((moment: Moment.Moment) => Effect.Effect<void>) | undefined;
}

const text = (value: string) => ({ type: "text" as const, text: value });

/**
 * What the model sees before a turn: the current tab's screenshot if `screen` says so, and the crops
 * since its last.
 */
const pictures = (
  controller: PageControl.Controller,
  zooms: Ref.Ref<Array<Page.Zoom>>,
  screen: (page: Page.Page) => Effect.Effect<boolean, BrowserError>,
) =>
  Effect.gen(function* () {
    // A look before a turn shows a tab an action opened, as `follow` says.
    const parts = yield* Effect.flatMap(controller.look, (page) =>
      Effect.gen(function* () {
        const crops = Moments.cropped(yield* Ref.getAndSet(zooms, []), page.id);

        if (!(yield* screen(page))) return crops;
        const shot = yield* page.screenshot();

        return [
          text(
            `The current tab's viewport, ${shot.width}x${shot.height}. Its pixel coordinates are viewport coordinates.`,
          ),
          { type: "file" as const, mediaType: shot.mediaType, data: shot.data },
          ...crops,
        ];
      }),
    ).pipe(
      Effect.catch((error) =>
        Effect.succeed([text(`(no screenshot of the current tab: ${error.message})`)]),
      ),
      controller.withTask,
    );

    return parts.length === 0 ? Prompt.empty : Prompt.make([{ role: "user", content: parts }]);
  });

// Whether the viewport shows what an outline cannot: a canvas, a video, or a frame from another
// site or holding either, at least 64 pixels square. Page-side code: it stands alone.
const pictorial = () => {
  const shown = (element: Element) => {
    const box = element.getBoundingClientRect();
    const width = Math.min(box.right, window.innerWidth) - Math.max(box.left, 0);
    const height = Math.min(box.bottom, window.innerHeight) - Math.max(box.top, 0);

    return width >= 64 && height >= 64;
  };

  return Array.from(document.querySelectorAll("canvas, video, iframe")).some(
    (element) =>
      shown(element) &&
      (!(element instanceof HTMLIFrameElement) ||
        element.contentDocument === null ||
        element.contentDocument.querySelector("canvas, video, iframe") !== null),
  );
};

// A point is the more specific of the two, such as a spot on a canvas a ref names.
const target = (place: {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
}): Option.Option<Page.Target> =>
  place.x !== undefined && place.y !== undefined
    ? Option.some({ x: place.x, y: place.y })
    : place.ref === undefined
      ? Option.none()
      : Option.some(place.ref);

const named = (to: Page.Target) => (typeof to === "string" ? to : `(${to.x}, ${to.y})`);

const missing = (what: string) =>
  Effect.fail(
    new BrowserUse.BrowserUseError({
      code: "invalid",
      message: `Give ${what} a ref from the observation, or x and y from the screenshot.`,
    }),
  );

/**
 * The pointer tools' handlers over the controller's current tab. Each sets `pointed` once its input
 * reaches the page, but going back.
 */
const pointing = (
  controller: PageControl.Controller,
  zooms: Ref.Ref<Array<Page.Zoom>>,
  vision: Vision,
  pointed: Ref.Ref<boolean>,
) => {
  const act = <A>(
    run: (page: Page.Page) => Effect.Effect<A, BrowserError>,
    did: (value: A) => string,
    action?: Action,
  ) =>
    controller.perform(run).pipe(
      Effect.tap(() =>
        action === undefined || action._tag === "Back" ? Effect.void : Ref.set(pointed, true),
      ),
      Effect.map(({ value, followed }) => ({ did: did(value), followed, action })),
      Effect.mapError(PageControl.useError),
    );

  return Pointer.of({
    click_at: ({ x, y, double, button }) =>
      act(
        (page) => page.click({ x, y }, { button, clickCount: double === true ? 2 : 1 }),
        ({ element, point }) => `Clicked ${element} at (${point.x}, ${point.y}).`,
        {
          _tag: "Click",
          target: { x, y },
          options: { button, clickCount: double === true ? 2 : 1 },
        },
      ),
    hover: (place) =>
      Option.match(target(place), {
        onNone: () => missing("hover"),
        onSome: (to) =>
          act(
            (page) => page.hover(to),
            () => `Hovered over ${named(to)}.`,
            { _tag: "Hover", target: to },
          ),
      }),
    drag: (drag) => {
      const from = target({ ref: drag.fromRef, x: drag.fromX, y: drag.fromY });
      const to = target({ ref: drag.toRef, x: drag.toX, y: drag.toY });

      return Option.isNone(from) || Option.isNone(to)
        ? missing("each end of a drag")
        : act(
            (page) => page.drag(from.value, to.value),
            () => `Dragged from ${named(from.value)} to ${named(to.value)}.`,
            { _tag: "Drag", from: from.value, to: to.value },
          );
    },
    type_text: ({ text: typed, submit }) =>
      act(
        (page) => page.type(typed, { submit }),
        () => `Typed ${JSON.stringify(typed)}${submit === true ? " and pressed Enter" : ""}.`,
        { _tag: "Type", text: typed, options: { submit } },
      ),
    press_keys: ({ keys, times, holdMillis }) =>
      act(
        (page) => page.press(keys, { times, holdMillis }),
        () => `Pressed ${keys}${times === undefined || times === 1 ? "" : ` ${times} times`}.`,
        { _tag: "Press", keys, options: { times, holdMillis } },
      ),
    zoom: (region) =>
      vision !== false
        ? controller.current.pipe(
            Effect.flatMap((page) => page.zoom(new Page.Region(region))),
            Effect.tap((zoom) => Ref.update(zooms, (crops) => [...crops, zoom])),
            Effect.map(() => ({
              did: `Cropped (${region.x}, ${region.y}), ${region.width}x${region.height}: it is shown before your next turn if this tab is still current.`,
              followed: [],
            })),
            Effect.mapError(PageControl.useError),
            controller.withTask,
          )
        : Effect.fail(
            new BrowserUse.BrowserUseError({
              code: "invalid",
              message: "These tools show no pictures, so a crop cannot be shown.",
            }),
          ),
    wait_still: ({ seconds }) =>
      act(
        (page) =>
          // What was already moving before the input, such as a game's idle animation, is not
          // what the model waits for.
          Stillness.wait(page, {
            still: "foreground",
            quietMillis: 600,
            timeout: `${Math.min(Math.max(seconds ?? 15, 0), 30)} seconds`,
          }),
        () => "The screen is still.",
      ),
    back: () =>
      act(
        (page) => page.back,
        () => "Went back.",
        { _tag: "Back" },
      ),
  });
};

/** One mode's tools and the layer that serves them for a run. */
const tooling = <Refs extends Record<string, Tool.Any>>(
  refs: Toolkit.Toolkit<Refs>,
  serve: (actions: PageControl.Controller["actions"]) => Layer.Layer<Tool.HandlersFor<Refs>>,
) => {
  const toolkit = Toolkit.merge(refs, Control, Pointer);

  /**
   * Every tool's handler, and with `vision` the pictures before each turn or the moments in the
   * thread, for one run on `target`.
   */
  const layer = (target: PageControl.Target, options: LayerOptions = {}) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const controller = yield* PageControl.make(target, options);
        const zooms = yield* Ref.make<Array<Page.Zoom>>([...(options.initialZooms ?? [])]);
        const vision = options.vision ?? true;
        const { control } = controller;
        // Since the last turn: whether the model called `look`, and whether pointer input ran.
        const asked = yield* Ref.make(false);
        const pointed = yield* Ref.make(false);

        // Whether the screen is shown before a turn: always with `true`, after `look` with `"ask"`,
        // and with `"page"` also after pointer input or while the viewport shows a picture.
        const wanted = (page: Page.Page) =>
          Effect.gen(function* () {
            const looked = yield* Ref.getAndSet(asked, false);
            const input = yield* Ref.getAndSet(pointed, false);

            if (vision === true || looked) return true;
            if (vision !== "page") return false;

            return (
              input ||
              (yield* page.read(pictorial, { arg: undefined, result: Schema.Boolean })).value
            );
          });

        const handlers = Layer.mergeAll(
          serve(controller.actions),
          Control.toLayer({
            inspect: control.inspect,
            navigate: control.navigate,
            scroll: control.scroll,
            wait: control.wait,
            press: control.press,
            select_tab: control.selectTab,
          }),
          Pointer.toLayer(pointing(controller, zooms, vision, pointed)),
          Look.toLayer({
            look: () =>
              vision === false
                ? Effect.fail(
                    new BrowserUse.BrowserUseError({
                      code: "invalid",
                      message: "These tools show no pictures.",
                    }),
                  )
                : Ref.set(asked, true).pipe(
                    Effect.as({
                      did:
                        vision === "ask" || vision === "page"
                          ? "A screenshot of the current tab is shown before your next turn."
                          : "A screenshot is shown before every turn already.",
                      followed: [],
                    }),
                  ),
          }),
        );

        // Without pictures, an application's own context preparation stays as it is.
        const preparation =
          vision === "moments"
            ? Layer.succeed(
                RunContextPreparation,
                yield* Moments.make(
                  controller.look,
                  Ref.getAndSet(zooms, []),
                  options.onMoment ?? (() => Effect.void),
                  options.initialMoments,
                ),
              )
            : vision === false
              ? Layer.empty
              : Layer.succeed(RunContextPreparation, {
                  transientContext: {
                    load: () => pictures(controller, zooms, wanted),
                  },
                });

        return Layer.mergeAll(handlers, preparation);
      }),
    );

  return { toolkit, layer };
};

const singleTools = tooling(single, (actions) =>
  single.toLayer({ observe: () => actions.observe, act: ({ action }) => actions.act([action]) }),
);

const batchedTools = tooling(batched, (actions) =>
  batched.toLayer({
    observe: () => actions.observe,
    act: ({ actions: steps }) => actions.act(steps),
  }),
);

/**
 * The tools and their layer. `"batched"`, the default, lets `act` take up to eight actions; with
 * `"single"`, it takes one.
 */
export function make(options?: { readonly mode?: "batched" }): typeof batchedTools;
export function make(options: { readonly mode: "single" }): typeof singleTools;

export function make(options: { readonly mode?: "single" | "batched" } = {}) {
  return options.mode === "single" ? singleTools : batchedTools;
}
