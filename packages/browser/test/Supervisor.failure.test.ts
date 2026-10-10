// Cleanup defects and repeated generation loss must not escape ownership or extend admission.
import { assert, describe, it } from "@effect/vitest";
import { Duration, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

import type * as Browser from "../src/Browser.ts";
import type { DisconnectCause } from "../src/BrowserEvent.ts";
import * as Supervisor from "../src/Supervisor.ts";

/** Only the provider identity and disconnection boundary consumed by Supervisor. */
const browser = (id: string, disconnected: Effect.Effect<DisconnectCause> = Effect.never) =>
  ({ id, disconnected }) as unknown as Browser.Service;

/** These tests deliberately fail finalizers; close their owner even after an assertion fails. */
const owner = Effect.gen(function* () {
  const scope = yield* Scope.make();

  yield* Effect.addFinalizer(() => Scope.close(scope, Exit.void).pipe(Effect.exit, Effect.asVoid));

  return scope;
});

describe("Supervisor failure ownership", () => {
  it.effect("refuses unbounded or negative handover before opening a provider", () =>
    Effect.gen(function* () {
      let opened = false;

      for (const handover of [Duration.infinity, Duration.millis(-1)]) {
        const result = yield* Supervisor.make({
          handover,
          open: Effect.sync(() => {
            opened = true;

            return { browser: browser("invalid"), value: undefined };
          }),
        }).pipe(Effect.scoped, Effect.exit);

        assert.isTrue(Exit.hasDies(result));
      }
      assert.isFalse(opened);
    }),
  );

  it.effect("releases the provider and reports a retained-resource cleanup defect", () =>
    Effect.gen(function* () {
      const scope = yield* owner;
      const order: Array<string> = [];

      const supervisor = yield* Supervisor.make({
        open: Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => void order.push("generation")));

          return {
            browser: browser("first"),
            value: undefined,
            release: Effect.sync(() => void order.push("provider")).pipe(
              Effect.as(new Supervisor.Settled()),
            ),
          };
        }),
      }).pipe(Scope.provide(scope));

      const retained = yield* supervisor.use((lease) => lease.retain);

      yield* Scope.addFinalizer(retained, Effect.die("retained cleanup defect"));
      const retired = yield* Effect.exit(supervisor.retire);

      assert.deepStrictEqual(order, ["provider", "generation"]);
      assert.isTrue(Exit.hasDies(retired), "retirement must preserve the cleanup failure");

      const closed = yield* supervisor.states.pipe(
        Stream.filter((event) => event.state._tag === "Closed"),
        Stream.runHead,
      );

      assert.isTrue(
        closed._tag === "Some" &&
          closed.value.state._tag === "Closed" &&
          closed.value.state.released?._tag === "Settled",
      );
    }),
  );

  it.effect("finishes exclusive release despite a generation-scope cleanup defect", () =>
    Effect.gen(function* () {
      const scope = yield* owner;
      const releases: Array<number> = [];
      let opens = 0;

      const supervisor = yield* Supervisor.make({
        exclusive: true,
        waitTimeout: "50 millis",
        open: Effect.gen(function* () {
          const number = ++opens;

          if (number === 1)
            yield* Effect.addFinalizer(() => Effect.die("generation cleanup defect"));

          return {
            browser: browser(String(number)),
            value: undefined,
            release: Effect.sync(() => void releases.push(number)).pipe(
              Effect.as(new Supervisor.Settled()),
            ),
          };
        }),
      }).pipe(Scope.provide(scope));

      yield* supervisor.browser;
      const rotating = yield* supervisor.rotate.pipe(Effect.exit, Effect.forkChild);

      yield* TestClock.adjust("50 millis");
      const rotated = yield* Fiber.join(rotating);

      assert.isTrue(Exit.isSuccess(rotated), "a closed scope must not strand exclusive arrival");
      assert.strictEqual(opens, 2);
      const retired = yield* Effect.exit(supervisor.retire);

      assert.deepStrictEqual(releases, [1, 2]);
      assert.isTrue(Exit.hasDies(retired), "retirement must preserve the earlier cleanup failure");
    }),
  );

  it.effect("bounds the entire borrow while successive generations are lost before admission", () =>
    Effect.gen(function* () {
      let opens = 0;
      let calls = 0;

      const supervisor = yield* Supervisor.make({
        open: Effect.sleep("10 millis").pipe(
          Effect.map(() => ({
            browser: browser(
              String(++opens),
              opens <= 10 ? Effect.succeed("connection") : Effect.never,
            ),
            value: undefined,
            release: Effect.succeed(new Supervisor.Settled()),
          })),
        ),
      });

      const waiting = yield* supervisor
        .use(() => Effect.sync(() => void calls++), { wait: "25 millis" })
        .pipe(Effect.flip, Effect.forkChild);

      // Let publication and loss fibers finish between clock advances, as on the host clock.
      for (let tick = 0; tick < 5; tick++) {
        yield* TestClock.adjust("5 millis");
        yield* TestClock.withLive(Effect.sleep("1 millis"));
      }
      assert.isDefined(waiting.pollUnsafe(), "generation races must not restart the wait budget");
      const waited = yield* Fiber.join(waiting);

      assert.deepStrictEqual(
        [waited._tag, waited.reason, calls, opens],
        ["Unavailable", "opening", 0, 2],
      );
    }),
  );
});
