// Deterministic free checks of shared admission, raw receipts and real browser ownership.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, describe, it } from "@effect/vitest";
import { Cause, ConfigProvider, Deferred, Effect, Exit, Fiber, Ref, Schema, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel } from "effect/ai";
import { FetchHttpClient, HttpClient, HttpClientResponse } from "effect/http";
import type { BrowserContext } from "playwright-core";

import {
  budgetedClient,
  eligibleEndpoints,
  ledger,
  ListedEndpoint,
  modelRunner,
} from "../Budget.ts";
import { isolatedTrial, trialSeed, workDeadline } from "../Trial.ts";

const receipt = (cost: number) => ({
  prompt_tokens: 100,
  completion_tokens: 20,
  prompt_tokens_details: { cached_tokens: 30 },
  cost,
});

describe("ledger", () => {
  it.effect(
    "reserves before parallel dispatch and attributes reverse-order receipts to their trials",
    () =>
      Effect.gen(function* () {
        const budget = yield* ledger(0.1, 0.04);
        const first = yield* budget.account;
        const second = yield* budget.account;
        const third = yield* budget.account;
        const firstReply = yield* Deferred.make<ReturnType<typeof receipt>>();
        const secondReply = yield* Deferred.make<ReturnType<typeof receipt>>();
        const entered = yield* Ref.make(0);
        const bothEntered = yield* Deferred.make<void>();

        const request = (reply: Deferred.Deferred<ReturnType<typeof receipt>>) =>
          Effect.gen(function* () {
            if ((yield* Ref.updateAndGet(entered, (count) => count + 1)) === 2)
              yield* Deferred.succeed(bothEntered, undefined);

            return yield* Deferred.await(reply);
          });

        const firstFiber = yield* first
          .run(request(firstReply), (value) => value)
          .pipe(Effect.forkChild);

        const secondFiber = yield* second
          .run(request(secondReply), (value) => value)
          .pipe(Effect.forkChild);

        yield* Deferred.await(bothEntered);

        const thirdFiber = yield* third
          .run(
            Ref.update(entered, (count) => count + 1).pipe(Effect.as(receipt(0.005))),
            (value) => value,
          )
          .pipe(Effect.forkChild);

        yield* Effect.yieldNow;
        assert.strictEqual(yield* Ref.get(entered), 2);
        assert.isFalse(yield* budget.exhausted);
        assert.closeTo((yield* budget.snapshot).reservedUsd, 0.08, 1e-9);

        yield* Deferred.succeed(secondReply, receipt(0.015));
        yield* Fiber.join(secondFiber);
        yield* Fiber.join(thirdFiber);
        assert.strictEqual(yield* Ref.get(entered), 3);
        assert.closeTo((yield* second.snapshot).knownUsd, 0.015, 1e-9);
        assert.strictEqual((yield* first.snapshot).knownUsd, 0);
        yield* Deferred.succeed(firstReply, receipt(0.01));
        yield* Fiber.join(firstFiber);

        const firstAccounting = yield* first.snapshot;
        const secondAccounting = yield* second.snapshot;

        assert.strictEqual(firstAccounting.calls, 1);
        assert.strictEqual(secondAccounting.calls, 1);
        assert.deepStrictEqual(firstAccounting.usage, {
          inputTokens: 100,
          outputTokens: 20,
          cachedInputTokens: 30,
        });
        assert.closeTo(
          (yield* budget.snapshot).knownUsd,
          firstAccounting.knownUsd + secondAccounting.knownUsd + (yield* third.snapshot).knownUsd,
          1e-9,
        );
        assert.strictEqual((yield* budget.snapshot).reservedUsd, 0);
        assert.isFalse(yield* budget.exhausted);
      }),
  );

  it.effect("keeps interrupted and unpriced reservations instead of spending them again", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.08, 0.04);
      const interrupted = yield* budget.account;
      const unpriced = yield* budget.account;
      const entered = yield* Deferred.make<void>();

      const fiber = yield* interrupted
        .run(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          () => undefined,
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      yield* unpriced.run(
        Effect.succeed({
          prompt_tokens: 70,
          completion_tokens: 3,
        }),
        (value) => value,
      );

      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0.08 });
      assert.strictEqual((yield* interrupted.snapshot).uncertainCalls, 1);
      assert.strictEqual((yield* unpriced.snapshot).usage.inputTokens, 70);
      assert.strictEqual((yield* unpriced.snapshot).uncertainCalls, 1);

      const denied = yield* unpriced
        .run(Effect.succeed(receipt(0)), (value) => value)
        .pipe(Effect.flip);

      assert.include(denied.message, "budget");
      assert.isTrue(yield* budget.exhausted);
    }),
  );

  it.effect(
    "keeps a failed transport reserved and accounts successful receipts before answer decoding",
    () =>
      Effect.gen(function* () {
        const budget = yield* ledger(0.1, 0.04);
        const account = yield* budget.account;
        const sent: Array<unknown> = [];

        const http = HttpClient.make((request) =>
          Effect.sync(() => {
            if (request.body._tag !== "Uint8Array") throw new Error("expected JSON request bytes");

            sent.push(JSON.parse(new TextDecoder().decode(request.body.body)));

            return HttpClientResponse.fromWeb(
              request,
              new Response(
                JSON.stringify({
                  id: "free-test",
                  object: "chat.completion",
                  created: 0,
                  model: "openai/test",
                  system_fingerprint: null,
                  choices: [
                    {
                      index: 0,
                      finish_reason: "stop",
                      message: { role: "assistant", content: "not valid JSON" },
                    },
                  ],
                  usage: { ...receipt(0.012), total_tokens: 120 },
                }),
                { headers: { "content-type": "application/json" } },
              ),
            );
          }),
        );

        const native = yield* OpenRouterClient.make({}).pipe(
          Effect.provideService(HttpClient.HttpClient, http),
        );

        const wrapped = budgetedClient(native, account, {
          rates: { input: 1e-6, output: 2e-6 },
          maxOutputTokens: 512,
        });

        const model = yield* OpenRouterLanguageModel.make({ model: "openai/test" }).pipe(
          Effect.provideService(OpenRouterClient.OpenRouterClient, wrapped),
        );

        const error = yield* LanguageModel.generateObject({
          prompt: "Return a number",
          schema: Schema.Struct({ result: Schema.Finite }),
        }).pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.flip);

        assert.strictEqual(error._tag, "AiError");
        assert.lengthOf(sent, 1);
        assert.deepInclude(sent[0], {
          max_tokens: 512,
          service_tier: "default",
          provider: {
            allow_fallbacks: false,
            require_parameters: true,
            max_price: { prompt: "1", completion: "2", request: "0", image: "0", audio: "0" },
          },
        });
        assert.deepStrictEqual(yield* account.snapshot, {
          calls: 1,
          usage: { inputTokens: 100, outputTokens: 20, cachedInputTokens: 30 },
          knownUsd: 0.012,
          reservedUsd: 0,
          uncertainCalls: 0,
        });

        const disconnected = yield* budget.account;

        const failure = yield* disconnected
          .run(Effect.fail("connection closed"), () => undefined)
          .pipe(Effect.flip);

        assert.strictEqual(failure, "connection closed");
        assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0.012, reservedUsd: 0.04 });
      }),
  );
});

