// Deterministic free checks of shared admission, raw receipts and real browser ownership.
import { OpenRouterClient, OpenRouterLanguageModel } from "@effect/ai-openrouter";
import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Ref, Schema } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";
import type { BrowserContext } from "playwright-core";

import { budgetedClient, ledger } from "../Budget.ts";
import { isolatedTrial, trialSeed } from "../Trial.ts";

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
