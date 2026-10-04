/**
 * A browser agent: a language model with the browser tools, called in a loop until it reports
 * an answer with `done` or stops with `give_up`.
 *
 * Any `effect/ai` `LanguageModel` drives it. Tool calls run one at a time, in the order the model
 * made them. Pictures the tools take go to the model in a user message after the tool results.
 * Only the latest few stay in the conversation: older ones are replaced by a note, several at a
 * time, so a provider's prompt cache keeps most of the conversation between steps.
 *
 * @since 0.3.0
 */
import { Effect, Option, Ref, Schema } from "effect";
import { type AiError, Chat, type LanguageModel, Prompt, Tool, Toolkit } from "effect/ai";

import type { Browser } from "./Browser.ts";
import type { BrowserError } from "./BrowserError.ts";
import * as Tools from "./Tools.ts";

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

export class AgentError extends Schema.TaggedError<AgentError>()("AgentError", {
  reason: Schema.Union([StepLimit, GaveUp]),
  steps: Schema.Finite,
}) {
  override get message() {
    return this.reason.message;
  }
}

export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens the provider read from its prompt cache, included in `inputTokens`. */
  readonly cachedInputTokens: number;
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
  readonly usage: Usage;
}

export interface Result<A> {
  readonly answer: A;
  readonly steps: number;
  readonly usage: Usage;
  /** The whole conversation, for logs and for picking a run up later. */
  readonly history: Prompt.Prompt;
}

export interface Options {
  /** Model calls before stopping with `StepLimit`. Defaults to 30. */
  readonly maxSteps?: number | undefined;
  /** More guidance for the system prompt, such as a site's rules or what matters in the task. */
  readonly instructions?: string | undefined;
  /** Pictures kept in the conversation. Defaults to 3. */
  readonly keepPictures?: number | undefined;
  /** Show the model a picture of the page at the start, as well as a snapshot. Defaults to false. */
  readonly startWithScreenshot?: boolean | undefined;
  readonly tools?: Tools.Options | undefined;
  /** Runs after every model call. */
  readonly onStep?: ((step: Step) => Effect.Effect<void>) | undefined;
}

const system = (instructions: string | undefined) =>
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
    "- If an action fails and says it may have taken effect, look at the page before you repeat it.",
    "- Work on your own. Do not ask the user anything; if something blocks you, try another way.",
    "- When the task is done, call done with the answer. If it cannot be done, call give_up with the reason.",
    ...(instructions === undefined ? [] : ["", instructions]),
  ].join("\n");

const isPicture = (part: Prompt.UserMessagePart) =>
  part.type === "file" && part.mediaType.startsWith("image/");