const byokResponse = (usage: Record<string, unknown>) =>
  HttpClient.make((request) =>
    Effect.succeed(
      HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify({
            id: "free-test",
            object: "chat.completion",
            created: 0,
            model: "openai/test",
            system_fingerprint: null,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: '{"result":1}' },
              },
            ],
            usage: { prompt_tokens: 1000, completion_tokens: 50, total_tokens: 1050, ...usage },
          }),
          { headers: { "content-type": "application/json" } },
        ),
      ),
    ),
  );

/** One generateObject call through the real adapter and the budgeted client. */
const callWith = (
  budget: Effect.Success<ReturnType<typeof ledger>>,
  usage: Record<string, unknown>,
) =>
  Effect.gen(function* () {
    const account = yield* budget.account;

    const native = yield* OpenRouterClient.make({}).pipe(
      Effect.provideService(HttpClient.HttpClient, byokResponse(usage)),
    );

    const model = yield* OpenRouterLanguageModel.make({ model: "openai/test" }).pipe(
      Effect.provideService(
        OpenRouterClient.OpenRouterClient,
        budgetedClient(native, account, {
          rates: { input: 1e-6, output: 2e-6 },
          maxOutputTokens: 64,
        }),
      ),
    );

    return yield* LanguageModel.generateObject({
      prompt: "x",
      schema: Schema.Struct({ result: Schema.Finite }),
    }).pipe(Effect.provideService(LanguageModel.LanguageModel, model), Effect.exit);
  });

