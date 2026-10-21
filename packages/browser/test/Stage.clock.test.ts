// A stage has one timestamp domain, even when a caller supplies another page owner.
import { assert, it } from "@effect/vitest";
import { Clock, Effect, Exit, Option } from "effect";

import * as Stage from "../src/presentation/Stage.ts";
import * as TestPage from "../src/testing/TestPage.ts";

it.effect("refuses unrelated owning clocks before starting capture or waiting for a frame", () =>
  Effect.gen(function* () {
    const stage = yield* Stage.make();
    const first = yield* TestPage.make();
    const second = yield* TestPage.make();
    const original = yield* Clock.Clock;

    const unrelated: Clock.Clock = {
      ...original,
      monotonicTimeNanosUnsafe: () => original.monotonicTimeNanosUnsafe() + 1_000_000_000_000n,
    };

    yield* stage.cue(first.page);
    yield* stage.cue(second.page);
    const foreign = { ...second.page, clock: unrelated };

    for (const operation of [
      Effect.asVoid(stage.cue(foreign)),
      Effect.asVoid(stage.present(foreign)),
    ]) {
      const result = yield* Effect.exit(operation);

      assert.isTrue(Exit.isFailure(result));
      if (Exit.isFailure(result)) {
        const failure = Exit.findErrorOption(result);

        assert.isTrue(Option.isSome(failure));
        if (Option.isSome(failure)) {
          assert.strictEqual(failure.value.reason._tag, "InvalidRequest");
          assert.isFalse(failure.value.dispatched);
        }
      }
    }
  }),
);
