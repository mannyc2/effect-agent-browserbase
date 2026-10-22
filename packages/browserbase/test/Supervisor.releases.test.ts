// #289 and the 21 October audit: every failed try publishes its own cleanup evidence.
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Stream } from "effect";
import * as Supervisor from "effect-browser/Supervisor";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as ContextLease from "effect-browserbase/ContextLease";
import { TestBrowserbase } from "effect-browserbase/testing";
import { TestClock } from "effect/testing";

const fake = (script: TestBrowserbase.Script) =>
  Layer.merge(TestBrowserbase.layer(script), ContextLease.layer);

const sessions = Effect.flatMap(TestBrowserbase.TestBrowserbase, (fake) => fake.sessions);

/** Advance the real provider deadlines while its cleanup owns the session. */
const finish = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let second = 0; fiber.pollUnsafe() === undefined; second++) {
      assert.isBelow(second, 180, "cleanup finishes within three minutes");
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
    }

    return yield* Fiber.join(fiber);
  });

it.effect.each([
  { release: { _tag: "Refused", status: 403 } as const, outcome: "Unconfirmed", status: "RUNNING" },
  { release: { _tag: "Ends" } as const, outcome: "Settled", status: "COMPLETED" },
])("publishes the failed try's $outcome cleanup", ({ release, outcome, status }) =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.make({
      ...Browserbase.generations({ build: Effect.succeed }),
      reopen: Schedule.recurs(0),
    });

    const error = yield* finish(
      yield* Effect.forkChild(Effect.flip(supervisor.use(() => Effect.void))),
    );

    if (error._tag !== "Unavailable")
      throw new Error(`expected Unavailable, received ${error._tag}`);
    yield* supervisor.retire;
    const events = yield* supervisor.states.pipe(Stream.runCollect);
    const failures = events.flatMap(({ state }) => (state._tag === "Failed" ? [state.error] : []));
    const rows = yield* sessions;

    assert.strictEqual(error.reason, "down");
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0]?.cleanup?._tag, outcome);
    assert.deepStrictEqual(
      rows.map(({ status, releases }) => [status, releases]),
      [[status, 1]],
    );
    const released = failures[0]?.cleanup;

    if (released?._tag === "Unconfirmed") assert.include(released.detail, rows[0]!.id);
  }).pipe(Effect.scoped, Effect.provide(fake({ releases: [release] }))),
);

it.effect("publishes pending cleanup before a retirement during a failed try finishes", () =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.make({
      ...Browserbase.generations({ build: Effect.succeed }),
      reopen: Schedule.spaced("10 seconds"),
    });

    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(
      (yield* sessions).map(({ status, releases }) => [status, releases]),
      [["RUNNING", 1]],
    );
    const retiring = yield* Effect.forkChild(supervisor.retire);

    yield* Effect.yieldNow;
    assert.isUndefined(retiring.pollUnsafe());
    yield* finish(retiring);
    const events = yield* supervisor.states.pipe(Stream.runCollect);
    const failures = events.flatMap(({ state }) => (state._tag === "Failed" ? [state.error] : []));
    const rows = yield* sessions;
    const released = failures[0]?.cleanup;

    assert.strictEqual(events.at(-1)?.state._tag, "Closed");
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(released?._tag, "Unconfirmed");
    if (released?._tag === "Unconfirmed") assert.include(released.detail, rows[0]!.id);
    assert.deepStrictEqual(
      rows.map(({ status, releases }) => [status, releases]),
      [["RUNNING", 1]],
    );
  }).pipe(Effect.scoped, Effect.provide(fake({ releases: [{ _tag: "Refused", status: 403 }] }))),
);

it.effect("reports no cleanup when the provider refused to create anything", () =>
  Effect.gen(function* () {
    const supervisor = yield* Supervisor.make(Browserbase.generations({ build: Effect.succeed }));
    const error = yield* Effect.flip(supervisor.use(() => Effect.void));

    if (error._tag !== "Unavailable")
      throw new Error(`expected Unavailable, received ${error._tag}`);
    assert.strictEqual(error.reason, "down");
    assert.isUndefined(error.error?.cleanup);
    assert.deepStrictEqual(yield* sessions, []);
  }).pipe(Effect.scoped, Effect.provide(fake({ creates: [{ _tag: "Reject", status: 403 }] }))),
);

it.effect(
  "publishes each try's own cleanup rather than carrying the first uncertainty forward",
  () =>
    Effect.gen(function* () {
      const supervisor = yield* Supervisor.make({
        ...Browserbase.generations({ build: Effect.succeed }),
        reopen: Schedule.recurs(1),
      });

      yield* finish(yield* Effect.forkChild(Effect.flip(supervisor.use(() => Effect.void))));
      yield* supervisor.retire;
      const events = yield* supervisor.states.pipe(Stream.runCollect);

      const failures = events.flatMap(({ state }) =>
        state._tag === "Failed" ? [state.error.cleanup?._tag] : [],
      );

      assert.deepStrictEqual(failures, ["Unconfirmed", "Settled"]);
      assert.deepStrictEqual(
        (yield* sessions).map(({ status, releases }) => [status, releases]),
        [
          ["RUNNING", 1],
          ["COMPLETED", 1],
        ],
      );
    }).pipe(
      Effect.scoped,
      Effect.provide(fake({ releases: [{ _tag: "Refused", status: 403 }, { _tag: "Ends" }] })),
    ),
);
