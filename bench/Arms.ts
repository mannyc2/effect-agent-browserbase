// The arms of the paired experiment: how a model sees a page and acts on it. Arm 5 is the
// library's default, `Agent.run`. Arms 1 and 2 need another observation, other tools and another
// system prompt, which `Agent.run` does not let a caller replace, so the bench drives them with
// its own loop over the public `Tools`, built like `Agent.run`'s: a turn's calls run in order and
// halt on the first failure or on `done`, older pictures are pruned, and a response that cannot be
// read goes back to the model. Understand tasks differ only in arm 1, whose moments add the
// outline.
import { Context, Effect, Exit, Option, Ref, Schema } from "effect";
import * as Agent from "effect-browser/Agent";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";
import * as Tools from "effect-browser/Tools";
import { AiError, Chat, Prompt, type Response, Tool, Toolkit } from "effect/ai";

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

type Image = Effect.Success<ReturnType<Page["screenshot"]>>;

const text = (value: string) => Prompt.makePart("text", { text: value });

const picture = (image: Image): ReadonlyArray<Prompt.UserMessagePart> => [
  text(
    `Screenshot: ${image.width}x${image.height}. Its pixel coordinates are viewport coordinates.`,
  ),
  Prompt.makePart("file", { mediaType: image.mediaType, data: image.data }),
];

const message = (content: ReadonlyArray<Prompt.UserMessagePart>) =>
  Prompt.makeMessage("user", { content: [...content] });

const isPicture = (part: Prompt.UserMessagePart) =>
  part.type === "file" && part.mediaType.startsWith("image/");

/** `Agent.run`'s pruning: older pictures go in groups, and the newest message keeps all of its own. */
const prunePictures = (prompt: Prompt.Prompt, keep: number): Prompt.Prompt => {
  const total = prompt.content.reduce(
    (count, item) => count + (item.role === "user" ? item.content.filter(isPicture).length : 0),
    0,
  );

  const current = prompt.content.at(-1);

  const retain = Math.max(
    keep,
    current?.role === "user" ? current.content.filter(isPicture).length : 0,
  );

  if (total <= Math.max(retain * 2, 1)) return prompt;
  let remove = total - retain;

  return Prompt.fromMessages(
    prompt.content.map((item) => {
      if (item.role !== "user" || remove === 0 || !item.content.some(isPicture)) return item;

      return message(
        item.content.map((part) => {
          if (remove === 0 || !isPicture(part)) return part;
          remove -= 1;

          return text("(an earlier screenshot was removed)");
        }),
      );
    }),
  );
};

/** `Agent.run`'s rule: a response whose calls could not be decoded ran nothing, so the model may retry. */
const isUnreadable = (
  error: unknown,
): error is AiError.AiError & {
  readonly reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError;
} =>
  AiError.isAiError(error) &&
  ((error.reason._tag === "InvalidOutputError" &&
    error.module === "LanguageModel" &&
    error.method === "generateText") ||
    (error.reason._tag === "ToolParameterValidationError" && error.module !== "Toolkit"));

const unreadable = (
  reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError,
  tools: ReadonlyArray<string>,
) =>
  reason._tag === "ToolParameterValidationError"
    ? `Your call to ${reason.toolName} could not be read, so none of your last response's tool calls ran: ${reason.description}. Send each call's arguments as one JSON object.`
    : `Your last response could not be read, so none of its tool calls ran. It most likely called a tool that does not exist. The tools are: ${tools.join(", ")}.`;

const add = (total: Agent.Usage, usage: Response.Usage): Agent.Usage => ({
  inputTokens: total.inputTokens + (usage.inputTokens.total ?? 0),
  outputTokens: total.outputTokens + (usage.outputTokens.total ?? 0),
  cachedInputTokens: total.cachedInputTokens + (usage.inputTokens.cacheRead ?? 0),
});

const noUsage: Agent.Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

const closing = [
  "- If an action fails and says it may have taken effect, look at the page before you repeat it.",
  "- Work on your own. Do not ask the user anything; if something blocks you, try another way.",
  "- When the task is done, call done with the answer. If it cannot be done, call give_up with the reason.",
];

