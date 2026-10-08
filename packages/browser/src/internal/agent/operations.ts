/**
 * The page operations the browser tools offer, each one contract: what a model is told it does,
 * the parameters that a model's call, or a request from another process, decodes with, and one
 * handler over a page. `projection.ts` makes the model's tools and the RPC group from them, and
 * `on` binds them to a page. A call answers with a `Receipt`: what it did, and for anything but a
 * read, what followed on its page while it ran, from the page's events and one read of its changes.
 */
import { Duration, Effect, Option, Predicate, Result, Schema, SchemaTransformation } from "effect";
import { Tool } from "effect/ai";

import { BrowserError, InvalidRequest } from "../../BrowserError.ts";
import { Action, DialogShown, Navigated, PageOpened } from "../../BrowserEvent.ts";
import { Changes } from "../../Change.ts";
import * as Page from "../../Page.ts";
import { undispatched } from "../page/context.ts";
import * as Url from "../page/url.ts";

/**
 * What one call did, and what followed it on its page while it ran, each as the page's own record
 * has it: the action the page recorded, the dialogs that opened and how each was answered, where
 * the page went, the tabs it opened and what visibly changed. A read says only what it read. A
 * model is told it as text; a caller reads it as a value, which crosses a process boundary as is.
 */
export class Receipt extends Schema.Class<Receipt>("effect-browser/Receipt")({
  /** The page the call acted on or read. */
  page: Schema.String,
  /** What the call did, in a sentence, or what it read. */
  did: Schema.String,
  /** The action the page recorded for the call, with the correlation id it was given. */
  action: Schema.optional(Action),
  /** The dialogs that opened while it ran, each with how it was answered. */
  dialogs: Schema.Array(DialogShown),
  /** Where the page's main frame went last while it ran. */
  navigated: Schema.optional(Navigated),
  /** The tabs the page opened while it ran. */
  opened: Schema.Array(PageOpened),
  /** What visibly changed on the page while it ran; absent where `missing` says why. */
  changes: Schema.optional(Changes),
  /** The crop `browser_zoom` took, which a model sees after its batch. */
  zoom: Schema.optional(Page.Zoom),
  /** Why a part of the receipt could not be read. */
  missing: Schema.Array(BrowserError),
}) {}

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

/** An element by ref, or a point by x and y. */
const place = { ref, x, y };

const Place = Schema.Struct(place);

type Place = typeof Place.Type;

export interface Operation<Name extends string, Input extends Schema.Top> {
  /** Its name, the same for its tool, its method and its RPC. */
  readonly name: Name;
  /** What a model is told the operation does. */
  readonly description: string;
  readonly input: Input;
  /**
   * `"act"`: an action the input policy decides on, so one it allows ends a run of refusals;
   * `"move"`: an action it does not count, such as hovering, scrolling or waiting; `"read"`: a
   * read, whose receipt says only what it read.
   */
  readonly kind: "act" | "move" | "read";
  /** What it did, in a sentence, and the crop it took, if it took one. */
  readonly run: (
    page: Page.Page,
    input: Input["Type"],
  ) => Effect.Effect<{ readonly did: string; readonly zoom?: Page.Zoom }, BrowserError>;
}

const operation = <const Name extends string, Input extends Schema.Top>(
  definition: Operation<Name, Input>,
) => definition;

const refused = (name: string, detail: string) =>
  Effect.fail(undispatched(name, new InvalidRequest({ detail })));

// A point is the more specific of the two, such as a spot on a canvas a ref names.
const target = (name: string, place: Place): Effect.Effect<Page.Target, BrowserError> =>
  place.x !== undefined && place.y !== undefined
    ? Effect.succeed({ x: place.x, y: place.y })
    : place.ref !== undefined
      ? Effect.succeed(place.ref)
      : refused(name, "give a ref from the snapshot, or x and y from a screenshot");

const named = (place: Place) => place.ref ?? `(${place.x}, ${place.y})`;

/** Where a model may go: web addresses, inline data and a blank page, never local files. */
export const destination = (name: string, input: string) => {
  const url = Url.parse(input);

  return url !== null &&
    (url.protocol === "http:" ||
      url.protocol === "https:" ||
      url.protocol === "data:" ||
      url.href === "about:blank")
    ? Effect.succeed(url.href)
    : refused(
        name,
        `${JSON.stringify(input)} was not opened: the browser tools open http and https addresses, data: URLs and about:blank`,
      );
};

