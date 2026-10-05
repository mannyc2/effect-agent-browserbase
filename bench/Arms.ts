/** Bench-only strategies. Task truth and graders never cross this boundary. */
import { createHash } from "node:crypto";

import { Context, Effect, Option, Ref, Schema, Stream } from "effect";
import * as Agent from "effect-browser/Agent";
import { Browser } from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Moment from "effect-browser/Moment";
import type { Page, Observation, Zoom } from "effect-browser/Page";
import * as Tools from "effect-browser/Tools";
import { type AiError, Chat, LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";

import {
  Perception,
  type PerceptionError,
  type ParsedFrame,
  type Image as PerceptionImage,
} from "./Perception.ts";

type Image = Effect.Success<ReturnType<Page["screenshot"]>>;

export const Arm = Schema.Literals([1, 2, 3, 4, 5]);
export type Arm = typeof Arm.Type;

export const metadata = [
  {
    id: 1,
    name: "per-action-outline",
    requires: [],
    operate: "Opening and per-action outlines; explicit screenshots only.",
    understand: "Shipping Moment.describe (identical control for arms 1/4/5).",
    notes:
      "Same-runtime baseline; retains current halt and guard behavior. Comparison with 5 includes automatic pictures.",
  },
  {
    id: 2,
    name: "vision-first",
    requires: [],
    operate: "Screenshots and pixel actions, with optional zoom; no DOM outline or refs.",
    understand: "All timed frames and timeline; no DOM outline.",
    notes: "Browser metadata and action receipts remain available.",
  },
  {
    id: 3,
    name: "parsed-elements",
    requires: ["parse"],
    operate: "OCR and icon list only, with numbered pixel actions.",
    understand: "Every retained frame parsed into a timed list, plus timeline.",
    notes: "No screenshots or DOM outline reach the planner.",
  },
  {
    id: 4,
    name: "local-grounder",
    requires: ["ground"],
    operate: "Default outline and image, plus click_described using the local grounder.",
    understand: "Shipping Moment.describe (identical control for arms 1/4/5).",
    notes: "Rejects changed page, viewport or image after grounding; no retry or fallback.",
  },
  {
    id: 5,
    name: "shipping-batched",
    requires: [],
    operate: "Shipping Agent.run.",
    understand: "Shipping Moment.describe (identical control for arms 1/4/5).",
    notes: "Current public library behavior without an adapter loop.",
  },
] as const;

export interface Prediction<A> {
  readonly answer: A;
  readonly steps: number;
  readonly usage: Agent.Usage;
}

export interface OperateInput<A, I, E> {
  readonly page: Page;
  readonly prompt: string;
  readonly schema: Schema.Codec<A, I>;
  readonly maxSteps: number;
  readonly onUsage: (usage: Agent.Usage) => Effect.Effect<void, E>;
}

export interface UnderstandInput<A, I extends Record<string, unknown>, E> {
  readonly moment: Moment.Moment;
  readonly instructions: string;
  readonly schema: Schema.Codec<A, I>;
  readonly onUsage: (usage: Agent.Usage) => Effect.Effect<void, E>;
}

export interface Strategy<E = never, R = never> {
  readonly operate: <A, I, HookE>(
    input: OperateInput<A, I, HookE>,
  ) => Effect.Effect<
    Prediction<A>,
    BrowserError | AiError.AiError | Agent.AgentError | E | HookE,
    Browser | LanguageModel.LanguageModel | R
  >;
  readonly understand: <A, I extends Record<string, unknown>, HookE>(
    input: UnderstandInput<A, I, HookE>,
  ) => Effect.Effect<Prediction<A>, AiError.AiError | E | HookE, LanguageModel.LanguageModel | R>;
}

const empty: Agent.Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

const usageOf = (usage: Response.Usage): Agent.Usage => ({
  inputTokens: usage.inputTokens.total ?? 0,
  outputTokens: usage.outputTokens.total ?? 0,
  cachedInputTokens: usage.inputTokens.cacheRead ?? 0,
});

const add = (left: Agent.Usage, right: Agent.Usage): Agent.Usage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
});

