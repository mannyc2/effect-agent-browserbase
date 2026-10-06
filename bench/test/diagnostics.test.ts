// Real pinned adapter calls against an in-memory HTTP transport; no credentials or paid requests.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit, Schema } from "effect";
import { AiError, LanguageModel } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

import { budgetedClient, ledger } from "../Budget.ts";
import * as Diagnostics from "../Diagnostics.ts";

const secret = "PRIVATE-CANARY-session-account-prompt-response";

const billedUsage = {
  prompt_tokens: 100,
  completion_tokens: 20,
  total_tokens: 120,
  prompt_tokens_details: { cached_tokens: 30 },
  cost: 0.012,
};

const knownAccounting = {
  calls: 1,
  usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
  knownUsd: 0.012,
  reservedUsd: 0,
  uncertainCalls: 0,
};

const choice = (content: unknown, finish = "stop", reasoning?: string) => ({
  index: 0,
  finish_reason: finish,
  message: { role: "assistant", content, ...(reasoning === undefined ? {} : { reasoning }) },
});

const runResponse = Effect.fnUntraced(function* (choices: ReadonlyArray<unknown>) {
  const budget = yield* ledger(0.1, 0.04);
  const account = yield* budget.account;
  let requests = 0;

  const http = HttpClient.make((request) =>
    Effect.sync(() => {
      requests += 1;

      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            id: secret,
            object: "chat.completion",
            created: 0,
            model: secret,
            system_fingerprint: secret,
            choices,
            usage: billedUsage,
          }),
          { headers: { "content-type": "application/json", "x-request-id": secret } },
        ),
      );
    }),
  );

  const native = yield* OpenRouterClient.make({}).pipe(
    Effect.provideService(HttpClient.HttpClient, http),
  );

  const model = yield* OpenRouterLanguageModel.make({ model: "openai/test" }).pipe(
    Effect.provideService(
      OpenRouterClient.OpenRouterClient,
      budgetedClient(native, account, {
        rates: { input: 1e-6, output: 2e-6 },
        maxOutputTokens: 512,
      }),
    ),
  );

  const exit = yield* LanguageModel.generateObject({
    prompt: secret,
    schema: Schema.Struct({ result: Schema.Finite }),
  }).pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.exit);

  return {
    exit,
    diagnostic: Exit.isFailure(exit) ? Diagnostics.failure(exit.cause) : null,
    lastResponse: yield* account.lastResponse,
    accounting: yield* account.snapshot,
    budget: yield* budget.snapshot,
    requests,
  };
});

