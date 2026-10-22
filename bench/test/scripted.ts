// Models that answer from a script, for the bench's tests: no model is called. A script's turn is a
// response's parts; an agent's run, which streams, gets them as a stream that sent everything at
// once, and a single call, such as an understand task's, gets them whole.
import { Effect } from "effect";
import { TestModel } from "effect-agent-browser/testing";
import {
  type AiError,
  type LanguageModel,
  Model,
  type Prompt,
  type Response,
  type Tool,
} from "effect/ai";

/** One response, from the prompt it was given. */
export type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;

/** What a model was shown: the prompt, and the tools it could call. */
export interface Seen {
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
}

export const streamed = TestModel.streamed;

export const modelOf = (
  answer: (
    options: LanguageModel.ProviderOptions,
  ) => Effect.Effect<ReadonlyArray<Response.PartEncoded>, AiError.AiError>,
) =>
  Model.make(
    "scripted",
    "test-model",
    TestModel.layer({ respond: (request) => Effect.map(answer(request.options), TestModel.reply) }),
  );

/** A model that answers each call with the next turn of its script, and keeps what it was shown. */
export const scripted = (turns: ReadonlyArray<Turn>) => {
  const seen: Array<Seen> = [];

  const layer = Model.make(
    "scripted",
    "test-model",
    TestModel.layer(
      turns.map(
        (turn) =>
          ({ prompt }) =>
            Effect.sync(() => TestModel.reply(turn(prompt))),
      ),
      { onRequest: ({ prompt, tools }) => Effect.sync(() => void seen.push({ prompt, tools })) },
    ),
  );

  return { layer, seen };
};

export const call = TestModel.call;

/** A response's end, after its tool calls. */
export const finish: Response.PartEncoded = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
};

/** A response that answers with this value as JSON. */
export const answer = (value: unknown): ReadonlyArray<Response.PartEncoded> => [
  { type: "text", text: JSON.stringify(value) },
  { ...finish, reason: "stop" },
];

/** The text a model was shown, tool results included. */
export const textOf = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text"
              ? [part.text]
              : part.type === "tool-result"
                ? [JSON.stringify(part.result)]
                : [],
          ),
    )
    .join("\n");

/** How many pictures a prompt shows. */
export const pictures = (prompt: Prompt.Prompt): number =>
  prompt.content.reduce(
    (count, message) =>
      count +
      (message.role === "user" ? message.content.filter((part) => part.type === "file").length : 0),
    0,
  );