export const current: Strategy = {
  operate: (input) =>
    Agent.run(input.prompt, {
      answer: input.schema,
      maxSteps: input.maxSteps,
      onStep: (step) => input.onUsage(step.usage),
    }),
  understand: (input) =>
    Moment.describe(input.moment, { schema: input.schema, instructions: input.instructions }).pipe(
      Effect.tap(({ usage }) => input.onUsage(usage)),
      Effect.map(({ value, usage }) => ({ answer: value, steps: 1, usage })),
    ),
};

const message = (content: ReadonlyArray<Prompt.UserMessagePart>) =>
  Prompt.makeMessage("user", { content: [...content] });

const text = (value: string) => Prompt.makePart("text", { text: value });

const picture = (image: Image) => [
  text(`Screenshot: ${image.width}x${image.height}; coordinates are viewport pixels.`),
  Prompt.makePart("file", { mediaType: image.mediaType, data: image.data }),
];

const observed = (observation: Observation, zooms: ReadonlyArray<Zoom>) =>
  message([
    text(observation.snapshot?.rendered ?? "Current viewport."),
    ...(observation.image === undefined ? [] : picture(observation.image)),
    ...zooms.flatMap((zoom) => [
      text(
        `Zoom: page ${zoom.page}, viewport origin (${zoom.region.x}, ${zoom.region.y}), ${zoom.region.width}x${zoom.region.height}. Add the origin when clicking.`,
      ),
      Prompt.makePart("file", { mediaType: zoom.image.mediaType, data: zoom.image.data }),
    ]),
  ]);

const isPicture = (part: Prompt.UserMessagePart) =>
  part.type === "file" && part.mediaType.startsWith("image/");

const prune = (prompt: Prompt.Prompt) => {
  const total = prompt.content.reduce(
    (sum, item) => sum + (item.role === "user" ? item.content.filter(isPicture).length : 0),
    0,
  );

  const last = prompt.content.at(-1);
  const retain = Math.max(3, last?.role === "user" ? last.content.filter(isPicture).length : 0);

  if (total <= retain * 2) return prompt;
  let remove = total - retain;

  return Prompt.fromMessages(
    prompt.content.map((item) =>
      item.role !== "user"
        ? item
        : message(
            item.content.map((part) => {
              if (!isPicture(part) || remove === 0) return part;
              remove -= 1;

              return text("(an earlier screenshot was removed)");
            }),
          ),
    ),
  );
};

// Preserve the shipping safety contract in every comparison, including the historical observation
// baseline: changing representation is not permission to execute later calls after an uncertain one.
function batch<T extends Record<string, Tool.Any>>(
  toolkit: Toolkit.WithHandler<T>,
): Toolkit.WithHandler<T>;
function batch<T extends Record<string, Tool.Any>>(toolkit: Toolkit.WithHandler<T>) {
  let halted: string | undefined;

  return {
    tools: toolkit.tools,
    handle: <N extends keyof T>(name: N, params: Tool.ParametersEncoded<T[N]>, id?: string) => {
      if (halted !== undefined) {
        const result: typeof Tool.ExecutionFailure.Type = {
          type: "execution-interrupted",
          reason: "Not executed: " + halted,
        };

        return Effect.succeed(
          Stream.succeed({ result, encodedResult: result, isFailure: true, preliminary: false }),
        );
      }

      return Effect.succeed(
        toolkit.handle(name, params, id).pipe(
          Stream.unwrap,
          Stream.catch((error) => {
            const result: typeof Tool.ExecutionFailure.Type = {
              type: "execution-interrupted",
              reason: "The call failed and may have taken effect: " + String(error),
            };

            return Stream.succeed({
              result,
              encodedResult: result,
              isFailure: true,
              preliminary: false,
            });
          }),
          Stream.tap((result) =>
            Effect.sync(() => {
              if (
                !result.preliminary &&
                (result.isFailure || name === "done" || name === "give_up")
              )
                halted = String(name) + (result.isFailure ? " failed." : " ended the batch.");
            }),
          ),
        ),
      );
    },
  };
}

