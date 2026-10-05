// Both pinned SDKs run across the real loopback broker; only the upstream transport is synthetic.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Deferred, Effect, Exit, Fiber, Ref, Schema } from "effect";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as Diagnostics from "../Diagnostics.ts";
import * as Broker from "../ModelBroker.ts";
import type * as Native from "../Native.ts";
import * as NativeClient from "../NativeClient.ts";
import { budgetedClient, ledger } from "../run.ts";

class TransportError extends Schema.TaggedError<TransportError>()("BrokerTestTransportError", {}) {}

const secret = "PRIVATE-provider-key-session-prompt-reply-canary";
const modelId = "openai/test";

const usage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 30, image_tokens: 8 },
  completion_tokens_details: { reasoning_tokens: 3 },
  cost: 0.012,
};

const chat = {
  model: modelId,
  reasoning: { effort: "none" as const },
  messages: [{ role: "user" as const, content: secret }],
};

const envelope = (content: unknown, priced = true) => ({
  id: secret,
  object: "chat.completion",
  created: 0,
  model: modelId,
  system_fingerprint: secret,
  choices: [{ index: 0, finish_reason: "stop", message: { role: "assistant", content } }],
  usage: { ...usage, cost: priced ? usage.cost : null },
});

const nativeRequest: Native.Request = {
  model: modelId,
  store: false,
  include: ["reasoning.encrypted_content"],
  instructions: secret,
  input: [{ role: "user", content: [{ type: "input_text", text: secret }] }],
  tools: [{ type: "computer" }],
  reasoning: { effort: "none" },
  max_output_tokens: 8192,
  service_tier: "default",
};

const nativeEnvelope = (priced = true) => ({
  id: secret,
  status: "completed",
  output: [
    { type: "computer_call", id: "call", call_id: "call-id", actions: [{ type: "screenshot" }] },
  ],
  usage: {
    input_tokens: 100,
    output_tokens: 20,
    input_tokens_details: { cached_tokens: 30, image_tokens: 8 },
    output_tokens_details: { reasoning_tokens: 3 },
    cost: priced ? 0.012 : null,
  },
});

const fixture = Effect.fnUntraced(function* (
  response: unknown,
  upstream: Effect.Effect<void> = Effect.void,
  options: { readonly native?: boolean; readonly status?: number } = {},
) {
  const budget = yield* ledger(0.2, 0.04);
  const account = yield* budget.account;
  const calls = yield* Ref.make(0);
  const wire: Array<{ readonly status: number; readonly body: string }> = [];
  const sent: Array<unknown> = [];

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      yield* Ref.update(calls, (count) => count + 1);
      if (request.body._tag === "Uint8Array")
        sent.push(JSON.parse(new TextDecoder().decode(request.body.body)));
      yield* upstream;

      return HttpClientResponse.fromWeb(
        request,
        new Response(JSON.stringify(response), {
          status: options.status ?? 200,
          headers: { "content-type": "application/json", "x-request-id": secret },
        }),
      );
    }),
  );

  const parent = yield* OpenRouterClient.make({}).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );

  const native =
    options.native === true
      ? yield* NativeClient.make({
          account,
          model: modelId,
          reasoning: "none",
          maxOutputTokens: 512,
          bounds: { rates: { input: 1e-6, output: 2e-6 }, provider: "test-only" },
        }).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
          Effect.provideService(
            ConfigProvider.ConfigProvider,
            ConfigProvider.fromUnknown({ OPENROUTER_API_KEY: secret }),
          ),
        )
      : undefined;

  const broker = yield* Broker.make;

  const route = yield* broker.register({
    model: modelId,
    reasoning: "none",
    account,
    client: budgetedClient(parent, account, {
      rates: { input: 1e-6, output: 2e-6 },
      maxOutputTokens: 512,
      provider: "test-only",
    }),
    timeoutMillis: 2000,
    native,
  });

  const workerFetch: typeof globalThis.fetch = async (input, init) => {
    const received = await fetch(input, init);

    wire.push({ status: received.status, body: await received.clone().text() });

    return received;
  };

  const worker = yield* OpenRouterClient.make({ apiUrl: route.apiUrl }).pipe(
    Effect.provide(FetchHttpClient.layer),
    Effect.provideService(FetchHttpClient.Fetch, workerFetch),
  );

  const model = yield* OpenRouterLanguageModel.make({
    model: modelId,
    config: { reasoning: { effort: "none" } },
  }).pipe(Effect.provideService(OpenRouterClient.OpenRouterClient, worker));

  return { budget, account, calls, wire, sent, route, worker, model };
});

const post = (url: string, body: unknown, method = "POST") =>
  Effect.tryPromise({
    try: async (signal) => {
      const response = await fetch(url, {
        method,
        signal,
        headers: { "content-type": "application/json" },
        ...(method === "GET" ? {} : { body: JSON.stringify(body) }),
      });

      return { status: response.status, text: await response.text() };
    },
    catch: () => new TransportError(),
  });

