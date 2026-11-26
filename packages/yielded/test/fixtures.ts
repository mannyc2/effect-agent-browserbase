// A model that answers from a script, as a Yielded agent's model.
import { Effect, Layer } from "effect";
import { TestModel } from "effect-browser/testing";
import { LanguageModel, Model, type Prompt, type Response } from "effect/ai";

/** One prompt-aware response; model ownership and exhaustion come from the public kit. */
export type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;
export const call = TestModel.call;
export const answer = TestModel.text;
export const calling = TestModel.calling;

/** The scripted model, and every prompt it was sent. */
export const scripted = (turns: ReadonlyArray<Turn>) => {
  const prompts: Array<Prompt.Prompt> = [];

  const layer = TestModel.layer(
    turns.map(
      (turn) =>
        ({ prompt }) =>
          Effect.sync(() => TestModel.reply(turn(prompt))),
    ),
    { onRequest: ({ prompt }) => Effect.sync(() => void prompts.push(prompt)) },
  );

  return {
    layer: Model.make(
      "scripted",
      "test-model",
      Layer.effect(LanguageModel.LanguageModel, LanguageModel.LanguageModel).pipe(
        Layer.provide(layer),
      ),
    ),
    prompts,
  };
};