const runLoop = <A, I, E, T extends Record<string, Tool.Any>, OE, OR>(
  input: OperateInput<A, I, E>,
  definition: Toolkit.Toolkit<T>,
  handlers: Toolkit.HandlersFrom<T>,
  opening: Effect.Effect<Prompt.Message, OE, OR>,
  after: Effect.Effect<ReadonlyArray<Prompt.Message>, OE, OR>,
  guidance: string,
) =>
  Effect.gen(function* () {
    const outcome = yield* Ref.make(
      Option.none<{ readonly answer: A } | { readonly reason: string }>(),
    );

    const Done = Tool.make("done", {
      description: "Finish and report the answer.",
      parameters: Schema.Struct({ answer: input.schema }),
      success: Schema.String,
      failureMode: "return",
    });

    const GiveUp = Tool.make("give_up", {
      description: "Stop and say why.",
      parameters: Schema.Struct({ reason: Schema.String }),
      success: Schema.String,
      failureMode: "return",
    });

    const finish = Toolkit.make(Done, GiveUp);

    const finishContext = yield* finish.toHandlers({
      done: ({ answer }) => Ref.set(outcome, Option.some({ answer })).pipe(Effect.as("Done.")),
      give_up: ({ reason }) =>
        Ref.set(outcome, Option.some({ reason })).pipe(Effect.as("Stopped.")),
    });

    const actionContext = yield* definition.toHandlers(handlers);

    const toolkit = yield* Toolkit.merge(definition, finish).pipe(
      Effect.provideContext(Context.merge(actionContext, finishContext)),
    );

    const chat = yield* Chat.fromPrompt([
      {
        role: "system",
        content: [
          "You operate a web browser through tools to complete the user's task.",
          guidance,
          "Calls run in order and stop at the first failure or completion. If an action may have taken effect, observe before repeating it.",
          "Work on your own. Call done with the answer, or give_up if blocked.",
        ].join("\n"),
      },
      { role: "user", content: input.prompt },
      yield* opening,
    ]);

    let usage = empty;
    let idle = 0;
    let next: Array<Prompt.Message> = [];

    for (let step = 1; step <= input.maxSteps; step++) {
      const response = yield* chat.generateText({
        prompt: Prompt.fromMessages(next),
        toolkit: batch(toolkit),
        concurrency: 1,
      });

      const stepUsage = usageOf(response.usage);

      usage = add(usage, stepUsage);
      // Account before observation: a capture failure cannot hide a completed paid model response.
      yield* input.onUsage(stepUsage);
      const observations = yield* after;

      yield* Ref.update(chat.history, (history) => prune(Prompt.concat(history, observations)));
      const result = yield* Ref.get(outcome);

      if (Option.isSome(result)) {
        if ("reason" in result.value)
          return yield* new Agent.AgentError({
            reason: new Agent.GaveUp({ reason: result.value.reason }),
            steps: step,
          });

        return { answer: result.value.answer, steps: step, usage };
      }
      if (response.toolCalls.length === 0) {
        idle += 1;
        if (idle >= 3)
          return yield* new Agent.AgentError({
            reason: new Agent.GaveUp({ reason: "stopped calling tools: " + response.text }),
            steps: step,
          });
        next = [message([text("Continue with tools, or call done with the answer.")])];
      } else {
        idle = 0;
        next = [];
      }
    }

    return yield* new Agent.AgentError({
      reason: new Agent.StepLimit({ steps: input.maxSteps }),
      steps: input.maxSteps,
    });
  });

const tool = <const N extends string, F extends Schema.Struct.Fields>(
  name: N,
  description: string,
  fields: F,
) =>
  Tool.make(name, {
    description,
    parameters: Schema.Struct(fields),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  });

