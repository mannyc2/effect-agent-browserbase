// The contract command, free: its opt-in, its verdicts, and the checks against the package's fake.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { ConfigProvider, Effect, Result } from "effect";
import { BrowserbaseError, Unauthorized } from "effect-browserbase/BrowserbaseError";
import { BrowserbaseContract, TestBrowserbase } from "effect-browserbase/testing";
import { Command } from "effect/cli";

import * as Contract from "../contract.ts";

const held = (name: string): BrowserbaseContract.Check => ({
  name,
  clock: false,
  run: Effect.void,
});

describe("contract", () => {
  it.effect("refuses to open sessions unless EFFECT_BROWSER_BENCH_HOSTED is 1", () =>
    Effect.gen(function* () {
      const ended = yield* Command.runWith(Contract.command, { version: "test" })([]).pipe(
        Effect.provide([
          NodeServices.layer,
          ConfigProvider.layer(ConfigProvider.fromUnknown({ BROWSERBASE_API_KEY: "unused" })),
        ]),
        Effect.result,
      );

      assert.isTrue(Result.isFailure(ended));
      if (Result.isSuccess(ended)) return;
      assert.strictEqual(ended.failure._tag, "BenchError");
      assert.include(ended.failure.message, "EFFECT_BROWSER_BENCH_HOSTED=1");
    }),
  );

  it.effect("says which checks held, which broke and which could not run", () =>
    Effect.gen(function* () {
      const verdicts = yield* Contract.verify([
        held("holds"),
        {
          name: "breaks",
          clock: false,
          run: Effect.fail(new BrowserbaseContract.Broken({ check: "breaks", detail: "it ran" })),
        },
        {
          name: "cannot ask",
          clock: false,
          run: Effect.fail(
            new BrowserbaseError({
              operation: "getSession",
              reason: new Unauthorized({ detail: "key for project 1234 refused" }),
            }),
          ),
        },
        { ...held("moves the test clock"), clock: true },
      ]).pipe(Effect.provide(TestBrowserbase.layer()));

      assert.deepStrictEqual(verdicts, [
        { _tag: "Held", check: "holds" },
        { _tag: "Broken", check: "breaks", detail: "it ran" },
        // The reason's own text is left out: Browserbase's can name the project or a session.
        { _tag: "Unrun", check: "cannot ask", detail: "getSession: Unauthorized" },
      ]);
    }),
  );

  it.live("finds the package's fake faithful to every check it can run", () =>
    Effect.gen(function* () {
      const verdicts = yield* Contract.verify(BrowserbaseContract.checks).pipe(
        Effect.provide(TestBrowserbase.layer()),
      );

      assert.isAbove(verdicts.length, 0);
      for (const verdict of verdicts) assert.strictEqual(verdict._tag, "Held", verdict.check);
    }),
  );
});
