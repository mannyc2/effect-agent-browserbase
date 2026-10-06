import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber } from "effect";

import * as Input from "../src/internal/input.ts";
import { maximumSamples } from "../src/Motion.ts";

interface Receipt {
  readonly kind: string;
  readonly resolve: () => void;
  readonly reject: (cause: unknown) => void;
  settled: boolean;
}

/** Replies stay under test control after submission, just as a lost CDP receipt remains owned. */
const heldReplies = Effect.gen(function* () {
  const receipts: Receipt[] = [];
  let outstanding = 0;
  let maximumOutstanding = 0;

  const issue = (kind = "move") => {
    const reply = Promise.withResolvers<void>();

    receipts.push({ kind, resolve: () => reply.resolve(), reject: reply.reject, settled: false });
    outstanding += 1;
    maximumOutstanding = Math.max(maximumOutstanding, outstanding);

    return reply.promise;
  };

  const settle = (index: number, cause?: unknown) => {
    const receipt = receipts[index];

    if (receipt === undefined) throw new Error("the test did not submit this command");
    if (receipt.settled) return;
    receipt.settled = true;
    outstanding -= 1;
    if (cause === undefined) receipt.resolve();
    else receipt.reject(cause);
  };

  const settleAll = () => {
    for (let index = 0; index < receipts.length; index++) settle(index);
  };

  yield* Effect.addFinalizer(() => Effect.sync(settleAll));

  return {
    receipts,
    issue,
    settle,
    settleAll,
    outstanding: () => outstanding,
    maximumOutstanding: () => maximumOutstanding,
  };
});

