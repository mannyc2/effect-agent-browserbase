// The arms of the paired experiment: how a model sees a page and acts on it, each a configuration of
// `Agent.run` on the task's page. Arm 5 is the library's default. Arm 1 answers every action with an
// outline and shows pictures only on request; arm 2 sees a picture after each batch and acts by
// pixels. Understand tasks differ only in arm 1, whose moments add the outline.
import { Effect, Schema } from "effect";
import * as Agent from "effect-browser/Agent";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";
import * as Tools from "effect-browser/Tools";
import { Prompt, Tool, Toolkit } from "effect/ai";

export const arms = [1, 2, 5] as const;

export type Arm = (typeof arms)[number];

export const armNames: { readonly [A in Arm]: string } = {
  1: "per-action outline",
  2: "vision first",
  5: "batched, Agent.run",
};

export interface OperateOptions<A, I, E> {
  readonly answer: Schema.Codec<A, I>;
  readonly maxSteps: number;
  readonly onStep: (step: Agent.Step) => Effect.Effect<void, E>;
}

/** Whether an arm's moments carry the page's outline: only arm 1's, as the library's default leaves it out. */
export const outline = (arm: Arm): boolean => arm === 1;

const text = (value: string) => Prompt.makePart("text", { text: value });

const closing = [
  "- If an action fails and says it may have taken effect, look at the page before you repeat it.",
  "- Work on your own. Do not ask the user anything; if something blocks you, try another way.",
  "- When the task is done, call done with the answer. If it cannot be done, call give_up with the reason.",
];

const { tools } = Tools.PageToolkit;

// Without parameters: an empty struct's JSON Schema has no object root, which OpenAI rejects.
const Screenshot = Tool.make("browser_screenshot", {
  description: "Show the viewport as a picture in the next message.",
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
});

const PerActionToolkit = Toolkit.make(
  tools.browser_navigate,
  tools.browser_back,
  tools.browser_snapshot,
  Screenshot,
  tools.browser_click,
  tools.browser_hover,
  tools.browser_type,
  tools.browser_press,
  tools.browser_scroll,
  tools.browser_drag,
  tools.browser_select,
  tools.browser_wait,
);

/**
 * Arm 1, the tools as they were before batching (`d100c9f`): every action answers with a fresh
 * outline, pictures come only from `browser_screenshot`, and the prompt has no batching hint.
 * The halt on the first failure stays, as the library's safety contract.
 */
const perActionOutline = (page: Page) => {
  let pending: Array<Prompt.UserMessagePart> = [];
  let opened = false;
  const outlined = page.snapshot({ maxChars: 8000 });

  const withOutline =
    <P>(handler: (params: P) => Effect.Effect<Tools.Receipt, BrowserError>) =>
    (params: P) =>
      Effect.flatMap(handler(params), (receipt) =>
        outlined.pipe(
          Effect.map((snapshot) => snapshot.rendered),
          Effect.orElseSucceed(() => "(could not read the page)"),
          Effect.map((read) => new Tools.Receipt({ ...receipt, did: `${receipt.did}\n${read}` })),
        ),
      );

  return {
    system: () =>
      [
        "You operate a web browser through tools to complete the user's task.",
        "",
        "Seeing the page:",
        "- browser_snapshot gives a text outline of the viewport. Controls carry refs such as e12 for the other tools. Refs from an old snapshot can be stale.",
        "- browser_screenshot shows the viewport as a picture in the next message. Its pixel coordinates are viewport coordinates: use them as x and y for anything without a ref, such as a canvas game, a chart or a video.",
        "- Every action answers with what it did and a fresh snapshot of the viewport.",
        "",
        "Acting:",
        "- Prefer refs. Use x and y for what the snapshot cannot show.",
        "- Calls run in order and stop at the first failure; remaining calls are not executed.",
        ...closing,
      ].join("\n"),
    // The opening is the outline alone; after that, only the pictures the model asked for.
    observe: () =>
      opened
        ? Effect.sync(() => {
            const pictures = pending;

            pending = [];

            return pictures;
          })
        : Effect.map(outlined, (snapshot) => {
            opened = true;

            return [text(snapshot.rendered)];
          }),
    tools: (defaults: Tools.Tools<Tools.PageTools>) => {
      const { handlers } = defaults;

      return {
        toolkit: PerActionToolkit,
        handlers: PerActionToolkit.of({
          browser_navigate: withOutline(handlers.browser_navigate),
          browser_back: withOutline(handlers.browser_back),
          browser_snapshot: handlers.browser_snapshot,
          browser_screenshot: () =>
            page.screenshot().pipe(
              Effect.map((image) => {
                pending.push(
                  text(
                    `Screenshot: ${image.width}x${image.height}. Its pixel coordinates are viewport coordinates.`,
                  ),
                  Prompt.makePart("file", { mediaType: image.mediaType, data: image.data }),
                );

                return "The screenshot follows in the next message.";
              }),
              Effect.mapError((error) => error.message),
            ),
          browser_click: withOutline(handlers.browser_click),
          browser_hover: withOutline(handlers.browser_hover),
          browser_type: withOutline(handlers.browser_type),
          browser_press: withOutline(handlers.browser_press),
          browser_scroll: withOutline(handlers.browser_scroll),
          browser_drag: withOutline(handlers.browser_drag),
          browser_select: withOutline(handlers.browser_select),
          browser_wait: withOutline(handlers.browser_wait),
        }),
      };
    },
  };
};

