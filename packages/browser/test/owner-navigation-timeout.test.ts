import { expect, it } from "@effect/vitest";
import { Clock, Effect, Exit, Fiber } from "effect";
import { TestClock } from "effect/testing";

import { Reasons } from "../src/Errors.ts";
import { dispatchNavigationStop } from "../src/internal/browser/Actions.ts";
import type { NativeNavigation } from "../src/internal/browser/Driver.ts";
import { failure } from "../src/internal/browser/NativeCalls.ts";
import { fixture, gate } from "./fixtures/ScriptedOwner.ts";

/** The engine reports completion; the real session and D1 stop coordinator own recovery. */
const flight = (open: Parameters<typeof dispatchNavigationStop>[3], mainFrame = true) => {
  const completed = gate<string>();
  const retired = gate<void>();

  return {
    completed,
    retired,
    script: (_url: string, pageId: string): NativeNavigation => ({
      pageId,
      mainFrame,
      settled: completed.promise,
      stop: (ticket, pending, onDispatch, retainSetup) =>
        dispatchNavigationStop(ticket, pending, onDispatch, open, retainSetup).finally(() => {
          retired.resolve();
        }),
    }),
  };
};

const loadingTimeout = () => failure(Reasons.Timeout.make({}), "unknown");

it.effect.each(["recovery-first", "public-first"] as const)(
  "%s shares one stop with timeout recovery and keeps the owner usable",
  (order) =>
    Effect.scoped(
      Effect.gen(function* () {
        const opened = gate<void>();
        const setup = gate<void>();
        const sent = gate<void>();
        const acknowledgement = gate<void>();
        let opens = 0;
        let sends = 0;
        let closes = 0;

        const navigation = flight(async () => {
          opens++;
          opened.resolve();
          await setup.promise;

          return {
            stop: async () => {
              sends++;
              sent.resolve();
              await acknowledgement.promise;
            },
            close: async () => {
              closes++;
            },
          };
        });

        const f = yield* fixture({ onNavigate: navigation.script, lifetimeMillis: 10000 });
        const session = yield* (yield* f.acquisition).connect;

        const operation = yield* session.operations.startNavigation(
          "https://example.test/slow",
          100,
        );

        const first =
          order === "public-first" ? yield* Effect.forkChild(operation.stop) : undefined;

        if (first !== undefined) yield* Effect.promise(() => opened.promise);
        yield* TestClock.adjust(100);
        navigation.completed.reject(loadingTimeout());
        // The producer's rejection is delivered before either caller can dispatch its stop.
        yield* Effect.promise(() => navigation.completed.promise.catch(() => undefined));
        yield* Effect.promise(() => opened.promise);

        const joined = yield* Effect.forkChild(operation.stop, { startImmediately: true });

        setup.resolve();
        yield* Effect.promise(() => sent.promise);
        acknowledgement.resolve();
        if (first !== undefined) yield* Fiber.join(first);
        yield* Fiber.join(joined);
        yield* operation.stop;

        expect(yield* Effect.result(operation.completed)).toMatchObject({
          _tag: "Failure",
          failure: { operation: "navigate", reason: { _tag: "Timeout" }, outcome: "unknown" },
        });
        expect({ opens, sends, closes }).toEqual({ opens: 1, sends: 1, closes: 1 });
        expect(yield* session.operations.readText()).toBe("initial");
        yield* session.operations.click("#act");
        expect(f.state.clicks).toBe(1);
        expect(f.state.connects).toBe(1);
      }),
    ),
);

it.effect.each(["recovery", "lifetime"] as const)(
  "%s deadline is shared by permit wait and setup, and rejects a late native continuation",
  (bound) =>
    Effect.scoped(
      Effect.gen(function* () {
        const observing = gate<void>();
        const observed = gate<void>();
        const opened = gate<void>();
        const setup = gate<void>();
        let opens = 0;
        let sends = 0;
        let closes = 0;
        let ended = false;

        const navigation = flight(async () => {
          opens++;
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

        const f = yield* fixture({
          actionMillis: 10000,
          lifetimeMillis: bound === "lifetime" ? 500 : 10000,
          onNavigate: navigation.script,
          onObserve: async () => {
            observing.resolve();
            await observed.promise;
          },
        });

        const session = yield* (yield* f.acquisition).connect;
        const started = Number(yield* Clock.monotonicTimeNanos) / 1_000_000;

        const operation = yield* session.operations.startNavigation(
          "https://example.test/slow",
          100,
        );

        const completed = yield* Effect.forkChild(
          operation.completed.pipe(
            Effect.result,
            Effect.tap(() =>
              Effect.sync(() => {
                ended = true;
              }),
            ),
          ),
        );

        const holder = yield* Effect.forkChild(session.observe());

        yield* Effect.promise(() => observing.promise);
        // Delivery is later than the loading deadline: the recovery budget must not restart here.
        yield* TestClock.adjust(150);
        navigation.completed.reject(loadingTimeout());
        yield* Effect.promise(() => navigation.completed.promise.catch(() => undefined));
        const maximum = bound === "lifetime" ? 500 : 3100;

        yield* TestClock.adjust(maximum - 250);
        expect(ended).toBe(false);
        expect(opens).toBe(0);
        observed.resolve();
        yield* Fiber.join(holder);
        yield* Effect.promise(() => opened.promise);
        expect(Number(yield* Clock.monotonicTimeNanos) / 1_000_000 - started).toBe(maximum - 100);
        yield* TestClock.adjust(100);

        expect(yield* Fiber.join(completed)).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
        });
        expect(Number(yield* Clock.monotonicTimeNanos) / 1_000_000 - started).toBe(maximum);
        expect(sends).toBe(0);
        setup.resolve();
        yield* Effect.promise(() => navigation.retired.promise);
        expect({ opens, sends, closes }).toEqual({ opens: 1, sends: 0, closes: 1 });
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: { _tag: bound === "lifetime" ? "Expired" : "Closed" },
            outcome: "undispatched",
          },
        });
        expect(f.state.clicks).toBe(0);
      }),
    ),
);

