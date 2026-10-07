// The bench's own gates for operate tasks: each page varies with the seed, so a task's trials
// sample a family of pages rather than repeat one, and each grader reads the page, so an agent that
// reports the right answer without doing the work fails, while work reported in the wrong form
// still counts on the page. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, type Prompt, type Response } from "effect/ai";

import { tasks } from "../Catalog.ts";
import { frameHistory } from "../Tasks.ts";
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

/** The text a model was shown: instructions, the page's outline and tool results. */
const shown = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text"
              ? [part.text]
              : part.type === "tool-result"
                ? [JSON.stringify(part.result)]
                : [],
          ),
    )
    .join("\n");

/** A model that answers each call with the next turn of `script`, given what it was shown. */
const scripted = (script: ReadonlyArray<(text: string) => ReadonlyArray<Response.PartEncoded>>) => {
  let turn = 0;

  return Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: (options) =>
        Effect.suspend(() => {
          const next = script[turn];

          turn += 1;

          return next === undefined
            ? Effect.die(`no turn ${turn} in the script`)
            : Effect.succeed([...next(shown(options.prompt))]);
        }),
      streamText: () => Stream.empty,
    }),
  );
};

const finish: Response.PartEncoded = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
};

const refIn = (text: string, pattern: RegExp) => pattern.exec(text)?.[1] ?? "missing";

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
            (text) => [
              {
                type: "tool-call",
                id: "call-1",
                name: "browser_click",
                params: { ref: refIn(text, /radio "Buy" \[ref=(e\d+)\]/) },
              },
              {
                type: "tool-call",
                id: "call-2",
                name: "browser_type",
                params: { ref: refIn(text, /textbox "\w+ \(BTC\)" \[ref=(e\d+)\]/), text: "0.25" },
              },
              {
                type: "tool-call",
                id: "call-3",
                name: "browser_click",
                params: { ref: refIn(text, /button "\w+ order" \[ref=(e\d+)\]/) },
              },
              finish,
            ],
            (text) => [
              {
                type: "tool-call",
                id: "call-4",
                name: "done",
                params: {
                  answer: { orderId: `Order ${/ORD-\d+/.exec(text)?.[0] ?? "none"} was filled.` },
                },
              },
              finish,
            ],
          ]),
        ),
      );

      assert.isFalse(outcome.pass, outcome.detail);
      assert.isTrue(outcome.onPage, outcome.detail);
    }),
  );
});
