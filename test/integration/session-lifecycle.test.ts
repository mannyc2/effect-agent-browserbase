import { expect, it } from "@effect/vitest";
import { Cause, Clock, Deferred, Effect, Exit, Fiber, Schema } from "effect";
import { TestClock } from "effect/testing";

import * as Bootstrap from "../../packages/browser/src/Bootstrap.ts";
import { InitializationError } from "../../packages/browser/src/Errors.ts";
import {
  makeBindings,
  preparePlan,
  type ConnectionBindings,
} from "../../packages/browser/src/internal/browser/Bindings.ts";
import type {
  DriverEvents,
  NavigationControl,
} from "../../packages/browser/src/internal/browser/Driver.ts";
import { makeOwner, type Ticket } from "../../packages/browser/src/internal/browser/Owner.ts";
import type { TargetControls } from "../../packages/browser/src/internal/browser/Session.ts";
import { fixture, gate } from "./fixtures/ScriptedProvider.ts";
import { elapse } from "./fixtures/Time.ts";

it.effect.each(["timeout", "native-check"] as const)(
  "the %s path records elapsed expiry before an overlapping action timeout",
  (path) =>
    Effect.scoped(
      Effect.gen(function* () {
        const clock = yield* Clock.Clock;
        let nativeNow: bigint | undefined;

        const owner = yield* makeOwner({
          maxActions: 2,
          maxHostReads: 2,
          maxElapsedMillis: 100,
          actionTimeoutMillis: 100,
        }).pipe(
          Effect.provideService(Clock.Clock, {
            ...clock,
            monotonicTimeNanosUnsafe: () => nativeNow ?? clock.monotonicTimeNanosUnsafe(),
          }),
        );

        expect(yield* owner.status).toMatchObject({
          phase: "acquiring",
          reason: null,
          busy: false,
          unresolvedDispatch: false,
        });
        owner.transition("open");
        const entered = yield* Deferred.make<void>();
        let ticket: Ticket | undefined;

        const running = yield* Effect.forkChild(
          owner
            .guard(
              "click",
              (admitted) => {
                ticket = admitted;

                return Effect.sync(() => admitted.dispatch()).pipe(
                  Effect.andThen(Deferred.succeed(entered, undefined)),
                  Effect.andThen(Effect.never),
                );
              },
              { mutation: true },
            )
            .pipe(Effect.exit),
        );

        yield* Deferred.await(entered);
        expect(yield* owner.status).toMatchObject({
          phase: "open",
          busy: true,
          unresolvedDispatch: true,
        });
        if (path === "native-check") {
          // A native continuation observes the deadline before Effect's timer is scheduled to run.
          nativeNow = 100_000_000n;
          expect(() => ticket?.check()).toThrow(expect.objectContaining({ outcome: "unknown" }));
          expect((yield* owner.status).reason).toBe("expired");
        }
        yield* TestClock.adjust(100);
        yield* Fiber.join(running);
        expect(yield* owner.status).toMatchObject({
          phase: "faulted",
          reason: "expired",
          busy: false,
          unresolvedDispatch: true,
        });
        expect(yield* Effect.result(owner.guard("click", () => Effect.void))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Expired" }, outcome: "undispatched" },
        });
        expect((yield* owner.diagnostics).records[0]).toMatchObject({
          reason: "expired",
          disposition: "confirmed",
          generation: 0,
        });
      }),
    ),
);

it.effect.each([false, true])(
  "expiry preserves pending navigation evidence (%s) until owned release confirms retirement",
  (pending) =>
    Effect.scoped(
      Effect.gen(function* () {
        const disconnected = gate<void>();
        const disconnect = gate<void>();
        const loading = gate<string>();

        const f = yield* fixture({
          lifetimeMillis: 100,
          onNavigate: (_url, pageId) => ({
            pageId,
            settled: loading.promise,
            stop: async () => "settled",
          }),
          onConnect: async (driver) => ({
            ...driver,
            disconnect: async () => {
              disconnected.resolve();
              await disconnect.promise;
              await driver.disconnect();
            },
          }),
        });

        const session = yield* (yield* f.acquisition).connect;

        const operation = pending
          ? yield* session.operations.startNavigation("https://example.test/slow")
          : undefined;

        yield* TestClock.adjust(100);
        yield* Effect.promise(() => disconnected.promise);
        expect(yield* session.status).toMatchObject({
          phase: "closing",
          reason: "expired",
          unresolvedDispatch: pending,
        });
        if (operation !== undefined)
          expect(yield* Effect.result(operation.completed)).toMatchObject({
            _tag: "Failure",
            failure: { outcome: "unknown" },
          });
        disconnect.resolve();
        const report = yield* session.close;

        expect(report.remote).toBe("confirmed");
        expect(yield* session.status).toMatchObject({
          phase: "closed",
          reason: "expired",
          unresolvedDispatch: false,
        });
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Expired" }, outcome: "undispatched" },
        });
        expect(f.state.releases).toBe(1);
        expect(f.state.clicks).toBe(0);
      }),
    ),
);

