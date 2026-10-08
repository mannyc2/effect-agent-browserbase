/**
 * A browser agent: a language model with the browser tools, called in a loop until it reports
 * an answer with `done` or stops with `give_up`.
 *
 * Any `effect/ai` `LanguageModel` drives it. Tool calls run one at a time, in the order the model
 * made them, halting on failure or completion. One observation follows each turn, and a run whose
 * browser is gone fails with that `BrowserError`. Pictures travel in a user message after the
 * tool results. Only the latest few stay in the conversation: older ones are replaced by a note,
 * several at a time, so a provider's prompt cache keeps most of the conversation between steps.
 *
 * @since 0.3.0
 */
import { Context, Effect, Exit, Option, Ref, Schema } from "effect";
import { AiError, Chat, type LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";

import { Browser } from "./Browser.ts";
import type { BrowserError } from "./BrowserError.ts";
import * as Usage from "./internal/agent/usage.ts";
import type { Observation, ObservationMode, Zoom } from "./Page.ts";
import * as Policy from "./Policy.ts";
import * as Tools from "./Tools.ts";

export type { Usage } from "./internal/agent/usage.ts";

/** The model used every step it was given without finishing. */
export class StepLimit extends Schema.TaggedError<StepLimit>()("StepLimit", {
  steps: Schema.Finite,
}) {
  override get message() {
    return `the task was not finished in ${this.steps} steps`;
  }
}

/** The model said the task cannot be done, or stopped calling tools. */
export class GaveUp extends Schema.TaggedError<GaveUp>()("GaveUp", {
  reason: Schema.String,
}) {
  override get message() {
    return `the agent gave up: ${this.reason}`;
  }
}

/** The input policy refused three actions in a row: the task needs what the policy forbids. */
export class Refused extends Schema.TaggedError<Refused>()("Refused", {
  refusals: Schema.Array(Schema.String),
}) {
  override get message() {
    return `the input policy refused ${this.refusals.length} actions in a row; the last: ${this.refusals.at(-1)}`;
  }
}

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  reason: Schema.Union([StepLimit, GaveUp, Refused]),
  steps: Schema.Finite,
}) {
  override get message() {
    return this.reason.message;
  }
}

/** One model call and the tool calls it made, for logging, narration or a live view. */
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
  readonly usage: Usage.Usage;
  /**
   * Set when the model's response could not be read, such as a call to a tool that does not exist
   * or arguments that are not JSON. None of its calls ran, the model is asked to try again, and
   * its usage is not reported.
   */
  readonly rejected?: string | undefined;
}

export interface Result<A> {
  readonly answer: A;
  readonly steps: number;
  readonly usage: Usage.Usage;
  /** The whole conversation, for logs and for picking a run up later. */
  readonly history: Prompt.Prompt;
}

/** Tools a caller adds. `done` and `give_up` end the run, so they remain the agent's own. */
type ExtraTools = Record<string, Tool.Any> & { readonly done?: never; readonly give_up?: never };

export interface Options<E = never, Extra extends ExtraTools = {}, R = never> {
  /** Model calls before stopping with `StepLimit`. Defaults to 30. */
  readonly maxSteps?: number | undefined;
  /** More guidance for the system prompt, such as a site's rules or what matters in the task. */
  readonly instructions?: string | undefined;
  /** Pictures kept in the conversation. Defaults to 3. */
  readonly keepPictures?: number | undefined;
  /** What the model sees initially and after each turn. Defaults to both. */
  readonly observation?: ObservationMode | undefined;
  /**
   * Additional tools; their definitions and handlers take precedence over a browser tool of the
   * same name. They cannot be named `done` or `give_up`.
   */
  readonly additionalTools?: Toolkit.Toolkit<Extra> | undefined;
  readonly tools?: Tools.Options | undefined;
  /**
   * Runs after every model call. Failing stops the run with that error, such as a spent budget.
   * The services it needs become the run's requirements.
   */
  readonly onStep?: ((step: Step) => Effect.Effect<void, E, R>) | undefined;
}