export const operations = {
  browser_navigate: operation({
    name: "browser_navigate",
    description: "Open a URL in the current tab.",
    input: Schema.Struct({ url: Schema.String }),
    kind: "act",
    run: (page, { url }) =>
      Effect.flatMap(destination("navigate", url), (address) =>
        Effect.as(page.goto(address), { did: `Opened ${address}.` }),
      ),
  }),
  // Without parameters, not with `Schema.Struct({})`: an empty struct's JSON Schema has no object
  // root, which OpenAI's structured outputs reject for the whole request.
  browser_back: operation({
    name: "browser_back",
    description: "Go back to the previous page in the current tab.",
    input: Tool.EmptyParams,
    kind: "act",
    run: (page) => Effect.as(page.back, { did: "Went back." }),
  }),
  browser_snapshot: operation({
    name: "browser_snapshot",
    description:
      "Read the page as a text outline in which controls carry refs for the other tools. Covers the viewport unless full is set.",
    input: Schema.Struct({
      full: absent(Schema.Boolean, { description: "Read the whole page, not just the viewport" }),
      query: absent(Schema.String, { description: "Keep only lines containing this text" }),
    }),
    kind: "read",
    run: (page, { full, query }) =>
      Effect.map(page.snapshot({ full, query, maxChars: 8000 }), (snapshot) => ({
        did: snapshot.rendered,
      })),
  }),
  browser_zoom: operation({
    name: "browser_zoom",
    description:
      "Crop a small viewport region at the viewport's own CSS pixel scale, without magnification. Its image follows the batch; click coordinates stay in viewport space. At most 8 crops per observation.",
    input: Schema.Struct(Page.Region.fields),
    kind: "read",
    run: (page, region) =>
      Effect.map(page.zoom(region), (zoom) => ({
        zoom,
        did: `Captured a zoom at viewport (${region.x}, ${region.y}), ${region.width}x${region.height}. The image follows the batch; click coordinates remain in viewport space.`,
      })),
  }),
  browser_click: operation({
    name: "browser_click",
    description: "Click an element by ref, or a point by x and y.",
    input: Schema.Struct({
      ...place,
      double: absent(Schema.Boolean),
      button: absent(Schema.Literals(["left", "right", "middle"])),
    }),
    kind: "act",
    run: (page, place) =>
      target("click", place).pipe(
        Effect.flatMap((to) =>
          page.click(to, { button: place.button, clickCount: place.double === true ? 2 : 1 }),
        ),
        Effect.map(({ element, point }) => ({
          did: `Clicked ${element} at (${point.x}, ${point.y}).`,
        })),
      ),
  }),
  browser_hover: operation({
    name: "browser_hover",
    description: "Move the pointer over an element by ref, or to a point by x and y.",
    input: Place,
    kind: "move",
    run: (page, place) =>
      target("hover", place).pipe(
        Effect.flatMap(page.hover),
        Effect.as({ did: `Hovered over ${named(place)}.` }),
      ),
  }),
  browser_type: operation({
    name: "browser_type",
    description:
      "Type text. With a ref, that field is focused and its content replaced first; without one, the text goes to the focused element.",
    input: Schema.Struct({
      text: Schema.String,
      ref,
      append: absent(Schema.Boolean, {
        description: "Keep the field's content and add to it",
      }),
      submit: absent(Schema.Boolean, { description: "Press Enter afterwards" }),
    }),
    kind: "act",
    run: (page, { text, ref: into, append, submit }) =>
      Effect.as(page.type(text, { into, replace: append !== true, submit }), {
        did: `Typed ${JSON.stringify(text)}${into === undefined ? "" : ` into ${into}`}.`,
      }),
  }),
  browser_press: operation({
    name: "browser_press",
    description: "Press a key or chord, such as Enter, Escape, Space, ArrowDown or Control+A.",
    input: Schema.Struct({
      keys: Schema.String,
      times: absent(Schema.Int, { description: "Press it this many times; defaults to 1" }),
      holdMillis: absent(Schema.Finite, { description: "Hold the keys down this long" }),
    }),
    kind: "act",
    run: (page, { keys, times, holdMillis }) =>
      Effect.as(page.press(keys, { times, holdMillis }), {
        did: `Pressed ${keys}${times === undefined || times === 1 ? "" : ` ${times} times`}.`,
      }),
  }),
  browser_scroll: operation({
    name: "browser_scroll",
    description: "Scroll the page, or whatever is under a ref or point, such as a list or a chart.",
    input: Schema.Struct({
      direction: Schema.Literals(["down", "up", "right", "left"]),
      pages: absent(Schema.Finite, { description: "How far, in viewports; defaults to 0.8" }),
      ...place,
    }),
    kind: "move",
    run: (page, place) =>
      Effect.gen(function* () {
        const at =
          place.ref === undefined && place.x === undefined
            ? undefined
            : yield* target("scroll", place);

        const viewport = yield* page.viewport;
        const pages = place.pages ?? 0.8;
        const vertical = place.direction === "down" ? 1 : place.direction === "up" ? -1 : 0;
        const horizontal = place.direction === "right" ? 1 : place.direction === "left" ? -1 : 0;

        yield* page.scroll({
          at,
          dy: Math.round(vertical * pages * viewport.height),
          dx: Math.round(horizontal * pages * viewport.width),
        });

        return { did: `Scrolled ${place.direction}.` };
      }),
  }),
  browser_drag: operation({
    name: "browser_drag",
    description: "Drag from one element or point to another, such as a slider or a chart range.",
    input: Schema.Struct({ fromRef: ref, fromX: x, fromY: y, toRef: ref, toX: x, toY: y }),
    kind: "act",
    run: (page, drag) => {
      const from = { ref: drag.fromRef, x: drag.fromX, y: drag.fromY };
      const to = { ref: drag.toRef, x: drag.toX, y: drag.toY };

      return Effect.all([target("drag", from), target("drag", to)]).pipe(
        Effect.flatMap(([start, end]) => page.drag(start, end)),
        Effect.as({ did: `Dragged from ${named(from)} to ${named(to)}.` }),
      );
    },
  }),
  browser_select: operation({
    name: "browser_select",
    description: "Choose options of a select element by value or label.",
    input: Schema.Struct({ ref: Schema.String, values: Schema.Array(Schema.String) }),
    kind: "act",
    run: (page, { ref: select, values }) =>
      Effect.map(page.select(select, values), (chosen) => ({
        did: `Chose ${chosen} in ${select}.`,
      })),
  }),
  browser_wait: operation({
    name: "browser_wait",
    description:
      "Wait for text to appear, for the screen to stop moving (reels, animations, loading), or for some seconds.",
    input: Schema.Struct({
      text: absent(Schema.String),
      still: absent(Schema.Boolean),
      seconds: absent(Schema.Finite, { description: "At most 30" }),
    }),
    kind: "move",
    run: (page, { text, still, seconds }) =>
      text !== undefined
        ? Effect.as(page.waitForText(text), { did: `Saw ${JSON.stringify(text)}.` })
        : still === true
          ? Effect.as(page.ready({ quietMillis: 600 }), { did: "The screen is still." })
          : Effect.as(Effect.sleep(Duration.seconds(Math.min(Math.max(seconds ?? 1, 0), 30))), {
              did: "Waited.",
            }),
  }),
};

