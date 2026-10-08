// The agent on the real OpenRouter adapter, answered from memory: which failures the model is
// asked to correct and which end the run. No request leaves the process.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Option } from "effect";
import * as Agent from "effect-browser/Agent";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { AiError, LanguageModel } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

const toolCall = (name: string, args: string) => ({
  id: "completion",
  object: "chat.completion",
  created: 0,
  model: "openai/test",
  system_fingerprint: null,
  choices: [
    {
      index: 0,
      finish_reason: "tool_calls",
      message: {
        role: "assistant",
        content: null,
        tool_calls: [{ id: "call-" + name, type: "function", function: { name, arguments: args } }],
      },
    },
  ],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** Run the agent with each request answered by the next body, counting the requests. */
const run = (bodies: ReadonlyArray<unknown>) =>
  Effect.gen(function* () {
    let requests = 0;

    const http = HttpClient.make((request) =>
      Effect.sync(() => {
        const body = bodies[requests];

        requests += 1;

        return HttpClientResponse.fromWeb(
          request,
          new Response(JSON.stringify(body ?? null), {
            headers: { "content-type": "application/json" },
          }),
        );
      }),
    );

    const client = yield* OpenRouterClient.make({}).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    // An OpenAI model, so the tools also pass OpenAI's structured-output codec.
    const model = yield* OpenRouterLanguageModel.make({ model: "openai/test" }).pipe(
      Effect.provideService(OpenRouterClient.OpenRouterClient, client),
    );

    yield* (yield* (yield* Browser).firstPage).goto("data:text/html,<title>Task</title>42");

    const exit = yield* Agent.run("Read the number.", { maxSteps: 5 }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model),
      Effect.exit,
    );

    return { exit, requests };
  }).pipe(Effect.provide(Chromium.layer()));

describe("the agent on the OpenRouter adapter", () => {
  it.live("asks the model again after arguments that are not JSON", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* run([
        toolCall("browser_snapshot", "{not json"),
        toolCall("done", JSON.stringify({ answer: "42" })),
      ]);

      assert.isTrue(Exit.isSuccess(exit));
      assert.strictEqual(Exit.isSuccess(exit) ? exit.value.answer : undefined, "42");
      assert.strictEqual(requests, 2);
    }),
  );

  it.live("ends the run, without asking again, when a reply cannot be decoded", () =>
    Effect.gen(function* () {
      const { exit, requests } = yield* run([
        { error: { message: "upstream provider error", code: 502 } },
      ]);

      const failure = Exit.isFailure(exit)
        ? Option.getOrUndefined(Exit.findErrorOption(exit))
        : undefined;

      assert.isTrue(AiError.isAiError(failure));
      assert.strictEqual(
        AiError.isAiError(failure) ? failure.module : undefined,
        "OpenRouterClient",
      );
      assert.strictEqual(requests, 1);
    }),
  );
});
