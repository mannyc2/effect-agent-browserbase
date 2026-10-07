// The paid opt-ins: without its variable set to 1, `run` refuses a model or a hosted browser before
// it reaches either. Free, with no network.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Result } from "effect";
import { Command } from "effect/cli";

import * as Run from "../run.ts";

const refusal = (args: ReadonlyArray<string>, environment: Record<string, string>) =>
  Command.runWith(Run.command, { version: "test" })(args).pipe(
    Effect.provide([
      NodeServices.layer,
      ConfigProvider.layer(ConfigProvider.fromUnknown(environment)),
    ]),
    Effect.result,
    Effect.map((ended) => (Result.isFailure(ended) ? ended.failure : undefined)),
  );

describe("run's opt-ins", () => {
  it.effect("refuse model calls unless EFFECT_BROWSER_BENCH_LIVE is 1", () =>
    Effect.gen(function* () {
      const environments: ReadonlyArray<Record<string, string>> = [
        {},
        { EFFECT_BROWSER_BENCH_LIVE: "0" },
      ];

      for (const environment of environments) {
        const error = yield* refusal(["--model", "openai/gpt-6-luna"], environment);

        assert.strictEqual(error?._tag, "BenchError");
        assert.include(error?.message, "EFFECT_BROWSER_BENCH_LIVE=1");
      }
    }),
  );

  it.effect("refuse Browserbase sessions unless EFFECT_BROWSER_BENCH_HOSTED is 1", () =>
    Effect.gen(function* () {
      const error = yield* refusal(["--browser", "browserbase"], {
        EFFECT_BROWSER_BENCH_LIVE: "1",
        EFFECT_BROWSER_BENCH_HOSTED: "yes",
      });

      assert.strictEqual(error?._tag, "BenchError");
      assert.include(error?.message, "EFFECT_BROWSER_BENCH_HOSTED=1");
    }),
  );
});
