// #281: provider release acknowledgement must be available before the next acquisition.
// A controlled provider forces release/admission races without paid sessions or wall-clock waits.
import { assert, it } from "@effect/vitest";
import { Context, Deferred, Effect, Fiber, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import type * as Browser from "../src/Browser.ts";
import * as Supervisor from "../src/Supervisor.ts";

const browser = (disconnected: Effect.Effect<"connection"> = Effect.never) =>
  ({ disconnected }) as unknown as Browser.Service;

const published = (supervisor: Supervisor.Supervisor, number: number, tag: string) =>
  supervisor.states.pipe(
    Stream.filter((event) => event.number === number && event.state._tag === tag),
    Stream.runHead,
  );

const settledOnly = ({ after }: Supervisor.Admission) =>
  after === undefined
    ? Effect.void
    : after.pipe(
        Effect.flatMap((released) =>
          released._tag === "Unconfirmed" ? Effect.fail("unconfirmed session") : Effect.void,
        ),
      );

// #281's expanded acceptance: one admission policy must preserve rotation and guard every loss.
it.effect("keeps healthy nonexclusive rotation make-before-break with release admission", () =>
  Effect.gen(function* () {
    const released = yield* Deferred.make<Supervisor.Released>();
    const admitting = yield* Deferred.make<void>();
    const order: Array<string> = [];
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.sync(() => {
        const number = ++opens;

        order.push(`open ${number}`);

        return {
          browser: browser(),
          release: Effect.sync(() => order.push(`release ${number}`)).pipe(
            Effect.andThen(Deferred.await(released)),
          ),
        };
      }),
      admit: (opening) =>
        (opening.number === 2 ? Deferred.succeed(admitting, undefined) : Effect.void).pipe(
          Effect.andThen(settledOnly(opening)),
        ),
      definite: (error) => error === "unconfirmed session",
    });

    yield* Effect.addFinalizer(() => Deferred.succeed(released, new Supervisor.Settled()));
    yield* supervisor.browser;
    const rotating = yield* supervisor.rotate.pipe(Effect.forkChild);

    yield* Deferred.await(admitting);
    yield* Effect.yieldNow;
    assert.strictEqual(opens, 2);
    yield* Fiber.join(rotating);
    assert.deepStrictEqual(order.slice(0, 2), ["open 1", "open 2"]);
    assert.strictEqual(yield* supervisor.use(({ generation }) => Effect.succeed(generation)), 2);
    yield* Deferred.succeed(released, new Supervisor.Settled());
    yield* published(supervisor, 1, "Closed");
    assert.deepStrictEqual(order, ["open 1", "open 2", "release 1"]);
  }),
);

for (const exclusive of [false, true])
  it.effect(`confirms each lost release before allocating again (exclusive=${exclusive})`, () =>
    Effect.gen(function* () {
      const firstLost = yield* Deferred.make<"connection">();
      const secondLost = yield* Deferred.make<"connection">();
      const firstReleased = yield* Deferred.make<Supervisor.Released>();
      const secondReleased = yield* Deferred.make<Supervisor.Released>();
      const outcome = new Supervisor.Unconfirmed({ detail: "confirmation timed out" });
      let opens = 0;

      const supervisor = yield* Supervisor.make({
        open: Effect.sync(() => ({
          browser: browser(Deferred.await(++opens === 1 ? firstLost : secondLost)),
          release: Deferred.await(opens === 1 ? firstReleased : secondReleased),
        })),
        exclusive,
        admit: settledOnly,
        definite: (error) => error === "unconfirmed session",
      });

      yield* Effect.addFinalizer(() =>
        Deferred.succeed(firstReleased, new Supervisor.Settled()).pipe(
          Effect.andThen(Deferred.succeed(secondReleased, outcome)),
        ),
      );

      yield* supervisor.browser;
      yield* Deferred.succeed(firstLost, "connection");
      yield* published(supervisor, 2, "Reopening");
      yield* TestClock.adjust("2500 millis");
      assert.strictEqual(opens, 1);
      yield* Deferred.succeed(firstReleased, new Supervisor.Settled());
      yield* published(supervisor, 2, "Open");
      assert.strictEqual(opens, 2);
      assert.strictEqual(yield* supervisor.use(({ generation }) => Effect.succeed(generation)), 2);

      yield* Deferred.succeed(secondLost, "connection");
      yield* published(supervisor, 3, "Reopening");
      yield* TestClock.adjust("2500 millis");
      assert.strictEqual(opens, 2);
      yield* Deferred.succeed(secondReleased, outcome);
      yield* published(supervisor, 3, "Down");
      assert.deepStrictEqual(
        yield* Effect.flip(supervisor.browser).pipe(
          Effect.map(({ reason, cause }) => [reason, cause]),
        ),
        ["down", "unconfirmed session"],
      );
      assert.strictEqual(
        (yield* Effect.flip(supervisor.use(() => Effect.void, { wait: 0 }))).reason,
        "down",
      );
      assert.strictEqual((yield* Effect.flip(supervisor.rotate)).reason, "down");
      assert.strictEqual(opens, 2);
      const closed = yield* published(supervisor, 2, "Closed");

      assert.isTrue(
        closed._tag === "Some" &&
          closed.value.state._tag === "Closed" &&
          closed.value.state.released === outcome,
      );
    }),
  );