const Screenshot = tool(
  "browser_screenshot",
  "Capture the current viewport; its picture follows this turn.",
  {},
);

const PixelClick = tool("browser_click", "Click screenshot viewport pixels.", {
  x: Schema.Finite,
  y: Schema.Finite,
  double: Schema.optional(Schema.Boolean),
  button: Schema.optional(Schema.Literals(["left", "middle", "right"])),
});

const PixelHover = tool("browser_hover", "Move to screenshot viewport pixels.", {
  x: Schema.Finite,
  y: Schema.Finite,
});

const PixelType = tool(
  "browser_type",
  "Type into the focused control. Use ControlOrMeta+A first to replace text.",
  { text: Schema.String, submit: Schema.optional(Schema.Boolean) },
);

const PixelScroll = tool("browser_scroll", "Scroll at viewport pixels or the current pointer.", {
  direction: Schema.Literals(["up", "down", "left", "right"]),
  pages: Schema.optional(Schema.Finite),
  x: Schema.optional(Schema.Finite),
  y: Schema.optional(Schema.Finite),
});

const PixelDrag = tool("browser_drag", "Drag between screenshot viewport points.", {
  fromX: Schema.Finite,
  fromY: Schema.Finite,
  toX: Schema.Finite,
  toY: Schema.Finite,
});

const PixelWait = tool("browser_wait", "Wait for a still screen or a bounded number of seconds.", {
  still: Schema.optional(Schema.Boolean),
  seconds: Schema.optional(Schema.Finite),
});

const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));
const numbered = { view: PositiveInt, id: PositiveInt };

const NumberClick = tool(
  "browser_click",
  "Click an element from the current parsed view.",
  numbered,
);

const NumberType = tool(
  "browser_type",
  "Focus a numbered field and type text; replaces existing text unless append is true.",
  {
    ...numbered,
    text: Schema.String,
    append: Schema.optional(Schema.Boolean),
    submit: Schema.optional(Schema.Boolean),
  },
);

const NumberSelect = tool(
  "browser_select",
  "Focus a numbered select and choose a visible label using keyboard input.",
  { ...numbered, label: Schema.String },
);

const ClickDescribed = tool(
  "click_described",
  "Locate the described visible target with a local vision grounder, then click it if the screenshot has not changed.",
  { what: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512)) },
);

const baselineOperate = <A, I, E>(input: OperateInput<A, I, E>) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make();
    let pending: Array<Prompt.UserMessagePart> = [];

    const outline = tools.page.pipe(
      Effect.flatMap((page) => page.snapshot({ maxChars: 8000 })),
      Effect.map((snapshot) => snapshot.rendered),
    );

    const withOutline =
      <P>(handler: (params: P) => Effect.Effect<string, string>) =>
      (params: P) =>
        handler(params).pipe(
          Effect.flatMap((receipt) =>
            outline.pipe(
              Effect.map((value) => receipt + "\n" + value),
              Effect.mapError((error) => error.message),
            ),
          ),
        );

    const kit = Toolkit.make(
      Tools.Navigate,
      Tools.Back,
      Tools.Snapshot,
      Tools.Click,
      Tools.Hover,
      Tools.Type,
      Tools.Press,
      Tools.Scroll,
      Tools.Drag,
      Tools.Select,
      Tools.Wait,
      Tools.Tabs,
      Screenshot,
    );

    const handlers = kit.of({
      ...tools.handlers,
      browser_navigate: withOutline(tools.handlers.browser_navigate),
      browser_back: withOutline(tools.handlers.browser_back),
      browser_click: withOutline(tools.handlers.browser_click),
      browser_hover: withOutline(tools.handlers.browser_hover),
      browser_type: withOutline(tools.handlers.browser_type),
      browser_press: withOutline(tools.handlers.browser_press),
      browser_scroll: withOutline(tools.handlers.browser_scroll),
      browser_drag: withOutline(tools.handlers.browser_drag),
      browser_select: withOutline(tools.handlers.browser_select),
      browser_wait: withOutline(tools.handlers.browser_wait),
      browser_screenshot: () =>
        Effect.gen(function* () {
          if (pending.length >= 16)
            return yield* Effect.fail("At most 8 screenshots may await a turn.");
          const page = yield* tools.page;
          const image = yield* page.screenshot({ fresh: true });

          pending.push(...picture(image));

          return "Captured a screenshot; its picture follows this turn.";
        }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message))),
    });

    return yield* runLoop(
      input,
      kit,
      handlers,
      outline.pipe(Effect.map((value) => message([text(value)]))),
      Effect.sync(() => {
        const content = pending;

        pending = [];

        return content.length === 0 ? [] : [message(content)];
      }),
      "Read the page outline and use its current refs. Each action returns a fresh outline. Call browser_screenshot to inspect canvas content or other visual details. Click pixels when no ref is available.",
    );
  });

