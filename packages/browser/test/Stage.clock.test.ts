// A stage has one timestamp domain, even when a caller supplies another page owner.
import { assert, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber, Option } from "effect";
import { TestClock } from "effect/testing";

import { BrowserPaint, Frame } from "../src/Frame.ts";
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

it.effect("same-page frame waits use the page clock even under a suspended caller clock", () =>
  Effect.gen(function* () {
    const page = yield* TestPage.make(
      {
        frames: [
          new Frame({
            page: "same",
            document: 0,
            session: "test-browser",
            connection: "test-connection",
            url: "about:blank",
            data: new Uint8Array([1]),
            width: 10,
            height: 10,
            receivedAt: 0,
            timing: new BrowserPaint({ timestamp: 0, hostTime: 0, uncertaintyMillis: 0 }),
          }),
        ],
      },
      { id: "same" },
    );

    const stage = yield* Stage.make({ firstFrame: "1 second" });

    yield* stage.present(page.page);
    yield* page.document({});
    const owner = yield* Clock.Clock;
    const caller: Clock.Clock = { ...owner, sleep: () => Effect.never };

    const waiting = yield* stage
      .present(page.page)
      .pipe(Effect.provideService(Clock.Clock, caller), Effect.exit, Effect.forkScoped);

    yield* TestClock.adjust("2 seconds");
    assert.isDefined(waiting.pollUnsafe(), "the owning clock must expire the first-frame wait");
    const result = yield* Fiber.join(waiting);

    assert.strictEqual(Option.getOrThrow(Exit.findErrorOption(result)).reason._tag, "Timeout");
  }),
);