/** The model loop for arms 1 and 2, with `Agent.run`'s completion, batching and step rules. */
const drive = <A, I, E, T extends Record<string, Tool.Any>>(
  task: string,
  options: OperateOptions<A, I, E>,
  arm: {
    readonly system: string;
    readonly toolkit: Toolkit.Toolkit<T>;
    readonly handlers: Toolkit.HandlersFrom<T>;
    /** What the model sees before its first turn. */
    readonly opening: Effect.Effect<Prompt.Message, BrowserError>;
    /** What the model sees after each turn, if anything. */
    readonly observe: Effect.Effect<Prompt.Message | undefined, BrowserError>;
  },
) =>
  Effect.gen(function* () {
    const outcome = yield* Ref.make(
      Option.none<{ readonly answer: A } | { readonly reason: string }>(),
    );

    const Done = Tool.make("done", {
      description: "Finish the task and report the answer.",
      parameters: Schema.Struct({ answer: options.answer }),
      success: Schema.String,
      failureMode: "return",
    });

    const GiveUp = Tool.make("give_up", {
      description: "Stop because the task cannot be done, and say why.",
      parameters: Schema.Struct({ reason: Schema.String }),
      success: Schema.String,
      failureMode: "return",
    });

    const Completion = Toolkit.make(Done, GiveUp);

    const completion = yield* Completion.toHandlers({
      done: ({ answer }) => Ref.set(outcome, Option.some({ answer })).pipe(Effect.as("Done.")),
      give_up: ({ reason }) =>
        Ref.set(outcome, Option.some({ reason })).pipe(Effect.as("Stopped.")),
    });

    const actions = yield* arm.toolkit.toHandlers(arm.handlers);

    const toolkit = yield* Toolkit.merge(arm.toolkit, Completion).pipe(
      Effect.provideContext(Context.merge(actions, completion)),
    );

    const chat = yield* Chat.fromPrompt([
      { role: "system", content: arm.system },
      { role: "user", content: task },
      yield* arm.opening,
    ]);

    let next: Array<Prompt.Message> = [];
    let usage = noUsage;
    let idle = 0;

    for (let step = 1; step <= options.maxSteps; step++) {
      const response = yield* chat
        .generateText({
          prompt: Prompt.fromMessages(next),
          ...(yield* Tools.batch(toolkit, { endsBatch: ["done", "give_up"] })),
        })
        .pipe(
          Effect.map((turn) => ({ turn })),
          Effect.catchIf(isUnreadable, (error) => Effect.succeed({ rejected: error.reason })),
        );

      // As in `Agent.run`, a browser that is gone ends the run only after the paid turn is reported.
      const observed = yield* Effect.exit(arm.observe);

      if (Exit.isSuccess(observed) && observed.value !== undefined) {
        const latest = observed.value;

        yield* Ref.update(chat.history, (history) =>
          prunePictures(Prompt.concat(history, [latest]), 3),
        );
      }

      if ("rejected" in response) {
        yield* options.onStep({
          step,
          text: "",
          calls: [],
          results: [],
          usage: noUsage,
          rejected: response.rejected.description,
        });
        if (Exit.isFailure(observed)) return yield* Effect.failCause(observed.cause);
        idle = 0;
        next = [message([text(unreadable(response.rejected, Object.keys(toolkit.tools)))])];
        continue;
      }
      const { turn } = response;

      usage = add(usage, turn.usage);
      yield* options.onStep({
        step,
        text: turn.text,
        calls: turn.toolCalls.map((call) => ({ name: call.name, params: call.params })),
        results: turn.toolResults.map((result) => ({
          name: result.name,
          result: result.result,
          isFailure: result.isFailure,
        })),
        usage: add(noUsage, turn.usage),
      });

      const finished = yield* Ref.get(outcome);

      if (Option.isSome(finished)) {
        if ("reason" in finished.value)
          return yield* new Agent.AgentError({
            reason: new Agent.GaveUp({ reason: finished.value.reason }),
            steps: step,
          });

        return { answer: finished.value.answer, steps: step, usage };
      }
      if (Exit.isFailure(observed)) return yield* Effect.failCause(observed.cause);

      if (turn.toolCalls.length === 0) {
        idle += 1;
        if (idle >= 3)
          return yield* new Agent.AgentError({
            reason: new Agent.GaveUp({ reason: `stopped calling tools: ${turn.text}` }),
            steps: step,
          });
        next = [message([text("Continue with the tools, or call done with the answer.")])];
        continue;
      }
      idle = 0;
      next = [];
    }

    return yield* new Agent.AgentError({
      reason: new Agent.StepLimit({ steps: options.maxSteps }),
      steps: options.maxSteps,
    });
  });