describe("BYOK receipts", () => {
  it.effect("charge OpenRouter's fee plus the provider's upstream inference", () =>
    Effect.gen(function* () {
      // $0.0015 fee + $0.03 billed by the provider: a $0.10 budget admits two such calls.
      const budget = yield* ledger(0.1, 0.04);

      const byok = {
        cost: 0.0015,
        is_byok: true,
        cost_details: {
          upstream_inference_cost: 0.03,
          upstream_inference_prompt_cost: 0.025,
          upstream_inference_completions_cost: 0.005,
        },
      };

      const exits = [];

      for (let call = 0; call < 4; call++) exits.push((yield* callWith(budget, byok))._tag);

      assert.deepStrictEqual(exits, ["Success", "Success", "Failure", "Failure"]);
      assert.closeTo((yield* budget.snapshot).knownUsd, 0.063, 1e-9);
      assert.isTrue(yield* budget.exhausted);
    }),
  );

  it.effect("keep a BYOK receipt without its upstream cost reserved as uncertain", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.1, 0.04);
      const exit = yield* callWith(budget, { cost: 0, is_byok: true });

      assert.strictEqual(exit._tag, "Success");
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0.04 });
    }),
  );
});

describe("unbudgeted routes", () => {
  it.effect("refuse decisions and raw generated requests before sending them", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.1, 0.04);
      const account = yield* budget.account;
      let requests = 0;

      const native = yield* OpenRouterClient.make({}).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.sync(() => {
              requests++;

              return HttpClientResponse.fromWeb(request, new Response("{}"));
            }),
          ),
        ),
      );

      const wrapped = budgetedClient(native, account, {
        rates: { input: 1e-6, output: 2e-6 },
        maxOutputTokens: 64,
      });

      const request = { model: "openai/test", messages: [{ role: "user" as const, content: "x" }] };

      const decisions = yield* wrapped
        .createDecisions({ model: "openai/test", state: {}, questions: {} })
        .pipe(Effect.flip);

      const raw = yield* wrapped.client
        .sendChatCompletionRequest({ payload: request })
        .pipe(Effect.flip);

      assert.strictEqual(decisions.reason._tag, "InvalidRequestError");
      assert.strictEqual(raw._tag, "HttpClientError");
      assert.strictEqual(requests, 0);
      assert.strictEqual((yield* account.snapshot).calls, 0);
    }),
  );
});

describe("streamed requests", () => {
  it.effect("are sent as one charged completion and read back as a stream that sent it whole", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.1, 0.04);
      const account = yield* budget.account;
      const bodies: Array<string> = [];

      const http = byokResponse({ cost: 0.002 });

      const native = yield* OpenRouterClient.make({}).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            if (request.body._tag === "Uint8Array")
              bodies.push(new TextDecoder().decode(request.body.body));

            return http.execute(request);
          }),
        ),
      );

      const model = yield* OpenRouterLanguageModel.make({ model: "openai/test" }).pipe(
        Effect.provideService(
          OpenRouterClient.OpenRouterClient,
          budgetedClient(native, account, {
            rates: { input: 1e-6, output: 2e-6 },
            maxOutputTokens: 64,
          }),
        ),
      );

      const parts = yield* LanguageModel.streamText({ prompt: "x" }).pipe(
        Stream.runCollect,
        Effect.provideService(LanguageModel.LanguageModel, model),
      );

      const text = parts.flatMap((part) => (part.type === "text-delta" ? [part.delta] : []));

      assert.deepStrictEqual(text, ['{"result":1}']);
      assert.strictEqual(parts.at(-1)?.type, "finish");
      assert.strictEqual(bodies.length, 1);
      assert.notInclude(bodies[0] ?? "", '"stream":true');
      assert.strictEqual((yield* account.snapshot).calls, 1);
      assert.closeTo((yield* budget.snapshot).knownUsd, 0.002, 1e-9);
    }),
  );
});

