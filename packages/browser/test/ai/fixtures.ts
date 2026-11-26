// A model that answers from a script, and the browser tools in a plain effect/ai loop, as any loop
// may run them: each request is the thread so far and the pictures for the coming turn, which the
// thread never keeps.
import { Effect } from "effect";
import { LanguageModel, Prompt, type Response, type Tool, type Toolkit } from "effect/ai";

import { Pictures } from "../../src/ai/BrowserTools.ts";
import * as TestModel from "../../src/testing/TestModel.ts";

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

  return { layer, prompts };
};

/** The task to the model's answer, one call at a time, in the order the model made them. */
export const loop = <Tools extends Record<string, Tool.Any>>(
  toolkit: Toolkit.Toolkit<Tools>,
  task: string,
) =>
  Effect.gen(function* () {
    const pictures = yield* Pictures;
    let thread = Prompt.make(task);

    for (;;) {
      const response = yield* LanguageModel.generateText({
        prompt: Prompt.concat(thread, yield* pictures.next),
        toolkit,
        concurrency: 1,
      });

      thread = Prompt.concat(thread, Prompt.fromResponseParts(response.content));
      if (response.toolCalls.length === 0) return response.text;
    }
  });
