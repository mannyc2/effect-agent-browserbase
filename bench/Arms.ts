// The arms of the paired experiment: which tools a Yielded agent drives a task's page with, and
// what it sees. Arm 5 is the library's default: `act` in batches, the control tools, the pointer
// tools and a screenshot before each turn. Arm 1 is the ref and control tools alone, as Yielded
// once gave them: one action per `act`, an outline after each, and no pictures. Arm 2 sees a
// screenshot before each turn and acts by pixels. Arm 6 is arm 5 with moments in its thread instead
// of the screenshot: after each turn's results, what the page did since the turn before. Arm 7 is
// arm 5 with its tools behind one Code Mode tool, `browser_program`: the model writes a program
// whose `browser.*` calls are those tools. Arm 8 has both: arm 5's tools and the program tool.
// Understand tasks differ only in arm 1, whose moments add the outline.
import { Agent, AgentRuntime, CodeMode, InMemory, type RunEvent } from "@yielded/agent";
import { inProcessCodeExecutorLayer } from "@yielded/agent-testing/code-executor-substitute";
import { CodeExecutionLimits } from "@yielded/agent/code-executor";
import { Duration, Effect, Layer, Schema, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/BrowserTools";
import type * as Moment from "effect-browser/Moment";
import type { Page } from "effect-browser/Page";
import { type LanguageModel, type Model, Tool, Toolkit } from "effect/ai";

export const arms = [1, 2, 5, 6, 7, 8] as const;

export type Arm = (typeof arms)[number];

export const armNames: { readonly [A in Arm]: string } = {
  1: "Yielded's tools alone",
  2: "vision first",
  5: "default",
  6: "moments",
  7: "programs",
  8: "programs and tools",
};

/** Token counts, as the run or the model's response reported them. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input read from the provider's cache, where the response says. */
  readonly cachedInputTokens?: number | undefined;
}

/** One model turn and the tool calls it made, for a recording. */
export interface Step {
  readonly step: number;
  /** What the model said alongside its tool calls. */
  readonly text: string;
  readonly calls: ReadonlyArray<{ readonly name: string; readonly params: unknown }>;
  readonly results: ReadonlyArray<{
    readonly name: string;
    readonly result: unknown;
    readonly isFailure: boolean;
  }>;
}

/** The model said the task cannot be done. */
export class GaveUp extends Schema.TaggedError<GaveUp>()("GaveUp", { reason: Schema.String }) {}

/** The run used every turn or tool call its policy allows without an answer. */
export class StepLimit extends Schema.TaggedError<StepLimit>()("StepLimit", {
  detail: Schema.String,
}) {}

/** The model's output could not stand as a turn or an answer, as the runtime refused it. */
export class Unanswered extends Schema.TaggedError<Unanswered>()("Unanswered", {
  detail: Schema.String,
}) {}

/** How an operate task ended without an answer, as the bench grades it. */
export const isUnanswered = Schema.is(Schema.Union([GaveUp, StepLimit, Unanswered]));

export interface OperateOptions<A, I> {
  readonly answer: Schema.Codec<A, I>;
  readonly maxSteps: number;
  readonly onStep: (step: Step) => Effect.Effect<void>;
  /** In arm 6, called with each moment as the model is first shown it. */
  readonly onMoment?: ((moment: Moment.Moment) => Effect.Effect<void>) | undefined;
  /** Who the agent is to whoever watches it, added to its instructions. */
  readonly persona?: string | undefined;
}

/** Whether an arm's moments carry the page's outline: only arm 1's, as the library's default leaves it out. */
export const outline = (arm: Arm): boolean => arm === 1;

const closing = [
  "- If an action fails and says it may have taken effect, look at the page before you repeat it.",
  "- Work on your own. Do not ask the user anything; if something blocks you, try another way.",
  "- When the task is done, call done with the answer. If it cannot be done, call give_up with the reason.",
];

