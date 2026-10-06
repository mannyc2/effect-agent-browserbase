// Free checks of the judges bench: its opt-in, and Jev's admission and charge.
import { TypeSafeClient } from "@effect/ai-typesafe";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import { HttpClient } from "effect/http";

import { ledger } from "../Budget.ts";
import { budgetedTypeSafe, jevReservation, options } from "../judges.ts";

const refusal = (args: ReadonlyArray<string>, live: boolean) =>
  options(args, live).pipe(
    Effect.match({ onFailure: (error) => error.message, onSuccess: () => "accepted" }),
  );

describe("judges", () => {
  it.effect("runs only the free arm unless paid arms are opted into", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual((yield* options([], false)).arms, ["structure"]);
      assert.deepStrictEqual(
        yield* Effect.all([
          refusal(["--arm", "decider"], false),
          refusal(["--arm", "reviewer"], true),
          refusal(["--arm", "reviewer", "--model", "openai/gpt-6-luna"], true),
          refusal(["--arm", "oracle"], true),
          refusal(["--arm", "decider", "--arm", "decider"], true),
        ]),
        [
          "Model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them.",
          "The reviewer needs --model, an OpenRouter model.",
          "accepted",
          "--arm takes structure, reviewer, decider, escalate, each once.",
          "--arm takes structure, reviewer, decider, escalate, each once.",
        ],
      );
    }),
  );

  it.effect("admits each Jev request against the budget and charges its input tokens", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(1, jevReservation);

      const ask = (inputTokens: number) =>
        Effect.gen(function* () {
          const account = yield* budget.account;

          const answered = Layer.succeed(
            TypeSafeClient.TypeSafeClient,
            TypeSafeClient.TypeSafeClient.of({
              client: HttpClient.make(() => Effect.die("no HTTP in this test")),
              systemOne: () =>
                Effect.succeed({
                  model: "jev-1.13.0",
                  answers: {},
                  usage: { input_tokens: inputTokens, output_tokens: 7 },
                }),
              listModels: () => Effect.die("not asked"),
            }),
          );

          const client = yield* TypeSafeClient.TypeSafeClient.pipe(
            Effect.provide(budgetedTypeSafe(account).pipe(Layer.provide(answered))),
          );

          const outcome = yield* client
            .systemOne({ model: "jev-1.13.0", state: {}, questions: {} })
            .pipe(Effect.match({ onFailure: (error) => error.message, onSuccess: () => "ok" }));

          return { outcome, spent: yield* account.snapshot };
        });

      const charged = yield* ask(1_000);

      assert.strictEqual(charged.outcome, "ok");
      assert.strictEqual(charged.spent.calls, 1);
      // The ledger rounds each charge up to the next billionth of a dollar.
      assert.closeTo(charged.spent.knownUsd, 0.000042, 1e-9);

      // More than a 64k-token request can hold exceeds the reservation, and stops the budget.
      const exceeded = yield* ask(100_000);

      assert.include(exceeded.outcome, "exceeded its enforced price/token bounds");
      assert.strictEqual(yield* budget.halted, "charge-exceeded-bound");
    }),
  );
});
