// The lease within a process as a model: random writers on a few contexts, some that give up
// waiting and some that never say how they leave, checked against what a lease must keep.
import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Duration, Effect, Fiber, Option, Schema } from "effect";
import { TestClock } from "effect/testing";

import * as ContextLease from "../src/ContextLease.ts";

const Millis = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 4 }));

const Writer = Schema.Struct({
  context: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 2 })),
  /** When it asks for the context. */
  after: Millis,
  /** How long it holds the context once it has it. */
  holds: Millis,
  /** How it says it leaves the context, if it says. */
  says: Schema.Literals(["settled", "unsettled", "nothing"]),
  /** How long it waits for the context before it gives up, if it gives up. */
  patience: Schema.optional(Millis),
});

type Writer = typeof Writer.Type;

type Entry =
  | { readonly _tag: "Took"; readonly writer: number; readonly saw: boolean }
  | { readonly _tag: "Left"; readonly writer: number; readonly unsettled: boolean };

/** One writer's turn, written to the context's log as it takes and as it lets go. */
const write = (lease: ContextLease.Service, writer: Writer, index: number, log: Array<Entry>) =>
  Effect.gen(function* () {
    yield* Effect.sleep(Duration.millis(writer.after));

    const waiting = lease.hold(`context-${writer.context}`);

    const held = yield* writer.patience === undefined
      ? Effect.asSome(waiting)
      : Effect.timeoutOption(waiting, Duration.millis(writer.patience));

    if (Option.isNone(held)) return;
    log.push({ _tag: "Took", writer: index, saw: held.value.unsettled });
    yield* Effect.sleep(Duration.millis(writer.holds));
    if (writer.says !== "nothing") yield* held.value.leave(writer.says === "unsettled");
    // A writer that never says leaves the context as if a session that saves to it still ran.
    log.push({ _tag: "Left", writer: index, unsettled: writer.says !== "settled" });
  }).pipe(Effect.scoped);

describe("ContextLease.layer", () => {
  it.effect.prop(
    "lets one writer hold a context at a time, and tells each how the writer before left it",
    {
      writers: Arbitrary.array(Arbitrary.schema(Writer), { minLength: 1, maxLength: 10 }),
    },
    ({ writers }) =>
      Effect.gen(function* () {
        const lease = yield* ContextLease.ContextLease;
        const logs: Array<Array<Entry>> = [[], [], []];

        const running = yield* Effect.forEach(writers, (writer, index) =>
          Effect.forkChild(write(lease, writer, index, logs[writer.context] ?? [])),
        );

        for (let millis = 0; running.some((fiber) => fiber.pollUnsafe() === undefined); millis++) {
          assert.isBelow(millis, 1000, "every writer finishes");
          yield* TestClock.adjust("1 millis");
        }
        yield* Fiber.joinAll(running);

        for (const log of logs) {
          // A context nobody held before is presumed settled.
          let unsettled = false;
          let holder: number | undefined;

          for (const entry of log)
            if (entry._tag === "Took") {
              assert.isUndefined(holder, "one writer holds a context at a time");
              assert.strictEqual(entry.saw, unsettled, "each sees how the one before left it");
              holder = entry.writer;
            } else {
              assert.strictEqual(entry.writer, holder, "only its holder lets a context go");
              holder = undefined;
              ({ unsettled } = entry);
            }
          assert.isUndefined(holder, "every hold goes");
        }
      }).pipe(Effect.provide(ContextLease.layer)),
    { arbitrary: { runs: 300 } },
  );
});
