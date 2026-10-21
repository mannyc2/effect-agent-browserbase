// The 21 October supervisor audit reproduced lost outcomes when retirement's waiter left.
// Suspended public resource ports make cancellation and cleanup ordering deterministic.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Exit, Fiber, Schedule, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

import * as Released from "../src/providers/Released.ts";
import * as Supervisor from "../src/supervisor/Supervisor.ts";

const closed = <A, E>(supervisor: Supervisor.Supervisor<A, E>) =>
  supervisor.states.pipe(
    Stream.filter(({ state }) => state._tag === "Closed"),
    Stream.runHead,
    Effect.map((event) => {
      assert.strictEqual(event._tag, "Some");
      if (event._tag === "None") throw new Error("the release outcome was lost");

      const state = event.value.state;

      if (state._tag !== "Closed") throw new Error("expected Closed");

      return state;
    }),
  );

it.effect.each(["interrupted caller", "inside use"] as const)(
  "publishes the final outcome after retiring from %s",
  (trigger) =>
    Effect.gen(function* () {
      const releasing = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      let releases = 0;

      const supervisor = yield* Supervisor.make({
        open: () =>
          Effect.succeed({
            value: "resource",
            release: () =>
              Deferred.succeed(releasing, undefined).pipe(
                Effect.andThen(Deferred.await(finish)),
                Effect.andThen(Effect.sync(() => releases++)),
                Effect.as(new Released.Settled()),
              ),
          }),
      });

      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));
      const early = yield* supervisor.states.pipe(Stream.runCollect, Effect.forkChild);

      yield* supervisor.use(() => Effect.void);

      const caller = yield* (
        trigger === "inside use" ? supervisor.use(() => supervisor.retire) : supervisor.retire
      ).pipe(Effect.exit, Effect.forkChild);

      yield* Deferred.await(releasing);
      if (trigger === "interrupted caller") yield* Fiber.interrupt(caller);
      else assert.strictEqual((yield* Fiber.join(caller))._tag, "Failure");
      assert.isUndefined(early.pollUnsafe(), "states must remain open while release is suspended");
      yield* Deferred.succeed(finish, undefined);
      yield* supervisor.retire;
      const events = yield* Fiber.join(early);
      const late = yield* supervisor.states.pipe(Stream.runCollect);

      assert.deepStrictEqual(events, late);
      assert.strictEqual(events.at(-1)?.state._tag, "Closed");
      assert.strictEqual((yield* closed(supervisor)).released?._tag, "Settled");
      assert.strictEqual(releases, 1);
    }),
);

it.effect.each(["provider defect", "scope defect", "no release"] as const)(
  "uses the same outcome rule for %s",
  (failure) =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.make({
        exclusive: true,
        open: (number) =>
          Effect.gen(function* () {
            if (number === 1 && failure === "scope defect")
              yield* Effect.addFinalizer(() => Effect.die("scope cleanup failed"));

            return {
              value: number,
              release:
                failure === "no release"
                  ? undefined
                  : () =>
                      number === 1 && failure === "provider defect"
                        ? Effect.die("provider release failed")
                        : Effect.succeed(new Released.Settled()),
            };
          }),
      });

      yield* supervisor.use(() => Effect.void);
      yield* supervisor.rotate();
      assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value)), 2);
      yield* supervisor.retire;
      const events = yield* supervisor.states.pipe(Stream.runCollect);

      const outcomes = events.flatMap(({ state }) =>
        state._tag === "Closed" ? [state.released?._tag] : [],
      );

      assert.deepStrictEqual(outcomes, [
        failure === "no release" ? "Settled" : "Unconfirmed",
        "Settled",
      ]);
    }),
);

it.effect("finishes a running try before retirement, then releases it once", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const released: Array<string> = [];

    const supervisor = yield* Supervisor.make({
      open: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as({
            value: "opened during retirement",
            release: (why: Supervisor.Why) =>
              Effect.sync(() => released.push(why)).pipe(Effect.as(new Released.Settled())),
          }),
        ),
    });

    yield* Deferred.await(entered);
    const retiring = yield* Effect.forkChild(supervisor.retire);

    yield* Effect.yieldNow;
    assert.isUndefined(retiring.pollUnsafe());
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(retiring);
    assert.deepStrictEqual(released, ["retired"]);
    assert.strictEqual((yield* closed(supervisor)).released?._tag, "Settled");
  }),
);

