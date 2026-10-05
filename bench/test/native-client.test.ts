// Real Effect HttpClient responses and the shared ledger; every provider is in memory.
import { assert, describe, it } from "@effect/vitest";
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";

import * as Native from "../Native.ts";
import * as NativeClient from "../NativeClient.ts";
import { ledger, type Account } from "../run.ts";

const secret = "PRIVATE-KEY-PROMPT-RESPONSE-CANARY";
const config = ConfigProvider.fromUnknown({ OPENROUTER_API_KEY: secret });

const bill = {
  input_tokens: 100,
  output_tokens: 20,
  input_tokens_details: { cached_tokens: 30, image_tokens: 50 },
  output_tokens_details: { reasoning_tokens: 7 },
  cost: 0.012,
};

const body = (usage: unknown = bill) => ({
  id: secret,
  status: "completed",
  output: [
    { type: "computer_call", id: "old", call_id: "old-call", action: { type: "screenshot" } },
  ],
  usage,
});

const request: Native.Request = {
  model: "openai/worker-selected",
  store: false,
  include: ["reasoning.encrypted_content"],
  instructions: secret,
  input: [{ role: "user", content: [{ type: "input_text", text: secret }] }],
  tools: [{ type: "computer" }],
  reasoning: { effort: "high" },
  max_output_tokens: 8192,
  service_tier: "default",
};

const options = (account: Account): NativeClient.Options => ({
  account,
  model: "openai/gpt-6-luna",
  reasoning: "medium",
  maxOutputTokens: 512,
  bounds: {
    rates: { input: 1e-6, output: 2e-6 },
    provider: "openai",
    outputParameter: "max_tokens",
  },
});

const parseObject = Schema.decodeEffect(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

const code = (exit: Exit.Exit<unknown, unknown>) => {
  if (Exit.isSuccess(exit)) throw new Error("Expected a native transport failure");
  const found = Cause.findErrorOption(exit.cause);

  if (found._tag === "None" || !Schema.is(Native.NativeError)(found.value))
    throw new Error("Expected a closed native transport error");
  assert.notInclude(JSON.stringify(found.value), secret);

  return found.value.code;
};

const fixture = Effect.fnUntraced(function* (
  responseBody: string | Uint8Array = JSON.stringify(body()),
  status = 200,
) {
  const budget = yield* ledger(0.2, 0.04);
  const account = yield* budget.account;
  const sent: Array<string> = [];

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const accounting = yield* account.snapshot;

      assert.isAtLeast(accounting.calls, 1);
      assert.strictEqual(accounting.reservedUsd, 0.04);
      assert.strictEqual(request.url, "https://openrouter.ai/api/v1/responses");
      assert.strictEqual(request.headers.authorization, "Bearer " + secret);
      assert.strictEqual(request.body._tag, "Uint8Array");
      if (request.body._tag === "Uint8Array")
        sent.push(new TextDecoder().decode(request.body.body));

      return HttpClientResponse.fromWeb(
        request,
        new Response(
          typeof responseBody === "string" ? responseBody : Uint8Array.from(responseBody).buffer,
          {
            status,
            headers: { "content-type": "application/json", "x-request-id": secret },
          },
        ),
      );
    }),
  );

  const send = yield* NativeClient.make(options(account)).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
    Effect.provideService(ConfigProvider.ConfigProvider, config),
  );

  return { budget, account, sent, send };
});