const visionOperate = <A, I, E>(input: OperateInput<A, I, E>) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make();

    const kit = Toolkit.make(
      Tools.Navigate,
      Tools.Back,
      PixelClick,
      PixelHover,
      PixelType,
      Tools.Press,
      PixelScroll,
      PixelDrag,
      PixelWait,
      Tools.Tabs,
      Tools.Zoom,
    );

    const handlers = kit.of({
      ...tools.handlers,
      // The shared click receipt names the DOM target. Keep the pixel-only planner's receipt visual.
      browser_click: (op) =>
        tools.handlers.browser_click(op).pipe(Effect.as(`Clicked (${op.x}, ${op.y}).`)),
      browser_type: (op) => tools.handlers.browser_type({ ...op, append: true }),
    });

    const observe = Effect.gen(function* () {
      const zooms = yield* tools.takeZooms;
      const page = yield* tools.page;

      return observed(yield* page.observe({ mode: "screenshot" }), zooms);
    });

    return yield* runLoop(
      input,
      kit,
      handlers,
      observe,
      Effect.map(observe, (value) => [value]),
      "Use screenshots and viewport pixel coordinates. There is no DOM outline or ref lookup. Use browser_zoom for detail. Batch predictable steps; one fresh screenshot follows the batch. Select options with keyboard input.",
    );
  });

const hash = (data: Uint8Array) => createHash("sha256").update(data).digest("hex");

const capture = (page: Page) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const image = yield* page.screenshot({ fresh: true });

    return {
      data: image.data,
      mimeType: "image/jpeg" as const,
      width: image.width,
      height: image.height,
      sha256: hash(image.data),
      page: page.id,
      at: yield* browser.now,
    };
  });

const renderParsed = (parsed: ParsedFrame, view?: number) =>
  [
    view === undefined ? "Parsed frame:" : `Parsed view ${view}:`,
    `Page ${parsed.observation.page}; ${parsed.observation.width}x${parsed.observation.height}; pixel coordinates.`,
    ...parsed.elements.map(
      (element) =>
        `${element.id}. ${element.kind} ${JSON.stringify(element.text)} box=(${element.bbox.x0},${element.bbox.y0},${element.bbox.x1},${element.bbox.y1})`,
    ),
  ].join("\n");