// Without parameters: an empty struct's JSON Schema has no object root, which OpenAI rejects.
const Screenshot = Tool.make("browser_screenshot", {
  description: "Show the viewport as a picture in the next message.",
  success: Schema.String,
  failure: Schema.String,
  failureMode: "return",
});

const PerActionToolkit = Toolkit.make(
  Tools.Navigate,
  Tools.Back,
  Tools.Snapshot,
  Screenshot,
  Tools.Click,
  Tools.Hover,
  Tools.Type,
  Tools.Press,
  Tools.Scroll,
  Tools.Drag,
  Tools.Select,
  Tools.Wait,
  Tools.Tabs,
);

/**
 * Arm 1, the tools as they were before batching (`d100c9f`): every action answers with a fresh
 * outline, pictures come only from `browser_screenshot`, and the prompt has no batching hint.
 * The halt on the first failure stays, as the library's safety contract.
 */
const perActionOutline = <A, I, E>(task: string, options: OperateOptions<A, I, E>) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make();
    let pending: Array<Prompt.UserMessagePart> = [];

    const outline = Effect.flatMap(tools.page, (page) => page.snapshot({ maxChars: 8000 }));

    const withOutline =
      <P>(handler: (params: P) => Effect.Effect<string, string>) =>
      (params: P) =>
        Effect.flatMap(handler(params), (receipt) =>
          outline.pipe(
            Effect.map((snapshot) => `${receipt}\n${snapshot.rendered}`),
            Effect.orElseSucceed(() => `${receipt}\n(could not read the page)`),
          ),
        );

    const { handlers } = tools;

    return yield* drive(task, options, {
      system: [
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
      toolkit: PerActionToolkit,
      handlers: PerActionToolkit.of({
        browser_navigate: withOutline(handlers.browser_navigate),
        browser_back: withOutline(handlers.browser_back),
        browser_snapshot: handlers.browser_snapshot,
        browser_screenshot: () =>
          Effect.gen(function* () {
            const page = yield* tools.page;
            const image = yield* page.screenshot();

            pending.push(...picture(image));

            return "The screenshot follows in the next message.";
          }).pipe(Effect.mapError((error) => error.message)),
        browser_click: withOutline(handlers.browser_click),
        browser_hover: withOutline(handlers.browser_hover),
        browser_type: withOutline(handlers.browser_type),
        browser_press: withOutline(handlers.browser_press),
        browser_scroll: withOutline(handlers.browser_scroll),
        browser_drag: withOutline(handlers.browser_drag),
        browser_select: withOutline(handlers.browser_select),
        browser_wait: withOutline(handlers.browser_wait),
        browser_tabs: handlers.browser_tabs,
      }),
      opening: Effect.map(outline, (snapshot) => message([text(snapshot.rendered)])),
      // Looking up the tab ends the run, as in `Agent.run`, once the browser has no page.
      observe: Effect.map(tools.page, () => {
        const pictures = pending;

        pending = [];

        return pictures.length === 0 ? undefined : message(pictures);
      }),
    });
  });

const pixel = (description: string) =>
  Schema.Finite.annotate({ description: `Viewport ${description} in screenshot pixels` });

