// The requests PromptCache's client sends, read back from a client that only records them.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import * as PromptCache from "../src/PromptCache.ts";

const picture = {
  role: "user",
  content: [
    { type: "text", text: "The current tab's viewport." },
    { type: "image_url", image_url: { url: "data:image/jpeg;base64,AA==" } },
  ],
};

const system = { role: "system", content: [{ type: "text", text: "You operate a browser." }] };
const task = { role: "user", content: "Find the cheapest tent." };
const calls = {
  role: "assistant",
  content: null,
  tool_calls: ["a", "b"].map((id) => ({
    id,
    type: "function",
    function: { name: "observe", arguments: "{}" },
  })),
};
const result = (id: string, text: string) => ({ role: "tool", tool_call_id: id, content: text });
const mark = { type: "ephemeral" };

// The model and messages of a request as the recording client receives it.
const sent = (url: string, payload: object) =>
  Effect.gen(function* () {
    const bodies: Array<string> = [];
    const recording = Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) => {
        if (request.body._tag === "Uint8Array")
          bodies.push(new TextDecoder().decode(request.body.body));

        return Effect.succeed(HttpClientResponse.fromWeb(request, new Response("{}")));
      }),
    );

    yield* HttpClient.execute(
      HttpClientRequest.bodyJsonUnsafe(HttpClientRequest.post(url), payload),
    ).pipe(Effect.provide(PromptCache.layer.pipe(Layer.provide(recording))));

    const body = JSON.parse(bodies[0] ?? "null");

    return { model: body.model, messages: body.messages };
  });

const completions = "https://openrouter.ai/api/v1/chat/completions";

describe("PromptCache", () => {
  it.effect(
    "marks the last tool result, or before any the system message, ahead of the picture",
    () =>
      Effect.gen(function* () {
        const first = yield* sent(completions, { model: "m", messages: [system, task, picture] });

        assert.deepStrictEqual(first, {
          model: "m",
          messages: [
            { role: "system", content: [{ ...system.content[0], cache_control: mark }] },
            task,
            picture,
          ],
        });

        const history = [system, task, calls, result("a", "one"), result("b", "two")];
        const later = yield* sent(completions, { model: "m", messages: [...history, picture] });

        assert.deepStrictEqual(later.messages, [
          ...history.slice(0, 4),
          {
            role: "tool",
            tool_call_id: "b",
            content: [{ type: "text", text: "two", cache_control: mark }],
          },
          picture,
        ]);
      }),
  );

  it.effect("leaves other requests and histories with neither as they are", () =>
    Effect.gen(function* () {
      const messages = [system, task, calls, result("a", "one"), picture];

      assert.deepStrictEqual(
        (yield* sent("https://openrouter.ai/api/v1/models", { model: "m", messages })).messages,
        messages,
      );
      assert.deepStrictEqual(
        (yield* sent(completions, { model: "m", messages: [task, picture] })).messages,
        [task, picture],
      );
    }),
  );
});
