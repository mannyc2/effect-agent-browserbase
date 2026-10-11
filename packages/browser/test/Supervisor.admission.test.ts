// #281: provider release acknowledgement must be available before the next acquisition.
// A controlled provider forces release/admission races without paid sessions or wall-clock waits.
import { assert, it } from "@effect/vitest";
import { Context, Deferred, Effect, Exit, Schedule, Stream } from "effect";

import type * as Browser from "../src/Browser.ts";
import * as Supervisor from "../src/Supervisor.ts";

const browser = (disconnected: Effect.Effect<"connection"> = Effect.never) =>
  ({ disconnected }) as unknown as Browser.Service;

const published = (supervisor: Supervisor.Supervisor, number: number, tag: string) =>
  supervisor.states.pipe(
    Stream.filter((event) => event.number === number && event.state._tag === tag),
    Stream.runHead,
  );

it.effect("waits for a lost release on the first try and refuses an unconfirmed session", () =>
  Effect.gen(function* () {
    const lost = yield* Deferred.make<"connection">();
    const released = yield* Deferred.make<Supervisor.Released>();
    const admitting = yield* Deferred.make<void>();
    const outcome = new Supervisor.Unconfirmed({ detail: "confirmation timed out" });
    const admissions: Array<number> = [];
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.sync(() => {
        opens++;

        return { browser: browser(Deferred.await(lost)), release: Deferred.await(released) };
      }),
      admit: ({ number, after }) =>
        Effect.gen(function* () {
          admissions.push(number);
          if (number === 2) yield* Deferred.succeed(admitting, undefined);
          if (after !== undefined && (yield* after)._tag === "Unconfirmed")
            return yield* Effect.fail("unconfirmed session");
        }),
      definite: (error) => error === "unconfirmed session",
    });

    yield* Effect.addFinalizer(() => Deferred.succeed(released, outcome));

    yield* supervisor.browser;
    assert.deepStrictEqual(admissions, [1]);
    yield* Deferred.succeed(lost, "connection");
    yield* published(supervisor, 2, "Reopening");
    yield* Deferred.await(admitting);
    assert.deepStrictEqual(admissions, [1, 2]);
    assert.strictEqual(opens, 1);
    yield* Deferred.succeed(released, outcome);
    yield* published(supervisor, 2, "Down");
    assert.deepStrictEqual(
      yield* Effect.flip(supervisor.browser).pipe(
        Effect.map(({ reason, cause }) => [reason, cause]),
      ),
      ["down", "unconfirmed session"],
    );
    const closed = yield* published(supervisor, 1, "Closed");

    assert.isTrue(
      closed._tag === "Some" &&
        closed.value.state._tag === "Closed" &&
        closed.value.state.released === outcome,
    );
    assert.isTrue(Exit.isFailure(yield* Effect.exit(supervisor.rotate)));
    assert.strictEqual(opens, 1);
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
