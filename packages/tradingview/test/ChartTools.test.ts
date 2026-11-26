// The browser tools and the chart's in a plain effect/ai loop, over a stand-in for TradingView's
// widget on a real Chromium page, driven by a scripted model: no model is called.
import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer } from "effect";
import { BrowserTools } from "effect-browser/ai";
import { Browser } from "effect-browser/Browser";
import { TestModel } from "effect-browser/testing";
import { LanguageModel, Prompt, Toolkit } from "effect/ai";

import * as Chart from "../src/Chart.ts";
import * as ChartTools from "../src/ChartTools.ts";
import { chartOn, position, recorded, time } from "./fixture.ts";

const tools = BrowserTools.make();

const toolkit = Toolkit.merge(tools.toolkit, ChartTools.Reads, ChartTools.Writes);

// The task to the model's answer: each turn's calls run in order, and join the thread with their
// results.
const run = (task: string) =>
  Effect.gen(function* () {
    let thread = Prompt.make(task);

    for (;;) {
      const response = yield* LanguageModel.generateText({
        prompt: thread,
        toolkit,
        concurrency: 1,
      });

      thread = Prompt.concat(thread, Prompt.fromResponseParts(response.content));
      if (response.toolCalls.length === 0) return response.text;
    }
  });

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

        const answer = yield* run(task).pipe(
          Effect.provide(
            Layer.mergeAll(
              ChartTools.layer.pipe(Layer.provideMerge(tools.layer({ page }, { task }))),
              TestModel.layer([
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

        assert.strictEqual(answer, "Clicked and drew.");
        assert.deepStrictEqual((yield* recorded(page)).clicks, [position(70, 180)]);
        assert.deepStrictEqual(
          (yield* Chart.state(page)).drawings.map(({ name, points }) => [name, points]),
          [["horizontal_line", [{ time: time(99), price: 175 }]]],
        );
      }),
    );
  },
);
