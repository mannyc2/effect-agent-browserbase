// PLAN T1/T7: scripts must expose prompt-driven turns and fail on unexpected or unused calls.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Schema, Stream } from "effect";
import { LanguageModel, Tool, Toolkit } from "effect/ai";
import { TestClock } from "effect/testing";

import { Story, TestModel } from "../src/testing.ts";

it.effect("uses fresh script state per layer build and asserts its typed exhaustion", () => {
  const layer = TestModel.layer([
    (request) => Effect.succeed(TestModel.reply(TestModel.text(`turn ${request.turn}`))),
  ]);

  const run = Effect.gen(function* () {
    const model = yield* TestModel.TestModel;
    const response = yield* LanguageModel.generateText({ prompt: "observe e17" });

    assert.strictEqual(response.text, "turn 1");
    yield* model.assertExhausted;
    const error = yield* Effect.flip(LanguageModel.generateText({ prompt: "unexpected" }));

    assert.include(error.message, "script exhausted");
    assert.include((yield* model.assertExhausted.pipe(Effect.flip)).detail, "unexpected");
  }).pipe(Effect.provide(layer));

  return Effect.andThen(run, run);
});

it.effect("records schema fingerprints and holds a streamed turn until the story releases it", () =>
  Effect.gen(function* () {
    const story = yield* Story.make;
    const gate = yield* Deferred.make<void>();

    const tool = Tool.make("pick", {
      description: "Pick a ref",
      parameters: Schema.Struct({ ref: Schema.String }),
      success: Schema.String,
    });

    const toolkit = Toolkit.make(tool);

    const changed = Tool.make("pick", {
      description: "Pick a ref",
      parameters: Schema.Struct({ index: Schema.Int }),
      success: Schema.String,
    });

    assert.notStrictEqual(TestModel.fingerprint([tool]), TestModel.fingerprint([changed]));

    const turn = yield* story.port<TestModel.Request, TestModel.Reply>("model", [
      (request) =>
        Effect.gen(function* () {
          assert.include(TestModel.textOf(request.prompt), "e17");
          yield* Deferred.await(gate);
          yield* Effect.sleep("1 second");

          return TestModel.reply(TestModel.text("picked e17"));
        }),
    ]);

    const layer = TestModel.layer([turn]);

    yield* Effect.gen(function* () {
      const model = yield* TestModel.TestModel;

      const response = yield* LanguageModel.streamText({ prompt: "e17", toolkit }).pipe(
        Stream.runCollect,
        Effect.forkChild,
      );

      yield* Effect.yieldNow;
      assert.isUndefined(response.pollUnsafe());
      yield* Deferred.succeed(gate, undefined);
      yield* TestClock.adjust("1 second");
      assert.isNotEmpty(yield* Fiber.join(response));
      yield* story.assertFinished;
      const requests = yield* model.requests;

      assert.lengthOf(requests, 1);
      assert.include(requests[0]!.toolsFingerprint, "pick");
      yield* model.assertExhausted;
    }).pipe(
      Effect.provide(
        Layer.merge(layer, toolkit.toLayer({ pick: ({ ref }) => Effect.succeed(ref) })),
      ),
    );
  }),
);
