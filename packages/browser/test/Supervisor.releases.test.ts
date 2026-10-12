// #286: admission accounts for all earlier releases, including uncertainty after a drain ends.
import { assert, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";

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
          const browser = yield* Chromium.open();

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
