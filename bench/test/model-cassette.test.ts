// HTTP cassette replay runs the installed provider's encoding/decoding without model requests.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, it } from "@effect/vitest";
import { ConfigProvider, Effect } from "effect";
import { HttpCassette } from "effect-agent-browser/testing";
import { LanguageModel } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

const scenario = (http: HttpClient.HttpClient) =>
  Effect.gen(function* () {
    const client = yield* OpenRouterClient.make({}).pipe(
      Effect.provideService(HttpClient.HttpClient, http),
    );

    const model = yield* OpenRouterLanguageModel.make({ model: "openai/test" }).pipe(
      Effect.provideService(OpenRouterClient.OpenRouterClient, client),
    );

    return (yield* LanguageModel.generateText({ prompt: "Read the fixture" }).pipe(
      Effect.provideService(LanguageModel.LanguageModel, model),
    )).text;
  });

it.effect(
  "runs the same provider scenario recorded and replayed, with no network during replay",
  () =>
    Effect.gen(function* () {
      let calls = 0;

      const upstream = HttpClient.make((request) =>
        Effect.sync(() => {
          calls++;

          return HttpClientResponse.fromWeb(
            request,
            new Response(
              JSON.stringify({
                id: "fixture",
                object: "chat.completion",
                created: 0,
                model: "openai/test",
                system_fingerprint: "fixture",
                choices: [
                  {
                    index: 0,
                    finish_reason: "stop",
                    message: { role: "assistant", content: "Read it" },
                  },
                ],
                usage: { prompt_tokens: 4, completion_tokens: 3, total_tokens: 7 },
              }),
              { headers: { "content-type": "application/json" } },
            ),
          );
        }),
      );

      const exchanges: Array<HttpCassette.Exchange> = [];

      const record = yield* HttpCassette.make({
        mode: "record",
        http: upstream,
        cap: 1,
        reserve: () => Effect.succeed(1),
        append: (exchange) => Effect.sync(() => void exchanges.push(exchange)),
      });

      assert.strictEqual(yield* scenario(record.http), "Read it");
      const replay = yield* HttpCassette.make({ mode: "replay", exchanges });

      assert.strictEqual(yield* scenario(replay.http), "Read it");
      yield* replay.assertExhausted;
      assert.strictEqual(calls, 1);
    }).pipe(
      Effect.provide(
        ConfigProvider.layer(ConfigProvider.fromUnknown({ EFFECT_BROWSER_BENCH_LIVE: "1" })),
      ),
    ),
);
