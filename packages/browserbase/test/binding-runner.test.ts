import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Effect, Exit, Scope } from "effect";

import {
  type BindingRunner,
  makeBindingRunner,
} from "../src/internal/browser/BindingRunner.ts";

interface ConsumerService {
  readonly value: number;
}

const typedHandler = (_input: number): Effect.Effect<number, "consumer-error", ConsumerService> =>
  Effect.never;

const typedAcquisition: Effect.Effect<
  BindingRunner<number, number, "consumer-error">,
  never,
  ConsumerService | Scope.Scope
> = makeBindingRunner(1, typedHandler, () => {});

void typedAcquisition;

it.effect("reject-call preserves a typed host failure and admits later work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let faults = 0;
      const runner = yield* makeBindingRunner(
        1,
        (input: number) =>
          input < 0 ? Effect.fail("negative" as const) : Effect.succeed(input * 2),
        () => {
          faults++;
        },
      );

      const failed = runner.submit(-1, "reject-call");

      assert.equal(failed._tag, "Accepted");
      if (failed._tag === "Accepted") {
        const exit = yield* Effect.promise(() => failed.result);

        assert.equal(Exit.isFailure(exit), true);
      }
      assert.equal(faults, 0);

      const next = runner.submit(3, "reject-call");

      assert.equal(next._tag, "Accepted");
      if (next._tag === "Accepted") {
        const exit = yield* Effect.promise(() => next.result);

        assert.equal(Exit.isSuccess(exit), true);
        if (Exit.isSuccess(exit)) assert.equal(exit.value, 6);
      }
      assert.equal(faults, 0);
    }),
  ),
);

it.effect("reject-call capacity is finite before spawning and recovers after settlement", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let faults = 0;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner = yield* makeBindingRunner(
        1,
        (input: "blocked" | "fast") =>
          input === "blocked"
            ? Effect.promise(() => blocked).pipe(Effect.as(input))
            : Effect.succeed(input),
        () => {
          faults++;
        },
      );

      const first = runner.submit("blocked", "reject-call");
      const pressure = runner.submit("fast", "reject-call");

      assert.equal(first._tag, "Accepted");
      assert.deepEqual(pressure, { _tag: "Rejected", reason: "capacity" });
      assert.equal(faults, 0);

      release();
      if (first._tag === "Accepted") yield* Effect.promise(() => first.result);

      const recovered = runner.submit("fast", "reject-call");

      assert.equal(recovered._tag, "Accepted");
      if (recovered._tag === "Accepted") yield* Effect.promise(() => recovered.result);
      assert.equal(faults, 0);
    }),
  ),
);

it.effect("fail-session failure fences admission exactly once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let faults = 0;
      const runner = yield* makeBindingRunner(
        2,
        (_input: number) => Effect.fail("failed" as const),
        () => {
          faults++;
        },
      );

      const failed = runner.submit(1, "fail-session");

      assert.equal(failed._tag, "Accepted");
      if (failed._tag === "Accepted") yield* Effect.promise(() => failed.result);
      assert.equal(faults, 1);
      assert.deepEqual(runner.submit(2, "fail-session"), {
        _tag: "Rejected",
        reason: "closed",
      });
      assert.deepEqual(runner.submit(3, "reject-call"), {
        _tag: "Rejected",
        reason: "closed",
      });
      assert.equal(faults, 1);
    }),
  ),
);

it.effect("fail-session capacity pressure fences without starting rejected work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0,
        faults = 0;
      let release!: () => void;
      const blocked = new Promise<void>((resolve) => {
        release = resolve;
      });
      const runner = yield* makeBindingRunner(
        1,
        () =>
          Effect.sync(() => {
            calls++;
          }).pipe(Effect.andThen(Effect.promise(() => blocked))),
        () => {
          faults++;
        },
      );

      const accepted = runner.submit(undefined, "fail-session");
      const rejected = runner.submit(undefined, "fail-session");

      assert.equal(accepted._tag, "Accepted");
      assert.deepEqual(rejected, { _tag: "Rejected", reason: "capacity" });
      assert.ok(calls <= 1);
      assert.equal(faults, 1);

      release();
      if (accepted._tag === "Accepted") yield* Effect.promise(() => accepted.result);
      assert.equal(calls, 1);
      assert.equal(faults, 1);
    }),
  ),
);

it.effect("parallel parent teardown still fences admission before callback interruption", () =>
  Effect.gen(function* () {
    let faults = 0;
    let escaped: BindingRunner<void, never, never> | undefined;
    let pending: Promise<unknown> | undefined;
    const parent = yield* Scope.make("parallel");

    yield* Scope.provide(parent)(
      Effect.gen(function* () {
        const runner = yield* makeBindingRunner<void, never, never, never>(
          1,
          () => Effect.never,
          () => {
            faults++;
          },
        );
        const admitted = runner.submit(undefined, "fail-session");

        assert.equal(admitted._tag, "Accepted");
        escaped = runner;
        if (admitted._tag === "Accepted") pending = admitted.result;
      }),
    );
    yield* Scope.close(parent, Exit.void);

    assert.ok(escaped);
    assert.deepEqual(escaped.submit(undefined, "fail-session"), {
      _tag: "Rejected",
      reason: "closed",
    });
    if (pending !== undefined)
      yield* Effect.promise(() => pending!.then(
        () => undefined,
        () => undefined,
      ));
    assert.equal(faults, 0);
  }),
);