const pixel = (description: string) =>
  Schema.Finite.annotate({ description: `Viewport ${description} in screenshot pixels` });

// A default tool's receipt and failure, under parameters for pixels alone.
const byPixels = <const Name extends string, Parameters extends Schema.Struct.Fields>(
  name: Name,
  description: string,
  parameters: Parameters,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(parameters),
    success: tools.browser_click.successSchema,
    failure: tools.browser_click.failureSchema,
    failureMode: "return",
  });

const VisionToolkit = Toolkit.make(
  tools.browser_navigate,
  tools.browser_back,
  tools.browser_zoom,
  byPixels("browser_click", "Click a point of the screenshot.", {
    x: pixel("x"),
    y: pixel("y"),
    double: Schema.optional(Schema.Boolean),
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  }),
  byPixels("browser_hover", "Move the pointer to a point of the screenshot.", {
    x: pixel("x"),
    y: pixel("y"),
  }),
  byPixels(
    "browser_type",
    "Type text into the focused element. Click a field first to focus it; press Control+A first to replace its content.",
    {
      text: Schema.String,
      submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter afterwards" }),
    },
  ),
  tools.browser_press,
  byPixels(
    "browser_scroll",
    "Scroll the page, or whatever is under a point, such as a list or a chart.",
    {
      direction: Schema.Literals(["down", "up", "right", "left"]),
      pages: Schema.optional(Schema.Finite).annotate({
        description: "How far, in viewports; defaults to 0.8",
      }),
      x: Schema.optional(pixel("x")),
      y: Schema.optional(pixel("y")),
    },
  ),
  byPixels("browser_drag", "Drag from one point of the screenshot to another, such as a slider.", {
    fromX: pixel("x"),
    fromY: pixel("y"),
    toX: pixel("x"),
    toY: pixel("y"),
  }),
  byPixels(
    "browser_wait",
    "Wait for the screen to stop moving (reels, animations, loading), or for some seconds.",
    {
      still: Schema.optional(Schema.Boolean),
      seconds: Schema.optional(Schema.Finite).annotate({ description: "At most 30" }),
    },
  ),
);

/**
 * Arm 2, vision first: a screenshot after each batch and no outline, pixel targets only, and
 * `browser_zoom`. The tools that need the outline (`browser_snapshot`, `browser_select` and
 * waiting for text) are left out.
 */
const visionFirst = {
  system: () =>
    [
      "You operate a web browser through tools to complete the user's task.",
      "",
      "Seeing the page:",
      "- After each turn you see a screenshot of the viewport. Its pixel coordinates are viewport coordinates: act with x and y.",
      "- browser_zoom crops a small viewport region and shows it on its own after the batch, at the viewport's own CSS pixel scale: a closer look, not a magnification. Its caption gives the viewport origin; keep using viewport coordinates for clicks.",
      "- Tool calls return receipts. One fresh screenshot follows the whole batch.",
      "",
      "Acting:",
      "- Click a field before typing into it. To choose from a drop-down, click it, then type the option's label or use the arrow keys, and press Enter.",
      "- Batch two or more predictable steps in one turn. Calls run in order and stop at the first failure; remaining calls are not executed. Coordinates in a batch refer to the screenshot before it.",
      ...closing,
    ].join("\n"),
  observe: Agent.observe("screenshot"),
  tools: ({ handlers }: Tools.Tools<Tools.PageTools>) => ({
    toolkit: VisionToolkit,
    handlers: VisionToolkit.of({
      browser_navigate: handlers.browser_navigate,
      browser_back: handlers.browser_back,
      browser_zoom: handlers.browser_zoom,
      browser_click: handlers.browser_click,
      browser_hover: handlers.browser_hover,
      browser_type: handlers.browser_type,
      browser_press: handlers.browser_press,
      browser_scroll: handlers.browser_scroll,
      browser_drag: handlers.browser_drag,
      browser_wait: handlers.browser_wait,
    }),
  }),
};

/** Run an operate task on its page in one arm, to its answer or an `AgentError`. */
export const operate = <A, I, E>(
  arm: Arm,
  page: Page,
  task: string,
  options: OperateOptions<A, I, E>,
) =>
  arm === 5
    ? Agent.run(task, { page, ...options })
    : arm === 1
      ? Agent.run(task, { page, ...options, ...perActionOutline(page) })
      : Agent.run(task, { page, ...options, ...visionFirst });
