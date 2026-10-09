// Models that answer from a script, for the bench's tests: no model is called. A script's turn is a
// response's parts; an agent's run, which streams, gets them as a stream that sent everything at
// once, and a single call, such as an understand task's, gets them whole.
import { Effect, Layer, Stream } from "effect";
import {
  type AiError,
  LanguageModel,
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

/** A response's parts as a stream sends them. */
export const streamed = (
  parts: ReadonlyArray<Response.PartEncoded>,
): ReadonlyArray<Response.StreamPartEncoded> =>
  parts.flatMap((part, order): ReadonlyArray<Response.StreamPartEncoded> =>
    part.type === "text"
      ? [
          { type: "text-start", id: `text-${order}` },
          { type: "text-delta", id: `text-${order}`, delta: part.text },
          { type: "text-end", id: `text-${order}` },
        ]
      : part.type === "tool-call" || part.type === "finish"
        ? [part]
        : [],
  );

/**
 * A model from how it answers one call, which an agent's run gets as a stream that sent everything
 * at once, named as Yielded's runtime asks.
 */
export const modelOf = (
  answer: (
    options: LanguageModel.ProviderOptions,
  ) => Effect.Effect<ReadonlyArray<Response.PartEncoded>, AiError.AiError>,
) =>
  Model.make(
    "scripted",
    "test-model",
    Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) => Effect.map(answer(options), (parts) => [...parts]),
        streamText: (options) => Stream.fromIterableEffect(Effect.map(answer(options), streamed)),
      }),
    ),
  );

/** A model that answers each call with the next turn of its script, and keeps what it was shown. */
export const scripted = (turns: ReadonlyArray<Turn>) => {
  const seen: Array<Seen> = [];

  const layer = modelOf((options) =>
    Effect.suspend(() => {
      const turn = turns[seen.length];

      seen.push({ prompt: options.prompt, tools: options.tools });

      return turn === undefined
        ? Effect.die(`no turn ${seen.length} in the script`)
        : Effect.succeed(turn(options.prompt));
    }),
  );

  return { layer, seen };
};

let ids = 0;

/** A tool call in a scripted response. */
export const call = (name: string, params: unknown): Response.PartEncoded => {
  ids += 1;

  return { type: "tool-call", id: `call-${ids}`, name, params };
};

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
