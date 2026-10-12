// #289: failed and interrupted acquisition cleanup remains public without a later admission.
import { assert, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Schedule, Stream } from "effect";
import type * as Supervisor from "effect-browser/Supervisor";
import * as Browserbase from "effect-browserbase/Browserbase";
import * as ContextLease from "effect-browserbase/ContextLease";
import { TestBrowserbase } from "effect-browserbase/testing";
import { TestClock } from "effect/testing";

const fake = (script: TestBrowserbase.Script) =>
  Layer.merge(TestBrowserbase.layer(script), ContextLease.layer);

const sessions = Effect.flatMap(TestBrowserbase.TestBrowserbase, (fake) => fake.sessions);

/** Advance provider deadlines while allowing the supervisor's release finalizers to finish. */
const finish = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let second = 0; fiber.pollUnsafe() === undefined; second++) {
      assert.isBelow(second, 180, "cleanup finishes within three minutes");
      yield* TestClock.adjust("1 second");
      yield* Effect.yieldNow;
    }

    return yield* Fiber.join(fiber);
  });

const terminal = (supervisor: Supervisor.Supervisor<unknown>) =>
  supervisor.states.pipe(
    Stream.filter(({ state }) => state._tag === "Down" || state._tag === "Closed"),
    Stream.runHead,
    Effect.map((event) => {
      if (event._tag === "None") return assert.fail("a terminal generation must be published");

      return event.value;
    }),
  );

it.effect.each([
  { release: { _tag: "Refused", status: 403 } as const, outcome: "Unconfirmed", status: "RUNNING" },
  { release: { _tag: "Ends" } as const, outcome: "Settled", status: "COMPLETED" },
])("publishes the last failed try's $outcome cleanup", ({ release, outcome, status }) =>
  Effect.gen(function* () {
    const supervisor = yield* Browserbase.supervise({ reopen: Schedule.recurs(0) });
    const error = yield* finish(yield* Effect.forkChild(Effect.flip(supervisor.browser)));
    const ended = yield* terminal(supervisor);
    const rows = yield* sessions;
    const released = "released" in ended.state ? ended.state.released : undefined;

    assert.strictEqual(error.reason, "down");
    assert.deepStrictEqual([ended.number, ended.state._tag], [1, "Down"]);
    assert.strictEqual(released?._tag, outcome);
    assert.deepStrictEqual(
      rows.map(({ status, releases }) => [status, releases]),
      [[status, 1]],
    );
    if (released?._tag === "Unconfirmed") assert.include(released.detail, rows[0]!.id);
    yield* supervisor.retire;
  }).pipe(Effect.scoped, Effect.provide(fake({ releases: [release] }))),
);

it.effect("publishes interrupted cleanup when retired during a failed try's release", () =>
  Effect.gen(function* () {
    const supervisor = yield* Browserbase.supervise({ reopen: Schedule.spaced("10 seconds") });

    yield* TestClock.adjust("2 seconds");
    assert.deepStrictEqual(
      (yield* sessions).map(({ status, releases }) => [status, releases]),
      [["RUNNING", 1]],
    );
    const retiring = yield* Effect.forkChild(supervisor.retire);

    yield* Effect.yieldNow;
    assert.isUndefined(retiring.pollUnsafe(), "retirement still owns pending cleanup");
    yield* finish(retiring);
    const ended = yield* terminal(supervisor);
    const rows = yield* sessions;
    const released = "released" in ended.state ? ended.state.released : undefined;

    assert.strictEqual(ended.number, 1);
    assert.include(["Down", "Closed"], ended.state._tag);
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
    const supervisor = yield* Browserbase.supervise({ definite: () => true });
    const error = yield* Effect.flip(supervisor.browser);
    const ended = yield* terminal(supervisor);

    assert.strictEqual(error.reason, "down");
    assert.deepStrictEqual([ended.number, ended.state._tag], [1, "Down"]);
    assert.isUndefined("released" in ended.state ? ended.state.released : undefined);
    assert.deepStrictEqual(yield* sessions, []);
  }).pipe(Effect.scoped, Effect.provide(fake({ creates: [{ _tag: "Reject", status: 403 }] }))),
);

it.effect(
  "keeps the first unconfirmed try in admission and terminal cleanup after a settled try",
  () =>
    Effect.gen(function* () {
      const admissions: Array<Supervisor.Released | undefined> = [];

      const supervisor = yield* Browserbase.supervise({
        reopen: Schedule.recurs(1),
        waitTimeout: "5 minutes",
        admit: ({ after }) =>
          Effect.gen(function* () {
            admissions.push(after === undefined ? undefined : yield* after);
          }),
      });

      yield* finish(yield* Effect.forkChild(Effect.flip(supervisor.browser)));
      const ended = yield* terminal(supervisor);
      const rows = yield* sessions;
      const released = "released" in ended.state ? ended.state.released : undefined;

      assert.deepStrictEqual(
        admissions.map((outcome) => outcome?._tag),
        [undefined, "Unconfirmed"],
      );
      assert.strictEqual(ended.number, 1);
      assert.strictEqual(
        released,
        admissions[1],
        "the first uncertainty remains the same evidence",
      );
      if (released?._tag === "Unconfirmed") assert.include(released.detail, rows[0]!.id);
      assert.deepStrictEqual(
        rows.map(({ status, releases }) => [status, releases]),
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