const system = (instructions: string | undefined) =>
  [
    "You operate a web browser through tools to complete the user's task.",
    "",
    "Seeing the page:",
    "- browser_snapshot gives a text outline of the viewport. Controls carry refs such as e12 for the other tools. Refs from an old snapshot can be stale.",
    "- The observation after each turn shows the viewport as an outline, a picture, or both. The full screenshot uses viewport coordinates: use x and y for anything without a ref, such as a canvas game, a chart or a video.",
    "- browser_zoom crops a small viewport region and shows it on its own after the batch, at the viewport's own CSS pixel scale: a closer look, not a magnification. Its caption gives the viewport origin; keep using viewport coordinates for clicks.",
    "- Tool calls return receipts. One fresh observation follows the whole batch.",
    "",
    "Acting:",
    "- Prefer refs when an outline is available. Use x and y for what the outline cannot show.",
    "- Batch two or more predictable steps in one turn. Calls run in order and stop at the first failure; remaining calls are not executed. Coordinates in a batch refer to the observation before it.",
    "- If an action fails and says it may have taken effect, look at the page before you repeat it.",
    "- The input policy decides for the user. When it refuses an action, do not try another way to the same effect. Three refusals in a row end the task.",
    "- Work on your own. Do not ask the user anything; if something blocks you, try another way.",
    "- When the task is done, call done with the answer. If it cannot be done, call give_up with the reason.",
    ...(instructions === undefined ? [] : ["", instructions]),
  ].join("\n");

const isPicture = (part: Prompt.UserMessagePart) =>
  part.type === "file" && part.mediaType.startsWith("image/");

/** Prune older pictures in groups while keeping every picture in the current observation. */
const prunePictures = (prompt: Prompt.Prompt, keep: number): Prompt.Prompt => {
  const total = prompt.content.reduce(
    (count, message) =>
      count + (message.role === "user" ? message.content.filter(isPicture).length : 0),
    0,
  );

  const current = prompt.content.at(-1);
  const latest = current?.role === "user" ? current.content.filter(isPicture).length : 0;

  // All pictures from this observation must reach the model at least once, including requested crops.
  const retain = Math.max(keep, latest);

  if (total <= Math.max(retain * 2, 1)) return prompt;
  let remove = total - retain;

  return Prompt.fromMessages(
    prompt.content.map((message) => {
      if (message.role !== "user" || remove === 0 || !message.content.some(isPicture))
        return message;

      return Prompt.makeMessage("user", {
        content: message.content.map((part) => {
          if (remove === 0 || !isPicture(part)) return part;
          remove -= 1;

          return Prompt.makePart("text", { text: "(an earlier screenshot was removed)" });
        }),
      });
    }),
  );
};

/**
 * Model output that could not be read: `effect/ai`'s decoding of the response, which fails on a
 * call to a tool that does not exist, or an adapter's parsing of a call's arguments. Both happen
 * before any handler runs, and the batch answers every handler failure as a result, so nothing
 * in such a response ran and the chat leaves its history unchanged. A provider client that cannot
 * decode what its service sent is not the model's to correct: that failure ends the run.
 */
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

/** What the model is told about a response that could not be read. */
const unreadable = (
  reason: AiError.InvalidOutputError | AiError.ToolParameterValidationError,
  tools: ReadonlyArray<string>,
) =>
  reason._tag === "ToolParameterValidationError"
    ? `Your call to ${reason.toolName} could not be read, so none of your last response's tool ` +
      `calls ran: ${reason.description}. Send each call's arguments as one JSON object.`
    : "Your last response could not be read, so none of its tool calls ran. It most likely " +
      `called a tool that does not exist. The tools are: ${tools.join(", ")}.`;

const note = (text: string) =>
  Prompt.makeMessage("user", { content: [Prompt.makePart("text", { text })] });

/**
 * The observation, or why the page could not be observed, and each crop with its tab's number,
 * from one, as the tab list numbers them.
 */
const observationMessage = Effect.fnUntraced(function* (
  observed: Observation | string,
  zooms: ReadonlyArray<Zoom>,
) {
  const open = yield* (yield* Browser).pages;
  const image = typeof observed === "string" ? undefined : observed.image;

  const content: Array<Prompt.UserMessagePart> = [
    Prompt.makePart("text", {
      text:
        typeof observed === "string"
          ? `(the page could not be observed: ${observed})`
          : (observed.snapshot?.rendered ?? "Observation of the current viewport."),
    }),
  ];

  if (image !== undefined) {
    content.push(
      Prompt.makePart("text", {
        text: `Screenshot: ${image.width}x${image.height}. Its pixel coordinates are viewport coordinates.`,
      }),
      Prompt.makePart("file", { mediaType: image.mediaType, data: image.data }),
    );
  }

  for (const zoom of zooms) {
    const tab = open.findIndex((page) => page.id === zoom.page) + 1;

    content.push(
      Prompt.makePart("text", {
        text: `Zoom from ${tab === 0 ? "a tab since closed" : `tab ${tab}`}: viewport origin (${zoom.region.x}, ${zoom.region.y}), ${zoom.region.width}x${zoom.region.height} CSS pixels. Captured when browser_zoom ran. Add this origin to image coordinates for viewport clicks.`,
      }),
      Prompt.makePart("file", { mediaType: zoom.image.mediaType, data: zoom.image.data }),
    );
  }

  return Prompt.makeMessage("user", { content });
});

