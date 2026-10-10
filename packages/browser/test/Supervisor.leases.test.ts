// Provider-boundary ownership: generations own application resources, while use and retain own
// holds. These scripted browsers never dispatch browser actions; Chromium covers those separately.
import { assert, describe, it } from "@effect/vitest";
import { DateTime, Deferred, Effect, Exit, Fiber, Scope, Stream } from "effect";
import { TestClock } from "effect/testing";

import type * as Browser from "../src/Browser.ts";
import type { DisconnectCause } from "../src/BrowserEvent.ts";
import * as Supervisor from "../src/Supervisor.ts";

/** A provider with distinct application values and independently controlled connection losses. */
const provider = (release?: (number: number) => Effect.Effect<Supervisor.Released>) =>
  Effect.sync(() => {
    const order: Array<string> = [];
    const losses = new Map<number, Deferred.Deferred<DisconnectCause>>();
    let opened = 0;

    const open = Effect.gen(function* () {
      const number = ++opened;
      const lost = yield* Deferred.make<DisconnectCause>();

      losses.set(number, lost);
      order.push(`open ${number}`);
      yield* Effect.addFinalizer(() => Effect.sync(() => order.push(`scope ${number}`)));

      return {
        browser: { disconnected: Deferred.await(lost) } as unknown as Browser.Service,
        value: { number },
        release: Effect.sync(() => order.push(`release ${number}`)).pipe(
          Effect.andThen(release?.(number) ?? Effect.succeed(new Supervisor.Settled())),
        ),
      };
    });

    return {
      open,
      order,
      count: () => opened,
      lose: (number: number) =>
        Effect.suspend(() => {
          const lost = losses.get(number);

          return lost === undefined
            ? Effect.die(`generation ${number} never opened`)
            : Deferred.succeed(lost, "connection");
        }),
    };
  });

const published = (
  supervisor: { readonly states: Stream.Stream<Supervisor.Generation> },
  number: number,
  tag: string,
) =>
  supervisor.states.pipe(
    Stream.filter((event) => event.number === number && event.state._tag === tag),
    Stream.runHead,
  );

