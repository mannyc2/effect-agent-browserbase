// #286: admission accounts for all earlier releases, including uncertainty after a drain ends.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Option, Schedule, Stream } from "effect";
import { TestClock } from "effect/testing";

import type * as Browser from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Supervisor from "../src/Supervisor.ts";

const browser = (disconnected: Effect.Effect<"connection"> = Effect.never) =>
  ({ disconnected }) as unknown as Browser.Service;

const published = (supervisor: Supervisor.Supervisor, number: number, tag: string) =>
  supervisor.states.pipe(
    Stream.filter((event) => event.number === number && event.state._tag === tag),
    Stream.runHead,
  );

const reporting = Effect.serviceOption(Supervisor.Releasing).pipe(
  Effect.flatMap(
    Option.match({
      onNone: () => Effect.die("the cleanup port is missing"),
      onSome: Effect.succeed,
    }),
  ),
);

for (const outcome of [
  undefined,
  new Supervisor.Settled(),
  new Supervisor.Unconfirmed({ detail: "the interrupted attempt may still run" }),
])
  it.effect(`publishes interrupted acquisition cleanup (${outcome?._tag ?? "none"})`, () =>
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();

      const supervisor = yield* Supervisor.make({
        open: Effect.gen(function* () {
          const releasing = yield* reporting;

          yield* Effect.acquireRelease(Deferred.succeed(entered, undefined), () =>
            outcome === undefined
              ? Effect.void
              : Effect.sleep("1 second").pipe(Effect.andThen(releasing.released(outcome))),
          );

          return yield* Effect.never;
        }),
      });

      yield* Deferred.await(entered);
      const retiring = yield* Effect.forkChild(supervisor.retire);

      yield* TestClock.adjust("1 second");
      yield* Fiber.join(retiring);
      const closed = yield* published(supervisor, 1, "Closed");

      const state = closed._tag === "Some" ? closed.value.state : undefined;

      assert.strictEqual(state?._tag, "Closed");
      assert.strictEqual(state?._tag === "Closed" ? state.released : undefined, outcome);
      assert.strictEqual((yield* Effect.flip(supervisor.browser)).reason, "retired");
    }),
  );

it.effect(
  "routes terminal cleanup to its own generation while admission keeps older uncertainty",
  () =>
    Effect.gen(function* () {
      const older = new Supervisor.Unconfirmed({ detail: "the first generation's failed try" });
      const settled = new Supervisor.Settled();
      const admissions: Array<Supervisor.Released | undefined> = [];
      let attempts = 0;

      const supervisor = yield* Supervisor.make({
        reopen: Schedule.recurs(1),
        open: Effect.gen(function* () {
          const releasing = yield* reporting;

          if (++attempts === 2) return { browser: browser() };
          yield* releasing.released(attempts === 1 ? older : settled);

          return yield* Effect.fail("failed attempt");
        }),
        admit: ({ after }) =>
          Effect.gen(function* () {
            admissions.push(after === undefined ? undefined : yield* after);
          }),
      });

      yield* supervisor.browser;
      assert.strictEqual((yield* Effect.flip(supervisor.rotate)).reason, "down");
      const down = yield* published(supervisor, 2, "Down");

      const state = down._tag === "Some" ? down.value.state : undefined;

      assert.strictEqual(state?._tag, "Down");
      assert.strictEqual(state?._tag === "Down" ? state.released : undefined, settled);
      assert.deepStrictEqual(admissions, [undefined, older, older, older]);
    }),
);

it.effect("keeps failed-try uncertainty when retirement wins a successful acquisition", () =>
  Effect.gen(function* () {
    const entered = yield* Deferred.make<void>();
    const finish = yield* Deferred.make<void>();
    const outcome = new Supervisor.Unconfirmed({ detail: "the first try may still run" });
    let attempts = 0;

    const supervisor = yield* Supervisor.make({
      reopen: Schedule.recurs(1),
      open: Effect.gen(function* () {
        const releasing = yield* reporting;

        if (++attempts === 1) {
          yield* releasing.released(outcome);

          return yield* Effect.fail("failed attempt");
        }

        return yield* Deferred.succeed(entered, undefined).pipe(
          Effect.andThen(Deferred.await(finish)),
          Effect.as({ browser: browser(), release: Effect.succeed(new Supervisor.Settled()) }),
          Effect.uninterruptible,
        );
      }),
    });

    yield* Deferred.await(entered);
    const retiring = yield* Effect.forkChild(supervisor.retire);

    yield* Effect.yieldNow;
    yield* Deferred.succeed(finish, undefined);
    yield* Fiber.join(retiring);
    const closed = yield* published(supervisor, 1, "Closed");
    const state = closed._tag === "Some" ? closed.value.state : undefined;

    assert.strictEqual(state?._tag, "Closed");
    assert.strictEqual(state?._tag === "Closed" ? state.released : undefined, outcome);
    assert.strictEqual(attempts, 2);
  }),
);