describe("Input admission", () => {
  it.effect(
    "waits at the ordinary bound and admits exactly one command when its reply arrives",
    () =>
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const run = yield* Input.make().begin;

        yield* run.reserve(Input.capacity);
        for (let index = 0; index < Input.capacity; index++)
          yield* run.send(() => replies.issue("key"));

        const next = yield* run
          .reserve(1)
          .pipe(Effect.andThen(run.send(() => replies.issue("key"))), Effect.forkScoped);

        yield* Effect.yieldNow;
        assert.strictEqual(replies.receipts.length, Input.capacity);
        replies.settle(0);
        yield* Fiber.join(next);
        assert.strictEqual(replies.receipts.length, Input.capacity + 1);
        assert.strictEqual(replies.maximumOutstanding(), Input.capacity);
        replies.settleAll();
        yield* run.drain;
        yield* run.close;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "admits a complete maximum motion while keeping a strict combined bound and ordinary input separate",
    () =>
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const run = yield* Input.make().begin;
        const limit = Input.capacity + maximumSamples;

        yield* run.reserve(Input.capacity);
        for (let index = 0; index < Input.capacity; index++)
          yield* run.send(() => replies.issue("key"));
        yield* run.reserveMotion(maximumSamples);
        for (let index = 0; index < maximumSamples; index++) yield* run.send(() => replies.issue());
        assert.strictEqual(replies.receipts.length, limit);
        assert.strictEqual(replies.maximumOutstanding(), limit);

        const ordinary = yield* run
          .reserve(1)
          .pipe(Effect.andThen(run.send(() => replies.issue("key"))), Effect.forkScoped);

        const motion = yield* run
          .reserveMotion(1)
          .pipe(Effect.andThen(run.send(() => replies.issue())), Effect.forkScoped);

        yield* Effect.yieldNow;
        assert.strictEqual(replies.receipts.length, limit);

        replies.settle(0);
        yield* Fiber.join(motion);
        assert.strictEqual(replies.receipts.length, limit + 1);
        assert.strictEqual(replies.receipts.at(-1)?.kind, "move");
        assert.strictEqual(replies.outstanding(), limit);
        assert.strictEqual(replies.maximumOutstanding(), limit);

        // Releasing one motion slot must not let ordinary input borrow the larger motion budget.
        for (let index = 1; index < limit - Input.capacity + 1; index++) replies.settle(index);
        yield* Effect.yieldNow;
        assert.strictEqual(replies.receipts.length, limit + 1);
        assert.strictEqual(replies.outstanding(), Input.capacity);
        replies.settle(limit - Input.capacity + 1);
        yield* Fiber.join(ordinary);
        assert.strictEqual(replies.receipts.at(-1)?.kind, "key");
        assert.strictEqual(replies.outstanding(), Input.capacity);
        assert.strictEqual(replies.maximumOutstanding(), limit);
        replies.settleAll();
        yield* run.drain;
        yield* run.close;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "stops new dispatch after a failed motion receipt without abandoning the other replies",
    () =>
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const run = yield* Input.make().begin;
        const lost = new Error("the command ran but its receipt was lost");

        yield* run.reserveMotion(4);
        for (let index = 0; index < 3; index++) yield* run.send(() => replies.issue());
        replies.settle(1, lost);
        yield* Effect.yieldNow;
        const failure = yield* run.send(() => replies.issue()).pipe(Effect.flip);

        assert.strictEqual(failure.cause, lost);
        assert.strictEqual(replies.receipts.length, 3);
        let drained = false;

        const drain = yield* run.drain.pipe(
          Effect.exit,
          Effect.tap(() =>
            Effect.sync(() => {
              drained = true;
            }),
          ),
          Effect.forkScoped,
        );

        yield* Effect.yieldNow;
        assert.isFalse(drained);
        replies.settleAll();
        const exit = yield* Fiber.join(drain);

        assert.isTrue(Exit.isFailure(exit));
        assert.strictEqual(replies.receipts.length, 3);
        yield* run.close;
      }).pipe(Effect.scoped),
  );

  it.effect(
    "releases a held button once after an interrupted motion and retains every submitted reply across runs",
    () =>
      Effect.gen(function* () {
        const replies = yield* heldReplies;
        const input = Input.make();
        const run = yield* input.begin;

        yield* run.reserve(2);
        yield* run.down(
          "mouse:left",
          () => replies.issue("down"),
          () => replies.issue("up"),
        );
        const started = yield* Deferred.make<void>();

        const performer = yield* Effect.gen(function* () {
          yield* run.reserveMotion(maximumSamples);
          for (let index = 0; index < Input.capacity + 6; index++)
            yield* run.send(() => replies.issue());
          yield* Deferred.succeed(started, undefined);

          return yield* Effect.never;
        }).pipe(Effect.ensuring(run.close), Effect.forkScoped);

        yield* Deferred.await(started);
        yield* Fiber.interrupt(performer);
        yield* run.close;
        assert.strictEqual(replies.receipts.filter((receipt) => receipt.kind === "up").length, 1);
        const submitted = replies.receipts.length;

        assert.strictEqual(submitted, Input.capacity + 8);
        let began = false;

        const next = yield* input.begin.pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              began = true;
            }),
          ),
          Effect.forkScoped,
        );

        yield* Effect.yieldNow;
        assert.isFalse(began);
        for (let index = 0; index < submitted - 1; index++) replies.settle(index);
        yield* Effect.yieldNow;
        assert.isFalse(began, "the unresolved release still belongs to the old run");
        replies.settle(submitted - 1);
        const fresh = yield* Fiber.join(next);

        assert.isTrue(began);
        assert.strictEqual(replies.receipts.length, submitted);
        yield* fresh.reserve(Input.capacity);
        for (let index = 0; index < Input.capacity; index++)
          yield* fresh.send(() => replies.issue("key"));

        const overflow = yield* fresh
          .reserve(1)
          .pipe(Effect.andThen(fresh.send(() => replies.issue("key"))), Effect.forkScoped);

        yield* Effect.yieldNow;
        assert.strictEqual(replies.receipts.length, submitted + Input.capacity);
        replies.settle(submitted);
        yield* Fiber.join(overflow);
        assert.strictEqual(replies.outstanding(), Input.capacity);
        replies.settleAll();
        yield* fresh.drain;
        yield* fresh.close;
      }).pipe(Effect.scoped),
  );

  it.effect("cannot dispatch a queued motion after its admission was interrupted", () =>
    Effect.gen(function* () {
      const replies = yield* heldReplies;
      const input = Input.make();
      const run = yield* input.begin;

      yield* run.reserve(Input.capacity);
      for (let index = 0; index < Input.capacity; index++)
        yield* run.send(() => replies.issue("key"));
      yield* run.reserveMotion(maximumSamples);
      for (let index = 0; index < maximumSamples; index++) yield* run.send(() => replies.issue());
      const before = replies.receipts.length;

      const waiting = yield* run
        .reserveMotion(1)
        .pipe(
          Effect.andThen(run.send(() => replies.issue())),
          Effect.ensuring(run.close),
          Effect.forkScoped,
        );

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      replies.settleAll();
      const fresh = yield* input.begin;

      assert.strictEqual(replies.receipts.length, before);
      yield* fresh.reserve(1);
      yield* fresh.send(() => replies.issue("key"));
      assert.strictEqual(replies.receipts.length, before + 1);
      replies.settleAll();
      yield* fresh.drain;
      yield* fresh.close;
    }).pipe(Effect.scoped),
  );

  it.effect("rejects invalid reservations before consuming capacity or dispatching input", () =>
    Effect.gen(function* () {
      const replies = yield* heldReplies;
      const run = yield* Input.make().begin;

      for (const count of [0, -1, 1.5, Number.NaN, Infinity, Input.capacity + 1]) {
        const exit = yield* Effect.exit(run.reserve(count));

        assert.isTrue(Exit.isFailure(exit));
      }
      for (const count of [0, -1, 1.5, Number.NaN, Infinity, maximumSamples + 1]) {
        const exit = yield* Effect.exit(run.reserveMotion(count));

        assert.isTrue(Exit.isFailure(exit));
      }
      assert.strictEqual(replies.receipts.length, 0);
      yield* run.reserve(Input.capacity);
      for (let index = 0; index < Input.capacity; index++)
        yield* run.send(() => replies.issue("key"));
      assert.strictEqual(replies.receipts.length, Input.capacity);
      replies.settleAll();
      yield* run.drain;
      yield* run.close;
    }).pipe(Effect.scoped),
  );
});
