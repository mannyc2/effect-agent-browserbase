// One operate task through the real pinned OpenRouter adapter, its budgeted client and a real
// local Chromium. Every HTTP answer is in memory: no credentials and no paid calls.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, Model } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

import { budgetedClient, ledger } from "../Budget.ts";
import type { Trace } from "../Recording.ts";
import { frameHistory, type ModelOptions, tasks } from "../Tasks.ts";
import { classify, isolatedTrial } from "../Trial.ts";

const completion = (message: unknown) => ({
  id: "free-test",
  object: "chat.completion",
  created: 0,
  model: "openai/test",
  system_fingerprint: null,
  choices: [{ index: 0, finish_reason: "tool_calls", message }],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15, cost: 0.001 },
});

const toolCall = (name: string, args: string) =>
  completion({
    role: "assistant",
    content: null,
    tool_calls: [{ id: "call-1", type: "function", function: { name, arguments: args } }],
  });

/**
 * Run chart-trade with a model whose n-th HTTP answer is `answers(n, body)`, optionally narrated
 * every `narrate` with captions sent to `trace`.
 */
const trade = Effect.fnUntraced(function* (
  model: string,
  answers: (request: number, body: string) => unknown,
  narration: Pick<ModelOptions<never>, "narrate" | "trace"> = {},
) {
  const task = tasks.find((candidate) => candidate.name === "chart-trade");

  if (task === undefined) return yield* Effect.die("the bench has no chart-trade task");
  const budget = yield* ledger(10, 0.01);
  const account = yield* budget.account;
  let requests = 0;

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      const body =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";

      const answer = answers(requests, body);

      requests += 1;

      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(answer), { headers: { "content-type": "application/json" } }),
      );
    }),
  );

  const native = yield* OpenRouterClient.make({}).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );

  const language = yield* OpenRouterLanguageModel.make({ model }).pipe(
    Effect.provideService(
      OpenRouterClient.OpenRouterClient,
      budgetedClient(native, account, {
        rates: { input: 1e-6, output: 2e-6 },
        maxOutputTokens: 512,
      }),
    ),
  );

  const exit = yield* isolatedTrial(
    task.withModel({ seed: 23, onUsage: () => Effect.void, ...narration }),
    Chromium.layer({ frameHistory }),
  ).pipe(
    Effect.provide(
      Layer.mergeAll(
        Layer.succeed(LanguageModel.LanguageModel, language),
        Layer.succeed(Model.ProviderName, "openrouter"),
        Layer.succeed(Model.ModelName, model),
      ),
    ),
    Effect.exit,
  );

  const calls = yield* account.calls;

  return {
    outcome: classify(exit, calls),
    detail: Exit.isSuccess(exit) ? exit.value.detail : null,
    calls,
    requests,
    ledger: yield* budget.snapshot,
  };
});

describe("operate trials on the real adapter", () => {
  it.live("reach the provider for an openai/ model and grade its answer", () =>
    Effect.gen(function* () {
      const result = yield* trade("openai/test", () =>
        toolCall("done", JSON.stringify({ answer: { orderId: "ORD-0000" } })),
      );

      // Every tool schema must be one the OpenAI codec accepts, or no request is ever sent.
      assert.strictEqual(result.requests, 1);
      assert.deepStrictEqual(result.outcome, { status: "graded", reason: "answered", pass: false });
    }),
  );

  it.live("grade malformed tool arguments from a decoded, charged response", () =>
    Effect.gen(function* () {
      const result = yield* trade("google/test", () => toolCall("observe", "{not json"));

      assert.isAtLeast(result.requests, 1);
      assert.strictEqual(result.outcome.status, "graded");
      assert.isFalse(result.outcome.pass);
      assert.strictEqual(result.calls.accounting.calls, result.requests);
      assert.strictEqual(result.calls.accounting.uncertainCalls, 0);
    }),
  );

  it.live("grade a model that leaves the fixture page before answering", () =>
    Effect.gen(function* () {
      const result = yield* trade("google/test", (request) =>
        request === 0
          ? toolCall("navigate", JSON.stringify({ url: "https://bench.test/nowhere" }))
          : toolCall("done", JSON.stringify({ answer: { orderId: "ORD-1001" } })),
      );

      assert.deepStrictEqual(result.outcome, { status: "graded", reason: "answered", pass: false });
      assert.include(result.detail ?? "", "the fixture state is unreadable");
    }),
  );

  it.live("fail an undecodable provider answer as infrastructure without replaying it", () =>
    Effect.gen(function* () {
      const result = yield* trade("google/test", () => ({
        error: { message: "upstream provider error", code: 502 },
      }));

      assert.deepStrictEqual(result.outcome, {
        status: "infrastructure-failed",
        reason: "provider-failed",
        pass: null,
      });
      assert.strictEqual(result.requests, 1);
      assert.strictEqual(result.calls.accounting.uncertainCalls, 1);
      assert.deepStrictEqual(result.ledger, { knownUsd: 0, reservedUsd: 0.01 });
    }),
  );
});

describe("narration", () => {
  it.live("captions the page while the agent works, and skips a malformed caption", () =>
    Effect.gen(function* () {
      const captions: Array<string> = [];
      let captionCalls = 0;
      let agentCalls = 0;

      const result = yield* trade(
        "openai/test",
        (_request, body) => {
          // Caption calls ask for a JSON object; the agent's calls offer tools.
          if (body.includes('"response_format"')) {
            captionCalls += 1;

            // A malformed caption is charged and skipped. An unknown charge would instead stop
            // the trial's admission, as it does for any call.
            return completion({
              role: "assistant",
              content: captionCalls === 1 ? "not json" : JSON.stringify({ caption: "A chart." }),
            });
          }
          agentCalls += 1;

          return agentCalls === 1
            ? // A condition that never holds keeps the agent working for its three seconds.
              toolCall(
                "wait",
                JSON.stringify({ selector: "#never", state: "visible", timeoutMillis: 3000 }),
              )
            : toolCall("done", JSON.stringify({ answer: { orderId: "ORD-0000" } }));
        },
        {
          narrate: "1 second",
          trace: (entry: Trace) =>
            Effect.sync(() => {
              if (entry._tag === "Moment" && entry.caption !== undefined)
                captions.push(entry.caption);
            }),
        },
      );

      assert.strictEqual(result.outcome.status, "graded");
      assert.isAtLeast(captionCalls, 2);
      // The narrator finishes its last call rather than leaving its charge unknown.
      assert.strictEqual(result.calls.accounting.uncertainCalls, 0);
      assert.deepStrictEqual(captions, Array(captionCalls - 1).fill("A chart."));
    }),
  );
});