it.effect(
  "policy quarantine preserves the admitted click and exposes bounded copied evidence",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let events: DriverEvents | undefined;
        let nativeCalls = 0;
        const entered = gate<void>();
        const clicked = gate<void>();
        const token = {};

        const f = yield* fixture({
          onConnect: async (driver, supplied) => {
            events = supplied;

            return driver;
          },
          onClick: async (ticket) => {
            ticket.dispatch();
            nativeCalls++;
            events?.fault({
              source: "policy",
              reason: "popup-overflow",
              token,
              disposition: "pending",
            });
            events?.fault({
              source: "policy",
              reason: "popup-overflow",
              token,
              disposition: "dispatched",
            });
            entered.resolve();
            await clicked.promise;
            ticket.check();

            return "https://example.test/";
          },
        });

        const session = yield* (yield* f.acquisition).connect;
        const prior = yield* session.status;
        const click = yield* Effect.forkChild(session.operations.click("#act"));

        yield* Effect.promise(() => entered.promise);
        const during = yield* session.status;

        expect(during).toMatchObject({
          phase: "open",
          reason: "popup-overflow",
          generation: prior.generation,
          busy: true,
          unresolvedDispatch: true,
        });
        clicked.resolve();
        yield* Fiber.join(click);
        expect(yield* Effect.result(session.operations.readText())).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Busy" }, outcome: "undispatched" },
        });
        events?.fault({
          source: "policy",
          reason: "popup-overflow",
          token,
          disposition: "confirmed",
        });
        expect(yield* session.operations.readText()).toBe("initial");
        const diagnostics = yield* session.diagnostics;

        expect(diagnostics.records.map(({ disposition }) => disposition)).toEqual([
          "pending",
          "confirmed",
        ]);
        expect(Object.isFrozen(diagnostics)).toBe(true);
        expect(Object.isFrozen(diagnostics.records)).toBe(true);
        expect(Object.isFrozen(diagnostics.records[0])).toBe(true);
        expect(Object.isFrozen(during)).toBe(true);
        expect(prior).toMatchObject({ reason: null, busy: false, unresolvedDispatch: false });
        expect(during.reason).toBe("popup-overflow");
        expect(nativeCalls).toBe(1);
        expect(yield* session.status).toMatchObject({
          phase: "open",
          reason: null,
          generation: prior.generation,
          busy: false,
          unresolvedDispatch: false,
        });
      }),
    ),
);

it.effect(
  "a late policy acknowledgement retires only its own control and cannot reopen a faulted session",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let events: DriverEvents | undefined;

        const f = yield* fixture({
          onConnect: async (driver, supplied) => {
            events = supplied;

            return driver;
          },
        });

        const session = yield* (yield* f.acquisition).connect;
        const token = {};

        events?.fault({
          source: "policy",
          reason: "dialog-overflow",
          token,
          disposition: "pending",
        });
        events?.fault({
          source: "policy",
          reason: "dialog-overflow",
          token,
          disposition: "dispatched",
        });
        events?.fault({
          source: "policy",
          reason: "dialog-overflow",
          token,
          disposition: "unknown",
        });
        expect(yield* session.status).toMatchObject({
          phase: "uncertain",
          reason: "dialog-overflow",
          unresolvedDispatch: true,
        });
        events?.fault({
          source: "policy",
          reason: "dialog-overflow",
          token: {},
          disposition: "confirmed",
        });
        expect((yield* session.status).unresolvedDispatch).toBe(true);
        events?.fault({
          source: "policy",
          reason: "dialog-overflow",
          token,
          disposition: "confirmed",
        });
        expect(yield* session.status).toMatchObject({
          phase: "uncertain",
          reason: "dialog-overflow",
          unresolvedDispatch: false,
        });
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { reason: { _tag: "Closed" }, outcome: "undispatched" },
        });
        const before = yield* session.diagnostics;

        // More records than the documented window must not retain an unbounded event history.
        for (let index = 0; index < 33; index++)
          events?.fault({
            source: "policy",
            reason: "popup-overflow",
            token: {},
            disposition: "not-dispatched",
          });
        const after = yield* session.diagnostics;

        expect(after.records).toHaveLength(32);
        expect(after.total).toBe(before.total + 33);
        expect(after.dropped).toBe(after.total - 32);
        expect(after.truncated).toBe(true);
        expect(after.records.every(({ generation }) => generation === 0)).toBe(true);
        expect(Object.keys(after.records[0] ?? {}).sort()).toEqual([
          "disposition",
          "generation",
          "monotonicNanos",
          "reason",
        ]);
        expect((yield* session.status).reason).toBe("dialog-overflow");
        expect(f.state.clicks).toBe(0);
      }),
    ),
);