/** Replace all but the latest `keep` pictures with a note, once there are twice that many. */
const prunePictures = (prompt: Prompt.Prompt, keep: number): Prompt.Prompt => {
  const total = prompt.content.reduce(
    (count, message) =>
      count + (message.role === "user" ? message.content.filter(isPicture).length : 0),
    0,
  );

  if (total <= Math.max(keep * 2, 1)) return prompt;
  let remove = total - keep;

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

const picturesMessage = (pictures: ReadonlyArray<Tools.Picture>) =>
  Prompt.makeMessage("user", {
    content: pictures.flatMap((picture) => [
      Prompt.makePart("text", { text: picture.caption }),
      Prompt.makePart("file", { mediaType: picture.image.mediaType, data: picture.image.data }),
    ]),
  });

const addUsage = (
  total: Usage,
  usage: {
    readonly inputTokens: {
      readonly total?: number | undefined;
      readonly cacheRead?: number | undefined;
    };
    readonly outputTokens: { readonly total?: number | undefined };
  },
): Usage => ({
  inputTokens: total.inputTokens + (usage.inputTokens.total ?? 0),
  outputTokens: total.outputTokens + (usage.outputTokens.total ?? 0),
  cachedInputTokens: total.cachedInputTokens + (usage.inputTokens.cacheRead ?? 0),
});

const loop = (
  answerSchema: Schema.Codec<unknown, unknown>,
  task: string,
  options: Options,
): Effect.Effect<
  Result<unknown>,
  AgentError | AiError.AiError | BrowserError,
  Browser | LanguageModel.LanguageModel
> =>
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
    });

    const GiveUp = Tool.make("give_up", {
      description: "Stop because the task cannot be done, and say why.",
      parameters: Schema.Struct({ reason: Schema.String }),
      success: Schema.String,
    });

    const AgentToolkit = Toolkit.merge(Tools.BrowserToolkit, Toolkit.make(Done, GiveUp));

    const toolkit = yield* AgentToolkit.pipe(
      Effect.provide(
        AgentToolkit.toLayer({
          ...tools.handlers,
          done: ({ answer }) => Ref.set(outcome, Option.some({ answer })).pipe(Effect.as("Done.")),
          give_up: ({ reason }) =>
            Ref.set(outcome, Option.some({ reason })).pipe(Effect.as("Stopped.")),
        }),
      ),
    );

    const tab = yield* tools.page;

    const opening = yield* tab.snapshot({ maxChars: options.tools?.snapshotChars ?? 8000 }).pipe(
      Effect.map((snapshot) => snapshot.rendered),
      Effect.orElseSucceed(() => "(the page could not be read)"),
    );

    const chat = yield* Chat.fromPrompt([
      { role: "system", content: system(options.instructions) },
      { role: "user", content: `${task}\n\nThe browser is on this page:\n${opening}` },
    ]);

    let next: Array<Prompt.Message> = [];
    let usage: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
    let idle = 0;

    if (options.startWithScreenshot === true) {
      const image = yield* tab.screenshot().pipe(Effect.option);

      if (Option.isSome(image)) {
        next = [
          picturesMessage([
            { image: image.value, caption: "Screenshot of the page at the start." },
          ]),
        ];
      }
    }

    for (let step = 1; step <= maxSteps; step++) {
      const response = yield* chat.generateText({
        prompt: Prompt.fromMessages(next),
        toolkit,
        concurrency: 1,
      });

      const stepUsage = addUsage(
        { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
        response.usage,
      );

      usage = addUsage(usage, response.usage);
      if (options.onStep !== undefined) {
        yield* options.onStep({
          step,
          text: response.text,
          calls: response.toolCalls.map((call) => ({ name: call.name, params: call.params })),
          results: response.toolResults.map((result) => ({
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

        return { answer: finished.value.answer, steps: step, usage, history };
      }

      if (response.toolCalls.length === 0) {
        idle += 1;
        if (idle >= 3) {
          return yield* new AgentError({
            reason: new GaveUp({ reason: `stopped calling tools: ${response.text}` }),
            steps: step,
          });
        }
        next = [
          Prompt.makeMessage("user", {
            content: [
              Prompt.makePart("text", {
                text: "Continue with the tools, or call done with the answer.",
              }),
            ],
          }),
        ];
        continue;
      }
      idle = 0;
      const pictures = yield* tools.takePictures;

      next = pictures.length === 0 ? [] : [picturesMessage(pictures)];
      yield* Ref.update(chat.history, (history) => prunePictures(history, keepPictures));
    }

    return yield* new AgentError({ reason: new StepLimit({ steps: maxSteps }), steps: maxSteps });
  });

/** Run a task to its end. The answer is a string. */
export function run(
  task: string,
  options?: Options,
): Effect.Effect<
  Result<string>,
  AgentError | AiError.AiError | BrowserError,
  Browser | LanguageModel.LanguageModel
>;

/** Run a task to its end, with an answer of the given shape. */
export function run<A, I>(
  task: string,
  options: Options & { readonly answer: Schema.Codec<A, I> },
): Effect.Effect<
  Result<A>,
  AgentError | AiError.AiError | BrowserError,
  Browser | LanguageModel.LanguageModel
>;

export function run(
  task: string,
  options: Options & { readonly answer?: Schema.Codec<unknown, unknown> } = {},
) {
  return loop(options.answer ?? Schema.String, task, options).pipe(Effect.withSpan("Agent.run"));
}