const instructions: { readonly [A in Arm]: string } = {
  1: [
    "You operate a web browser through tools to complete the user's task.",
    "- observe reads the viewport as an outline whose controls carry refs such as e12; act clicks, fills or selects one of them and answers with the next outline.",
    "- inspect narrows the outline to a CSS selector; scroll, wait, navigate and press do what they say.",
    ...closing,
  ].join("\n"),
  2: [
    "You operate a web browser through tools to complete the user's task.",
    "- Before each turn you see a screenshot of the viewport. Its pixel coordinates are viewport coordinates: act with x and y.",
    "- zoom crops a small region, shown before your next turn at the viewport's own scale; keep using viewport coordinates for clicks.",
    "- Click a field before typing into it. To choose from a drop-down, click it, then type the option's label or use the arrow keys, and press Enter.",
    "- Batch two or more predictable steps in one turn. Calls run in order and stop at the first failure.",
    ...closing,
  ].join("\n"),
  5: [
    "You operate a web browser through tools to complete the user's task.",
    "- Before each turn you see a screenshot of the viewport. Its pixel coordinates are viewport coordinates, which click_at, hover, drag and zoom take: use them for what has no ref, such as a canvas game or a chart.",
    "- observe reads the viewport as an outline whose controls carry refs such as e12; act clicks, fills or selects them, up to eight in one call, and answers with the next outline and what followed.",
    "- Prefer refs where the outline has them.",
    ...closing,
  ].join("\n"),
  6: [
    "You operate a web browser through tools to complete the user's task.",
    "- After each turn you are shown what the page did since the turn before: what happened and changed, with screenshots and their times, the last one the page now. Older screenshots are dropped; what happened stays.",
    "- Screenshot pixel coordinates are viewport coordinates, which click_at, hover, drag and zoom take: use them for what has no ref, such as a canvas game or a chart.",
    "- observe reads the viewport as an outline whose controls carry refs such as e12; act clicks, fills or selects them, up to eight in one call, and answers with the next outline and what followed.",
    "- Prefer refs where the outline has them.",
    ...closing,
  ].join("\n"),
  7: [
    "You operate a web browser to complete the user's task by writing programs for browser_program.",
    "- Before each turn you see a screenshot of the viewport. Its pixel coordinates are viewport coordinates, which browser.click_at, hover, drag and zoom take: use them for what has no ref, such as a canvas game or a chart.",
    "- browser.observe reads the viewport as an outline whose controls carry refs such as e12, with the controls as values; browser.act clicks, fills or selects them, up to eight in one call, and answers with the next outline and what followed.",
    "- A program can find a control in an observation, act on it, check what followed and go on. Its calls run one at a time, in order.",
    "- Only what a program returns or logs reaches you, with the screenshot before your next turn: return what you need to decide what comes next.",
    "- Prefer refs where the outline has them. done and give_up are tools of their own, not program calls.",
    ...closing,
  ].join("\n"),
  8: [
    "You operate a web browser through tools to complete the user's task.",
    "- Before each turn you see a screenshot of the viewport. Its pixel coordinates are viewport coordinates, which click_at, hover, drag and zoom take: use them for what has no ref, such as a canvas game or a chart.",
    "- observe reads the viewport as an outline whose controls carry refs such as e12; act clicks, fills or selects them, up to eight in one call, and answers with the next outline and what followed.",
    "- browser_program runs a program whose browser.* calls are these same tools, one at a time, in order: use it for several steps that depend on each other, such as finding a control in an observation and acting on it. Only what the program returns or logs reaches you.",
    "- Prefer refs where the outline has them.",
    ...closing,
  ].join("\n"),
};

const finishing = <A, I>(answer: Schema.Codec<A, I>) =>
  Toolkit.make(
    Tool.make("done", {
      description: "Finish the task and report the answer.",
      parameters: Schema.Struct({ answer }),
      success: Schema.Void,
    }),
    Tool.make("give_up", {
      description: "Stop because the task cannot be done, and say why.",
      parameters: Schema.Struct({ reason: Schema.String }),
      success: Schema.Void,
    }),
  );

const { tools: control } = BrowserTools.Control;
const { tools: pointer } = BrowserTools.Pointer;
const single = BrowserTools.make({ mode: "single" });
const batched = BrowserTools.make();

// Arm 5's tools act on one page, so a program's calls run one at a time. The executor runs the
// model's program in the bench's own process, isolated by nothing but shadowed globals: the bench's,
// not a sandbox for untrusted hosts.
const program = CodeMode.make("browser_program", {
  description:
    "Operate the browser by writing a program whose browser.* calls are the browser tools, run one at a time, in order, on the current tab.",
  tools: { browser: batched.toolkit.tools },
  limits: CodeExecutionLimits.make({
    maxSourceBytes: 64 * 1024,
    maxWallTime: Duration.seconds(90),
    maxLogBytes: 64 * 1024,
    maxResultBytes: 256 * 1024,
    maxHostCalls: 64,
    maxHostCallConcurrency: 1,
    maxHostCallArgumentBytes: 64 * 1024,
    maxHostCallResultBytes: 1024 * 1024,
  }),
});

// Every arm serves the program tool over its tools, which it calls by name; only arms 7 and 8 show
// it to the model.
const programs = program.handlers.pipe(Layer.provide(inProcessCodeExecutorLayer));

const VisionToolkit = Toolkit.make(
  control.navigate,
  pointer.back,
  pointer.zoom,
  pointer.click_at,
  pointer.hover,
  pointer.type_text,
  pointer.press_keys,
  pointer.drag,
  pointer.wait_still,
);

/** Each arm's tools, the run's layer, and whether it shows pictures. */
const tooling = {
  1: {
    toolkit: Toolkit.merge(
      Toolkit.make(single.toolkit.tools.observe, single.toolkit.tools.act),
      BrowserTools.Control,
    ),
    tools: single,
    vision: false,
  },
  2: { toolkit: VisionToolkit, tools: batched, vision: true },
  5: { toolkit: batched.toolkit, tools: batched, vision: true },
  6: { toolkit: batched.toolkit, tools: batched, vision: "moments" },
  7: { toolkit: Toolkit.make(program.tool), tools: batched, vision: true },
  8: {
    toolkit: Toolkit.merge(batched.toolkit, Toolkit.make(program.tool)),
    tools: batched,
    vision: true,
  },
} as const;