const listed = (
  tag: string,
  supported: ReadonlyArray<string>,
  pricing: Record<string, string>,
): Record<string, unknown> => ({
  tag,
  status: 0,
  context_length: 1000,
  supported_parameters: supported,
  pricing,
});

const everything = [
  "max_tokens",
  "reasoning",
  "tools",
  "tool_choice",
  "response_format",
  "structured_outputs",
];

const listing = [
  listed("cheap/fp8", ["max_tokens"], { prompt: "0.0000001", completion: "0.0000001" }),
  listed("fee", everything, { prompt: "0.0000001", completion: "0.0000001", request: "0.01" }),
  listed("image", everything, { prompt: "0.0000001", completion: "0.0000001", image: "0.001" }),
  listed("objects", ["max_tokens", "reasoning", "response_format", "structured_outputs"], {
    prompt: "0.0000001",
    completion: "0.0000002",
  }),
  listed("capable", everything, { prompt: "0.0000002", completion: "0.0000008" }),
  listed("pricey", everything, { prompt: "0.000002", completion: "0.000008" }),
];

describe("endpoint pinning", () => {
  it.effect("keeps only endpoints that serve every sent parameter under the price ceilings", () =>
    Effect.gen(function* () {
      const endpoints = yield* Schema.decodeUnknownEffect(Schema.Array(ListedEndpoint))(listing);

      const operate = eligibleEndpoints(endpoints, {
        maxOutputTokens: 100,
        needs: { tools: true, structuredOutput: true },
      });

      const understand = eligibleEndpoints(endpoints, {
        maxOutputTokens: 100,
        needs: { tools: false, structuredOutput: true },
      });

      assert.deepStrictEqual(
        operate.map((endpoint) => endpoint.tag),
        ["capable", "pricey"],
      );
      assert.deepStrictEqual(
        understand.map((endpoint) => endpoint.tag),
        ["objects", "capable", "pricey"],
      );
      assert.deepStrictEqual(operate[0], {
        tag: "capable",
        contextTokens: 1000,
        outputParameter: "max_tokens",
        inputPerMillion: 0.2,
        outputPerMillion: 0.8,
        requestUsd: 1000 * 0.0000002 + 100 * 0.0000008,
      });
    }),
  );

  it.effect("records the pinned endpoint and sends its exact listed price ceilings", () =>
    Effect.gen(function* () {
      const sent: Array<unknown> = [];

      const stub: typeof globalThis.fetch = async (input, init) => {
        const url =
          typeof input === "string" ? input : input instanceof URL ? input.href : input.url;

        if (url === "https://openrouter.ai/api/v1/models/openai/probe/endpoints")
          return new Response(JSON.stringify({ data: { endpoints: listing } }), {
            headers: { "content-type": "application/json" },
          });
        if (url !== "https://openrouter.ai/api/v1/chat/completions")
          throw new Error("the test refuses " + url);
        sent.push(JSON.parse(await new Response(init?.body).text()));

        return new Response(
          JSON.stringify({
            id: "free-test",
            object: "chat.completion",
            created: 0,
            model: "openai/probe",
            system_fingerprint: null,
            choices: [
              {
                index: 0,
                finish_reason: "stop",
                message: { role: "assistant", content: '{"result":1}' },
              },
            ],
            usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12, cost: 0 },
          }),
          { headers: { "content-type": "application/json" } },
        );
      };

      const result = yield* Effect.gen(function* () {
        const runner = yield* modelRunner({
          model: "openai/probe",
          rates: undefined,
          maxUsd: 1,
          maxOutputTokens: 100,
          needs: { tools: true, structuredOutput: true },
        });

        const account = yield* runner.account;

        yield* runner.withModel(
          LanguageModel.generateObject({
            prompt: "x",
            schema: Schema.Struct({ result: Schema.Finite }),
          }),
          "none",
          account,
        );

        return runner.endpoint;
      }).pipe(
        Effect.provideService(FetchHttpClient.Fetch, stub),
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromUnknown({ OPENROUTER_API_KEY: "test-not-a-key" }),
        ),
      );

      assert.strictEqual(result.tag, "capable");
      assert.lengthOf(sent, 1);
      assert.deepInclude(sent[0], {
        provider: {
          only: ["capable"],
          allow_fallbacks: false,
          require_parameters: true,
          max_price: { prompt: "0.2", completion: "0.8", request: "0", image: "0", audio: "0" },
        },
      });
    }),
  );
});

