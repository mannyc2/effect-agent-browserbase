// Yielded agent runs with the browser tools on a real Chromium page, driven by scripted models: no
// model is called.
import { assert, it, layer } from "@effect/vitest";
import { Agent, AgentRuntime, InMemory, Output } from "@yielded/agent";
import { Duration, Effect, Layer, Schema } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { AnthropicStructuredOutput, OpenAiStructuredOutput, type Prompt } from "effect/ai";

import * as BrowserTools from "../src/BrowserTools.ts";
import {
  answer,
  call,
  calling,
  refIn,
  scripted,
  Site,
  SiteLayer,
  textOf,
  type Turn,
} from "./fixtures.ts";

const tools = BrowserTools.make();

const agent = Agent.make("browser-test", {
  input: Schema.String,
  output: Output.text(Schema.String),
  instructions: "Use the browser tools to do the task, then say what you did.",
  toolkit: tools.toolkit,
  policy: { maxTurns: 6, maxToolCalls: 12, maxDuration: "1 minute", toolConcurrency: 1 },
});

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) =>
      Effect.ignore(page.close),
    );
  });

const pictures = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.filter((part) => part.type === "file") : [],
  );

const run = (task: string, turns: ReadonlyArray<Turn>, options: BrowserTools.LayerOptions = {}) =>
  Effect.gen(function* () {
    const page = yield* open(task.includes("spin") ? "/slots" : "/form");
    const model = scripted(turns);

    const result = yield* AgentRuntime.run(agent, task).pipe(
      Effect.provide(
        Layer.mergeAll(tools.layer({ page }, { task, ...options }), InMemory.layer, model.layer),
      ),
    );

    return { page, result, prompts: model.prompts };
  });

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("BrowserTools", (it) => {
  it.effect("runs an agent on a page, showing it the current screen before every turn", () =>
    Effect.gen(function* () {
      const { page, result, prompts } = yield* run("Order 25 Ethereum", [
        () => calling(call("observe", {})),
        (prompt) =>
          calling(
            call("act", {
              actions: [
                { kind: "fill", ref: refIn(prompt, "textbox", "Amount"), value: "25" },
                { kind: "select", ref: refIn(prompt, "combobox", "Coin"), value: "Ethereum" },
                { kind: "click", ref: refIn(prompt, "button", "Submit") },
              ],
            }),
          ),
        () => answer("Ordered 25 Ethereum."),
      ]);

      assert.strictEqual(result.output, "Ordered 25 Ethereum.");
      assert.strictEqual(
        yield* Effect.promise(() => page.playwright.textContent("#outcome")),
        "Ordered 25 eth",
      );
      assert.strictEqual(prompts.length, 3);
      // Each request shows the screen as it is, and never an earlier one.
      for (const prompt of prompts) {
        assert.strictEqual(pictures(prompt).length, 1);
        assert.strictEqual(prompt.content.at(-1)?.role, "user");
      }
      assert.include(textOf(prompts[2]!), '\\"Not ordered\\" became \\"Ordered 25 eth\\"');
    }),
  );

  it.effect("plays a canvas by point, and shows a crop before the next turn", () =>
    Effect.gen(function* () {
      const { page, prompts } = yield* run("Press spin once", [
        () => calling(call("click_at", { x: 300, y: 320 }), call("wait_still", { seconds: 10 })),
        () => calling(call("zoom", { x: 50, y: 60, width: 150, height: 180 })),
        () => answer("Spun once."),
      ]);

      const state = yield* Effect.promise(() =>
        page.playwright.evaluate(() => (window as unknown as { state: { spins: number } }).state),
      );

      assert.strictEqual(state.spins, 1);
      assert.include(textOf(prompts[1]!), "The screen is still.");
      assert.strictEqual(pictures(prompts[2]!).length, 2);
      assert.include(textOf(prompts[2]!), "Zoom: viewport origin (50, 60), 150x180");
      // The crop is shown once, before the turn after it was taken.
      assert.strictEqual(pictures(prompts[1]!).length, 1);
    }),
  );

  it.effect("shows no pictures without vision, and refuses a crop it could not show", () =>
    Effect.gen(function* () {
      const { prompts } = yield* run(
        "Press spin once",
        [
          () => calling(call("zoom", { x: 0, y: 0, width: 10, height: 10 })),
          () => answer("No crop."),
        ],
        { vision: false },
      );

      assert.deepStrictEqual(prompts.map(pictures), [[], []]);
      assert.include(textOf(prompts[1]!), "a crop cannot be shown");
    }),
  );
});

it("gives every tool parameters both pinned providers' structured outputs accept", () => {
  const all = {
    ...BrowserTools.make().toolkit.tools,
    ...BrowserTools.make({ mode: "single" }).toolkit.tools,
  };

  // Each provider's codec takes any schema; a tool's own parameters are one.
  const schemas: ReadonlyArray<[string, Schema.Top]> = Object.entries(all).map(([name, tool]) => [
    name,
    tool.parametersSchema,
  ]);

  const refused = schemas.flatMap(([name, schema]) =>
    [OpenAiStructuredOutput.toCodecOpenAI, AnthropicStructuredOutput.toCodecAnthropic].flatMap(
      (codec) => {
        try {
          codec(schema);

          return [];
        } catch (error) {
          return [`${name}: ${String(error)}`];
        }
      },
    ),
  );

  assert.deepStrictEqual(refused, []);
});
