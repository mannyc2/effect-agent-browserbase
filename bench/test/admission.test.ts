import { assert, describe, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Ref, Scheduler } from "effect";

import { ledger } from "../run.ts";

const receipt = {
  usage: { prompt_tokens: 10, completion_tokens: 3, cost: 0.02 },
};

describe("model admission before hosted allocation", () => {
  it.effect("holds budget without claiming a call and releases unused setup capacity", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.1, 0.1);
      const holder = yield* budget.account;
      const peer = yield* budget.account;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const dispatched = yield* Ref.make(0);

      const owner = yield* Effect.gen(function* () {
        yield* holder.reserve;
        yield* Deferred.succeed(held, undefined);
        yield* Deferred.await(release);
      }).pipe(Effect.scoped, Effect.forkChild);

      yield* Deferred.await(held);
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0.1 });
      assert.strictEqual((yield* holder.snapshot).calls, 0);
      assert.strictEqual((yield* holder.snapshot).uncertainCalls, 0);

      const waiting = yield* peer
        .run(
          Ref.update(dispatched, (value) => value + 1).pipe(Effect.as(receipt)),
          (response) => response.usage,
        )
        .pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.strictEqual(yield* Ref.get(dispatched), 0);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* Fiber.join(waiting);
      assert.strictEqual(yield* Ref.get(dispatched), 1);
      assert.strictEqual((yield* holder.snapshot).calls, 0);
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0.02, reservedUsd: 0 });
    }),
  );

  it.effect("consumes its held admission once and refuses to dispatch after a global stop", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.2, 0.1);
      const account = yield* budget.account;
      const dispatched = yield* Ref.make(false);

      yield* Effect.gen(function* () {
        yield* account.reserve;
        yield* budget.stop;

        const error = yield* account
          .run(Ref.set(dispatched, true).pipe(Effect.as(receipt)), (response) => response.usage)
          .pipe(Effect.flip);

        assert.strictEqual(error._tag, "BenchError");
        assert.isFalse(yield* Ref.get(dispatched));
        assert.strictEqual((yield* account.snapshot).calls, 0);
      }).pipe(Effect.scoped);

      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
    }),
  );

  it.effect("cleans a cancelled waiter and prevents duplicate reservations on one account", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(0.1, 0.1);
      const holder = yield* budget.account;
      const waiter = yield* budget.account;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();

      const owner = yield* Effect.gen(function* () {
        yield* holder.reserve;
        yield* Deferred.succeed(held, undefined);
        yield* Deferred.await(release);
      }).pipe(Effect.scoped, Effect.forkChild);

      yield* Deferred.await(held);
      const pending = yield* waiter.reserve.pipe(Effect.scoped, Effect.forkChild);

      yield* Effect.yieldNow;
      const duplicate = yield* waiter.reserve.pipe(Effect.scoped, Effect.flip);

      assert.strictEqual(duplicate._tag, "BenchError");
      yield* Fiber.interrupt(pending);
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(owner);
      yield* waiter.reserve.pipe(Effect.scoped);
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
      assert.strictEqual((yield* waiter.snapshot).calls, 0);
    }),
  );

  it.effect(
    "returns unused model admission if cancellation arrives before ownership is installed",
    () =>
      Effect.gen(function* () {
        const budget = yield* ledger(0.1, 0.1);
        const account = yield* budget.account;
        const base = yield* Scheduler.Scheduler;
        const observe = Effect.runSyncWith(yield* Effect.context<never>());
        let interrupted = false;

        // Interrupt at the committed reservation itself, before the acquisition can return.
        // Ordinary timing-based cancellation rarely exercises this ownership transition.
        const scheduler: Scheduler.Scheduler = {
          executionMode: base.executionMode,
          makeDispatcher: () => base.makeDispatcher(),
          shouldYield: (fiber) => {
            const state = observe(budget.snapshot);

            if (!interrupted && state.reservedUsd === 0.1) {
              interrupted = true;
              fiber.interruptUnsafe();
            }

            return base.shouldYield(fiber);
          },
        };

        const owner = yield* account.reserve.pipe(
          Effect.scoped,
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );

        const exit = yield* Fiber.await(owner);

        assert.isTrue(interrupted);
        assert.isTrue(Exit.isFailure(exit));
        assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
        assert.strictEqual((yield* account.snapshot).calls, 0);
        assert.strictEqual((yield* account.snapshot).uncertainCalls, 0);
        assert.isFalse(yield* budget.exhausted);
        yield* account.reserve.pipe(Effect.scoped);
        assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0 });
      }),
  );

  it.effect("stops every later admission when a receipt does not establish the charge", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(1, 0.1);
      const first = yield* budget.account;
      const later = yield* budget.account;

      yield* first.run(
        Effect.succeed({ usage: { prompt_tokens: 5, completion_tokens: 2 } }),
        (response) => response.usage,
      );
      assert.isTrue(yield* budget.exhausted);

      const error = yield* later
        .run(Effect.succeed(receipt), (response) => response.usage)
        .pipe(Effect.flip);

      assert.strictEqual(error._tag, "BenchError");
      assert.strictEqual((yield* later.snapshot).calls, 0);
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0, reservedUsd: 0.1 });
      assert.strictEqual((yield* first.snapshot).uncertainCalls, 1);
    }),
  );

  it.effect("reports provider token breakdowns only when every billed call supplied them", () =>
    Effect.gen(function* () {
      const budget = yield* ledger(1, 0.1);
      const account = yield* budget.account;

      const complete = {
        usage: {
          ...receipt.usage,
          prompt_tokens_details: { image_tokens: 7 },
          completion_tokens_details: { reasoning_tokens: 2 },
        },
      };

      yield* account.run(Effect.succeed(complete), (response) => response.usage);
      assert.deepStrictEqual(yield* account.tokens, { image: 7, reasoning: 2 });
      yield* account.run(Effect.succeed(receipt), (response) => response.usage);
      assert.deepStrictEqual(yield* account.tokens, { image: null, reasoning: null });
      assert.strictEqual((yield* account.snapshot).calls, 2);
      assert.deepStrictEqual(yield* budget.snapshot, { knownUsd: 0.04, reservedUsd: 0 });
    }),
  );
});