const parsedOperate = <A, I, E>(input: OperateInput<A, I, E>) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make();
    const perception = yield* Perception;
    let view = 0;

    let latest:
      | {
          readonly view: number;
          readonly page: Page;
          readonly url: string;
          readonly image: PerceptionImage;
          readonly parsed: ParsedFrame;
        }
      | undefined;

    const observe = Effect.gen(function* () {
      const page = yield* tools.page;
      const image = yield* capture(page);
      const parsed = yield* perception.parse(image);

      view += 1;
      latest = { view, page, url: yield* page.url, image, parsed };

      return message([text(renderParsed(parsed, view))]);
    });

    const point = (params: typeof NumberClick.parametersSchema.Type) =>
      Effect.gen(function* () {
        const sample = latest;
        const page = yield* tools.page;
        const viewport = page.playwright.viewportSize();

        if (
          sample === undefined ||
          params.view !== sample.view ||
          page !== sample.page ||
          (yield* page.url) !== sample.url ||
          viewport === null ||
          viewport.width !== sample.image.width ||
          viewport.height !== sample.image.height
        )
          return yield* Effect.fail("Stale parsed view; finish the turn and use the fresh view.");
        const element = sample.parsed.elements.find((candidate) => candidate.id === params.id);

        if (element === undefined)
          return yield* Effect.fail("No element with that id in the current view.");

        return {
          x: (element.bbox.x0 + element.bbox.x1) / 2,
          y: (element.bbox.y0 + element.bbox.y1) / 2,
        };
      }).pipe(Effect.mapError((error) => (typeof error === "string" ? error : error.message)));

    const focus = (params: typeof NumberClick.parametersSchema.Type) =>
      point(params).pipe(
        Effect.flatMap((coordinates) => tools.handlers.browser_click(coordinates)),
        Effect.as(`Clicked element ${params.id} in view ${params.view}.`),
      );

    const invalidate =
      <P>(handler: (params: P) => Effect.Effect<string, string>) =>
      (params: P) =>
        handler(params).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              latest = undefined;
            }),
          ),
        );

    const kit = Toolkit.make(
      Tools.Navigate,
      Tools.Back,
      NumberClick,
      NumberType,
      NumberSelect,
      Tools.Press,
      PixelScroll,
      PixelDrag,
      PixelWait,
      Tools.Tabs,
    );

    const handlers = kit.of({
      ...tools.handlers,
      // The URL alone cannot detect a reload to the same address. A changed viewport or document
      // invalidates the numbered map even when subsequent calls belong to the same model turn.
      browser_navigate: invalidate(tools.handlers.browser_navigate),
      browser_back: invalidate(tools.handlers.browser_back),
      browser_scroll: invalidate(tools.handlers.browser_scroll),
      browser_drag: invalidate(tools.handlers.browser_drag),
      browser_tabs: (params) =>
        tools.handlers.browser_tabs(params).pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              if (params.action !== "list") latest = undefined;
            }),
          ),
        ),
      browser_click: focus,
      browser_type: (params) =>
        Effect.gen(function* () {
          yield* focus(params);
          if (params.append !== true)
            yield* tools.handlers.browser_press({ keys: "ControlOrMeta+A" });
          yield* tools.handlers.browser_type({
            text: params.text,
            append: true,
            submit: params.submit,
          });

          return `Typed into element ${params.id}.`;
        }),
      browser_select: (params) =>
        Effect.gen(function* () {
          yield* focus(params);
          yield* tools.handlers.browser_press({ keys: "Home" });
          yield* tools.handlers.browser_type({ text: params.label, append: true });
          yield* tools.handlers.browser_press({ keys: "Enter" });

          return `Selected ${JSON.stringify(params.label)} using keyboard input.`;
        }),
    });

    return yield* runLoop(
      input,
      kit,
      handlers,
      observe,
      Effect.map(observe, (value) => [value]),
      "The observation is an OCR and icon list from a screenshot. Use the current view number and element id for click, type and select. No images or DOM outline are supplied. Batch predictable steps; one new parsed view follows the batch.",
    );
  });