describe("Supervisor leases", () => {
  it.effect("keeps manual and timed rotation independent of older retained generations", () =>
    Effect.gen(function* () {
      for (const timed of [false, true]) {
        yield* Effect.gen(function* () {
          const world = yield* provider();

          const open = Effect.gen(function* () {
            const opened = yield* world.open;
            const now = yield* DateTime.now;

            return {
              ...opened,
              browser: { ...opened.browser, expiresAt: DateTime.add(now, { seconds: 20 }) },
            };
          });

          const supervisor = yield* Supervisor.make({
            open,
            handover: "1 hour",
            rotateBefore: "10 seconds",
          });

          const held = yield* supervisor.use((lease) => lease.retain);

          if (timed) yield* TestClock.adjust("10 seconds");
          else yield* supervisor.rotate;
          assert.strictEqual(world.count(), 2);
          if (timed) yield* TestClock.adjust("10 seconds");
          else {
            const rotating = yield* Effect.forkChild(supervisor.rotate);

            yield* TestClock.adjust("1 second");
            assert.strictEqual(world.count(), 3);
            yield* Fiber.join(rotating);
          }
          assert.strictEqual(world.count(), 3);
          assert.notInclude(world.order, "release 1");
          assert.strictEqual(
            yield* supervisor.use(({ generation }) => Effect.succeed(generation)),
            3,
          );
          yield* Scope.close(held, Exit.void);
          yield* published(supervisor, 1, "Closed");
        }).pipe(Effect.scoped);
      }
    }),
  );

  it.effect(
    "keeps a transferred hold alive after use and releases its resources before the provider",
    () =>
      Effect.gen(function* () {
        const world = yield* provider();
        const supervisor = yield* Supervisor.make({ open: world.open });

        const held = yield* supervisor.use((lease) =>
          Effect.gen(function* () {
            assert.strictEqual(lease.generation, 1);
            assert.strictEqual(lease.value.number, 1);
            yield* Effect.addFinalizer(() => Effect.sync(() => world.order.push("work 1")));
            const scope = yield* lease.retain;

            yield* Scope.addFinalizer(
              scope,
              Effect.sync(() => world.order.push("retained 1")),
            );

            return { lease, scope };
          }),
        );

        assert.deepStrictEqual(world.order, ["open 1", "work 1"]);
        const second = yield* supervisor.rotate;

        assert.notStrictEqual(second, held.lease.browser);
        assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value.number)), 2);
        assert.strictEqual((yield* held.lease.ending).reason, "rotated");
        assert.deepStrictEqual(world.order, ["open 1", "work 1", "open 2"]);

        yield* Scope.close(held.scope, Exit.void);
        yield* published(supervisor, 1, "Closed");
        assert.deepStrictEqual(world.order.slice(-3), ["retained 1", "release 1", "scope 1"]);
        assert.strictEqual((yield* Effect.flip(held.lease.retain))._tag, "Superseded");
      }),
  );

  it.effect(
    "revokes after the default 30 seconds and waits for use finalizers before release",
    () =>
      Effect.gen(function* () {
        const world = yield* provider();
        const supervisor = yield* Supervisor.make({ open: world.open });
        const admitted = yield* Deferred.make<Supervisor.Lease<{ readonly number: number }>>();
        const cleaning = yield* Deferred.make<void>();
        const cleaned = yield* Deferred.make<void>();

        return yield* Effect.gen(function* () {
          const work = yield* supervisor
            .use((lease) =>
              Effect.gen(function* () {
                yield* Effect.addFinalizer(() =>
                  Deferred.succeed(cleaning, undefined).pipe(
                    Effect.andThen(Deferred.await(cleaned)),
                    Effect.andThen(Effect.sync(() => world.order.push("work 1"))),
                  ),
                );
                yield* Deferred.succeed(admitted, lease);

                return yield* Effect.never;
              }),
            )
            .pipe(Effect.flip, Effect.forkChild);

          const lease = yield* Deferred.await(admitted);

          yield* supervisor.rotate;
          const ending = yield* lease.ending;

          assert.deepStrictEqual([ending.generation, ending.reason], [1, "rotated"]);
          yield* TestClock.adjust("29 seconds");
          const lateHold = yield* lease.retain;

          yield* Scope.addFinalizer(
            lateHold,
            Effect.sync(() => world.order.push("retained 1")),
          );
          assert.notInclude(world.order, "release 1");
          yield* TestClock.adjust("1 second");
          yield* Deferred.await(cleaning);
          assert.notInclude(world.order, "release 1");
          assert.strictEqual((yield* Effect.flip(lease.retain))._tag, "Superseded");

          yield* Deferred.succeed(cleaned, undefined);
          const failure = yield* Fiber.join(work);

          assert.deepStrictEqual([failure._tag, failure.reason], ["Superseded", "rotated"]);
          yield* published(supervisor, 1, "Closed");
          assert.isBelow(world.order.indexOf("work 1"), world.order.indexOf("release 1"));
          assert.isBelow(world.order.indexOf("retained 1"), world.order.indexOf("release 1"));
          assert.isBelow(world.order.indexOf("release 1"), world.order.indexOf("scope 1"));
          assert.strictEqual(
            yield* supervisor.use(({ generation }) => Effect.succeed(generation)),
            2,
          );
        }).pipe(Effect.ensuring(Deferred.succeed(cleaned, undefined)));
      }),
  );

  it.effect(
    "waits for exclusive draining and provider acknowledgement despite an interrupted rotate caller",
    () =>
      Effect.gen(function* () {
        const releasing = yield* Deferred.make<void>();
        const released = yield* Deferred.make<void>();

        return yield* Effect.gen(function* () {
          const world = yield* provider((number) =>
            number === 1
              ? Deferred.succeed(releasing, undefined).pipe(
                  Effect.andThen(Deferred.await(released)),
                  Effect.as(
                    new Supervisor.Unconfirmed({ detail: "provider acknowledgement lost" }),
                  ),
                )
              : Effect.succeed(new Supervisor.Settled()),
          );

          const supervisor = yield* Supervisor.make({ open: world.open, exclusive: true });
          const held = yield* supervisor.use((lease) => lease.retain);
          const rotating = yield* Effect.forkChild(supervisor.rotate);

          yield* published(supervisor, 1, "Draining");
          assert.strictEqual(world.count(), 1);
          let called = false;

          const unavailable = yield* Effect.flip(
            supervisor.use(() => Effect.sync(() => (called = true)), { wait: 0 }),
          );

          assert.deepStrictEqual(
            [unavailable._tag, unavailable.reason, called],
            ["Unavailable", "opening", false],
          );
          yield* Fiber.interrupt(rotating);
          yield* Scope.close(held, Exit.void);
          yield* Deferred.await(releasing);
          assert.strictEqual(world.count(), 1);
          yield* Deferred.succeed(released, undefined);
          yield* published(supervisor, 2, "Open");

          const closed = yield* supervisor.states.pipe(
            Stream.filter((event) => event.number === 1 && event.state._tag === "Closed"),
            Stream.runHead,
          );

          assert.isTrue(
            closed._tag === "Some" &&
              closed.value.state._tag === "Closed" &&
              closed.value.state.released?._tag === "Unconfirmed",
          );
          assert.deepStrictEqual(world.order.slice(0, 4), [
            "open 1",
            "release 1",
            "scope 1",
            "open 2",
          ]);
          assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value.number)), 2);
        }).pipe(Effect.ensuring(Deferred.succeed(released, undefined)));
      }),
  );

  it.effect("answers immediate borrows and bounds waiting without cancelling the shared open", () =>
    Effect.gen(function* () {
      const world = yield* provider();

      const supervisor = yield* Supervisor.make({
        open: Effect.sleep("30 seconds").pipe(Effect.andThen(world.open)),
      });

      let calls = 0;

      const work = (lease: Supervisor.Lease<{ readonly number: number }>) =>
        Effect.sync(() => {
          calls += 1;

          return lease.value.number;
        });

      const immediate = yield* Effect.flip(supervisor.use(work, { wait: 0 }));

      assert.strictEqual(immediate.reason, "opening");
      assert.strictEqual(calls, 0);

      const impatient = yield* supervisor
        .use(work, { wait: "1 second" })
        .pipe(Effect.flip, Effect.forkChild);

      const patient = yield* supervisor.use(work, { wait: "40 seconds" }).pipe(Effect.forkChild);

      yield* TestClock.adjust("1 second");
      assert.strictEqual((yield* Fiber.join(impatient)).reason, "opening");
      assert.strictEqual(calls, 0);
      yield* TestClock.adjust("29 seconds");
      assert.strictEqual(yield* Fiber.join(patient), 1);
      assert.strictEqual(yield* supervisor.use(work, { wait: 0 }), 1);
      assert.strictEqual(calls, 2);
      assert.strictEqual(world.count(), 1);
    }),
  );

  it.effect(
    "revokes a lost draining generation immediately without replacing its healthy successor",
    () =>
      Effect.gen(function* () {
        const world = yield* provider();
        const supervisor = yield* Supervisor.make({ open: world.open, handover: "1 hour" });
        const admitted = yield* Deferred.make<Supervisor.Lease<{ readonly number: number }>>();

        const work = yield* supervisor
          .use((lease) => Deferred.succeed(admitted, lease).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.flip, Effect.forkChild);

        const lease = yield* Deferred.await(admitted);
        const retained = yield* lease.retain;

        yield* Scope.addFinalizer(
          retained,
          Effect.sync(() => world.order.push("retained 1")),
        );
        yield* supervisor.rotate;
        assert.strictEqual((yield* lease.ending).reason, "rotated");
        yield* world.lose(1);
        const failure = yield* Fiber.join(work);

        assert.deepStrictEqual([failure._tag, failure.reason], ["Superseded", "lost"]);
        yield* published(supervisor, 1, "Closed");
        assert.strictEqual(world.count(), 2);
        assert.strictEqual(yield* supervisor.use(({ value }) => Effect.succeed(value.number)), 2);
        assert.deepStrictEqual(world.order.slice(-3), ["retained 1", "release 1", "scope 1"]);
      }),
  );

  it.effect(
    "revokes live work when its provider session expires without waiting for handover",
    () =>
      Effect.gen(function* () {
        const world = yield* provider();

        const open = Effect.gen(function* () {
          const opened = yield* world.open;
          const now = yield* DateTime.now;

          return {
            ...opened,
            browser: {
              ...opened.browser,
              expiresAt: DateTime.add(now, { seconds: 10 }),
              disconnected: Effect.sleep("10 seconds").pipe(Effect.as("session" as const)),
            },
          };
        });

        const supervisor = yield* Supervisor.make({ open, handover: "1 hour" });
        const admitted = yield* Deferred.make<void>();

        const work = yield* supervisor
          .use(() => Deferred.succeed(admitted, undefined).pipe(Effect.andThen(Effect.never)))
          .pipe(Effect.flip, Effect.forkChild);

        yield* Deferred.await(admitted);
        yield* TestClock.adjust("10 seconds");
        const failure = yield* Fiber.join(work);

        assert.deepStrictEqual([failure._tag, failure.reason], ["Superseded", "lost"]);
        yield* published(supervisor, 1, "Closed");
        assert.strictEqual(
          yield* supervisor.use(({ generation }) => Effect.succeed(generation)),
          2,
        );
        assert.strictEqual(world.count(), 2);
      }),
  );

  it.effect(
    "closes cancelled work before letting its generation go and preserves ordinary work errors",
    () =>
      Effect.gen(function* () {
        const world = yield* provider();
        const supervisor = yield* Supervisor.make({ open: world.open });
        const admitted = yield* Deferred.make<void>();

        const work = yield* supervisor
          .use(() =>
            Effect.gen(function* () {
              yield* Effect.addFinalizer(() => Effect.sync(() => world.order.push("work 1")));
              yield* Deferred.succeed(admitted, undefined);

              return yield* Effect.never;
            }),
          )
          .pipe(Effect.forkChild);

        yield* Deferred.await(admitted);
        yield* supervisor.rotate;
        assert.notInclude(world.order, "release 1");
        yield* Fiber.interrupt(work);
        assert.isTrue(Exit.hasInterrupts(yield* Fiber.await(work)));
        yield* published(supervisor, 1, "Closed");
        assert.deepStrictEqual(world.order.slice(-3), ["work 1", "release 1", "scope 1"]);
        assert.strictEqual(
          yield* Effect.flip(supervisor.use(() => Effect.fail("caller failure"))),
          "caller failure",
        );
        assert.strictEqual(
          yield* supervisor.use(({ generation }) => Effect.succeed(generation)),
          2,
        );
      }),
  );

  it.effect(
    "closes retained application resources on keep, while explicit retire still releases",
    () =>
      Effect.gen(function* () {
        for (const retire of [false, true]) {
          const world = yield* provider();
          const owner = yield* Scope.make();

          yield* Effect.addFinalizer(() => Scope.close(owner, Exit.void));

          const supervisor = yield* Scope.provide(
            Supervisor.make({ open: world.open, keep: true }),
            owner,
          );

          const lease = yield* supervisor.use((current) =>
            Effect.gen(function* () {
              const retained = yield* current.retain;

              yield* Scope.addFinalizer(
                retained,
                Effect.sync(() => world.order.push("retained 1")),
              );

              return current;
            }),
          );

          if (retire) yield* supervisor.retire;
          else yield* Scope.close(owner, Exit.void);
          assert.deepStrictEqual(
            world.order,
            retire
              ? ["open 1", "retained 1", "release 1", "scope 1"]
              : ["open 1", "retained 1", "scope 1"],
          );
          const unavailable = yield* Effect.flip(supervisor.use(() => Effect.void, { wait: 0 }));

          assert.deepStrictEqual(
            [unavailable._tag, unavailable.reason],
            ["Unavailable", "retired"],
          );
          assert.strictEqual((yield* Effect.flip(lease.retain)).reason, "retired");
        }
      }),
  );
});
