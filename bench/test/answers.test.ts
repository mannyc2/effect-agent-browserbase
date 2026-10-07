// The bench's gate for understand tasks: each task's scripted solution passes, and a model that
// gives one seed's right answer on another seed's page fails, so no constant answer passes a task
// and each grader reads what the page holds. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel } from "effect/ai";

import { tasks } from "../Catalog.ts";
import { frameHistory } from "../Tasks.ts";
import { isolatedTrial } from "../Trial.ts";

/** A describer that gives this answer, whatever it is shown. */
const says = (answer: unknown) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { type: "text", text: JSON.stringify(answer) },
          {
            type: "finish",
            reason: "stop",
            usage: { inputTokens: { total: 1200 }, outputTokens: { total: 40 } },
          },
        ]),
      streamText: () => Stream.empty,
    }),
  );

const browser = Chromium.layer({ frameHistory });

// A sharp move and its control have one right answer each, on every seed: the answer is the
// task's class. grading.test.ts holds a constant answer to passing at most one of the two.
const classes: ReadonlySet<string> = new Set(["chart-spike", "chart-calm"]);

const understand = tasks.filter((task) => task.kind === "understand");

describe("understand tasks", () => {
  for (const task of understand.filter((candidate) => !classes.has(candidate.name)))
    it.live(
      `${task.name} passes its scripted solution and fails another seed's answer`,
      () =>
        Effect.gen(function* () {
          const solved = yield* isolatedTrial(task.scripted({ seed: 1 }), browser);

          assert.isTrue(solved.pass, solved.detail);

          const constant = yield* isolatedTrial(
            task.withModel({ seed: 2, onUsage: () => Effect.void }),
            browser,
          ).pipe(Effect.provide(says(solved.answer)));

          assert.isFalse(constant.pass, constant.detail);
        }),
      { timeout: 120_000 },
    );

  for (const task of understand.filter((candidate) => classes.has(candidate.name)))
    it.live(`${task.name} passes its scripted solution`, () =>
      isolatedTrial(task.scripted({ seed: 1 }), browser).pipe(
        Effect.map((solved) => assert.isTrue(solved.pass, solved.detail)),
      ),
    );
});
