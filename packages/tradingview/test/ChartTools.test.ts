// A Yielded agent run with the browser tools and the chart's, over a stand-in for TradingView's
// widget on a real Chromium page, driven by a scripted model: no model is called.
import { assert, layer } from "@effect/vitest";
import { Agent, AgentRuntime, InMemory, Output } from "@yielded/agent";
import { Duration, Effect, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/BrowserTools";
import { TestModel } from "effect-agent-browser/testing";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, Model, Toolkit } from "effect/ai";

import * as Chart from "../src/Chart.ts";
import * as ChartTools from "../src/ChartTools.ts";
import { chartOn, position, recorded, time } from "./fixture.ts";

const tools = BrowserTools.make();

const agent = Agent.make("chart-test", {
  input: Schema.String,
  output: Output.text(Schema.String),
  instructions: "Use the tools to do the task, then say what you did.",
  toolkit: Toolkit.merge(tools.toolkit, ChartTools.Reads, ChartTools.Writes),
  policy: { maxTurns: 6, maxToolCalls: 12, maxDuration: "1 minute", toolConcurrency: 1 },
});

const scripted = (turns: ReadonlyArray<TestModel.Turn>) =>
  Model.make(
    "scripted",
    "test-model",
    Layer.effect(LanguageModel.LanguageModel, LanguageModel.LanguageModel).pipe(
      Layer.provide(TestModel.layer(turns)),
    ),
  );

const reply = (call: ReturnType<typeof TestModel.call>) =>
  Effect.succeed(TestModel.reply(TestModel.calling(call)));

// The last viewport point a tool result in the prompt gave.
const pointIn = (request: TestModel.Request) => {
  const found = [...TestModel.textOf(request.prompt).matchAll(/"x":([\d.]+),"y":([\d.]+)/g)].at(-1);

  return { x: Number(found?.[1]), y: Number(found?.[2]) };
};

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "ChartTools",
  (it) => {
    it.effect("reads a chart point, clicks it with the pointer, and draws through the API", () =>
      Effect.gen(function* () {
        const page = yield* (yield* Browser).newPage("about:blank");
        const task = "Click the 70th bar at 180, then draw a level at 175.";

        yield* chartOn(page);

        const result = yield* AgentRuntime.run(agent, task).pipe(
          Effect.provide(
            Layer.mergeAll(
              ChartTools.layer.pipe(Layer.provideMerge(tools.layer({ page }, { task }))),
              InMemory.layer,
              scripted([
                () =>
                  reply(
                    TestModel.call("chart_point", { points: [{ time: time(70), price: 180 }] }),
                  ),
                (request) => reply(TestModel.call("click_at", pointIn(request))),
                () =>
                  reply(
                    TestModel.call("chart_draw", {
                      shape: "horizontal_line",
                      points: [{ time: time(99), price: 175 }],
                    }),
                  ),
                () => Effect.succeed(TestModel.reply(TestModel.text("Clicked and drew."))),
              ]),
            ),
          ),
        );

        assert.strictEqual(result.output, "Clicked and drew.");
        assert.deepStrictEqual((yield* recorded(page)).clicks, [position(70, 180)]);
        assert.deepStrictEqual(
          (yield* Chart.state(page)).drawings.map(({ name, points }) => [name, points]),
          [["horizontal_line", [{ time: time(99), price: 175 }]]],
        );
      }),
    );
  },
);