it.effect("rechecks the predecessor when a rotating open retries after its loss", () =>
  Effect.gen(function* () {
    const lost = yield* Deferred.make<"connection">();
    const released = yield* Deferred.make<Supervisor.Released>();
    const admitting = yield* Deferred.make<void>();
    const admissions: Array<boolean> = [];
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.suspend(() => {
        if (++opens === 2) return Effect.fail("provider outage");

        return Effect.succeed({
          browser: browser(Deferred.await(lost)),
          release: Deferred.await(released),
        });
      }),
      admit: (opening) =>
        Effect.sync(() => admissions.push(opening.after !== undefined)).pipe(
          Effect.andThen(
            opening.number === 2 ? Deferred.succeed(admitting, undefined) : Effect.void,
          ),
          Effect.andThen(settledOnly(opening)),
        ),
      reopen: Schedule.spaced("1 second"),
      definite: (error) => error === "unconfirmed session",
    });

    yield* Effect.addFinalizer(() => Deferred.succeed(released, new Supervisor.Settled()));
    yield* supervisor.browser;
    const rotating = yield* supervisor.rotate.pipe(Effect.flip, Effect.forkChild);

    yield* Deferred.await(admitting);
    yield* Effect.yieldNow;
    assert.strictEqual(opens, 2);
    yield* Deferred.succeed(lost, "connection");
    yield* published(supervisor, 1, "Lost");
    yield* TestClock.adjust("1 second");
    assert.deepStrictEqual(admissions, [false, false, true]);
    assert.strictEqual(opens, 2);
    yield* Deferred.succeed(
      released,
      new Supervisor.Unconfirmed({ detail: "confirmation timed out" }),
    );
    assert.strictEqual((yield* Fiber.join(rotating)).reason, "down");
    assert.strictEqual(opens, 2);
  }),
);

it.effect("does not delay a loss reopen when admission ignores its prior release", () =>
  Effect.gen(function* () {
    const lost = yield* Deferred.make<"connection">();
    const released = yield* Deferred.make<Supervisor.Released>();
    const admissions: Array<Supervisor.Admission> = [];
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.sync(() => ({
        browser: browser(++opens === 1 ? Deferred.await(lost) : Effect.never),
        release: Deferred.await(released),
      })),
      admit: (opening) => Effect.sync(() => void admissions.push(opening)),
    });

    yield* Effect.addFinalizer(() => Deferred.succeed(released, new Supervisor.Settled()));

    yield* supervisor.browser;
    yield* Deferred.succeed(lost, "connection");
    yield* published(supervisor, 2, "Open");
    assert.strictEqual(opens, 2);
    assert.deepStrictEqual(
      admissions.map(({ number, after }) => [number, after !== undefined]),
      [
        [1, false],
        [2, true],
      ],
    );
    yield* Deferred.succeed(released, new Supervisor.Settled());
  }),
);

it.effect("gives exclusive rotation admission the exact outgoing Closed outcome", () =>
  Effect.gen(function* () {
    const outcome = new Supervisor.Unconfirmed({ detail: "provider still running" });
    const admissions: Array<Supervisor.Released | undefined> = [];

    const supervisor = yield* Supervisor.make({
      open: Effect.succeed({ browser: browser(), release: Effect.succeed(outcome) }),
      exclusive: true,
      admit: ({ after }) =>
        Effect.gen(function* () {
          admissions.push(after === undefined ? undefined : yield* after);
        }),
    });

    yield* supervisor.browser;
    yield* supervisor.rotate;
    assert.deepStrictEqual(admissions, [undefined, outcome]);
    const closed = yield* published(supervisor, 1, "Closed");

    assert.isTrue(
      closed._tag === "Some" &&
        closed.value.state._tag === "Closed" &&
        closed.value.state.released === admissions[1],
    );
  }),
);

class Policy extends Context.Service<Policy, { readonly attempt: () => number }>()(
  "test/SupervisorPolicy",
) {}

it.effect("runs admission again on each retry, with its requirements and failure policy", () =>
  Effect.gen(function* () {
    let attempts = 0;
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.sync(() => {
        opens++;

        return { browser: browser() };
      }),
      admit: () =>
        Effect.gen(function* () {
          const policy = yield* Policy;

          if (policy.attempt() < 3) return yield* Effect.fail("denied" as const);
        }),
      reopen: Schedule.recurs(2),
    }).pipe(Effect.provideService(Policy, { attempt: () => ++attempts }));

    yield* supervisor.browser;
    assert.deepStrictEqual([attempts, opens], [3, 1]);
  }),
);

it.effect("retirement interrupts admission before its provider can open", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const ended = yield* Deferred.make<void>();
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.sync(() => {
        opens++;

        return { browser: browser() };
      }),
      admit: () =>
        Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Effect.never),
          Effect.ensuring(Deferred.succeed(ended, undefined)),
        ),
    });

    // Run scheduler work without advancing time; neither an admission nor retirement needs a timer.
    yield* Effect.yieldNow;
    assert.isTrue(yield* Deferred.isDone(entered));
    yield* supervisor.retire;
    assert.isTrue(yield* Deferred.isDone(ended));
    assert.strictEqual(opens, 0);
    assert.strictEqual((yield* Effect.flip(supervisor.browser)).reason, "retired");
  }),
);