describe("work deadline", () => {
  const receipt = { prompt_tokens: 1, completion_tokens: 1, cost: 0 };

  it.live("does not count time queued for budget admission", () =>
    Effect.gen(function* () {
      // One reservation fits, so the second call queues until the first settles at 400 ms.
      const budget = yield* ledger(0.04, 0.04);
      const holder = yield* budget.account;
      const queued = yield* budget.account;

      const held = yield* holder
        .run(Effect.sleep("400 millis").pipe(Effect.as(receipt)), (value) => value)
        .pipe(Effect.forkChild);

      yield* Effect.sleep("20 millis");
      const work = queued.run(Effect.sleep("50 millis").pipe(Effect.as(receipt)), (value) => value);

      const exit = yield* work.pipe(
        Effect.raceFirst(workDeadline("200 millis", queued.queued)),
        Effect.exit,
      );

      yield* Fiber.join(held);
      assert.strictEqual(exit._tag, "Success");
      assert.isAtLeast((yield* queued.timing).queueSeconds, 0.3);
    }),
  );

  it.live("still ends work that runs past it", () =>
    Effect.gen(function* () {
      const unfinished = yield* Deferred.make<void>();

      const exit = yield* Deferred.await(unfinished).pipe(
        Effect.raceFirst(workDeadline("100 millis", Effect.succeed(0))),
        Effect.exit,
      );

      assert.isTrue(Exit.isFailure(exit) && Cause.hasFails(exit.cause));
    }),
  );
});

describe("trial ownership", () => {
  it.live(
    "keeps concurrent Chromium trials separate and alive through another trial's cleanup",
    () =>
      Effect.gen(function* () {
        const browserLayer = Chromium.layer();
        const firstFinished = yield* Deferred.make<void>();
        const bothStarted = yield* Deferred.make<void>();
        const active = yield* Ref.make(0);
        const maximum = yield* Ref.make(0);
        const contexts: Array<BrowserContext> = [];

        const completed = yield* Effect.forEach(
          [1, 2, 3],
          (trial) =>
            isolatedTrial(
              Effect.gen(function* () {
                const browser = yield* Browser;

                contexts.push(browser.context);
                const current = yield* Ref.updateAndGet(active, (count) => count + 1);

                yield* Ref.update(maximum, (count) => Math.max(count, current));
                if (current === 2) yield* Deferred.succeed(bothStarted, undefined);

                const page = yield* Effect.promise(() => browser.context.newPage());

                yield* Effect.promise(() => page.setContent(`<input value="trial-${trial}">`));
                if (trial === 1) yield* Deferred.await(bothStarted);
                if (trial === 2) yield* Deferred.await(firstFinished);
                const value = yield* Effect.promise(() => page.locator("input").inputValue());

                yield* Ref.update(active, (count) => count - 1);

                return value;
              }),
              browserLayer,
            ).pipe(
              Effect.tap(() =>
                trial === 1 ? Deferred.succeed(firstFinished, undefined) : Effect.void,
              ),
            ),
          { concurrency: 2 },
        );

        assert.deepStrictEqual(completed, ["trial-1", "trial-2", "trial-3"]);
        assert.strictEqual(yield* Ref.get(maximum), 2);
        assert.strictEqual(new Set(contexts).size, 3);
        assert.isTrue(contexts.every((context) => context.pages().length === 0));
      }),
  );

  it.effect("derives the same fixture seeds independent of ordering", () =>
    Effect.sync(() => {
      const forward = ["checkout", "chart-read"].map((name) => trialSeed(23, name, 1));
      const reverse = ["chart-read", "checkout"].map((name) => trialSeed(23, name, 1)).reverse();

      assert.deepStrictEqual(forward, reverse);
      assert.notStrictEqual(trialSeed(23, "checkout", 1), trialSeed(23, "checkout", 2));
      assert.notStrictEqual(trialSeed(23, "checkout", 1), trialSeed(24, "checkout", 1));
      assert.isTrue(forward.every(Number.isSafeInteger));
    }),
  );
});