it.effect("publishes every typed retry error without retaining earlier uncertainty", () =>
  Effect.gen(function* () {
    const first = {
      detail: "first failed try",
      cleanup: new Released.Unconfirmed({ detail: "possibly still running" }),
    };

    let tries = 0;

    const supervisor = yield* Supervisor.make({
      open: () =>
        Effect.suspend(() =>
          ++tries === 1 ? Effect.fail(first) : Effect.succeed({ value: tries }),
        ),
      reopen: Schedule.recurs(1),
    });

    assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value)), 2);
    yield* supervisor.rotate();
    assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value)), 3);
    yield* supervisor.retire;
    const events = yield* supervisor.states.pipe(Stream.runCollect);
    const failures = events.flatMap(({ state }) => (state._tag === "Failed" ? [state.error] : []));

    assert.deepStrictEqual(failures, [first]);
    assert.deepStrictEqual(
      events.flatMap(({ state }) => (state._tag === "Closed" ? [state.released?._tag] : [])),
      ["Settled", "Settled"],
    );
  }),
);

it.effect("cuts retry sleep short and preserves typed definite failures", () =>
  Effect.gen(function* () {
    const refusal = { _tag: "Refused", detail: "no permission" };

    const definite = yield* Supervisor.make({
      open: () => Effect.fail(refusal),
      definite: () => true,
    });

    const unavailable = yield* Effect.flip(definite.use(() => Effect.void));

    assert.strictEqual(unavailable._tag, "Unavailable");
    assert.strictEqual(unavailable._tag === "Unavailable" && unavailable.error, refusal);
    yield* definite.retire;

    const retrying = yield* Supervisor.make({
      open: () => Effect.fail(refusal),
      reopen: Schedule.spaced("1 hour"),
    });

    yield* retrying.states.pipe(
      Stream.filter(({ state }) => state._tag === "Failed"),
      Stream.runHead,
    );
    yield* retrying.retire;
    assert.strictEqual(
      (yield* retrying.states.pipe(Stream.runCollect)).at(-1)?.state._tag,
      "Closed",
    );
  }),
);

it.effect("bounds the entire admission without bounding work or cancelling the shared open", () =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.make({
      open: () => Effect.sleep("30 seconds").pipe(Effect.as({ value: "ready" })),
    });

    const immediate = yield* Effect.exit(supervisor.use(() => Effect.void, { wait: 0 }));

    assert.isTrue(Exit.isFailure(immediate));

    const waiting = yield* supervisor
      .use(() => Effect.never, { wait: "10 seconds" })
      .pipe(Effect.exit, Effect.forkChild);

    yield* TestClock.adjust("10 seconds");
    assert.isTrue(Exit.isFailure(yield* Fiber.join(waiting)));
    yield* TestClock.adjust("20 seconds");

    const work = yield* supervisor
      .use(() => Effect.sleep("20 seconds"), { wait: 0 })
      .pipe(Effect.forkChild);

    yield* TestClock.adjust("19 seconds");
    assert.isUndefined(work.pollUnsafe(), "the admission budget must not time out the work");
    yield* TestClock.adjust("1 second");
    yield* Fiber.join(work);
    yield* supervisor.retire;
  }),
);

it.effect(
  "releases only after revoked work finishes cleanup and ignores stale loss and rotation",
  () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<Supervisor.Lease<number>>();
      const cleaning = yield* Deferred.make<void>();
      const finish = yield* Deferred.make<void>();
      const order: Array<string> = [];

      const supervisor = yield* Supervisor.make({
        exclusive: true,
        open: (number) =>
          Effect.sync(() => {
            order.push(`open ${number}`);

            return {
              value: number,
              release: () =>
                Effect.sync(() => order.push(`release ${number}`)).pipe(
                  Effect.as(new Released.Settled()),
                ),
            };
          }),
      });

      yield* Effect.addFinalizer(() => Deferred.succeed(finish, undefined));

      const work = yield* supervisor
        .use((lease) =>
          Deferred.succeed(entered, lease).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Deferred.succeed(cleaning, undefined).pipe(Effect.andThen(Deferred.await(finish))),
            ),
          ),
        )
        .pipe(Effect.exit, Effect.forkChild);

      const lease = yield* Deferred.await(entered);

      yield* lease.lose("declared unusable");
      yield* Deferred.await(cleaning);
      assert.deepStrictEqual(order, ["open 1"]);
      yield* Deferred.succeed(finish, undefined);
      const outcome = yield* Fiber.join(work);

      assert.strictEqual(outcome._tag, "Failure");
      assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value)), 2);
      yield* lease.lose("late declaration");
      yield* supervisor.rotate(1);
      assert.deepStrictEqual(order, ["open 1", "release 1", "open 2"]);
      yield* supervisor.retire;
    }),
);

