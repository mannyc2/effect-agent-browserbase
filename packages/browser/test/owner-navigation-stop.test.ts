import { expect, it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { dispatchNavigationStop } from "../src/internal/browser/Actions.ts";
import type { NativeNavigation } from "../src/internal/browser/Driver.ts";
import { fixture, gate } from "./fixtures/ScriptedOwner.ts";

/** Script only the native setup/acknowledgement; the real session, permit and dispatch path run. */
const flight = (open: Parameters<typeof dispatchNavigationStop>[3]) => {
  const completed = gate<string>();
  const nativeFinished = gate<void>();

  return {
    completed,
    nativeFinished,
    script: (_url: string, pageId: string): NativeNavigation => ({
      pageId,
      settled: completed.promise,
      stop: (ticket, pending, onDispatch, retainSetup) =>
        dispatchNavigationStop(ticket, pending, onDispatch, open, retainSetup).finally(() => {
          nativeFinished.resolve();
        }),
    }),
  };
};

it.effect("a busy first stop retries and concurrent callers share one native dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const observing = gate<void>();
      const observed = gate<void>();
      const dispatched = gate<void>();
      const acknowledged = gate<void>();
      let opens = 0;
      let sends = 0;
      let closes = 0;

      const navigation = flight(async () => {
        opens++;

        return {
          stop: async () => {
            sends++;
            dispatched.resolve();
            await acknowledged.promise;
          },
          close: async () => {
            closes++;
          },
        };
      });

      const f = yield* fixture({
        onNavigate: navigation.script,
        onObserve: async () => {
          observing.resolve();
          await observed.promise;
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const operation = yield* session.operations.startNavigation("https://example.test/slow");
      const holder = yield* Effect.forkChild(session.observe());

      yield* Effect.promise(() => observing.promise);
      expect(yield* Effect.result(operation.stop)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
      });
      expect(opens).toBe(0);
      observed.resolve();
      yield* Fiber.join(holder);

      const first = yield* Effect.forkChild(operation.stop);

      yield* Effect.promise(() => dispatched.promise);
      const canceledWaiter = yield* Effect.forkChild(operation.stop, { startImmediately: true });
      const joined = yield* Effect.forkChild(operation.stop, { startImmediately: true });

      yield* Fiber.interrupt(canceledWaiter);
      expect(Exit.hasInterrupts(yield* Fiber.await(canceledWaiter))).toBe(true);
      acknowledged.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(joined);
      yield* operation.stop;

      expect({ opens, sends, closes }).toEqual({ opens: 1, sends: 1, closes: 1 });
      expect(yield* Effect.result(operation.completed)).toMatchObject({
        _tag: "Failure",
        failure: { operation: "navigate", reason: { _tag: "Interrupted" }, outcome: "unknown" },
      });
      yield* session.operations.click("#act");
      expect(f.state.clicks).toBe(1);
    }),
  ),
);

it.effect.each(["cancel", "timeout"] as const)(
  "%s before dispatch keeps setup and late port cleanup reserved until a safe retry",
  (ending) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = gate<void>();
        const setup = gate<void>();
        const closing = gate<void>();
        const close = gate<void>();
        let opens = 0;
        let sends = 0;
        let closes = 0;

        const navigation = flight(async () => {
          opens++;
          if (opens === 1) {
            opened.resolve();
            await setup.promise;
          }

          return {
            stop: async () => {
              sends++;
            },
            close: async () => {
              closes++;
              if (closes === 1) {
                closing.resolve();
                await close.promise;
              }
            },
          };
        });

        const f = yield* fixture({ onNavigate: navigation.script, lifetimeMillis: 20000 });
        const session = yield* (yield* f.acquisition).connect;
        const operation = yield* session.operations.startNavigation("https://example.test/slow");
        const first = yield* Effect.forkChild(operation.stop);

        yield* Effect.promise(() => opened.promise);
        if (ending === "cancel") {
          yield* Fiber.interrupt(first);
          expect(Exit.hasInterrupts(yield* Fiber.await(first))).toBe(true);
        } else {
          yield* TestClock.adjust(1000);
          const timedOut = yield* Fiber.await(first);

          expect(Exit.isFailure(timedOut)).toBe(true);
          if (Exit.isFailure(timedOut))
            expect(Cause.squash(timedOut.cause)).toMatchObject({
              reason: { _tag: "Timeout" },
              outcome: "undispatched",
            });
        }

        for (let index = 0; index < 16; index++) {
          expect(yield* Effect.result(operation.stop)).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
          });
        }
        expect({ opens, sends }).toEqual({ opens: 1, sends: 0 });
        expect(yield* session.operations.readText()).toBe("initial");

        setup.resolve();
        yield* Effect.promise(() => closing.promise);
        expect(yield* Effect.result(operation.stop)).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
        });
        close.resolve();
        yield* Effect.promise(() => navigation.nativeFinished.promise);
        yield* operation.stop;
        yield* operation.stop;
        expect({ opens, sends, closes }).toEqual({ opens: 2, sends: 1, closes: 2 });
        expect(yield* Effect.result(operation.completed)).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Interrupted" } },
        });
        yield* session.operations.click("#act");
        expect(f.state.clicks).toBe(1);
      }),
    ),
);