/**
 * A turn's steps from the run's events: its text, its calls and their results. A turn completes
 * when the model finishes it, before its tools run, so a step is reported at the next turn's
 * start or when the run ends.
 */
const steps = (onStep: (step: Step) => Effect.Effect<void>) => {
  let pending:
    | {
        step: number;
        text: string;
        calls: Array<Step["calls"][number]>;
        results: Array<Step["results"][number]>;
      }
    | undefined;

  const flush = Effect.suspend(() => {
    const step = pending;

    pending = undefined;

    return step === undefined ? Effect.void : onStep(step);
  });

  const record = (event: RunEvent.RunEvent) => {
    if (event._tag === "TurnStarted") {
      return flush.pipe(
        Effect.andThen(
          Effect.sync(() => {
            pending = { step: event.turn, text: "", calls: [], results: [] };
          }),
        ),
      );
    }

    const step = pending;

    if (step === undefined) return Effect.void;

    if (event._tag === "TextDelta") step.text += event.text;
    else if (event._tag === "ToolCallDeclared")
      step.calls.push({ name: event.toolName, params: event.parameters });
    else if (event._tag === "ToolCallSucceeded")
      step.results.push({ name: event.toolName, result: event.result, isFailure: false });
    else if (event._tag === "ToolCallFailed")
      step.results.push({ name: event.toolName, result: event.message, isFailure: true });

    return Effect.void;
  };

  return { record, flush };
};

/** Run an operate task on its page in one arm, to its answer, `GaveUp` or `Unanswered`. */
export const operate = <A, I>(arm: Arm, page: Page, task: string, options: OperateOptions<A, I>) =>
  Effect.gen(function* () {
    const { toolkit, tools, vision } = tooling[arm];
    const finish = finishing(options.answer);

    const agent = Agent.make(`bench-arm-${arm}`, {
      input: Schema.String,
      output: options.answer,
      instructions:
        options.persona === undefined
          ? instructions[arm]
          : `${instructions[arm]}\n${options.persona}`,
      toolkit: Toolkit.merge(finish, toolkit),
      policy: {
        maxTurns: options.maxSteps,
        maxToolCalls: options.maxSteps * 8,
        maxDuration: "15 minutes",
        toolConcurrency: 1,
      },
      completion: { tool: "done", project: ({ parameters }) => parameters.answer },
    });

    const { record, flush } = steps(options.onStep);
    let completed: RunEvent.RunCompleted | undefined;
    let gaveUp: string | undefined;

    yield* AgentRuntime.stream(agent, task).pipe(
      // Yielded completes a run by its one completion tool, `done`; giving up ends the trial here.
      Stream.takeUntil(
        (event) => event._tag === "ToolCallSucceeded" && event.toolName === "give_up",
      ),
      Stream.runForEach((event) =>
        event._tag === "RunCompleted"
          ? Effect.sync(() => {
              completed = event;
            })
          : record(event),
      ),
      // A spent turn or tool-call allowance and a refused output are the model's; everything else
      // that stops a run stays what it is.
      Effect.catchTags({
        AgentPolicyError: (error) => Effect.fail(new StepLimit({ detail: error.message })),
        ModelProtocolError: (error) => Effect.fail(new Unanswered({ detail: error.message })),
      }),
      Effect.provide(
        Layer.mergeAll(
          Layer.provideMerge(
            programs,
            tools.layer({ page }, { task, vision, onMoment: options.onMoment }),
          ),
          finish.toLayer({
            done: () => Effect.void,
            give_up: ({ reason }) =>
              Effect.sync(() => {
                gaveUp = reason;
              }),
          }),
          InMemory.layer,
        ),
      ),
      Effect.ensuring(flush),
    );

    if (gaveUp !== undefined) return yield* new GaveUp({ reason: gaveUp });
    if (completed === undefined)
      return yield* new Unanswered({ detail: "the run ended without completing" });

    const answer = yield* Schema.decodeUnknownEffect(options.answer)(completed.output).pipe(
      Effect.mapError((error) => new Unanswered({ detail: error.message })),
    );

    const usage = completed.usage;

    return {
      answer,
      steps: completed.turns,
      usage: { inputTokens: usage?.inputTokens ?? 0, outputTokens: usage?.outputTokens ?? 0 },
    };
  });

/** What a run needs besides its page: the model, as the bench's runner provides it. */
export type Requirements = LanguageModel.LanguageModel | Model.ProviderName | Model.ModelName;

/** How a run can fail without a page or a provider to blame: see `isUnanswered`. */
export type OperateError = Effect.Error<ReturnType<typeof operate<unknown, unknown>>>;
