/**
 * Browser tools for a Yielded agent on effect-browser: Yielded's own over `PageControl`'s ports,
 * which are `observe` and `act` and the browser tools but `screenshot` and `respond_dialog`, and
 * this package's `Pointer` tools for what has no ref, such as a canvas game or a chart: clicking,
 * hovering and dragging at viewport points, typing and pressing keys into focus, zooming, waiting
 * for the screen to go still, and going back.
 *
 * With `vision`, the default, the model sees a screenshot of the current tab before each turn, and
 * the crops `zoom` took since its last, as context the run never keeps, so only the current picture
 * is ever in a request. Its pixel coordinates are viewport coordinates, which the pointer tools
 * take. The pictures are `RunContextPreparation`'s transient context, which a run's own
 * `transientContext` option replaces.
 *
 * `make` gives the toolkit to put in an agent, and `layer`, which provides every tool's handler,
 * the ports and the pictures for one run, on a page or a browser's tabs.
 *
 * @since 0.3.0
 */
import { BrowserUse } from "@yielded/agent";
import { RunContextPreparation } from "@yielded/agent/run-options";
import {
  Context,
  Effect,
  Layer,
  Option,
  Predicate,
  Ref,
  Schema,
  SchemaTransformation,
} from "effect";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Page from "effect-browser/Page";
import { Prompt, Tool, Toolkit } from "effect/ai";

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
    "Wait for the screen to stop moving, as reels coming to rest or a chart that loads.",
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

const { tools } = BrowserUse.browserTools;

/**
 * Yielded's browser tools but two: `screenshot`, since the model sees the page before each turn
 * instead, and `respond_dialog`, since the browser answers dialogs itself.
 */
export const Control = Toolkit.make(
  tools.inspect,
  tools.navigate,
  tools.scroll,
  tools.wait,
  tools.press,
  tools.select_tab,
);

const single = BrowserUse.make({ mode: "single" });
const batched = BrowserUse.make({ mode: "batched" });

export interface LayerOptions extends PageControl.Options {
  /** Show the model a screenshot of the current tab before each turn. Defaults to true. */
  readonly vision?: boolean | undefined;
}

/** At most this many crops are shown before a turn: the latest. */
const maxZooms = 8;

const text = (value: string) => ({ type: "text" as const, text: value });

/** What the model sees before a turn: the current tab's screenshot, and the crops since its last. */
const pictures = (controller: PageControl.Controller, zooms: Ref.Ref<Array<Page.Zoom>>) =>
  Effect.gen(function* () {
    const crops = yield* Ref.getAndSet(zooms, []);
    const shown = crops.slice(-maxZooms);

    const cropped = shown.flatMap(({ region, image }) => [
      text(
        `Zoom: viewport origin (${region.x}, ${region.y}), ${region.width}x${region.height} CSS pixels. Add this origin to a point in the crop for a viewport click.`,
      ),
      { type: "file" as const, mediaType: image.mediaType, data: image.data },
    ]);

    const left =
      crops.length > shown.length
        ? [text(`${crops.length - shown.length} earlier crops were left out.`)]
        : [];

    // A look before a turn shows a tab an action opened, as `follow` says.
    const screen = yield* Effect.flatMap(controller.look, (page) => page.screenshot()).pipe(
      Effect.map((image) => [
        text(
          `The current tab's viewport, ${image.width}x${image.height}. Its pixel coordinates are viewport coordinates.`,
        ),
        { type: "file" as const, mediaType: image.mediaType, data: image.data },
      ]),
      Effect.catch((error) =>
        Effect.succeed([text(`(no screenshot of the current tab: ${error.message})`)]),
      ),
      controller.withTask,
    );

    return Prompt.make([{ role: "user", content: [...screen, ...cropped, ...left] }]);
  });

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