it.effect(
  "abandoned setup stays bounded across successor operations and cannot stop a successor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = gate<void>();
        const setup = gate<void>();
        let predecessorSends = 0;
        let successorOpens = 0;
        let successorSends = 0;

        const predecessor = flight(async () => {
          opened.resolve();
          await setup.promise;

          return {
            stop: async () => {
              predecessorSends++;
            },
            close: async () => {},
          };
        });

        const successor = flight(async () => {
          successorOpens++;

          return {
            stop: async () => {
              successorSends++;
            },
            close: async () => {},
          };
        });

        const f = yield* fixture({
          onNavigate: (url, pageId) =>
            (url.endsWith("first") ? predecessor : successor).script(url, pageId),
        });

        const session = yield* (yield* f.acquisition).connect;
        const first = yield* session.operations.startNavigation("https://example.test/first");
        const canceled = yield* Effect.forkChild(first.stop);

        yield* Effect.promise(() => opened.promise);
        yield* Fiber.interrupt(canceled);
        predecessor.completed.resolve("https://example.test/first");
        expect(yield* first.completed).toBe("https://example.test/first");
        const second = yield* session.operations.startNavigation("https://example.test/second");

        for (let index = 0; index < 16; index++) {
          expect(yield* Effect.result(second.stop)).toMatchObject({
            _tag: "Failure",
            failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
          });
        }
        expect(successorOpens).toBe(0);
        setup.resolve();
        yield* Effect.promise(() => predecessor.nativeFinished.promise);
        yield* first.stop;
        expect(predecessorSends).toBe(0);
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
        });
        yield* second.stop;
        expect({ successorOpens, successorSends }).toEqual({
          successorOpens: 1,
          successorSends: 1,
        });
        yield* session.operations.click("#act");
        expect(f.state.clicks).toBe(1);
      }),
    ),
);

it.effect("natural completion during stop setup keeps the permit and sends no stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = gate<void>();
      const setup = gate<void>();
      let sends = 0;

      const navigation = flight(async () => {
        opened.resolve();
        await setup.promise;

        return {
          stop: async () => {
            sends++;
          },
          close: async () => {},
        };
      });

      const f = yield* fixture({
        onNavigate: (url, pageId) =>
          url.endsWith("first")
            ? navigation.script(url, pageId)
            : { pageId, settled: Promise.resolve(url), stop: async () => "settled" },
      });

      const session = yield* (yield* f.acquisition).connect;
      const operation = yield* session.operations.startNavigation("https://example.test/first");
      const stopping = yield* Effect.forkChild(operation.stop);

      yield* Effect.promise(() => opened.promise);
      navigation.completed.resolve("https://example.test/first");
      yield* operation.completed;
      expect(
        yield* Effect.result(session.operations.navigate("https://example.test/next")),
      ).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
      });
      setup.resolve();
      yield* Fiber.join(stopping);
      expect(sends).toBe(0);
      const next = yield* session.operations.startNavigation("https://example.test/next");

      yield* operation.stop;
      expect(yield* next.completed).toBe("https://example.test/next");
      expect(sends).toBe(0);
    }),
  ),
);