describe("parent model broker", () => {
  it.live(
    "delivers the native reply envelope only after the real parent transport settles it",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture(nativeEnvelope(), Effect.void, { native: true });
        const response = yield* post(test.route.apiUrl + "/responses", nativeRequest);

        assert.strictEqual(response.status, 200);
        assert.deepStrictEqual(JSON.parse(response.text), {
          status: 200,
          body: nativeEnvelope(),
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
        });
        assert.strictEqual(yield* Ref.get(test.calls), 1);
        assert.deepStrictEqual(yield* test.account.snapshot, {
          calls: 1,
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
          knownUsd: 0.012,
          reservedUsd: 0,
          uncertainCalls: 0,
        });
        assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0.012, reservedUsd: 0 });
        assert.deepStrictEqual(yield* test.account.tokens, { image: 8, reasoning: 3 });
        assert.deepInclude(test.sent[0], { model: modelId, max_output_tokens: 512 });
        assert.notInclude(JSON.stringify(yield* test.route.metrics), secret);
      }).pipe(Effect.scoped),
  );

  it.live(
    "preserves native unpriced and admission stop codes without releasing the reservation",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture(nativeEnvelope(false), Effect.void, { native: true });
        const endpoint = test.route.apiUrl + "/responses";
        const first = yield* post(endpoint, nativeRequest);
        const second = yield* post(endpoint, nativeRequest);

        assert.deepStrictEqual(first, {
          status: 502,
          text: JSON.stringify({ code: "UnpricedResponse" }),
        });
        assert.deepStrictEqual(second, {
          status: 502,
          text: JSON.stringify({ code: "AdmissionStopped" }),
        });
        assert.strictEqual(yield* Ref.get(test.calls), 1);
        assert.deepStrictEqual(yield* test.account.snapshot, {
          calls: 1,
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
          knownUsd: 0,
          reservedUsd: 0.04,
          uncertainCalls: 1,
        });
        assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0, reservedUsd: 0.04 });
        assert.isTrue(yield* test.budget.exhausted);
        assert.notInclude(
          JSON.stringify({ first, second, metrics: yield* test.route.metrics }),
          secret,
        );
      }).pipe(Effect.scoped),
  );

  it.live("preserves native provider rejection without forwarding its body or retrying", () =>
    Effect.gen(function* () {
      const test = yield* fixture({ error: secret }, Effect.void, { native: true, status: 503 });
      const response = yield* post(test.route.apiUrl + "/responses", nativeRequest);

      assert.deepStrictEqual(response, {
        status: 502,
        text: JSON.stringify({ code: "NativeRouteRejected" }),
      });
      assert.strictEqual(yield* Ref.get(test.calls), 1);
      assert.strictEqual((yield* test.account.snapshot).uncertainCalls, 1);
      assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0, reservedUsd: 0.04 });
      assert.notInclude(JSON.stringify({ response, metrics: yield* test.route.metrics }), secret);
    }).pipe(Effect.scoped),
  );

  it.live("settles the real provider receipt before worker object conversion fails", () =>
    Effect.gen(function* () {
      const test = yield* fixture(envelope(secret));

      const exit = yield* LanguageModel.generateObject({
        prompt: secret,
        schema: Schema.Struct({ result: Schema.Finite }),
      }).pipe(Effect.provideService(LanguageModel.LanguageModel, test.model), Effect.exit);

      const diagnostic = Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null;

      assert.isTrue(Exit.isFailure(exit));
      assert.deepInclude(diagnostic, { objectDecode: "JsonSyntax" });
      assert.strictEqual(yield* Ref.get(test.calls), 1);
      assert.deepStrictEqual(yield* test.account.snapshot, {
        calls: 1,
        usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
        knownUsd: 0.012,
        reservedUsd: 0,
        uncertainCalls: 0,
      });
      assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0.012, reservedUsd: 0 });
      assert.deepStrictEqual(yield* test.account.tokens, { image: 8, reasoning: 3 });
      assert.deepInclude(yield* test.account.lastResponse, {
        call: 1,
        choiceCount: 1,
        contentKind: "text",
        httpStatus: 200,
      });
      assert.deepInclude(test.sent[0], {
        model: modelId,
        max_tokens: 512,
        service_tier: "default",
        provider: {
          only: ["test-only"],
          allow_fallbacks: false,
          require_parameters: true,
          max_price: { prompt: "1", completion: "2", request: "0", image: "0", audio: "0" },
        },
      });
      assert.strictEqual(test.wire[0]?.status, 200);
      assert.notInclude(
        JSON.stringify({
          diagnostic,
          metrics: yield* test.route.metrics,
          receipt: yield* test.account.lastResponse,
        }),
        secret,
      );
    }).pipe(Effect.scoped),
  );

  it.live("does not deliver an unpriced body to the worker or allow another paid dispatch", () =>
    Effect.gen(function* () {
      const test = yield* fixture(envelope(secret, false));
      const first = yield* test.worker.createChatCompletion(chat).pipe(Effect.exit);
      const second = yield* test.worker.createChatCompletion(chat).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(first));
      assert.isTrue(Exit.isFailure(second));
      assert.strictEqual(yield* Ref.get(test.calls), 1);
      assert.deepStrictEqual(
        test.wire.map((response) => response.status),
        [502, 502],
      );
      assert.notInclude(JSON.stringify(test.wire), secret);
      assert.strictEqual((yield* test.account.snapshot).uncertainCalls, 1);
      assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0, reservedUsd: 0.04 });
      assert.isTrue(yield* test.budget.exhausted);
      assert.notInclude(JSON.stringify(yield* test.route.metrics), secret);
    }).pipe(Effect.scoped),
  );

  it.live(
    "rejects invalid capabilities, methods, request pins and streaming before admission",
    () =>
      Effect.gen(function* () {
        const test = yield* fixture(envelope('{"result":7}'));
        const endpoint = test.route.apiUrl + "/chat/completions";
        const unauthorized = new URL(endpoint);

        unauthorized.pathname = "/" + "0".repeat(48) + "/chat/completions";

        const responses = [
          yield* post(unauthorized.href, chat),
          yield* post(endpoint, chat, "GET"),
          yield* post(endpoint, { ...chat, model: "openai/other" }),
          yield* post(endpoint, { ...chat, reasoning: { effort: "high" } }),
          yield* post(endpoint, { ...chat, stream: true }),
          yield* post(endpoint, { ...chat, messages: 123 }),
        ];

        assert.deepStrictEqual(
          responses.map((response) => response.status),
          [404, 404, 502, 502, 502, 502],
        );
        assert.strictEqual(yield* Ref.get(test.calls), 0);
        assert.strictEqual((yield* test.account.snapshot).calls, 0);
        assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
        assert.notInclude(JSON.stringify(responses), secret);
        const [response] = yield* test.worker.createChatCompletion(chat);

        assert.strictEqual(response.choices[0]?.message.content, '{"result":7}');
        assert.strictEqual(yield* Ref.get(test.calls), 1);
        yield* test.route.close;
        assert.strictEqual((yield* post(endpoint, chat)).status, 404);
        assert.strictEqual(yield* Ref.get(test.calls), 1);
      }).pipe(Effect.scoped),
  );

  it.live("cleans up an oversized request without consuming admission or disabling the route", () =>
    Effect.gen(function* () {
      const test = yield* fixture(envelope('{"result":7}'));

      const oversized = yield* post(
        test.route.apiUrl + "/chat/completions",
        "x".repeat(Broker.maximumRequestBytes + 1),
      ).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(oversized) || oversized.value.status === 502);
      assert.strictEqual(yield* Ref.get(test.calls), 0);
      assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
      const [response] = yield* test.worker.createChatCompletion(chat);

      assert.strictEqual(response.choices[0]?.message.content, '{"result":7}');
      assert.strictEqual(yield* Ref.get(test.calls), 1);
    }).pipe(Effect.scoped),
  );

  it.live("allows only one request per route and closes after the active receipt settles", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const reply = yield* Deferred.make<void>();

      const test = yield* fixture(
        envelope('{"result":7}'),
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(reply))),
      );

      const first = yield* test.worker.createChatCompletion(chat).pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      const second = yield* test.worker.createChatCompletion(chat).pipe(Effect.exit);

      assert.isTrue(Exit.isFailure(second));
      assert.strictEqual(test.wire[0]?.status, 409);
      assert.strictEqual(yield* Ref.get(test.calls), 1);
      const closed = yield* Ref.make(false);

      const closing = yield* test.route.close.pipe(
        Effect.andThen(Ref.set(closed, true)),
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      assert.isFalse(yield* Ref.get(closed));
      assert.strictEqual((yield* post(test.route.apiUrl + "/chat/completions", chat)).status, 404);
      yield* Deferred.succeed(reply, undefined);
      yield* Fiber.join(first);
      yield* Fiber.join(closing);
      assert.isTrue(yield* Ref.get(closed));
      assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0.012, reservedUsd: 0 });
    }).pipe(Effect.scoped),
  );

  it.live("cancels a disconnected request once and retains its unresolved reservation", () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();
      const interrupted = yield* Deferred.make<void>();

      const test = yield* fixture(
        envelope(secret),
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
        ),
      );

      const request = yield* test.worker.createChatCompletion(chat).pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(request);
      yield* Deferred.await(interrupted).pipe(Effect.timeout("5 seconds"));
      yield* test.route.close;
      assert.strictEqual(yield* Ref.get(test.calls), 1);
      assert.strictEqual((yield* test.account.snapshot).uncertainCalls, 1);
      assert.deepStrictEqual(yield* test.budget.snapshot, { knownUsd: 0, reservedUsd: 0.04 });
      assert.isTrue(yield* test.budget.exhausted);
      assert.notInclude(JSON.stringify(yield* test.route.metrics), secret);
    }).pipe(Effect.scoped),
  );
});