/** The pointer tools' handlers over the controller's current tab. */
const pointing = (
  controller: PageControl.Controller,
  zooms: Ref.Ref<Array<Page.Zoom>>,
  vision: boolean,
) => {
  const act = <A>(
    run: (page: Page.Page) => Effect.Effect<A, BrowserError>,
    did: (value: A) => string,
  ) =>
    controller.perform(run).pipe(
      Effect.map(({ value, followed }) => ({ did: did(value), followed })),
      Effect.mapError(PageControl.useError),
    );

  return Pointer.of({
    click_at: ({ x, y, double, button }) =>
      act(
        (page) => page.click({ x, y }, { button, clickCount: double === true ? 2 : 1 }),
        ({ element, point }) => `Clicked ${element} at (${point.x}, ${point.y}).`,
      ),
    hover: (place) =>
      Option.match(target(place), {
        onNone: () => missing("hover"),
        onSome: (to) =>
          act(
            (page) => page.hover(to),
            () => `Hovered over ${named(to)}.`,
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
          );
    },
    type_text: ({ text: typed, submit }) =>
      act(
        (page) => page.type(typed, { submit }),
        () => `Typed ${JSON.stringify(typed)}${submit === true ? " and pressed Enter" : ""}.`,
      ),
    press_keys: ({ keys, times, holdMillis }) =>
      act(
        (page) => page.press(keys, { times, holdMillis }),
        () => `Pressed ${keys}${times === undefined || times === 1 ? "" : ` ${times} times`}.`,
      ),
    zoom: (region) =>
      vision
        ? controller.current.pipe(
            Effect.flatMap((page) => page.zoom(new Page.Region(region))),
            Effect.tap((zoom) => Ref.update(zooms, (crops) => [...crops, zoom])),
            Effect.map(() => ({
              did: `Cropped (${region.x}, ${region.y}), ${region.width}x${region.height}: it is shown before your next turn.`,
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
          page.ready({
            quietMillis: 600,
            timeout: `${Math.min(Math.max(seconds ?? 15, 0), 30)} seconds`,
          }),
        () => "The screen is still.",
      ),
    back: () =>
      act(
        (page) => page.back,
        () => "Went back.",
      ),
  });
};

/** One mode's tools and the layer that serves them for a run. */
const tooling = <Ports extends Record<string, Tool.Any>>(browserUse: {
  readonly toolkit: Toolkit.Toolkit<Ports>;
  readonly layer: () => Layer.Layer<Tool.HandlersFor<Ports>, never, BrowserUse.BrowserActions>;
}) => {
  const toolkit = Toolkit.merge(browserUse.toolkit, Control, Pointer);

  /**
   * Every tool's handler, `PageControl`'s ports, and with `vision` the pictures before each turn,
   * for one run on `target`.
   */
  const layer = (target: PageControl.Target, options: LayerOptions = {}) =>
    Layer.unwrap(
      Effect.gen(function* () {
        const controller = yield* PageControl.make(target, options);
        const zooms = yield* Ref.make<Array<Page.Zoom>>([]);
        const vision = options.vision ?? true;
        const { control } = controller;

        const ports = Layer.succeedContext(
          Context.make(BrowserUse.BrowserActions, controller.actions).pipe(
            Context.add(BrowserUse.BrowserControl, control),
          ),
        );

        const handlers = Layer.mergeAll(
          browserUse.layer(),
          Control.toLayer({
            inspect: control.inspect,
            navigate: control.navigate,
            scroll: control.scroll,
            wait: control.wait,
            press: control.press,
            select_tab: control.selectTab,
          }),
          Pointer.toLayer(pointing(controller, zooms, vision)),
        ).pipe(Layer.provide(ports));

        // Without pictures, an application's own context preparation stays as it is.
        const preparation = vision
          ? Layer.succeed(RunContextPreparation, {
              transientContext: { load: () => pictures(controller, zooms) },
            })
          : Layer.empty;

        return Layer.mergeAll(handlers, ports, preparation);
      }),
    );

  return { toolkit, layer };
};

const singleTools = tooling(single);
const batchedTools = tooling(batched);

/**
 * The tools and their layer. `"batched"`, the default, lets `act` take up to eight actions; with
 * `"single"`, it takes one.
 */
export function make(options?: { readonly mode?: "batched" }): typeof batchedTools;
export function make(options: { readonly mode: "single" }): typeof singleTools;

export function make(options: { readonly mode?: "single" | "batched" } = {}) {
  return options.mode === "single" ? singleTools : batchedTools;
}
