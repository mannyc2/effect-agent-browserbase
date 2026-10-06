// The spend ledger stops a model run at the call that reaches the budget: no model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel } from "effect/ai";

import { ledger } from "../run.ts";
import { tasks } from "../Tasks.ts";

let calls = 0;

/** A model that never finishes: every call reads the page again, for 1,000 input tokens. */
const endless = Layer.effect(
  LanguageModel.LanguageModel,
  LanguageModel.make({
    generateText: () =>
      Effect.sync(() => {
        calls += 1;

        return [
          { type: "tool-call", id: `call-${calls}`, name: "browser_snapshot", params: {} },
          {
            type: "finish",
            reason: "tool-calls",
            usage: { inputTokens: { total: 1000 }, outputTokens: { total: 0 } },
          },
        ];
      }),
    streamText: () => Stream.empty,
  }),
);

describe("ledger", () => {
  it.live("stops a model run at the call that reaches the budget", () =>
    Effect.gen(function* () {
      // $1 per million tokens makes each call $0.001, so the third reaches $0.0025.
      const budget = yield* ledger({ input: 1e-6, cachedInput: 1e-6, output: 1e-6 }, 0.0025);
      const checkout = tasks.find((task) => task.name === "checkout");

      assert.isDefined(checkout);

      const error = yield* budget
        .run(checkout!)
        .pipe(Effect.provide(Layer.merge(Chromium.layer(), endless)), Effect.flip);

      assert.include(error.message, "budget");
      assert.strictEqual(calls, 3);
      assert.isTrue(yield* budget.exhausted);
      assert.closeTo(yield* budget.spent, 0.003, 1e-9);
    }),
  );
});