const VisionToolkit = Toolkit.make(
  Tools.Navigate,
  Tools.Back,
  Tools.Zoom,
  Tool.make("browser_click", {
    description: "Click a point of the screenshot.",
    parameters: Schema.Struct({
      x: pixel("x"),
      y: pixel("y"),
      double: Schema.optional(Schema.Boolean),
      button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
    }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  }),
  Tool.make("browser_hover", {
    description: "Move the pointer to a point of the screenshot.",
    parameters: Schema.Struct({ x: pixel("x"), y: pixel("y") }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  }),
  Tool.make("browser_type", {
    description:
      "Type text into the focused element. Click a field first to focus it; press Control+A first to replace its content.",
    parameters: Schema.Struct({
      text: Schema.String,
      submit: Schema.optional(Schema.Boolean).annotate({ description: "Press Enter afterwards" }),
    }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  }),
  Tools.Press,
  Tool.make("browser_scroll", {
    description: "Scroll the page, or whatever is under a point, such as a list or a chart.",
    parameters: Schema.Struct({
      direction: Schema.Literals(["down", "up", "right", "left"]),
      pages: Schema.optional(Schema.Finite).annotate({
        description: "How far, in viewports; defaults to 0.8",
      }),
      x: Schema.optional(pixel("x")),
      y: Schema.optional(pixel("y")),
    }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  }),
  Tool.make("browser_drag", {
    description: "Drag from one point of the screenshot to another, such as a slider.",
    parameters: Schema.Struct({
      fromX: pixel("x"),
      fromY: pixel("y"),
      toX: pixel("x"),
      toY: pixel("y"),
    }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  }),
  Tool.make("browser_wait", {
    description:
      "Wait for the screen to stop moving (reels, animations, loading), or for some seconds.",
    parameters: Schema.Struct({
      still: Schema.optional(Schema.Boolean),
      seconds: Schema.optional(Schema.Finite).annotate({ description: "At most 30" }),
    }),
    success: Schema.String,
    failure: Schema.String,
    failureMode: "return",
  }),
  Tools.Tabs,
);

/**
 * Arm 2, vision first: a screenshot after each batch and no outline, pixel targets only, and
 * `browser_zoom`. The tools that need the outline (`browser_snapshot`, `browser_select` and
 * waiting for text) are left out.
 */
const visionFirst = <A, I, E>(task: string, options: OperateOptions<A, I, E>) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make();
    const { handlers } = tools;

    const observe = Effect.gen(function* () {
      const zooms = yield* tools.takeZooms;
      const page = yield* tools.page;

      const image = yield* page.observe({ mode: "screenshot" }).pipe(
        Effect.map((observed) => observed.image),
        Effect.catch((error) => Effect.succeed(error.message)),
      );

      return message([
        text(
          typeof image === "string"
            ? `(the page could not be observed: ${image})`
            : "Observation of the current viewport.",
        ),
        ...(image === undefined || typeof image === "string" ? [] : picture(image)),
        ...zooms.flatMap((zoom) => [
          text(
            `Zoom from page ${zoom.page}: viewport origin (${zoom.region.x}, ${zoom.region.y}), ${zoom.region.width}x${zoom.region.height} CSS pixels. Captured when browser_zoom ran. Add this origin to image coordinates for viewport clicks.`,
          ),
          Prompt.makePart("file", { mediaType: zoom.image.mediaType, data: zoom.image.data }),
        ]),
      ]);
    });

    return yield* drive(task, options, {
      system: [
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
      toolkit: VisionToolkit,
      handlers: VisionToolkit.of({
        browser_navigate: handlers.browser_navigate,
        browser_back: handlers.browser_back,
        browser_zoom: handlers.browser_zoom,
        browser_click: (op) => handlers.browser_click(op),
        browser_hover: (op) => handlers.browser_hover(op),
        browser_type: (op) => handlers.browser_type(op),
        browser_press: handlers.browser_press,
        browser_scroll: (op) => handlers.browser_scroll(op),
        browser_drag: (op) => handlers.browser_drag(op),
        browser_wait: (op) => handlers.browser_wait(op),
        browser_tabs: handlers.browser_tabs,
      }),
      opening: observe,
      observe,
    });
  });

/** The middle value, or the mean of the middle two; 0 for none. */
export const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length === 0) return 0;

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * Two arms' outcomes on the same task and trial, over the pairs graded in both: the discordant
 * counts are what McNemar's test reads. A pair with an ungraded side says nothing about accuracy.
 */
export const pairs = (
  records: ReadonlyArray<{
    readonly task: string;
    readonly trial: number;
    readonly arm: Arm | null;
    readonly status: string;
    readonly pass: boolean | null;
  }>,
  first: Arm,
  second: Arm,
) => {
  const passed = (arm: Arm) =>
    new Map(
      records
        .filter((record) => record.arm === arm && record.status === "graded")
        .map((record) => [`${record.task}#${record.trial}`, record.pass === true]),
    );

  const left = passed(first);
  const right = passed(second);
  const counts = { pairs: 0, both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 };

  for (const [key, a] of left) {
    const b = right.get(key);

    if (b === undefined) continue;
    counts.pairs += 1;
    if (a && b) counts.both += 1;
    else if (a) counts.onlyFirst += 1;
    else if (b) counts.onlySecond += 1;
    else counts.neither += 1;
  }

  return counts;
};

/** Run an operate task in one arm, to its answer or an `AgentError`, as `Agent.run` does. */
export const operate = <A, I, E>(arm: Arm, task: string, options: OperateOptions<A, I, E>) =>
  arm === 5
    ? Agent.run(task, {
        answer: options.answer,
        maxSteps: options.maxSteps,
        onStep: options.onStep,
      })
    : arm === 1
      ? perActionOutline(task, options)
      : visionFirst(task, options);