/** What `browser_tabs` takes, for tools that follow a browser's tabs. */
export const TabsInput = Schema.Struct({
  action: Schema.Literals(["list", "select", "new", "close"]),
  index: absent(Schema.Int, {
    description: "The tab's number in the list, for select and close",
  }),
  url: absent(Schema.String, { description: "For new" }),
});

export type Operations = typeof operations;

export type Name = keyof Operations;

/** What a caller of a method needs to know of its operation: its name, and what kind it is. */
export type Called = Pick<Operation<Name, Schema.Top>, "name" | "kind">;

const isAction = Schema.is(Action);
const isDialog = Schema.is(DialogShown);
const isNavigated = Schema.is(Navigated);
const isOpened = Schema.is(PageOpened);

/**
 * Run an operation on a page and answer with its receipt. An action's says what followed it on the
 * page while it ran, read from the page's events at no call and from its changes in one; a part
 * that cannot be read is missing, with why.
 */
export const perform = <I extends Schema.Top>(
  { kind, run }: Operation<Name, I>,
  page: Page.Page,
  input: I["Type"],
): Effect.Effect<Receipt, BrowserError> =>
  kind === "read"
    ? Effect.map(
        run(page, input),
        (done) => new Receipt({ page: page.id, ...done, dialogs: [], opened: [], missing: [] }),
      )
    : Effect.gen(function* () {
        const since = (yield* page.state).at;
        const done = yield* run(page, input);
        const events = (yield* page.recentEvents).filter((event) => event.at > since);
        const changes = yield* Effect.result(page.changes({ since }));

        return new Receipt({
          page: page.id,
          ...done,
          action: events.findLast(isAction),
          dialogs: events.filter(isDialog),
          navigated: events.findLast(isNavigated),
          opened: events.filter(isOpened),
          changes: Result.getOrUndefined(changes),
          missing: Option.toArray(Result.getFailure(changes)),
        });
      });

/**
 * Each operation as a method that `around` runs: it chooses the page, given how to run the call on
 * one, and may refuse it or add to its receipt.
 */
export const bind = (
  around: (
    operation: Called,
    run: (page: Page.Page) => Effect.Effect<Receipt, BrowserError>,
  ) => Effect.Effect<Receipt, BrowserError>,
) => {
  const method =
    <I extends Schema.Top>(operation: Operation<Name, I>) =>
    (input: I["Type"]) =>
      around(operation, (page) => perform(operation, page, input));

  return {
    browser_navigate: method(operations.browser_navigate),
    browser_back: method(operations.browser_back),
    browser_snapshot: method(operations.browser_snapshot),
    browser_zoom: method(operations.browser_zoom),
    browser_click: method(operations.browser_click),
    browser_hover: method(operations.browser_hover),
    browser_type: method(operations.browser_type),
    browser_press: method(operations.browser_press),
    browser_scroll: method(operations.browser_scroll),
    browser_drag: method(operations.browser_drag),
    browser_select: method(operations.browser_select),
    browser_wait: method(operations.browser_wait),
  };
};
