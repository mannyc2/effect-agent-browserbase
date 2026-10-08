// One outcome policy for both runners: which exits are graded answers and which are not.
import { assert, describe, it } from "@effect/vitest";
import { Cause, Effect, Exit } from "effect";
import { AgentError, GaveUp, StepLimit } from "effect-browser/Agent";
import { BrowserError, Closed } from "effect-browser/BrowserError";
import { AiError, Prompt } from "effect/ai";

import { type Calls, emptyAccounting, ledger, noCalls } from "../Budget.ts";
import { classify, EvidenceIncomplete, notAdmitted, tally } from "../Trial.ts";

const answered: Calls = {
  accounting: { ...emptyAccounting, calls: 1, knownUsd: 0.01 },
  lastResponse: {
    call: 1,
    httpStatus: 200,
    choiceCount: 1,
    finishReason: "stop",
    contentKind: "text",
    reasoningPresent: false,
    toolCallCount: 0,
  },
  refusal: null,
  halt: null,
};

const aiError = (reason: AiError.AiErrorReason) =>
  AiError.make({ module: "LanguageModel", method: "generateObject", reason });

const malformed = aiError(
  new AiError.StructuredOutputError({ description: "not JSON", responseText: "{" }),
);

// What a run that ended without an answer had spent and said, which classifying ignores.
const spent = {
  usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 },
  history: Prompt.empty,
};

describe("classify", () => {
  it("grades answers, give-ups and malformed output after an accounted receipt", () => {
    assert.deepStrictEqual(classify(Exit.succeed({ pass: false }), answered), {
      status: "graded",
      reason: "answered",
      pass: false,
    });
    assert.deepStrictEqual(classify(Exit.fail(malformed), answered), {
      status: "graded",
      reason: "invalid-output",
      pass: false,
    });
    assert.deepStrictEqual(
      classify(
        Exit.fail(
          aiError(
            new AiError.ToolParameterValidationError({
              toolName: "browser_click",
              description: "not JSON",
            }),
          ),
        ),
        answered,
      ),
      { status: "graded", reason: "invalid-output", pass: false },
    );
    assert.deepStrictEqual(
      classify(
        Exit.fail(new AgentError({ reason: new StepLimit({ steps: 3 }), steps: 3, ...spent })),
        answered,
      ),
      { status: "graded", reason: "step-limit", pass: false },
    );
    assert.deepStrictEqual(
      classify(
        Exit.fail(
          new AgentError({ reason: new GaveUp({ reason: "blocked" }), steps: 2, ...spent }),
        ),
        answered,
      ),
      { status: "graded", reason: "gave-up", pass: false },
    );
  });

  it("never counts a failure without a decoded, accounted answer as a wrong answer", () => {
    // The receipt belongs to an earlier call; the failing call never produced a decoded response.
    const earlier: Calls = { ...answered, accounting: { ...answered.accounting, calls: 2 } };
    const outage = aiError(new AiError.InternalProviderError({ description: "outage" }));

    for (const [exit, calls, reason] of [
      [Exit.fail(malformed), earlier, "provider-failed"],
      [Exit.fail(malformed), noCalls, "provider-failed"],
      [Exit.fail(outage), answered, "provider-failed"],
      [
        Exit.fail(new EvidenceIncomplete({ detail: "1 of 2 frames" })),
        noCalls,
        "evidence-incomplete",
      ],
      [Exit.fail(new Cause.TimeoutError()), noCalls, "timed-out"],
      [Exit.die(new Error("fixture never settled")), noCalls, "defect"],
      [Exit.fail(outage), { ...answered, refusal: "bound" }, "charge-exceeded-bound"],
      // A later call refused because an earlier request has an unknown outcome.
      [Exit.fail(malformed), { ...answered, refusal: "unresolved" }, "provider-failed"],
    ] as const) {
      assert.deepStrictEqual(classify(exit, calls), {
        status: "infrastructure-failed",
        reason,
        pass: null,
      });
    }
    assert.strictEqual(
      classify(
        Exit.fail(
          new BrowserError({
            operation: "goto",
            reason: new Closed({ cause: "page" }),
            dispatched: false,
          }),
        ),
        noCalls,
      ).reason,
      "browser-failed",
    );
  });

  it.effect("denies an arm whose admission the budget refused, and keeps interruptions unrun", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.04, 0.04);
      const first = yield* budget.account;
      const second = yield* budget.account;

      yield* first.run(
        Effect.succeed({ prompt_tokens: 1, completion_tokens: 1 }),
        (value) => value,
      );

      const refused = yield* second
        .run(Effect.succeed({ prompt_tokens: 1, completion_tokens: 1 }), (value) => value)
        .pipe(Effect.as({ pass: true }), Effect.exit);

      assert.deepStrictEqual(classify(refused, yield* second.calls), {
        status: "denied",
        reason: "budget-exhausted",
        pass: null,
      });
      assert.deepStrictEqual(classify(Exit.failCause(Cause.interrupt()), answered), {
        status: "unrun",
        reason: "interrupted",
        pass: null,
      });
    }),
  );

  it.effect("labels every unit refused after a charge above its bound with that stop", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(1, 0.04);
      const overcharged = yield* budget.account;
      const later = yield* budget.account;
      const receipt = (cost: number) => ({ prompt_tokens: 1, completion_tokens: 1, cost });

      const first = yield* overcharged
        .run(Effect.succeed(receipt(0.05)), (value) => value)
        .pipe(Effect.as({ pass: true }), Effect.exit);

      const refused = yield* later
        .run(Effect.succeed(receipt(0.01)), (value) => value)
        .pipe(Effect.as({ pass: true }), Effect.exit);

      assert.strictEqual(classify(first, yield* overcharged.calls).reason, "charge-exceeded-bound");
      assert.deepStrictEqual(classify(refused, yield* later.calls), {
        status: "unrun",
        reason: "stopped-after-charge-bound",
        pass: null,
      });
      // A unit the runner never starts gets the same label from the ledger's halt.
      assert.deepStrictEqual(notAdmitted(yield* budget.halted), {
        status: "unrun",
        reason: "stopped-after-charge-bound",
        pass: null,
      });
      assert.deepStrictEqual(notAdmitted(null), {
        status: "denied",
        reason: "budget-exhausted",
        pass: null,
      });
    }),
  );

  it("keeps graded denominators apart from units without an answer", () => {
    assert.deepStrictEqual(
      tally([
        { status: "graded", pass: true },
        { status: "graded", pass: false },
        { status: "infrastructure-failed", pass: null },
        { status: "denied", pass: null },
        { status: "unrun", pass: null },
      ]),
      {
        scheduled: 5,
        graded: 2,
        passed: 1,
        failed: 1,
        infrastructureFailed: 1,
        denied: 1,
        unrun: 1,
      },
    );
  });
});