it.effect("an old connection cannot change replacement status or diagnostics", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const connections: DriverEvents[] = [];

      const f = yield* fixture({
        keepAlive: true,
        onConnect: async (driver, events) => {
          connections.push(events);

          return driver;
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const old = connections[0];

      expect(old).toBeDefined();
      yield* session.detach;
      expect(yield* session.status).toMatchObject({
        phase: "detached",
        reason: "detached",
        unresolvedDispatch: false,
      });
      yield* session.reconnect(true);
      const before = yield* session.status;
      const diagnostics = yield* session.diagnostics;

      old?.fault({ source: "native", reason: "registration", disposition: "unknown" });
      old?.fault({ source: "binding", reason: "callback-failure", disposition: "known" });
      old?.pause("popup");
      old?.disconnected();
      expect(yield* session.status).toEqual(before);
      expect(yield* session.diagnostics).toEqual(diagnostics);
      yield* session.operations.click("#act");
      expect(f.state.clicks).toBe(1);
    }),
  ),
);

it.effect(
  "known callback failure preserves active input uncertainty and interrupts peer handlers after fencing",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const inputEntered = gate<void>();
        const finishInput = gate<void>();
        const inputRetired = gate<void>();
        const expected = { _tag: "ConsumerFailure" as const, privateDetail: "PRIVATE-CONSUMER" };
        let operations: TargetControls | undefined;
        let finalized = false;
        let finalizerOutcome: string | undefined;
        let inputCount = 0;
        let lateInput = 0;

        const plan = yield* preparePlan(
          Bootstrap.combine(
            Bootstrap.binding({
              name: "hold",
              origins: ["https://example.test"],
              input: Schema.Number,
              output: Schema.Number,
              handle: () =>
                Effect.gen(function* () {
                  yield* Effect.addFinalizer(() =>
                    Effect.gen(function* () {
                      if (operations === undefined) return;
                      const result = yield* Effect.result(operations.click("#must-not-dispatch"));

                      finalizerOutcome =
                        result._tag === "Failure" ? result.failure.outcome : "success";
                      finalized = true;
                    }),
                  );
                  yield* Deferred.succeed(entered, undefined);

                  return yield* Effect.never;
                }),
            }),
            Bootstrap.binding({
              name: "fail",
              origins: ["https://example.test"],
              input: Schema.Number,
              output: Schema.Number,
              failureMode: "fail-session",
              handle: () => Effect.fail(expected),
            }),
          ),
        );

        const bindings = yield* makeBindings(plan);
        let connection: ConnectionBindings | undefined;

        const f = yield* fixture({
          connectBindings: (fault, active, current) =>
            bindings.connect(fault, active, current).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  connection = value;
                }),
              ),
            ),
          onClick: async (ticket) => {
            ticket.dispatch();
            inputCount++;
            inputEntered.resolve();
            try {
              await finishInput.promise;
              ticket.check();
              lateInput++;

              return "https://example.test/";
            } finally {
              inputRetired.resolve();
            }
          },
        });

        const session = yield* (yield* f.acquisition).connect;

        operations = session.operations;
        const hold = connection?.bindings.find(({ name }) => name === "hold");
        const fail = connection?.bindings.find(({ name }) => name === "fail");

        expect(hold).toBeDefined();
        expect(fail).toBeDefined();

        const held = hold
          ?.invoke({ read: async () => "1", check: async () => {}, dispose: async () => {} })
          .catch(() => "rejected");

        yield* Deferred.await(entered);
        const input = yield* Effect.forkChild(session.operations.click("#act").pipe(Effect.result));

        yield* Effect.promise(() => inputEntered.promise);
        yield* Effect.promise(async () => {
          await fail
            ?.invoke({ read: async () => "1", check: async () => {}, dispose: async () => {} })
            .catch(() => undefined);
        });
        expect(yield* Fiber.join(input)).toMatchObject({
          _tag: "Failure",
          failure: { outcome: "unknown" },
        });
        yield* Effect.promise(async () => {
          expect(await held).toBe("rejected");
        });
        const failure = yield* Effect.exit(bindings.failure);

        expect(Exit.isFailure(failure)).toBe(true);
        if (Exit.isFailure(failure)) expect(Cause.squash(failure.cause)).toBe(expected);
        expect({ finalized, finalizerOutcome, inputCount }).toEqual({
          finalized: true,
          finalizerOutcome: "undispatched",
          inputCount: 1,
        });
        expect(yield* session.status).toMatchObject({
          phase: "faulted",
          reason: "callback-failure",
          unresolvedDispatch: true,
        });
        finishInput.resolve();
        yield* Effect.promise(() => inputRetired.promise);
        expect(lateInput).toBe(0);
        yield* session.close;
        expect(yield* session.status).toMatchObject({
          phase: "closed",
          reason: "callback-failure",
          unresolvedDispatch: false,
        });
        expect(f.state.releases).toBe(1);
      }),
    ),
);