const loop = <E, Extra extends ExtraTools, R>(
  answerSchema: Schema.Codec<unknown, unknown>,
  task: string,
  options: Options<E, Extra, R>,
) =>
  Effect.gen(function* () {
    const tools = yield* Tools.make(options.tools);
    const maxSteps = options.maxSteps ?? 30;
    const keepPictures = options.keepPictures ?? 3;

    const outcome = yield* Ref.make(
      Option.none<{ readonly answer: unknown } | { readonly reason: string }>(),
    );

    const Done = Tool.make("done", {
      description: "Finish the task and report the answer.",
      parameters: Schema.Struct({ answer: answerSchema }),
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
    const AgentToolkit = Toolkit.merge(Tools.BrowserToolkit, Completion);

    // Merged last, completion stays the agent's even when the types are bypassed.
    const CombinedToolkit = Toolkit.merge(
      Tools.BrowserToolkit,
      options.additionalTools ?? Toolkit.empty,
      Completion,
    );

    const defaults = yield* AgentToolkit.toHandlers({
      ...tools.handlers,
      done: ({ answer }) => Ref.set(outcome, Option.some({ answer })).pipe(Effect.as("Done.")),
      give_up: ({ reason }) =>
        Ref.set(outcome, Option.some({ reason })).pipe(Effect.as("Stopped.")),
    });

    const supplied = yield* Effect.context<Tool.HandlersFor<Extra>>();

    const completion = new Set([Done.id, GiveUp.id]);

    const overrides = Object.values(options.additionalTools?.tools ?? {})
      .filter((tool) => !completion.has(tool.id))
      .map((tool) => Context.Service<Tool.HandlersFor<Extra>>(tool.id));

    // Only explicitly added tools override defaults; unrelated ambient handlers must not replace them.
    const toolkit = yield* CombinedToolkit.pipe(
      Effect.provideContext(Context.merge(supplied, Context.omit(...overrides)(defaults))),
    );

    const observe = Effect.gen(function* () {
      const zooms = yield* tools.takeZooms;
      // Without any page, such as after the browser closed, more model calls cannot help.
      const page = yield* tools.page;

      const observed = yield* page
        .observe({
          mode: options.observation ?? "both",
          maxChars: options.tools?.snapshotChars ?? 8000,
        })
        .pipe(Effect.catch((error) => Effect.succeed(error.message)));

      return yield* observationMessage(observed, zooms);
    });

    const opening = yield* observe;

    const chat = yield* Chat.fromPrompt([
      { role: "system", content: system(options.instructions) },
      { role: "user", content: task },
      opening,
    ]);

    let next: Array<Prompt.Message> = [];
    let usage = Usage.empty;
    let idle = 0;

    /** One model call, its tool calls and the observation after them; the result if it ends. */
    const takeStep = (step: number) =>
      Effect.gen(function* () {
        const response = yield* chat
          .generateText({
            prompt: Prompt.fromMessages(next),
            ...(yield* Tools.batch(toolkit, { endsBatch: ["done", "give_up"] })),
          })
          .pipe(
            Effect.map((turn) => ({ turn })),
            Effect.catchIf(isUnreadable, (error) => Effect.succeed({ rejected: error.reason })),
          );

        // A browser that is gone ends the run, but only once the paid turn is reported and the
        // answer it may have given is kept.
        const observed = yield* Effect.exit(observe);

        if (Exit.isSuccess(observed))
          yield* Ref.update(chat.history, (history) =>
            prunePictures(Prompt.concat(history, [observed.value]), keepPictures),
          );

        if ("rejected" in response) {
          yield* Effect.annotateCurrentSpan("rejected", true);
          if (options.onStep !== undefined) {
            yield* options.onStep({
              step,
              text: "",
              calls: [],
              results: [],
              usage: Usage.empty,
              rejected: response.rejected.description,
            });
          }
          if (Exit.isFailure(observed)) return yield* Effect.failCause(observed.cause);
          idle = 0;
          next = [note(unreadable(response.rejected, Object.keys(toolkit.tools)))];

          return Option.none<Result<unknown>>();
        }
        const { turn } = response;
        const stepUsage = Usage.add(Usage.empty, turn.usage);

        usage = Usage.add(usage, turn.usage);
        yield* Effect.annotateCurrentSpan({
          toolCalls: turn.toolCalls.length,
          ...tokens(stepUsage),
        });
        if (options.onStep !== undefined) {
          yield* options.onStep({
            step,
            text: turn.text,
            calls: turn.toolCalls.map((call) => ({ name: call.name, params: call.params })),
            results: turn.toolResults.map((result) => ({
              name: result.name,
              result: result.result,
              isFailure: result.isFailure,
            })),
            usage: stepUsage,
          });
        }

        const finished = yield* Ref.get(outcome);

        if (Option.isSome(finished)) {
          const history = yield* Ref.get(chat.history);

          if ("reason" in finished.value) {
            return yield* new AgentError({
              reason: new GaveUp({ reason: finished.value.reason }),
              steps: step,
            });
          }

          return Option.some<Result<unknown>>({
            answer: finished.value.answer,
            steps: step,
            usage,
            history,
          });
        }
        if (Exit.isFailure(observed)) return yield* Effect.failCause(observed.cause);
        const refusals = yield* tools.refusals;

        // With nobody to ask, an agent that keeps meeting refusals stops rather than probing for
        // a way around them.
        if (refusals.length >= 3)
          return yield* new AgentError({ reason: new Refused({ refusals }), steps: step });

        if (turn.toolCalls.length === 0) {
          idle += 1;
          if (idle >= 3) {
            return yield* new AgentError({
              reason: new GaveUp({ reason: `stopped calling tools: ${turn.text}` }),
              steps: step,
            });
          }
          next = [note("Continue with the tools, or call done with the answer.")];

          return Option.none<Result<unknown>>();
        }
        idle = 0;
        next = [];

        return Option.none<Result<unknown>>();
      }).pipe(
        Effect.withSpan("Agent.step", { attributes: { step } }, { captureStackTrace: false }),
      );

    for (let step = 1; step <= maxSteps; step++) {
      const ended = yield* takeStep(step);

      if (Option.isSome(ended)) return ended.value;
    }

    return yield* new AgentError({ reason: new StepLimit({ steps: maxSteps }), steps: maxSteps });
  });

/** Token counts as OpenTelemetry's GenAI usage attributes. */
const tokens = (usage: Usage.Usage) => ({
  "gen_ai.usage.input_tokens": usage.inputTokens,
  "gen_ai.usage.output_tokens": usage.outputTokens,
});

/**
 * What the additional tools need: their handlers, and the services their schemas and handlers use.
 * A toolkit whose types were bypassed leaves `Extra` as `ExtraTools` itself, and adds nothing.
 */
type ToolServices<Extra extends ExtraTools> = string extends keyof Extra
  ? never
  :
      | Tool.HandlersFor<Extra>
      | Tool.HandlerServices<Extra[keyof Extra]>
      | Tool.ParametersEncodingServices<Extra[keyof Extra]>
      | Tool.ResultDecodingServices<Extra[keyof Extra]>;

/**
 * Run a task to its end. The answer is a string.
 *
 * It fails with how the agent ended (`AgentError`), the model's provider, the browser, or
 * `onStep`; an additional tool's failure goes back to the model as a result.
 */
export function run<E = never, Extra extends ExtraTools = {}, R = never>(
  task: string,
  options?: Options<E, Extra, R>,
): Effect.Effect<
  Result<string>,
  AgentError | AiError.AiError | BrowserError | E,
  Browser | LanguageModel.LanguageModel | ToolServices<Extra> | R
>;

/** Run a task to its end, with an answer of the given shape. */
export function run<A, I, E = never, Extra extends ExtraTools = {}, R = never>(
  task: string,
  options: Options<E, Extra, R> & { readonly answer: Schema.Codec<A, I> },
): Effect.Effect<
  Result<A>,
  AgentError | AiError.AiError | BrowserError | E,
  Browser | LanguageModel.LanguageModel | ToolServices<Extra> | R
>;

export function run<E, Extra extends ExtraTools, R>(
  task: string,
  options: Options<E, Extra, R> & { readonly answer?: Schema.Codec<unknown, unknown> } = {},
) {
  return loop(options.answer ?? Schema.String, task, options).pipe(
    Effect.tap((result) =>
      Effect.annotateCurrentSpan({ steps: result.steps, ...tokens(result.usage) }),
    ),
    Effect.provideService(Policy.Task, task),
    // Each step is a child span: its model call, its tool calls and the observation after them.
    Effect.withSpan("Agent.run", {
      attributes: {
        "gen_ai.operation.name": "invoke_agent",
        maxSteps: options.maxSteps ?? 30,
        observation: options.observation ?? "both",
      },
    }),
  );
}
