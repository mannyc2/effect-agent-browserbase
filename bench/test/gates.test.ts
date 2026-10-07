// The bench's own gates for operate tasks: each page varies with the seed, so a task's trials
// sample a family of pages rather than repeat one, and each grader reads the page, so an agent that
// reports the right answer without doing the work fails. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel } from "effect/ai";

import { frameHistory, tasks } from "../Tasks.ts";
import { isolatedTrial } from "../Trial.ts";

/** An agent that reports this answer at once, without looking at the page. */
const reports = (answer: unknown) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () =>
        Effect.succeed([
          { type: "tool-call", id: "call-1", name: "done", params: { answer } },
          {
            type: "finish",
            reason: "tool-calls",
            usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
          },
        ]),
      streamText: () => Stream.empty,
    }),
  );

const browser = Chromium.layer({ frameHistory });

describe("operate tasks", () => {
  for (const task of tasks.filter((candidate) => candidate.kind === "operate"))
    it.live(
      `${task.name} varies with the seed, and fails the right answer reported without the work`,
      () =>
        Effect.gen(function* () {
          const solved = yield* Effect.forEach(
            [1, 2, 3],
            (seed) => isolatedTrial(task.scripted({ seed }), browser),
            { concurrency: 2 },
          );

          for (const outcome of solved) assert.isTrue(outcome.pass, outcome.detail);
          assert.isAbove(
            new Set(solved.map((outcome) => JSON.stringify(outcome.answer))).size,
            1,
            "every seed gave the same answer",
          );

          const idle = yield* isolatedTrial(
            task.withModel({ seed: 1, onUsage: () => Effect.void }),
            browser,
          ).pipe(Effect.provide(reports(solved[0]?.answer)));

          assert.isFalse(idle.pass, idle.detail);
        }),
      { timeout: 120_000 },
    );
});
