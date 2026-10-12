// Random scope closure order and the shared deadline need deterministic scheduling in addition
// to the native browser proof in Suspension.test.ts.
import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Clock, Deferred, Duration, Effect, Exit, Fiber, Schema, Scope } from "effect";
import { TestClock } from "effect/testing";

import type { DisconnectCause } from "../src/BrowserEvent.ts";
import * as Gate from "../src/internal/input/gate.ts";

const fixture = Effect.gen(function* () {
  const clock = yield* Clock.Clock;
  const lost = yield* Deferred.make<DisconnectCause>();
  let sequence = 0;
  let closed: DisconnectCause | undefined;

  const gate = Gate.make({
    now: () => Number(clock.monotonicTimeNanosUnsafe()) / 1e6,
    sequence: () => sequence,
    closedBy: () => closed,
    lost: Deferred.await(lost),
    clock,
    drain: Duration.seconds(30),
  });

  return {
    gate,
    record: () => ++sequence,
    close: Effect.sync(() => {
      closed = "connection";
      Deferred.doneUnsafe(lost, Exit.succeed(closed));
    }),
  };
});

const owner = Effect.gen(function* () {
  const scope = yield* Scope.make();

  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void));

  return scope;
});

describe("Input suspension scopes", () => {
  it.effect.prop(
    "restores input only after the last acquired scope closes, in any closure order",
    { choices: Arbitrary.array(Arbitrary.schema(Schema.Int), { minLength: 20, maxLength: 100 }) },
    ({ choices }) =>
      Effect.gen(function* () {
        const { gate, record } = yield* fixture;
        const scopes: Array<Scope.Closeable> = [];

        for (const choice of choices) {
          if (Math.abs(choice % 3) === 0) {
            const scope = yield* owner;

            yield* gate.suspend().pipe(Scope.provide(scope));
            scopes.push(scope);
          } else if (Math.abs(choice % 3) === 1 && scopes.length > 0) {
            const [scope] = scopes.splice(Math.abs(choice) % scopes.length, 1);

            if (scope !== undefined) yield* Scope.close(scope, Exit.void);
          } else {
            const admitted = yield* Effect.exit(gate.enter("press"));

            assert.strictEqual(Exit.isSuccess(admitted), scopes.length === 0);
            if (Exit.isSuccess(admitted)) {
              record();
              admitted.value();
            }
          }
        }
        for (const scope of scopes) yield* Scope.close(scope, Exit.void);
        (yield* gate.enter("press"))();
      }).pipe(Effect.scoped),
    { arbitrary: { runs: 100 } },
  );

  it.effect("shares the first drain deadline and drops every pending claim on expiry", () =>
    Effect.gen(function* () {
      const { gate } = yield* fixture;
      const end = yield* gate.enter("press");

      const first = yield* gate
        .suspend("40 millis")
        .pipe(Effect.scoped, Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("10 millis");

      const second = yield* gate
        .suspend("1 millis")
        .pipe(Effect.scoped, Effect.flip, Effect.forkChild);

      yield* TestClock.adjust("29 millis");
      assert.isUndefined(first.pollUnsafe());
      assert.isUndefined(second.pollUnsafe());
      yield* TestClock.adjust("1 millis");
      assert.strictEqual((yield* Fiber.join(first)).reason._tag, "Busy");
      assert.strictEqual((yield* Fiber.join(second)).reason._tag, "Busy");
      (yield* gate.enter("new input"))();
      end();
      const scope = yield* owner;

      yield* gate.suspend(0).pipe(Scope.provide(scope));
      assert.strictEqual((yield* Effect.flip(gate.enter("held"))).reason._tag, "Suspended");
    }).pipe(Effect.scoped),
  );

  it.effect(
    "cancels one waiter without releasing another, and never grants after browser loss",
    () =>
      Effect.gen(function* () {
        const { gate, close } = yield* fixture;
        const end = yield* gate.enter("press");
        const first = yield* gate.suspend().pipe(Effect.scoped, Effect.forkChild);
        const second = yield* gate.suspend().pipe(Effect.scoped, Effect.flip, Effect.forkChild);

        yield* Effect.yieldNow;
        yield* Fiber.interrupt(first);
        assert.strictEqual((yield* Effect.flip(gate.enter("waiting"))).reason._tag, "Suspended");
        yield* close;
        assert.strictEqual((yield* Fiber.join(second)).reason._tag, "Closed");
        end();
        assert.strictEqual(
          (yield* gate.suspend().pipe(Effect.scoped, Effect.flip)).reason._tag,
          "Closed",
        );
      }).pipe(Effect.scoped),
  );
  it.effect(
    "refuses a late native reply even when its completion runs before the timer fiber",
    () =>
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        let now = 0;

        const gate = Gate.make({
          now: () => now,
          sequence: () => 1,
          closedBy: () => undefined,
          lost: Effect.never,
          clock,
          drain: Duration.millis(20),
        });

        const end = yield* gate.enter("press");
        const stopping = yield* gate.suspend().pipe(Effect.scoped, Effect.exit, Effect.forkChild);

        yield* Effect.yieldNow;
        // A native microtask observes the elapsed host deadline before the timer is scheduled.
        now = 21;
        end();
        const stopped = yield* Fiber.join(stopping);

        assert.isTrue(Exit.isFailure(stopped));
      }).pipe(Effect.scoped),
  );
});