describe("parent native Responses transport", () => {
  it.effect(
    "settles a priced unsupported native contract once and returns only the required receipt view",
    () =>
      Effect.gen(function* () {
        const { account, sent, send } = yield* fixture();
        const result = yield* send(request);

        assert.deepStrictEqual(result.body, body());
        assert.deepStrictEqual(result.usage, {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 30,
        });
        assert.strictEqual(sent.length, 1);
        assert.deepStrictEqual(yield* account.snapshot, {
          calls: 1,
          usage: result.usage,
          knownUsd: 0.012,
          reservedUsd: 0,
          uncertainCalls: 0,
        });
        assert.deepStrictEqual(yield* account.tokens, { image: 50, reasoning: 7 });
        assert.notInclude(JSON.stringify(yield* account.snapshot), secret);
        assert.isNull(yield* account.lastResponse);
      }),
  );

  // Regression for 6b8faf2: native receipt conversion must retain the BYOK billing
  // evidence too, or sharing the corrected chat ledger still undercounts this arm.
  it.effect("settles the full BYOK bill from a native response", () =>
    Effect.gen(function* () {
      const { account, sent, send } = yield* fixture(
        JSON.stringify(
          body({ ...bill, is_byok: true, cost_details: { upstream_inference_cost: 0.018 } }),
        ),
      );

      yield* send(request);

      assert.strictEqual(sent.length, 1);
      assert.closeTo((yield* account.snapshot).knownUsd, 0.03, 1e-9);
      assert.strictEqual((yield* account.snapshot).reservedUsd, 0);
    }),
  );

  it.effect("withholds native BYOK output when the upstream bill is absent", () =>
    Effect.gen(function* () {
      const { account, budget, send, sent } = yield* fixture(
        JSON.stringify(body({ ...bill, cost: 0, is_byok: true })),
      );

      assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "UnpricedResponse");
      assert.deepInclude(yield* account.snapshot, {
        knownUsd: 0,
        reservedUsd: 0.04,
        uncertainCalls: 1,
      });
      assert.isTrue(yield* budget.exhausted);
      assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "AdmissionStopped");
      assert.strictEqual(sent.length, 1);
    }),
  );

  it.effect(
    "pins model, effort, token ceiling, provider prices and disabled plugins before dispatch",
    () =>
      Effect.gen(function* () {
        const { sent, send } = yield* fixture();

        yield* send(request);
        const outbound = yield* parseObject(sent[0] ?? "");

        assert.strictEqual(outbound.model, "openai/gpt-6-luna");
        assert.deepStrictEqual(outbound.reasoning, { effort: "medium" });
        assert.strictEqual(outbound.max_output_tokens, 512);
        assert.isFalse("max_tokens" in outbound);
        assert.strictEqual(outbound.store, false);
        assert.strictEqual(outbound.service_tier, "default");
        assert.deepStrictEqual(outbound.tools, [{ type: "computer" }]);
        assert.deepStrictEqual(outbound.provider, {
          only: ["openai"],
          allow_fallbacks: false,
          require_parameters: true,
          max_price: { prompt: "1", completion: "2", request: "0", image: "0", audio: "0" },
        });
        assert.deepStrictEqual(
          outbound.plugins,
          [
            "web",
            "file-parser",
            "response-healing",
            "context-compression",
            "auto-router",
            "auto-beta-router",
            "pareto-router",
            "fusion",
          ].map((id) => ({ id, enabled: false })),
        );
        assert.isFalse("api_key" in outbound);
        assert.isFalse("authorization" in outbound);
      }),
  );

  it.effect(
    "keeps known tokens but withholds actionable output when price is absent and stops future admission",
    () =>
      Effect.gen(function* () {
        const { cost: _cost, ...unpriced } = bill;
        const { account, budget, send, sent } = yield* fixture(JSON.stringify(body(unpriced)));

        assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "UnpricedResponse");
        assert.deepStrictEqual(yield* account.snapshot, {
          calls: 1,
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
          knownUsd: 0,
          reservedUsd: 0.04,
          uncertainCalls: 1,
        });
        assert.deepStrictEqual(yield* account.tokens, { image: 50, reasoning: 7 });
        assert.isTrue(yield* budget.exhausted);
        assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "AdmissionStopped");
        assert.strictEqual(sent.length, 1);
      }),
  );

  const rejected = [
    {
      name: "missing usage",
      value: JSON.stringify({ status: "completed", output: [], private: secret }),
      code: "UnpricedResponse",
      status: 200,
    },
    {
      name: "negative tokens",
      value: JSON.stringify(body({ ...bill, input_tokens: -1 })),
      code: "UnpricedResponse",
      status: 200,
    },
    {
      name: "fractional tokens",
      value: JSON.stringify(body({ ...bill, output_tokens: 1.5 })),
      code: "UnpricedResponse",
      status: 200,
    },
    {
      name: "negative cost",
      value: JSON.stringify(body({ ...bill, cost: -1 })),
      code: "UnpricedResponse",
      status: 200,
    },
    {
      name: "invalid token subset",
      value: JSON.stringify(body({ ...bill, output_tokens_details: { reasoning_tokens: 21 } })),
      code: "UnpricedResponse",
      status: 200,
    },
    {
      name: "HTTP error with a purported price",
      value: JSON.stringify(body()),
      code: "NativeRouteRejected",
      status: 503,
    },
    { name: "malformed JSON", value: "{" + secret, code: "ResponseEnvelopeInvalid", status: 200 },
    {
      name: "invalid UTF-8",
      value: Uint8Array.of(0xc3, 0x28),
      code: "ResponseEnvelopeInvalid",
      status: 200,
    },
    {
      name: "oversized body",
      value: " ".repeat(NativeClient.maxResponseBytes + 1),
      code: "ResponseEnvelopeInvalid",
      status: 200,
    },
  ] as const;

  for (const scenario of rejected)
    it.effect("retains the reservation for " + scenario.name, () =>
      Effect.gen(function* () {
        const { account, budget, send, sent } = yield* fixture(scenario.value, scenario.status);

        assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), scenario.code);
        const accounting = yield* account.snapshot;

        assert.strictEqual(accounting.calls, 1);
        assert.strictEqual(accounting.knownUsd, 0);
        assert.strictEqual(accounting.reservedUsd, 0.04);
        assert.strictEqual(accounting.uncertainCalls, 1);
        assert.isTrue(yield* budget.exhausted);
        assert.strictEqual(sent.length, 1);
        assert.notInclude(JSON.stringify(accounting), secret);
      }),
    );

  it.effect("preserves absent image and reasoning breakdowns as unknown", () =>
    Effect.gen(function* () {
      const { account, send } = yield* fixture(
        JSON.stringify(
          body({
            input_tokens: 100,
            output_tokens: 20,
            cost: 0.004,
          }),
        ),
      );

      yield* send(request);
      assert.deepStrictEqual(yield* account.tokens, { image: null, reasoning: null });
    }),
  );

  it.effect("keeps nullable breakdowns unknown without discarding an otherwise valid price", () =>
    Effect.gen(function* () {
      const { account, send } = yield* fixture(
        JSON.stringify(
          body({
            input_tokens: 100,
            output_tokens: 20,
            cost: 0.004,
            input_tokens_details: { cached_tokens: null, image_tokens: null },
            output_tokens_details: { reasoning_tokens: null },
          }),
        ),
      );

      yield* send(request);
      assert.deepStrictEqual(yield* account.tokens, { image: null, reasoning: null });
      assert.strictEqual((yield* account.snapshot).knownUsd, 0.004);
      assert.strictEqual((yield* account.snapshot).uncertainCalls, 0);
    }),
  );

  it.effect("settles an over-bound known receipt and then stops instead of returning actions", () =>
    Effect.gen(function* () {
      const { account, send, sent } = yield* fixture(JSON.stringify(body({ ...bill, cost: 0.05 })));

      assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "AdmissionStopped");
      const accounting = yield* account.snapshot;

      assert.strictEqual(accounting.knownUsd, 0.05);
      assert.strictEqual(accounting.reservedUsd, 0);
      assert.strictEqual(accounting.uncertainCalls, 0);
      assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "AdmissionStopped");
      assert.strictEqual(sent.length, 1);
    }),
  );

  it.effect("rejects forbidden routing fields before admission", () =>
    Effect.gen(function* () {
      const { account, send, sent } = yield* fixture();
      const forged = { ...request, provider: { only: ["other"] } };

      assert.strictEqual(code(yield* send(forged).pipe(Effect.exit)), "InvalidOptions");
      assert.strictEqual((yield* account.snapshot).calls, 0);
      assert.strictEqual(sent.length, 0);
    }),
  );

  it.effect("retains an interrupted dispatch without retrying or exposing a transport cause", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.2, 0.04);
      const account = yield* budget.account;
      const entered = yield* Deferred.make<void>();
      let calls = 0;

      const http = HttpClient.make(() =>
        Effect.sync(() => {
          calls += 1;
        }).pipe(Effect.andThen(Deferred.succeed(entered, undefined)), Effect.andThen(Effect.never)),
      );

      const send = yield* NativeClient.make(options(account)).pipe(
        Effect.provideService(HttpClient.HttpClient, http),
        Effect.provideService(ConfigProvider.ConfigProvider, config),
      );

      const fiber = yield* send(request).pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      assert.strictEqual(calls, 1);
      assert.strictEqual((yield* account.snapshot).reservedUsd, 0.04);
      assert.strictEqual((yield* account.snapshot).uncertainCalls, 1);
      assert.isTrue(yield* budget.exhausted);
      assert.strictEqual(code(yield* send(request).pipe(Effect.exit)), "AdmissionStopped");
      assert.strictEqual(calls, 1);
    }),
  );

  it.effect(
    "uses the actual fetch-backed client with redirects disabled and no automatic retry",
    () =>
      Effect.gen(function* () {
        const budget = yield* ledger(0.2, 0.04);
        const account = yield* budget.account;
        let calls = 0;
        let redirect: RequestRedirect | undefined;

        const fakeFetch: typeof globalThis.fetch = (_input, init) => {
          calls += 1;
          redirect = init?.redirect;

          return Promise.reject(new Error(secret));
        };

        const send = yield* NativeClient.makeLive(options(account)).pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, config),
        );

        const exit = yield* send(request).pipe(
          Effect.provideService(FetchHttpClient.Fetch, fakeFetch),
          Effect.exit,
        );

        assert.strictEqual(code(exit), "RequestUncertain");
        assert.strictEqual(calls, 1);
        assert.strictEqual(redirect, "error");
        assert.strictEqual((yield* account.snapshot).reservedUsd, 0.04);
        assert.notInclude(JSON.stringify(yield* account.snapshot), secret);
      }),
  );
});