const groundOperate = <A, I, E>(input: OperateInput<A, I, E>) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make();
    const perception = yield* Perception;
    const browser = yield* Browser;
    const kit = Toolkit.merge(Tools.BrowserToolkit, Toolkit.make(ClickDescribed));

    const handlers = kit.of({
      ...tools.handlers,
      click_described: ({ what }) =>
        Effect.gen(function* () {
          const page = yield* tools.page;
          const url = yield* page.url;
          const image = yield* capture(page);
          const point = yield* perception.ground(image, what);
          const active = yield* tools.page;
          const viewport = page.playwright.viewportSize();

          if (
            active !== page ||
            (yield* page.url) !== url ||
            viewport === null ||
            viewport.width !== image.width ||
            viewport.height !== image.height
          )
            return yield* Effect.fail(
              "The page or viewport changed while grounding; no click was sent.",
            );
          const fresh = yield* page.screenshot({ fresh: true });

          if (hash(fresh.data) !== image.sha256)
            return yield* Effect.fail("The image changed while grounding; no click was sent.");
          yield* tools.handlers.browser_click({ x: point.x, y: point.y });

          return `Clicked described target at (${point.x}, ${point.y}).`;
        }).pipe(
          Effect.provideService(Browser, browser),
          Effect.mapError((error) =>
            typeof error === "string"
              ? error
              : error._tag === "PerceptionError"
                ? "Local grounding failed: " + error.reason
                : error.message,
          ),
        ),
    });

    const observe = Effect.gen(function* () {
      const zooms = yield* tools.takeZooms;
      const page = yield* tools.page;

      return observed(yield* page.observe({ mode: "both", maxChars: 8000 }), zooms);
    });

    return yield* runLoop(
      input,
      kit,
      handlers,
      observe,
      Effect.map(observe, (value) => [value]),
      "Use current outline refs when available, screenshot pixels otherwise. Batch predictable steps; one fresh observation follows the batch. browser_zoom supplies pixel detail. click_described asks a local vision model to locate a visible target; a changed image rejects the click.",
    );
  });

const describeVisual = <A, I extends Record<string, unknown>, E, PE, PR>(
  input: UnderstandInput<A, I, E>,
  parts: (image: PerceptionImage) => Effect.Effect<ReadonlyArray<Prompt.UserMessagePart>, PE, PR>,
) =>
  Effect.gen(function* () {
    const content: Array<Prompt.UserMessagePart> = [
      text("Timeline (seconds before the moment):\n" + input.moment.timeline),
      text(
        `${input.moment.frames.length} frames follow, oldest first; the last is the moment itself.`,
      ),
    ];

    for (const frame of input.moment.frames) {
      content.push(text(`${((frame.hostTime - input.moment.at) / 1000).toFixed(1)}s:`));
      content.push(
        ...(yield* parts({
          data: frame.data,
          mimeType: "image/jpeg",
          sha256: hash(frame.data),
          width: frame.width,
          height: frame.height,
          page: input.moment.page,
          at: frame.hostTime,
        })),
      );
    }

    const response = yield* LanguageModel.generateObject({
      schema: input.schema,
      objectName: "moment",
      prompt: Prompt.fromMessages([
        Prompt.makeMessage("system", {
          content: [
            "Describe only what the supplied browser evidence shows. Prefer concrete numbers, names, positions and changes.",
            input.instructions,
          ].join("\n"),
        }),
        message(content),
      ]),
    });

    const usage = usageOf(response.usage);

    yield* input.onUsage(usage);

    return { answer: response.value, steps: 1, usage };
  });

export const baseline: Strategy = { operate: baselineOperate, understand: current.understand };

export const vision: Strategy = {
  operate: visionOperate,
  understand: (input) =>
    describeVisual(input, (image) =>
      Effect.succeed([Prompt.makePart("file", { mediaType: image.mimeType, data: image.data })]),
    ),
};

export const parsed: Strategy<PerceptionError, Perception> = {
  operate: parsedOperate,
  understand: (input) =>
    describeVisual(input, (image) =>
      Effect.gen(function* () {
        const perception = yield* Perception;

        return [text(renderParsed(yield* perception.parse(image)))];
      }),
    ),
};

export const grounder: Strategy<never, Perception> = {
  operate: groundOperate,
  understand: current.understand,
};

export const strategies = { 1: baseline, 2: vision, 3: parsed, 4: grounder, 5: current } as const;
