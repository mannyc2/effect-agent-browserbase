/** Prefix laws for feed histories, then real public Page evidence through Stage. */
import { assert, it } from "@effect/vitest";
import { Arbitrary, Deferred, Effect, Fiber, Option, Schema, Stream } from "effect";
import { TestClock } from "effect/testing";

import { monotonicMillis } from "../src/Clock.ts";
import { BrowserPaint, Frame } from "../src/Frame.ts";
import * as Lifecycle from "../src/presentation/feed.ts";
import * as Stage from "../src/presentation/Stage.ts";
import * as TestPage from "../src/testing/TestPage.ts";

const frame = (page: string, document = 0, at = 0) =>
  new Frame({
    page,
    document,
    session: "test-browser",
    connection: "test-connection",
    url: "about:blank",
    data: new Uint8Array([1]),
    width: 10,
    height: 10,
    receivedAt: at,
    timing: new BrowserPaint({ timestamp: at / 1000, hostTime: at, uncertaintyMillis: 0 }),
  });

it.prop(
  "retirement absorbs every suffix, and reset never makes a previously ready feed warm again",
  {
    history: Arbitrary.schema(
      Schema.Array(Schema.Literals(["Paint", "Reset", "Stop"])).check(Schema.isMaxLength(100)),
    ),
  },
  ({ history }) => {
    let state = Lifecycle.initial;
    const inputs: Array<Lifecycle.Input> = [];

    for (const [index, tag] of history.entries()) {
      const input = tag === "Paint" ? { _tag: tag, frame: frame("page", 0, index) } : { _tag: tag };

      inputs.push(input);
      state = Lifecycle.step(state, input);
      const stopped = inputs.some((input) => input._tag === "Stop");
      const painted = inputs.some((input) => input._tag === "Paint");

      assert.strictEqual(state._tag, stopped ? "Stopped" : painted ? "Ready" : "Warming");
      if (state._tag === "Ready") {
        const last = inputs.findLast((input) => input._tag === "Paint" || input._tag === "Reset");

        assert.strictEqual(state.latest, last?._tag === "Paint" ? last.frame : undefined);
      }
    }
  },
  { arbitrary: { runs: 1000, seed: 20261021 } },
);

it.effect("publishes only current-document paint and stops retired feeds after a switch", () =>
  Effect.gen(function* () {
    const first = yield* TestPage.make({ frames: [frame("first")] }, { id: "first" });
    const second = yield* TestPage.make({ frames: [frame("second")] }, { id: "second" });
    const delayed = yield* Deferred.make<void>();
    let held = false;

    const page = {
      ...first.page,
      capture: (options?: Parameters<typeof first.page.capture>[0]) =>
        Effect.map(first.page.capture(options), (capture) => ({
          ...capture,
          stream: capture.stream.pipe(
            Stream.mapEffect((frame) =>
              held ? Effect.as(Deferred.await(delayed), frame) : Effect.succeed(frame),
            ),
          ),
        })),
    };

    const probe = yield* first.page.capture();
    const stage = yield* Stage.make();
    const frames: Array<Frame> = [];

    yield* stage.frames.pipe(
      Stream.runForEach((frame) =>
        Effect.sync(() => {
          frames.push(frame);
        }),
      ),
      Effect.forkScoped,
    );
    yield* stage.present(page);
    yield* Effect.yieldNow;
    assert.strictEqual(frames.at(-1)?.page, "first");
    held = true;
    const queued = [frame("first", 0, 1), frame("first", 0, 2)] as const;

    yield* first.emitFrame(queued[0]);
    yield* Effect.yieldNow;
    yield* first.emitFrame(queued[1]);
    assert.isFalse(probe.isCurrent(queued[0]));
    yield* Deferred.succeed(delayed, undefined);
    yield* TestClock.adjust("1 millis");
    assert.deepStrictEqual(frames.slice(-2), [...queued]);
    const before = frames.length;

    yield* first.document({});
    yield* first.emitFrame(frame("first"));
    yield* TestClock.adjust("1 millis");
    assert.lengthOf(frames, before);
    const current = frame("first", 1, monotonicMillis(first.page.clock));

    yield* first.emitFrame(current);
    yield* TestClock.adjust("1 millis");
    assert.strictEqual(frames.at(-1), current);
    yield* stage.present(second.page);
    yield* Effect.yieldNow;
    const switched = frames.length;

    yield* first.emitFrame(frame("first", 1, monotonicMillis(first.page.clock)));
    yield* TestClock.adjust("1 millis");
    assert.lengthOf(frames, switched);
    assert.strictEqual(frames.at(-1)?.page, "second");
    assert.deepStrictEqual(yield* stage.current, Option.some(second.page));
  }),
);

it.effect("same-page requests take their FIFO turn after an already queued switch", () =>
  Effect.gen(function* () {
    const first = yield* TestPage.make({ frames: [frame("first")] }, { id: "first" });
    const second = yield* TestPage.make({}, { id: "second" });
    const stage = yield* Stage.make();

    yield* stage.present(first.page);
    const next = yield* stage.present(second.page).pipe(Effect.forkScoped);

    yield* TestClock.adjust(0);
    const again = yield* stage.present(first.page).pipe(Effect.forkScoped);

    yield* TestClock.adjust(0);
    const overtook = again.pollUnsafe() !== undefined;

    yield* second.emitFrame(frame("second"));
    yield* Fiber.join(next);
    yield* Fiber.join(again);
    assert.isFalse(overtook, "the same-page shortcut must not overtake a queued switch");
    assert.deepStrictEqual(yield* stage.current, Option.some(first.page));
  }),
);