it.effect("adds its finalizer to the caller scope and watches loss throughout release", () =>
  Effect.gen(function* () {
    const owner = yield* Scope.make();
    const lost = yield* Deferred.make<string>();
    let watched = false;
    const order: Array<string> = [];

    const supervisor = yield* Supervisor.make({
      open: () =>
        Effect.succeed({
          value: "resource",
          lost: Deferred.await(lost).pipe(Effect.tap(() => Effect.sync(() => (watched = true)))),
          release: () =>
            Deferred.succeed(lost, "lost while releasing").pipe(
              Effect.andThen(Effect.repeat(Effect.yieldNow, { until: () => watched })),
              Effect.andThen(Effect.sync(() => order.push("provider"))),
              Effect.as(new Released.Settled()),
            ),
        }),
    }).pipe(Scope.provide(owner));

    yield* supervisor.use(() => Effect.void);
    yield* Scope.addFinalizer(
      owner,
      Effect.sync(() => order.push("caller finalizer")),
    );
    yield* Scope.close(owner, Exit.void);
    assert.deepStrictEqual(order, ["caller finalizer", "provider"]);
    assert.isTrue(watched);
    assert.strictEqual((yield* closed(supervisor)).released?._tag, "Settled");
  }),
);

// Preserve the former owner-clock and cleanup regressions across the public core cutover.
it.live("keeps admission on its owner clock under a caller TestClock", () =>
  Effect.gen(function* () {
    const opened = yield* Deferred.make<void>();

    const supervisor = yield* Supervisor.make({
      open: () => Deferred.await(opened).pipe(Effect.as({ value: "ready" })),
    });

    yield* Effect.addFinalizer(() => Deferred.succeed(opened, undefined));

    const caller = yield* supervisor
      .use(() => Effect.void, { wait: "20 millis" })
      .pipe(Effect.provide(TestClock.layer()), Effect.exit, Effect.forkChild);

    yield* Effect.sleep("80 millis");
    assert.isDefined(caller.pollUnsafe(), "a caller's stopped clock cannot stop admission expiry");
    assert.isTrue(Exit.isFailure(yield* Fiber.join(caller)));
    yield* Deferred.succeed(opened, undefined);
    yield* supervisor.retire;
  }),
);

it.effect("preserves a revoked work cleanup defect and still releases the provider", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const order: Array<string> = [];

    const supervisor = yield* Supervisor.make({
      open: () =>
        Effect.succeed({
          value: "resource",
          release: () =>
            Effect.sync(() => order.push("provider")).pipe(Effect.as(new Released.Settled())),
        }),
    });

    const work = yield* supervisor
      .use(() =>
        Effect.gen(function* () {
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => order.push("work")).pipe(
              Effect.andThen(Effect.die("work cleanup failed")),
            ),
          );
          yield* Deferred.succeed(entered, undefined);

          return yield* Effect.never;
        }),
      )
      .pipe(Effect.exit, Effect.forkChild);

    yield* Deferred.await(entered);
    yield* supervisor.retire;
    assert.isTrue(Exit.hasDies(yield* Fiber.join(work)));
    assert.deepStrictEqual(order, ["work", "provider"]);
    assert.strictEqual((yield* closed(supervisor)).released?._tag, "Settled");
  }),
);

it.effect.each([-1, Number.POSITIVE_INFINITY])(
  "rejects invalid admission budget %s as a typed failure",
  (wait) =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.make({ open: () => Effect.succeed({ value: "ready" }) });
      let ran = false;

      const result = yield* supervisor
        .use(
          () =>
            Effect.sync(() => {
              ran = true;
            }),
          { wait },
        )
        .pipe(Effect.result);

      assert.strictEqual(result._tag, "Failure");
      if (result._tag === "Failure") assert.strictEqual(result.failure._tag, "InvalidWait");
      assert.isFalse(ran);
    }),
);
