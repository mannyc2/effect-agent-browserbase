// Yielded agent runs with the browser tools on a real Chromium page, driven by scripted models: no
// model is called.
import { assert, it, layer } from "@effect/vitest";
import { Agent, AgentRuntime, InMemory, Output } from "@yielded/agent";
import { CompactionPolicy } from "@yielded/agent/agent-policy";
import { estimateMessageTokens } from "@yielded/agent/compaction";
import { ContextCompactor } from "@yielded/agent/context-compactor";
import { ModelCallContext } from "@yielded/agent/context-window";
import { RunContextPreparation } from "@yielded/agent/run-options";
import { Duration, Effect, Layer, Option, Schema, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import type * as Moment from "effect-browser/Moment";
import { AnthropicStructuredOutput, OpenAiStructuredOutput, Prompt, Toolkit } from "effect/ai";

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

const files = (message: Prompt.Message | undefined) =>
  message?.role === "user" ? message.content.filter((part) => part.type === "file") : [];

// The run's first user message is its input; accounts precede the recent image references.
const moments = (prompt: Prompt.Prompt) =>
  prompt.content
    .filter((message) => message.role === "user" && files(message).length === 0)
    .slice(1);

const references = (prompt: Prompt.Prompt) =>
  prompt.content.filter((message) => files(message).length > 0);

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

  it.effect(
    "keeps a moment of the tab after each turn's results, pictured for the latest few",
    () =>
      Effect.gen(function* () {
        const seen: Array<Moment.Moment> = [];

        const { prompts } = yield* run(
          "Press spin twice",
          [
            () =>
              calling(call("click_at", { x: 300, y: 320 }), call("wait_still", { seconds: 10 })),
            () => calling(call("zoom", { x: 50, y: 60, width: 150, height: 180 })),
            () => calling(call("click_at", { x: 300, y: 320 })),
            () => calling(call("wait_still", { seconds: 10 })),
            () => answer("Spun twice."),
          ],
          { vision: "moments", onMoment: (moment) => Effect.sync(() => seen.push(moment)) },
        );

        assert.strictEqual(seen.length, 5);
        assert.deepStrictEqual(
          prompts.map((prompt) => moments(prompt).length),
          [1, 2, 3, 4, 5],
        );

        for (const prompt of prompts) {
          // The first moment follows the task; each later one, the results of the turn it shows.
          const placed = prompt.content
            .flatMap((message, index) =>
              message.role === "user" && files(message).length === 0
                ? [prompt.content[index - 1]?.role]
                : [],
            )
            .slice(1);

          assert.deepStrictEqual(placed, ["user", ...placed.slice(1).map(() => "tool" as const)]);
          assert.strictEqual(prompt.content.at(-1)?.role, "user");
        }

        // Accounts never change. Only the latest moments' labeled image references survive.
        const last = prompts[4]!;

        assert.deepStrictEqual(moments(prompts[2]!)[0], moments(prompts[0]!)[0]);
        assert.deepStrictEqual(
          references(last).map((message) => message.content[0]),
          moments(last)
            .slice(-3)
            .map((message) => message.content[0]),
        );
        assert.deepStrictEqual(moments(last)[0], moments(prompts[0]!)[0]);
        assert.include(textOf(Prompt.fromMessages([moments(prompts[1]!)[1]!])), "(300, 320)");
        // The crop is shown with the moment of the turn that took it.
        assert.strictEqual(files(references(prompts[2]!)[2]).length, seen[2]!.frames.length + 1);
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

  // #292: ageing pictures changed a prefix already summarized by Yielded, ending long runs.
  // Exercise the real interpreter: short demos never reach either compaction or image expiry.
  it.effect(
    "continues moments through repeated native compaction with bounded recent pictures",
    () =>
      Effect.gen(function* () {
        const page = yield* open("/form");
        const seen: Array<Moment.Moment> = [];

        const summary = scripted(
          Array.from({ length: 30 }, () => () => answer("Order not placed.")),
        );

        const model = scripted([
          ...Array.from({ length: 24 }, () => () => calling(call("inspect", { selector: "body" }))),
          () => answer("Finished observing."),
        ]);

        const observer = Agent.make("compacting-browser", {
          input: Schema.String,
          output: Output.text(Schema.String),
          instructions: "Observe the order form without placing an order.",
          toolkit: Toolkit.make(BrowserTools.Control.tools.inspect),
          policy: {
            maxTurns: 30,
            maxToolCalls: 30,
            maxDuration: "1 minute",
            toolConcurrency: 1,
            compaction: CompactionPolicy.make({
              mode: "prune-then-summarize",
              keepRecentTokens: 400,
            }),
          },
        });

        const result = yield* Effect.gen(function* () {
          const preparation = Option.getOrThrow(yield* Effect.serviceOption(RunContextPreparation));

          return yield* AgentRuntime.stream(observer, "Observe the form, then finish.", {
            context: {
              prepare: (request) =>
                Effect.map(preparation.hook!.prepare(request), (prepared) => ({
                  ...prepared,
                  modelCall: {
                    model: model.layer,
                    context: ModelCallContext.make({
                      contextCapacity: 3000,
                      outputReserveTokens: 128,
                      uncountedOverheadTokens: 0,
                    }),
                    // The scripted model reserves 64 tokens per image, independent of encoding.
                    estimateMessageTokens: (message) => {
                      if (message.role !== "user") return undefined;
                      const images = message.content.filter((part) => part.type === "file");

                      if (images.length === 0) return undefined;

                      return (
                        images.length * 64 +
                        estimateMessageTokens(
                          Prompt.userMessage({
                            content: message.content.filter((part) => part.type !== "file"),
                          }),
                        )
                      );
                    },
                  },
                })),
            },
          }).pipe(Stream.runCollect);
        }).pipe(
          Effect.provide(
            Layer.mergeAll(
              tools.layer(
                { page },
                { vision: "moments", onMoment: (moment) => Effect.sync(() => seen.push(moment)) },
              ),
              InMemory.layer,
              ContextCompactor.layerWithModel(summary.layer),
              model.layer,
            ),
          ),
        );

        assert.strictEqual(
          result.find((event) => event._tag === "RunCompleted")?.output,
          "Finished observing.",
        );
        assert.isAtLeast(
          result.filter(
            (event) => event._tag === "CompactionPerformed" && event.kind === "clear-tool-results",
          ).length,
          1,
        );
        assert.isAtLeast(summary.prompts.length, 2);
        assert.strictEqual(seen.length, model.prompts.length);
        assert.isAtMost(pictures(model.prompts.at(-1)!).length, 9);
        assert.isAbove(pictures(model.prompts.at(-1)!).length, 0);
        assert.deepStrictEqual(
          references(model.prompts.at(-1)!).map((message) => message.content[0]),
          model.prompts.slice(-3).map((prompt) => moments(prompt).at(-1)?.content[0]),
        );
        for (const prompt of summary.prompts) {
          assert.strictEqual(pictures(prompt).length, 0);
          assert.include(textOf(prompt), "Moment");
        }
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