it.effect("capacity refusal is a known terminal block without invented native uncertainty", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let events: DriverEvents | undefined;

      const f = yield* fixture({
        onConnect: async (driver, supplied) => {
          events = supplied;

          return driver;
        },
      });

      const session = yield* (yield* f.acquisition).connect;

      events?.fault({ source: "native", reason: "callback", disposition: "not-dispatched" });
      expect(yield* session.status).toMatchObject({
        phase: "faulted",
        reason: "cleanup-capacity",
        unresolvedDispatch: false,
      });
      expect((yield* session.diagnostics).records).toEqual([
        expect.objectContaining({
          reason: "cleanup-capacity",
          disposition: "not-dispatched",
          generation: 0,
        }),
      ]);
      expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
        _tag: "Failure",
        failure: { outcome: "undispatched" },
      });
      expect(f.state.clicks).toBe(0);
      expect(f.state.releases).toBe(0);
    }),
  ),
);

it.effect("unconfirmed owned release cannot retire a dispatched operation's control evidence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const f = yield* fixture({
        releaseFails: true,
        onClick: async (ticket) => {
          ticket.dispatch();
          throw new Error("PRIVATE-LOST-ACKNOWLEDGEMENT");
        },
      });

      const session = yield* (yield* f.acquisition).connect;

      expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
        _tag: "Failure",
        failure: { outcome: "unknown" },
      });
      const original = yield* session.status;

      expect(original.unresolvedDispatch).toBe(true);
      const report = yield* elapse(session.close, 12_000);

      expect(report.remote).not.toBe("confirmed");
      expect(yield* session.status).toMatchObject({
        phase: "closed",
        reason: original.reason,
        unresolvedDispatch: true,
      });
      expect(yield* session.close).toEqual(report);
      expect(f.state.releases).toBe(1);
    }),
  ),
);

it.effect(
  "a completed navigation's late before-unload acknowledgement cannot settle its successor",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const first = gate<string>();
        const second = gate<string>();
        const controls: NavigationControl[] = [];
        let sends = 0;

        const f = yield* fixture({
          onConnect: async (driver) => ({
            ...driver,
            beginNavigation: async (url, _timeout, ticket, _target, control) => {
              ticket.dispatch();
              sends++;
              if (control !== undefined) controls.push(control);

              return {
                pageId: driver.selected().pageId,
                mainFrame: true,
                settled: url.endsWith("first") ? first.promise : second.promise,
                stop: async () => "settled",
              };
            },
          }),
        });

        const session = yield* (yield* f.acquisition).connect;
        const predecessor = yield* session.operations.startNavigation("https://example.test/first");
        const captured = controls[0]?.beforeUnload();

        expect(captured).toBeDefined();
        first.resolve("https://example.test/first");
        expect(yield* predecessor.completed).toBe("https://example.test/first");
        const successor = yield* session.operations.startNavigation("https://example.test/second");

        captured?.dismissed(false);
        controls[0]?.beforeUnload().dismissed(false);
        expect(controls[0]?.identity).not.toBe(controls[1]?.identity);
        expect(yield* session.status).toMatchObject({
          phase: "open",
          reason: null,
          unresolvedDispatch: true,
        });
        second.resolve("https://example.test/second");
        expect(yield* successor.completed).toBe("https://example.test/second");
        expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: false });
        expect(sends).toBe(2);
      }),
    ),
);

