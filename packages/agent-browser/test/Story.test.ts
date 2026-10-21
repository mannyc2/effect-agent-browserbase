// PLAN T7: an end check must catch held calls, unexpected calls, and unasserted error logs.
import { assert, it } from "@effect/vitest";
import { Agent, AgentRuntime, InMemory, Output, type RunEvent } from "@yielded/agent";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { BrowserError, Failed } from "effect-browser/BrowserError";
import type * as Page from "effect-browser/Page";
import { TestPage } from "effect-browser/testing";
import { TestClock } from "effect/testing";

import * as BrowserTools from "../src/BrowserTools.ts";
import { Story, TestModel } from "../src/testing.ts";

it.effect("checks suspended ports and asserted error logs before a story finishes", () =>
  Effect.gen(function* () {
    const story = yield* Story.make;
    const gate = yield* Deferred.make<string>();

    const call = yield* story.port<string, string>("model", [
      (prompt) =>
        Effect.andThen(
          Effect.sync(() => assert.strictEqual(prompt, "go")),
          Deferred.await(gate),
        ),
    ]);

    const run = yield* call("go").pipe(Effect.forkChild);

    yield* Effect.yieldNow;
    assert.include((yield* story.assertFinished.pipe(Effect.flip)).detail, "held model");
    yield* Deferred.succeed(gate, "done");
    assert.strictEqual(yield* Fiber.join(run), "done");
    yield* story.assertFinished;
    yield* Effect.logError("expected error").pipe(Effect.provide(story.logger));
    assert.include((yield* story.assertFinished.pipe(Effect.flip)).detail, "unasserted error log");
    const logs = yield* story.logs;

    assert.lengthOf(logs, 1);
    yield* story.assertLog(logs[0]!.id);
    yield* story.assertFinished;
    yield* call("extra").pipe(Effect.flip);
    assert.include((yield* story.assertFinished.pipe(Effect.flip)).detail, "unexpected model");
  }),
);

it.effect("runs a Yielded agent while the model and page ports release in story order", () =>
  Effect.gen(function* () {
    const story = yield* Story.make;

    const simulated = yield* TestPage.make({
      ready: true,
      elements: [
        {
          key: "go",
          subject: { role: "button", name: "Go", tag: "button", context: {} },
          box: { x: 0, y: 0, width: 40, height: 40 },
        },
      ],
    });

    const held = yield* simulated.holdNext();

    const click = yield* story.port<Page.Target, Page.ResolvedTarget, BrowserError>("page", [
      simulated.page.click,
    ]);

    const page = {
      ...simulated.page,
      click: (target: Page.Target) =>
        click(target).pipe(
          Effect.mapError((error) =>
            error._tag === "ScriptError"
              ? new BrowserError({
                  operation: "click",
                  dispatched: false,
                  reason: new Failed({ detail: error.detail }),
                })
              : error,
          ),
        ),
    };

    const respond = yield* story.port<TestModel.Request, TestModel.Reply>("model", [
      () =>
        Effect.succeed(
          TestModel.reply(TestModel.calling(TestModel.call("click_at", { x: 10, y: 10 }))),
        ),
      () => Effect.succeed(TestModel.reply(TestModel.text("Clicked"))),
    ]);

    const tools = BrowserTools.make();

    const agent = Agent.make("suspended-browser-story", {
      input: Schema.String,
      output: Output.text(Schema.String),
      instructions: "Click Go and finish",
      toolkit: tools.toolkit,
      policy: { maxTurns: 2, maxToolCalls: 2 },
    });

    const events: Array<RunEvent.RunEvent> = [];

    const run = yield* AgentRuntime.stream(agent, "Click Go").pipe(
      Stream.runForEach((event) => Effect.sync(() => void events.push(event))),
      Effect.provide(
        Layer.mergeAll(
          InMemory.layer,
          tools.layer({ page }, { vision: false }),
          TestModel.layer([respond, respond]),
          story.logger,
        ),
      ),
      Effect.forkChild,
    );

    yield* held.entered;
    assert.include((yield* story.assertFinished.pipe(Effect.flip)).detail, "held page");
    yield* TestClock.adjust("1 second");
    assert.isUndefined(run.pollUnsafe());
    yield* held.release;
    yield* Fiber.join(run);
    yield* story.assertFinished;
    assert.deepStrictEqual(
      (yield* simulated.actions).map((action) => action._tag),
      ["Click"],
    );
    const completed = events.find((event) => event._tag === "ToolCallSucceeded");

    assert.isTrue(completed?._tag === "ToolCallSucceeded");
    if (completed?._tag === "ToolCallSucceeded") {
      const receipt = yield* Schema.decodeUnknownEffect(BrowserTools.Receipt)(completed.result);

      assert.strictEqual(receipt.action?._tag, "Click");
    }
  }),
);