it.effect("recovery waits for a canceled public setup to retire before its only dispatch", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const opened = gate<void>();
      const setup = gate<void>();
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
          },
        };
      });

      const f = yield* fixture({ onNavigate: navigation.script, lifetimeMillis: 10000 });
      const session = yield* (yield* f.acquisition).connect;
      const operation = yield* session.operations.startNavigation("https://example.test/slow", 100);
      const publicStop = yield* Effect.forkChild(operation.stop);

      yield* Effect.promise(() => opened.promise);
      yield* Fiber.interrupt(publicStop);
      expect(Exit.hasInterrupts(yield* Fiber.await(publicStop))).toBe(true);
      yield* TestClock.adjust(100);
      navigation.completed.reject(loadingTimeout());
      yield* Effect.promise(() => navigation.completed.promise.catch(() => undefined));
      expect({ opens, sends }).toEqual({ opens: 1, sends: 0 });
      setup.resolve();

      expect(yield* Effect.result(operation.completed)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
      });
      expect({ opens, sends, closes }).toEqual({ opens: 2, sends: 1, closes: 2 });
      yield* operation.stop;
      yield* session.operations.click("#act");
      expect(f.state.clicks).toBe(1);
    }),
  ),
);

it.effect(
  "a failed recovery acknowledgement fences the owner and remains the only committed stop",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let sends = 0;

        const navigation = flight(async () => ({
          stop: async () => {
            sends++;
            throw new Error("PRIVATE-ACKNOWLEDGEMENT-FAILURE");
          },
          close: async () => {},
        }));

        const f = yield* fixture({ onNavigate: navigation.script });
        const session = yield* (yield* f.acquisition).connect;

        const operation = yield* session.operations.startNavigation(
          "https://example.test/slow",
          100,
        );

        yield* TestClock.adjust(100);
        navigation.completed.reject(loadingTimeout());
        expect(yield* Effect.result(operation.completed)).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
        });
        const first = yield* Effect.exit(operation.stop);
        const second = yield* Effect.exit(operation.stop);

        expect(Exit.isFailure(first)).toBe(true);
        expect(second).toEqual(first);
        expect(sends).toBe(1);
        expect(JSON.stringify(first)).not.toContain("PRIVATE-ACKNOWLEDGEMENT-FAILURE");
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
        });
        expect(f.state.clicks).toBe(0);
      }),
    ),
);

it.effect(
  "automatic recovery queues after a public Busy refusal without caching that refusal",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const observing = gate<void>();
        const observed = gate<void>();
        let opens = 0;
        let sends = 0;

        const navigation = flight(async () => {
          opens++;

          return {
            stop: async () => {
              sends++;
            },
            close: async () => {},
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

        const operation = yield* session.operations.startNavigation(
          "https://example.test/slow",
          100,
        );

        const holder = yield* Effect.forkChild(session.observe());

        yield* Effect.promise(() => observing.promise);
        expect(yield* Effect.result(operation.stop)).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
        });
        yield* TestClock.adjust(100);
        navigation.completed.reject(loadingTimeout());
        yield* Effect.promise(() => navigation.completed.promise.catch(() => undefined));
        expect({ opens, sends }).toEqual({ opens: 0, sends: 0 });
        observed.resolve();
        yield* Fiber.join(holder);

        expect(yield* Effect.result(operation.completed)).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
        });
        yield* operation.stop;
        expect({ opens, sends }).toEqual({ opens: 1, sends: 1 });
        yield* session.operations.click("#act");
        expect(f.state.clicks).toBe(1);
      }),
    ),
);

