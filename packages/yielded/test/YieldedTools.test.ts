// Yielded agent runs with the browser tools on a real Chromium page, with what the model sees of it
// as the run's context, driven by scripted models: no model is called.
import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, layer } from "@effect/vitest";
import { Agent, AgentRuntime, InMemory, Output } from "@yielded/agent";
import { CompactionPolicy } from "@yielded/agent/agent-policy";
import { estimateMessageTokens } from "@yielded/agent/compaction";
import { ContextCompactor } from "@yielded/agent/context-compactor";
import { ModelCallContext } from "@yielded/agent/context-window";
import { RunContextPreparation } from "@yielded/agent/run-options";
import { Duration, Effect, Layer, Option, Result, Schema, Stream } from "effect";
import { BrowserTools } from "effect-browser/ai";
import { Browser } from "effect-browser/Browser";
import type { Moment } from "effect-browser/timeline";
import { Model, Prompt, Toolkit } from "effect/ai";

import { refIn, Site, SiteLayer, textOf } from "../../../tools/testing/agent-site.ts";
import * as YieldedTools from "../src/YieldedTools.ts";
import { answer, call, calling, scripted, type Turn } from "./fixtures.ts";

const tools = YieldedTools.make();

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

const run = (task: string, turns: ReadonlyArray<Turn>, options: YieldedTools.LayerOptions = {}) =>
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
})("YieldedTools", (it) => {
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
        (yield* page.read(() => document.querySelector("#outcome")?.textContent ?? null, {
          arg: undefined,
          result: Schema.NullOr(Schema.String),
        })).value,
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

  // #293 discussion_r4249413830: a lost page must stop preparation before another model call.
  it.effect("fails moment preparation after the current page closes", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");
      const model = scripted([() => calling(call("observe", {})), () => answer("Still running.")]);

      const outcome = yield* AgentRuntime.run(agent, "Observe the form.").pipe(
        Effect.provide(
          Layer.mergeAll(
            tools.layer({ page }, { vision: "moments", onMoment: () => Effect.orDie(page.close) }),
            InMemory.layer,
            model.layer,
          ),
        ),
        Effect.result,
      );

      assert.isTrue(Result.isFailure(outcome));
      if (Result.isFailure(outcome)) assert.strictEqual(outcome.failure._tag, "AgentInputError");
      assert.strictEqual(model.prompts.length, 1);
    }),
  );

  // #293 discussion_r4249413869: a crop's coordinates cannot be used after selecting another tab.
  it.effect("keeps queued crops out of a newly selected tab's moment", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.open();
      const site = yield* Site;

      yield* browser.newPage(site.url("/form"));
      yield* browser.newPage(site.url("/next"));

      const model = scripted([
        () => calling(call("observe", {})),
        () =>
          calling(
            call("zoom", { x: 0, y: 0, width: 100, height: 100 }),
            call("select_tab", { ref: "tab2" }),
          ),
        () => answer("Selected the next page."),
      ]);

      yield* AgentRuntime.run(agent, "Inspect the first tab, then select the next.").pipe(
        Effect.provide(
          Layer.mergeAll(
            tools.layer({ browser }, { vision: "moments" }),
            InMemory.layer,
            model.layer,
          ),
        ),
      );
      const shown = references(model.prompts.at(-1)!).at(-1);

      assert.strictEqual(files(shown).length, 1, "the new tab has only its own screenshot");
      assert.notInclude(textOf(Prompt.fromMessages([shown!])), "Zoom:");
    }).pipe(Effect.scoped),
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

        const sharedModel = Model.make(
          "scripted",
          "test-model",
          Layer.succeedContext(yield* Layer.build(model.layer)),
        );

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
                    model: sharedModel,
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
