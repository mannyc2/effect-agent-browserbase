// Free checks of the judges command: its opt-in, and Jev's admission and charge.
import { TypeSafeClient } from "@effect/ai-typesafe";
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Layer, Result } from "effect";
import { Command } from "effect/cli";
import { HttpClient } from "effect/http";

import { ledger } from "../Budget.ts";
import { admit, budgetedTypeSafe, command, jevReservation, type Options } from "../judges.ts";

const refusal = (fields: Partial<Options>, live: boolean) =>
  admit({
    arms: ["structure"],
    model: undefined,
    jev: "jev-1.13.0",
    threshold: 0.5,
    maxUsd: 0.5,
    concurrency: 4,
    out: undefined,
    ...fields,
  }).pipe(
    Effect.match({ onFailure: (error) => error.message, onSuccess: () => "accepted" }),
    Effect.provide(
      ConfigProvider.layer(
        ConfigProvider.fromUnknown(live ? { EFFECT_BROWSER_BENCH_LIVE: "1" } : {}),
      ),
    ),
  );

describe("judges", () => {
  it.effect("runs only the free arm unless paid arms are opted into", () =>
    Effect.gen(function* () {
      assert.deepStrictEqual(
        yield* Effect.all([
          refusal({}, false),
          refusal({ arms: ["decider"] }, false),
          refusal({ arms: ["reviewer"] }, true),
          refusal({ arms: ["reviewer"], model: "openai/gpt-6-luna" }, true),
          refusal({ arms: ["decider", "decider"] }, true),
        ]),
        [
          "accepted",
          "Model calls cost money: set EFFECT_BROWSER_BENCH_LIVE=1 to make them.",
          "The reviewer needs --model, an OpenRouter model.",
          "accepted",
          "--arm takes structure, reviewer, decider, escalate, each once.",
        ],
      );

      const unknown = yield* Command.runWith(command, { version: "test" })([
        "--arm",
        "oracle",
      ]).pipe(Effect.provide(NodeServices.layer), Effect.result);

      // A flag the command line rejects shows the help, with the reason.
      assert.isTrue(
        Result.isFailure(unknown) &&
          unknown.failure._tag === "ShowHelp" &&
          unknown.failure.errors.some((error) => error._tag === "InvalidValue"),
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
