// The bench's own gates for operate tasks: each page varies with the seed, so a task's trials
// sample a family of pages rather than repeat one, and each grader reads the page, so an agent that
// reports the right answer without doing the work fails, while work reported in the wrong form
// still counts on the page. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Chromium from "effect-browser/Chromium";
import type { Prompt } from "effect/ai";

import { tasks } from "../Catalog.ts";
import { frameHistory } from "../Tasks.ts";
import { isolatedTrial } from "../Trial.ts";
import { call, finish, modelOf, scripted, textOf } from "./scripted.ts";

/** An agent that reports this answer at once, without looking at the page. */
const reports = (answer: unknown) =>
  modelOf(() =>
    Effect.succeed([
      { type: "tool-call", id: "call-1", name: "done", params: { answer } },
      {
        type: "finish",
        reason: "tool-calls",
        usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
      },
    ]),
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

          for (const outcome of solved) {
            assert.isTrue(outcome.pass, outcome.detail);
            assert.isTrue(outcome.onPage, outcome.detail);
          }
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
          assert.isFalse(idle.onPage, idle.detail);
        }),
      { timeout: 120_000 },
    );
});

// A ref from an observation, which a tool's result quotes with its quotes escaped.
const refIn = (prompt: Prompt.Prompt, pattern: RegExp) =>
  pattern.exec(textOf(prompt))?.[1] ?? "missing";

describe("work reported in the wrong form", () => {
  it.live("fails the grade but counts on the page", () =>
    Effect.gen(function* () {
      const task = tasks.find((candidate) => candidate.name === "chart-trade");

      if (task === undefined) return yield* Effect.die("the bench has no chart-trade task");

      // The order is placed as asked; its id comes back inside a sentence, as models write it.
      const outcome = yield* isolatedTrial(
        task.withModel({ seed: 1, onUsage: () => Effect.void }),
        browser,
      ).pipe(
        Effect.provide(
          scripted([
            () => [call("observe", {}), finish],
            (prompt) => [
              call("act", {
                actions: [
                  { kind: "click", ref: refIn(prompt, /radio \\"Buy\\" \[ref=(e\d+)\]/) },
                  {
                    kind: "fill",
                    ref: refIn(prompt, /textbox \\"\w+ \(BTC\)\\" \[ref=(e\d+)\]/),
                    value: "0.25",
                  },
                  { kind: "click", ref: refIn(prompt, /button \\"\w+ order\\" \[ref=(e\d+)\]/) },
                ],
              }),
              finish,
            ],
            (prompt) => [
              call("done", {
                answer: {
                  orderId: `Order ${/ORD-\d+/.exec(textOf(prompt))?.[0] ?? "none"} was filled.`,
                },
              }),
              finish,
            ],
          ]).layer,
        ),
      );

      assert.isFalse(outcome.pass, outcome.detail);
      assert.isTrue(outcome.onPage, outcome.detail);
    }),
  );
});