it.effect("successor recovery waits for a canceled predecessor's native setup to retire", () =>
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
      const first = yield* session.operations.startNavigation("https://example.test/first", 100);
      const canceled = yield* Effect.forkChild(first.stop);

      yield* Effect.promise(() => opened.promise);
      yield* Fiber.interrupt(canceled);
      predecessor.completed.resolve("https://example.test/first");
      expect(yield* first.completed).toBe("https://example.test/first");
      const second = yield* session.operations.startNavigation("https://example.test/second", 100);

      yield* TestClock.adjust(100);
      successor.completed.reject(loadingTimeout());
      yield* Effect.promise(() => successor.completed.promise.catch(() => undefined));
      expect({ predecessorSends, successorOpens }).toEqual({
        predecessorSends: 0,
        successorOpens: 0,
      });
      setup.resolve();
      yield* Effect.promise(() => predecessor.retired.promise);
      expect(yield* Effect.result(second.completed)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
      });
      yield* first.stop;
      yield* second.stop;
      expect({ predecessorSends, successorOpens, successorSends }).toEqual({
        predecessorSends: 0,
        successorOpens: 1,
        successorSends: 1,
      });
      yield* session.operations.click("#act");
      expect(f.state.clicks).toBe(1);
    }),
  ),
);

it.effect("a recovery acknowledgement past the absolute deadline cannot reopen or stop twice", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const dispatched = gate<void>();
      const acknowledgement = gate<void>();
      let sends = 0;
      let closes = 0;

      const navigation = flight(async () => ({
        stop: async () => {
          sends++;
          dispatched.resolve();
          await acknowledgement.promise;
        },
        close: async () => {
          closes++;
        },
      }));

      const f = yield* fixture({
        onNavigate: navigation.script,
        actionMillis: 10000,
        lifetimeMillis: 10000,
      });

      const session = yield* (yield* f.acquisition).connect;
      const operation = yield* session.operations.startNavigation("https://example.test/slow", 100);

      yield* TestClock.adjust(100);
      navigation.completed.reject(loadingTimeout());
      yield* Effect.promise(() => dispatched.promise);
      yield* TestClock.adjust(3000);
      expect(yield* Effect.result(operation.completed)).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
      });
      const original = yield* Effect.exit(operation.stop);

      expect(Exit.isFailure(original)).toBe(true);
      expect(yield* Effect.exit(operation.stop)).toEqual(original);
      acknowledgement.resolve();
      yield* Effect.promise(() => navigation.retired.promise);
      expect({ sends, closes }).toEqual({ sends: 1, closes: 1 });
      expect(yield* Effect.exit(operation.stop)).toEqual(original);
      expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
      });
      expect(f.state.clicks).toBe(0);
    }),
  ),
);

it.effect("a failed recovery setup fences with the loading timeout and does not retry", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let opens = 0;

      const navigation = flight(async () => {
        opens++;
        throw new Error("PRIVATE-STOP-SETUP-FAILURE");
      });

      const f = yield* fixture({ onNavigate: navigation.script });
      const session = yield* (yield* f.acquisition).connect;
      const operation = yield* session.operations.startNavigation("https://example.test/slow", 100);

      yield* TestClock.adjust(100);
      navigation.completed.reject(loadingTimeout());
      const result = yield* Effect.result(operation.completed);

      expect(result).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Timeout" }, outcome: "unknown" },
      });
      expect(JSON.stringify(result)).not.toContain("PRIVATE-STOP-SETUP-FAILURE");
      yield* operation.stop;
      yield* operation.stop;
      expect(opens).toBe(1);
      expect(yield* Effect.result(session.operations.readText())).toMatchObject({
        _tag: "Failure",
        failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
      });
    }),
  ),
);

it.effect.each(["child-timeout", "named-timeout", "replacement"] as const)(
  "%s has no automatic page-wide stop and retains the conservative fence",
  (kind) =>
    Effect.scoped(
      Effect.gen(function* () {
        let sends = 0;

        const navigation = flight(
          async () => ({
            stop: async () => {
              sends++;
            },
            close: async () => {},
          }),
          kind !== "child-timeout",
        );

        const f = yield* fixture({ onNavigate: navigation.script });
        const session = yield* (yield* f.acquisition).connect;

        const operation = yield* session.operations.startNavigation(
          "https://example.test/slow",
          100,
        );

        const error =
          kind === "child-timeout"
            ? loadingTimeout()
            : Object.assign(new Error("PRIVATE-NAVIGATION-FAILURE"), {
                name: kind === "named-timeout" ? "TimeoutError" : "NavigationAbortedError",
              });

        navigation.completed.reject(error);
        const result = yield* Effect.result(operation.completed);

        expect(result).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: { _tag: kind === "child-timeout" ? "Timeout" : "Provider" },
            outcome: "unknown",
          },
        });
        expect(JSON.stringify(result)).not.toContain("PRIVATE-NAVIGATION-FAILURE");
        yield* operation.stop;
        expect(sends).toBe(0);
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
        });
      }),
    ),
);