it.effect.each(["consumer", "consumer-initialization-error", "registration"] as const)(
  "%s retains its original typed cause and classifies at its producer",
  (origin) =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected =
          origin === "consumer"
            ? new Error("PRIVATE-CONSUMER")
            : InitializationError.make({
                operation: "register",
                step: "fixture",
                reason: "native",
              });

        const plan = yield* preparePlan(
          Bootstrap.binding({
            name: "fail",
            origins: ["https://example.test"],
            input: Schema.Number,
            output: Schema.Number,
            failureMode: "fail-session",
            handle: () => Effect.fail(expected),
          }),
        );

        const bindings = yield* makeBindings(plan);
        let connection: ConnectionBindings | undefined;

        const f = yield* fixture({
          connectBindings: (fault, active, current) =>
            bindings.connect(fault, active, current).pipe(
              Effect.tap((value) =>
                Effect.sync(() => {
                  connection = value;
                }),
              ),
            ),
        });

        const session = yield* (yield* f.acquisition).connect;

        if (origin === "registration") {
          expect(Schema.is(InitializationError)(expected)).toBe(true);
          if (Schema.is(InitializationError)(expected)) connection?.reportFailure(expected);
        } else {
          const binding = connection?.bindings[0];

          expect(binding).toBeDefined();
          yield* Effect.promise(async () => {
            await binding
              ?.invoke({ read: async () => "1", check: async () => {}, dispose: async () => {} })
              .catch(() => undefined);
          });
        }
        const failed = yield* Effect.exit(bindings.failure);

        expect(Exit.isFailure(failed)).toBe(true);
        if (Exit.isFailure(failed)) expect(Cause.squash(failed.cause)).toBe(expected);
        expect(yield* session.status).toMatchObject({
          phase: origin === "registration" ? "uncertain" : "faulted",
          reason: origin === "registration" ? "registration-failure" : "callback-failure",
          unresolvedDispatch: origin === "registration",
        });
        expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
          _tag: "Failure",
          failure: { outcome: "undispatched" },
        });
        expect(f.state.clicks).toBe(0);
      }),
    ),
);

it.effect.each(["ack-first", "reject-first", "unconfirmed"] as const)(
  "before-unload %s reconciles only its Session-issued navigation",
  (order) =>
    Effect.scoped(
      Effect.gen(function* () {
        const pending = gate<string>();
        let control: NavigationControl | undefined;
        let dispatches = 0;

        const f = yield* fixture({
          onConnect: async (driver) => ({
            ...driver,
            beginNavigation: async (_url, _timeout, ticket, _target, issued) => {
              ticket.dispatch();
              dispatches++;
              control = issued;

              return {
                pageId: driver.selected().pageId,
                mainFrame: true,
                settled: pending.promise,
                stop: async () => "settled",
              };
            },
          }),
        });

        const session = yield* (yield* f.acquisition).connect;
        const operation = yield* session.operations.startNavigation("https://example.test/first");
        const dialog = control?.beforeUnload();

        expect(dialog).toBeDefined();
        if (order === "ack-first") dialog?.dismissed(true);
        pending.reject(new Error("PRIVATE-GOTO-REJECTED"));
        yield* Effect.promise(() => pending.promise.catch(() => undefined));
        if (order !== "ack-first") {
          expect(yield* session.status).toMatchObject({ phase: "open", unresolvedDispatch: true });
          dialog?.dismissed(order !== "unconfirmed");
        }
        expect(yield* Effect.result(operation.completed)).toMatchObject({
          _tag: "Failure",
          failure: {
            reason: { _tag: order === "unconfirmed" ? "Provider" : "Interrupted" },
            outcome: "unknown",
          },
        });
        expect(dispatches).toBe(1);
        expect(yield* session.status).toMatchObject({
          phase: order === "unconfirmed" ? "uncertain" : "open",
          unresolvedDispatch: order === "unconfirmed",
        });
        dialog?.dismissed(true);
        if (order === "unconfirmed")
          expect(yield* Effect.result(session.operations.click("#act"))).toMatchObject({
            _tag: "Failure",
          });
        else {
          yield* session.operations.click("#act");
          expect(f.state.clicks).toBe(1);
        }
      }),
    ),
);