it.effect.each(["failure", "cancel"] as const)(
  "committed stop %s remains terminal after fencing completes the navigation",
  (ending) =>
    Effect.scoped(
      Effect.gen(function* () {
        const dispatched = gate<void>();
        const acknowledge = gate<void>();
        let sends = 0;

        const navigation = flight(async () => ({
          stop: async () => {
            sends++;
            dispatched.resolve();
            await acknowledge.promise;
            if (ending === "failure") throw new Error("PRIVATE-STOP-ACKNOWLEDGEMENT");
          },
          close: async () => {},
        }));

        const f = yield* fixture({ onNavigate: navigation.script });
        const session = yield* (yield* f.acquisition).connect;
        const operation = yield* session.operations.startNavigation("https://example.test/slow");
        const first = yield* Effect.forkChild(operation.stop);

        yield* Effect.promise(() => dispatched.promise);
        if (ending === "cancel") yield* Fiber.interrupt(first);
        acknowledge.resolve();
        const original = yield* Fiber.await(first);

        expect(Exit.isFailure(original)).toBe(true);
        expect(Exit.hasInterrupts(original)).toBe(ending === "cancel");
        expect(yield* Effect.result(operation.completed)).toMatchObject({ _tag: "Failure" });
        yield* Effect.promise(() => navigation.nativeFinished.promise);
        const repeated = yield* Effect.exit(operation.stop);

        expect(repeated).toEqual(original);
        expect(sends).toBe(1);
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
        });
        expect(f.state.clicks).toBe(0);
      }),
    ),
);

it.effect("failed late detach keeps setup quarantined across subsequent navigations", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = gate<void>();
      const setup = gate<void>();
      let sends = 0;
      let successorOpens = 0;

      const predecessor = flight(async () => {
        opened.resolve();
        await setup.promise;

        return {
          stop: async () => {
            sends++;
          },
          close: async () => {
            throw new Error("PRIVATE-DETACH-FAILURE");
          },
        };
      });

      const successor = flight(async () => {
        successorOpens++;

        return {
          stop: async () => {
            sends++;
          },
          close: async () => {},
        };
      });

      const f = yield* fixture({
        onNavigate: (url, pageId) =>
          (url.endsWith("first") ? predecessor : successor).script(url, pageId),
      });

      const session = yield* (yield* f.acquisition).connect;
      const first = yield* session.operations.startNavigation("https://example.test/first");
      const canceled = yield* Effect.forkChild(first.stop);

      yield* Effect.promise(() => opened.promise);
      yield* Fiber.interrupt(canceled);
      setup.resolve();
      yield* Effect.promise(() => predecessor.nativeFinished.promise);
      predecessor.completed.resolve("https://example.test/first");
      yield* first.completed;

      const second = yield* session.operations.startNavigation("https://example.test/second");

      expect(yield* Effect.result(second.stop)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
      });
      expect({ sends, successorOpens }).toEqual({ sends: 0, successorOpens: 0 });
      successor.completed.resolve("https://example.test/second");
      yield* second.completed;
      yield* session.operations.click("#act");
      expect(f.state.clicks).toBe(1);
    }),
  ),
);

it.effect(
  "closing the operation scope interrupts stop setup and retires its late port without dispatch",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = gate<void>();
        const setup = gate<void>();
        let sends = 0;
        let closes = 0;

        const navigation = flight(async () => {
          opened.resolve();
          await setup.promise;

          return {
            stop: async () => {
              sends++;
            },
            close: async () => {
              closes++;
            },
          };
        });

        const f = yield* fixture({ onNavigate: navigation.script });
        const session = yield* (yield* f.acquisition).connect;

        const stopping = yield* Effect.scoped(
          Effect.gen(function* () {
            const operation = yield* session.operations.startNavigation(
              "https://example.test/slow",
            );

            const fiber = yield* Effect.forkScoped(operation.stop);

            yield* Effect.promise(() => opened.promise);

            return fiber;
          }),
        );

        expect(Exit.hasInterrupts(yield* Fiber.await(stopping))).toBe(true);
        setup.resolve();
        yield* Effect.promise(() => navigation.nativeFinished.promise);
        expect({ sends, closes }).toEqual({ sends: 0, closes: 1 });
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
        });
        expect(f.state.clicks).toBe(0);
      }),
    ),
);
