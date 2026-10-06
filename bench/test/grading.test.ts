// Grading, against models scripted to be wrong or blindly sure: no model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Layer, Stream } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, type Response } from "effect/ai";

import { tasks } from "../Tasks.ts";

/** A model that answers every call with the same parts. */
const answering = (parts: ReadonlyArray<Response.PartEncoded>) =>
  Layer.effect(
    LanguageModel.LanguageModel,
    LanguageModel.make({
      generateText: () => Effect.succeed([...parts]),
      streamText: () => Stream.empty,
    }),
  );

const usage = { inputTokens: { total: 1200 }, outputTokens: { total: 40 } };

/** A describer that gives this answer whatever it is shown. */
const says = (answer: unknown) =>
  answering([
    { type: "text", text: JSON.stringify(answer) },
    { type: "finish", reason: "stop", usage },
  ]);

/** An agent that reports this answer at once, without looking. */
const reports = (answer: unknown) =>
  answering([
    { type: "tool-call", id: "call-1", name: "done", params: { answer } },
    { type: "finish", reason: "tool-calls", usage },
  ]);

const run = (name: string, model: Layer.Layer<LanguageModel.LanguageModel>) => {
  const task = tasks.find((candidate) => candidate.name === name);

  if (task === undefined) throw new Error(`no task ${name}`);

  return task
    .withModel({ onUsage: () => Effect.void })
    .pipe(Effect.provide(Layer.merge(Chromium.layer(), model)));
};

describe("grading", () => {
  it.live("a made-up confirmation number fails checkout", () =>
    run("checkout", reports({ confirmation: "CONF-00000" })).pipe(
      Effect.map((outcome) => {
        assert.isFalse(outcome.pass, outcome.detail);
        assert.strictEqual(outcome.steps, 1);
        assert.strictEqual(outcome.usage.inputTokens, 1200);
      }),
    ),
  );

  it.live("a misread price fails chart-read", () =>
    run("chart-read", says({ lastPrice: 1, trend: "up" })).pipe(
      Effect.map((outcome) => assert.isFalse(outcome.pass, outcome.detail)),
    ),
  );

  it.live("a model that always sees a sharp rise passes chart-spike and fails its control", () =>
    Effect.gen(function* () {
      const sure = says({ movedSharply: true, direction: "up" });
      const spike = yield* run("chart-spike", sure);
      const calm = yield* run("chart-calm", sure);

      assert.isTrue(spike.pass, spike.detail);
      assert.isFalse(calm.pass, calm.detail);
    }),
  );
});