describe("safe provider diagnostics", () => {
  const failures = [
    {
      name: "empty choices",
      choices: [],
      origin: "OpenRouterLanguageModel/makeResponse",
      reason: "InvalidOutputError",
      objectDecode: null,
      contentKind: "missing",
      finishReason: null,
      reasoningPresent: false,
    },
    {
      name: "reasoning without answer text",
      choices: [choice(null, "stop", secret)],
      origin: "LanguageModel/generateObject",
      reason: "StructuredOutputError",
      objectDecode: "NoText",
      contentKind: "null",
      finishReason: "stop",
      reasoningPresent: true,
    },
    {
      name: "empty answer text",
      choices: [choice("")],
      origin: "LanguageModel/generateObject",
      reason: "StructuredOutputError",
      objectDecode: "NoText",
      contentKind: "empty",
      finishReason: "stop",
      reasoningPresent: false,
    },
    {
      name: "malformed JSON",
      choices: [choice(secret)],
      origin: "LanguageModel/generateObject",
      reason: "StructuredOutputError",
      objectDecode: "JsonSyntax",
      contentKind: "text",
      finishReason: "stop",
      reasoningPresent: false,
    },
    {
      name: "truncated JSON",
      choices: [choice('{"result":', "length")],
      origin: "LanguageModel/generateObject",
      reason: "StructuredOutputError",
      objectDecode: "JsonSyntax",
      contentKind: "text",
      finishReason: "length",
      reasoningPresent: false,
    },
    {
      name: "valid JSON with wrong fields",
      choices: [choice(JSON.stringify({ wrong: secret }))],
      origin: "LanguageModel/generateObject",
      reason: "StructuredOutputError",
      objectDecode: "SchemaMismatch",
      contentKind: "text",
      finishReason: "stop",
      reasoningPresent: false,
    },
  ] as const;

  for (const sample of failures) {
    it.effect("charges once and classifies " + sample.name, () =>
      Effect.gen(function* () {
        const result = yield* runResponse(sample.choices);

        assert.isTrue(Exit.isFailure(result.exit));
        assert.strictEqual(result.requests, 1);
        assert.deepStrictEqual(result.accounting, knownAccounting);
        assert.deepStrictEqual(result.budget, { knownUsd: 0.012, reservedUsd: 0 });
        assert.deepStrictEqual(result.diagnostic, {
          kind: "AiError",
          origin: sample.origin,
          reason: sample.reason,
          objectDecode: sample.objectDecode,
          httpStatus: null,
        });
        assert.deepStrictEqual(result.lastResponse, {
          call: 1,
          httpStatus: 200,
          choiceCount: sample.choices.length,
          finishReason: sample.finishReason,
          contentKind: sample.contentKind,
          reasoningPresent: sample.reasoningPresent,
          toolCallCount: 0,
        });
        assert.notInclude(
          JSON.stringify({ diagnostic: result.diagnostic, lastResponse: result.lastResponse }),
          secret,
        );
      }),
    );
  }

  it.effect(
    "keeps a malformed provider envelope unresolved without claiming a decoded receipt",
    () =>
      Effect.gen(function* () {
        const result = yield* runResponse([choice(123)]);

        assert.isTrue(Exit.isFailure(result.exit));
        assert.strictEqual(result.requests, 1);
        assert.deepStrictEqual(result.diagnostic, {
          kind: "AiError",
          origin: "OpenRouterClient/createChatCompletion",
          reason: "InvalidOutputError",
          objectDecode: null,
          httpStatus: null,
        });
        assert.isNull(result.lastResponse);
        assert.deepStrictEqual(result.accounting, {
          calls: 1,
          usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
          knownUsd: 0,
          reservedUsd: 0.04,
          uncertainCalls: 1,
        });
        assert.deepStrictEqual(result.budget, { knownUsd: 0, reservedUsd: 0.04 });
        assert.notInclude(JSON.stringify(result.diagnostic), secret);
      }),
  );

  it.effect("keeps successful text and content-part answers on the real adapter path", () =>
    Effect.gen(function* () {
      const results = yield* Effect.forEach(
        ['{"result":7}', [{ type: "text", text: '{"result":7}' }]],
        (content) => runResponse([choice(content)]),
      );

      assert.deepStrictEqual(
        results.map((result) => result.exit._tag),
        ["Success", "Success"],
      );
      assert.deepStrictEqual(
        results.map((result) => result.diagnostic),
        [null, null],
      );
      assert.deepStrictEqual(
        results.map((result) => result.lastResponse?.contentKind),
        ["text", "parts"],
      );
      assert.deepStrictEqual(
        results.map((result) => result.accounting),
        [knownAccounting, knownAccounting],
      );
      assert.deepStrictEqual(
        results.map((result) => result.requests),
        [1, 1],
      );
    }),
  );

  it.effect("does not attach an earlier response to a later failed request", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.1, 0.04);
      const account = yield* budget.account;

      yield* account.run(
        Effect.succeed(billedUsage),
        (usage) => usage,
        () => ({
          httpStatus: 200,
          choiceCount: 1,
          finishReason: "stop",
          contentKind: "text",
          reasoningPresent: false,
          toolCallCount: 0,
        }),
      );

      assert.strictEqual((yield* account.lastResponse)?.call, 1);
      yield* account.run(Effect.fail("offline"), () => undefined).pipe(Effect.flip);
      assert.isNull(yield* account.lastResponse);
      assert.strictEqual((yield* account.snapshot).calls, 2);
      assert.strictEqual((yield* account.snapshot).knownUsd, 0.012);
      assert.strictEqual((yield* account.snapshot).reservedUsd, 0.04);
    }),
  );

  it.effect("emits only allowlisted fields when every private error field contains a canary", () =>
    Effect.sync(() => {
      const reason = new AiError.UnknownError({
        description: secret,
        metadata: { provider: { private: secret } },
        http: {
          request: {
            method: "POST",
            url: "https://" + secret,
            urlParams: [["account", secret]],
            hash: secret,
            headers: { authorization: secret },
          },
          response: { status: 429, headers: { "x-request-id": secret } },
          body: secret,
        },
      });

      const error = AiError.make({ module: secret, method: secret, reason });
      const diagnostic = Diagnostics.failure(Cause.fail(error));

      assert.deepStrictEqual(diagnostic, {
        kind: "AiError",
        origin: "Other",
        reason: "UnknownError",
        objectDecode: null,
        httpStatus: 429,
      });
      assert.isTrue(Schema.is(Diagnostics.Failure)(diagnostic));
      assert.notInclude(JSON.stringify(diagnostic), secret);

      // A future or malformed runtime reason must not turn its tag into a new log channel.
      Object.defineProperty(reason, "_tag", { value: secret });

      const unknownReason = Diagnostics.failure(Cause.fail(error));

      assert.isNull(unknownReason.reason);
      assert.notInclude(JSON.stringify(unknownReason), secret);
      assert.deepStrictEqual(Diagnostics.failure(Cause.die(new Error(secret))), {
        kind: "Defect",
        origin: "Other",
        reason: null,
        objectDecode: null,
        httpStatus: null,
      });
    }),
  );
});