for (const outcome of [
  new Supervisor.Settled(),
  new Supervisor.Unconfirmed({ detail: "the first generation may still run" }),
])
  it.live(`waits for the older release after rotation and loss (${outcome._tag})`, () =>
    Effect.gen(function* () {
      const firstReleased = yield* Deferred.make<Supervisor.Released>();
      const admitting = yield* Deferred.make<void>();
      const admissions: Array<Supervisor.Released | undefined> = [];
      let opens = 0;

      const supervisor = yield* Supervisor.make({
        open: Effect.gen(function* () {
          const number = ++opens;
          const browser = yield* Chromium.open().pipe(Effect.mapError(String));

          return {
            browser,
            release:
              number === 1
                ? Deferred.await(firstReleased)
                : Effect.succeed(new Supervisor.Settled()),
          };
        }),
        handover: 0,
        admit: ({ number, after }) =>
          Effect.gen(function* () {
            if (number === 3) yield* Deferred.succeed(admitting, undefined);
            const released = after === undefined ? undefined : yield* after;

            admissions.push(released);
            if (released?._tag === "Unconfirmed") return yield* Effect.fail("unconfirmed session");
          }),
        definite: (error) => error === "unconfirmed session",
      });

      yield* Effect.addFinalizer(() => Deferred.succeed(firstReleased, outcome));
      yield* supervisor.browser;
      yield* supervisor.rotate;
      yield* published(supervisor, 1, "Draining");
      assert.deepStrictEqual(admissions, [undefined, undefined]);

      yield* supervisor.use((lease) => lease.lose("the page on air closed")).pipe(Effect.ignore);
      yield* Deferred.await(admitting);
      yield* published(supervisor, 2, "Closed");
      yield* Effect.yieldNow;
      assert.strictEqual(opens, 2, "the older release still owns a possibly running session");
      assert.strictEqual(admissions.length, 2, "admission waits for every outgoing release");

      yield* Deferred.succeed(firstReleased, outcome);
      yield* published(supervisor, 3, outcome._tag === "Settled" ? "Open" : "Down");
      assert.deepStrictEqual(
        admissions.map((released) => released?._tag),
        [undefined, undefined, outcome._tag],
      );
      assert.strictEqual(opens, outcome._tag === "Settled" ? 3 : 2);
      if (outcome._tag === "Unconfirmed") {
        const unavailable = yield* Effect.flip(supervisor.browser);

        assert.deepStrictEqual(
          [unavailable.reason, unavailable.cause],
          ["down", "unconfirmed session"],
        );
      }
      const closed = yield* published(supervisor, 1, "Closed");

      assert.isTrue(
        closed._tag === "Some" &&
          closed.value.state._tag === "Closed" &&
          closed.value.state.released === outcome,
      );
    }),
  );

it.effect("remembers an unconfirmed release across later admissions and settled generations", () =>
  Effect.gen(function* () {
    const firstLost = yield* Deferred.make<"connection">();
    const secondLost = yield* Deferred.make<"connection">();
    const secondReleased = yield* Deferred.make<Supervisor.Released>();
    const admitting = yield* Deferred.make<void>();
    const outcome = new Supervisor.Unconfirmed({ detail: "the first generation may still run" });
    const admissions: Array<Supervisor.Released | undefined> = [];
    let opens = 0;

    const supervisor = yield* Supervisor.make({
      open: Effect.sync(() => {
        const number = ++opens;

        return {
          browser: browser(
            number === 1
              ? Deferred.await(firstLost)
              : number === 2
                ? Deferred.await(secondLost)
                : Effect.never,
          ),
          release:
            number === 2
              ? Deferred.await(secondReleased)
              : Effect.succeed(number === 1 ? outcome : new Supervisor.Settled()),
        };
      }),
      handover: 0,
      admit: ({ number, after }) =>
        Effect.gen(function* () {
          if (number === 3) yield* Deferred.succeed(admitting, undefined);
          admissions.push(after === undefined ? undefined : yield* after);
        }),
    });

    yield* Effect.addFinalizer(() => Deferred.succeed(secondReleased, new Supervisor.Settled()));
    yield* supervisor.browser;
    yield* Deferred.succeed(firstLost, "connection");
    yield* published(supervisor, 2, "Open");
    yield* published(supervisor, 1, "Closed");
    yield* Deferred.succeed(secondLost, "connection");
    yield* Deferred.await(admitting);
    yield* Effect.yieldNow;
    assert.strictEqual(opens, 2, "known uncertainty does not skip a pending release");
    assert.strictEqual(admissions.length, 2);
    yield* Deferred.succeed(secondReleased, new Supervisor.Settled());
    yield* published(supervisor, 3, "Open");
    for (const previous of [3, 4]) {
      yield* supervisor.rotate;
      yield* published(supervisor, previous, "Closed");
    }
    assert.strictEqual(opens, 5);
    assert.deepStrictEqual(
      admissions.map((released) => released?._tag),
      [undefined, "Unconfirmed", "Unconfirmed", "Unconfirmed", "Unconfirmed"],
    );
  }),
);

it.effect(
  "retirement interrupts admission awaiting an older release and still reports its end",
  () =>
    Effect.gen(function* () {
      const firstReleased = yield* Deferred.make<Supervisor.Released>();
      const secondLost = yield* Deferred.make<"connection">();
      const admitting = yield* Deferred.make<void>();
      const admissionEnded = yield* Deferred.make<void>();
      const releaseEnded = yield* Deferred.make<void>();
      const retired = yield* Deferred.make<void>();
      const outcome = new Supervisor.Unconfirmed({ detail: "the first generation may still run" });
      let opens = 0;

      const supervisor = yield* Supervisor.make({
        open: Effect.sync(() => ({
          browser: browser(++opens === 2 ? Deferred.await(secondLost) : Effect.never),
          release:
            opens === 1
              ? Deferred.await(firstReleased).pipe(
                  Effect.ensuring(Deferred.succeed(releaseEnded, undefined)),
                )
              : Effect.succeed(new Supervisor.Settled()),
        })),
        handover: 0,
        admit: ({ number, after }) =>
          number === 3
            ? Deferred.succeed(admitting, undefined).pipe(
                Effect.andThen(after ?? Effect.void),
                Effect.asVoid,
                Effect.ensuring(Deferred.succeed(admissionEnded, undefined)),
              )
            : Effect.asVoid(after ?? Effect.void),
      });

      yield* Effect.addFinalizer(() => Deferred.succeed(firstReleased, outcome));
      const states = yield* supervisor.states.pipe(Stream.runCollect, Effect.forkChild);

      yield* supervisor.browser;
      yield* supervisor.rotate;
      yield* Deferred.succeed(secondLost, "connection");
      yield* Deferred.await(admitting);
      yield* published(supervisor, 2, "Closed");
      yield* Effect.yieldNow;
      assert.strictEqual(opens, 2);
      assert.isFalse(yield* Deferred.isDone(admissionEnded));

      const retiring = yield* supervisor.retire.pipe(
        Effect.andThen(Deferred.succeed(retired, undefined)),
        Effect.forkChild,
      );

      yield* Deferred.await(admissionEnded);
      assert.isFalse(yield* Deferred.isDone(retired));
      assert.isFalse(yield* Deferred.isDone(releaseEnded));
      assert.strictEqual((yield* Effect.flip(supervisor.browser)).reason, "retired");
      yield* Deferred.succeed(firstReleased, outcome);
      yield* Fiber.join(retiring);
      assert.isTrue(yield* Deferred.isDone(releaseEnded));
      assert.strictEqual(opens, 2);

      const closed = (yield* Fiber.join(states))
        .filter(({ state }) => state._tag === "Closed")
        .toSorted((left, right) => left.number - right.number);

      assert.deepStrictEqual(
        closed.map(({ number, state }) => [
          number,
          state._tag === "Closed" ? state.released : undefined,
        ]),
        [
          [1, outcome],
          [2, new Supervisor.Settled()],
          [3, undefined],
        ],
      );
    }),
);
