import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import { Clock, Effect, Fiber, Schema, type Scope } from "effect";

import { BrowserError, type InitializationError } from "../src/Errors.ts";
import type { NativeNavigation } from "../src/internal/browser/Driver.ts";
import { makeOwner, native } from "../src/internal/browser/Owner.ts";
import type { ScriptedControl } from "../src/Testing.ts";
import { fixture, gate, ownerScript } from "./fixtures/ScriptedOwner.ts";
import { advance, elapse, timed } from "./fixtures/Time.ts";

/** Acquisition keeps its own declared channel; local browser operations stay BrowserError. */
type OwnershipFailure = BrowserError | InitializationError;

const expectReason = <A, E extends { readonly reason: string | { readonly _tag: string } }, R>(
  effect: Effect.Effect<A, E, R>,
  reason: E["reason"] extends infer Reason
    ? Reason extends { readonly _tag: infer Tag }
      ? Tag
      : Reason
    : never,
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure")
        assert.equal(
          typeof result.failure.reason === "string"
            ? result.failure.reason
            : result.failure.reason._tag,
          reason,
        );
    }),
  );

/** Observations the engine was asked for: a passive or refused reading takes none. */
const observations = (control: ScriptedControl) =>
  control.calls.pipe(
    Effect.map((calls) => calls.filter((call) => call.operation === "observe").length),
  );

/** A navigation the scripted driver leaves in flight until the test decides how it ends. */
const inFlight = () => {
  const urls: Array<string> = [];
  let stops = 0;
  let resolve: (url: string) => void = () => {};
  let reject: (error: Error) => void = () => {};

  return {
    urls,
    get stops() {
      return stops;
    },
    settle: () => resolve(urls.at(-1) ?? ""),
    fail: () => reject(new Error("PRIVATE-NAVIGATION-FAILURE")),
    script: (url: string, pageId: string): NativeNavigation => {
      urls.push(url);

      const settled = new Promise<string>((yes, no) => {
        resolve = yes;
        reject = no;
      });

      void settled.catch(() => {});

      return {
        pageId,
        settled,
        stop: async (ticket, pending, onDispatch) => {
          ticket.check();
          if (!pending()) return "settled" as const;
          ticket.dispatch();
          onDispatch();
          stops++;

          return "dispatched" as const;
        },
      };
    },
  };
};

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, OwnershipFailure>;
}

const test = (
  name: string,
  body: () => Effect.Effect<void, OwnershipFailure, Scope.Scope>,
): Case => ({ name, run: timed(Effect.scoped(Effect.suspend(body))) });

const ownershipCases: ReadonlyArray<Case> = [
  test("pre-dispatch interruption fences a late continuation without poisoning the owner", () =>
    Effect.gen(function* () {
      const entered = gate<void>(),
        queried = gate<void>(),
        settled = gate<void>();

      let dispatches = 0;

      const f = yield* fixture({
        onClick: async (ticket) => {
          entered.resolve();
          await queried.promise;
          try {
            ticket.dispatch();
            dispatches++;

            return "https://example.test/";
          } finally {
            settled.resolve();
          }
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const fiber = yield* session.operations.click("#button").pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      queried.resolve();
      yield* Effect.promise(() => settled.promise);
      assert.equal(dispatches, 0);
      assert.equal(yield* session.operations.readText(), "initial");
    })),
  test("interruption after dispatch expires automation without replay", () =>
    Effect.gen(function* () {
      const entered = gate<void>(),
        done = gate<void>();

      let dispatches = 0;

      const f = yield* fixture({
        onClick: async (ticket) => {
          ticket.dispatch();
          dispatches++;
          entered.resolve();
          await done.promise;

          return "https://example.test/";
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const fiber = yield* session.operations.click("#button").pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      yield* expectReason(session.operations.readText(), "Closed");
      done.resolve();
      assert.equal(dispatches, 1);
    })),
  test("late connection after interruption is locally closed", () =>
    Effect.gen(function* () {
      const connected = gate<void>(),
        complete = gate<void>(),
        closed = gate<void>();

      const f = yield* fixture({
        onDisconnect: () => closed.resolve(),
        onConnect: async (driver) => {
          connected.resolve();
          await complete.promise;

          return driver;
        },
      });

      const acquired = yield* f.acquisition;
      const fiber = yield* acquired.connect.pipe(Effect.forkChild);

      yield* Effect.promise(() => connected.promise);
      yield* Fiber.interrupt(fiber);
      complete.resolve();
      yield* Effect.promise(() => closed.promise);
      assert.equal(f.state.localCloses, 1);
      // The scripted lifetime has nothing remote to release: its one receipt says cleanup ran
      // while the connection was still pending, and the connection closed when it arrived.
      assert.deepEqual(
        f.reports.map((report) => report.connection),
        ["pending"],
      );
      assert.deepEqual(yield* f.control.connections, ["closed"]);
    })),
  test("selecting a tab invalidates old handles without spending an action", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ maxActions: 1 });
      const session = yield* (yield* f.acquisition).connect;
      // Opening a tab is no action either.
      const second = yield* session.createPage();
      const old = yield* session.retain;

      yield* session.selectPage(second);
      yield* expectReason(old.readText(), "Stale");
      assert.equal((yield* session.target).pageId, "page-2");
      // The one action reads the tab now selected, whose blank document has no text.
      assert.equal(yield* session.operations.readText(), "");
    })),
  test("native input through a handle that no longer selects its page is never sent", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const session = yield* (yield* f.acquisition).connect;
      const second = yield* session.createPage();
      const old = yield* session.retain;

      yield* session.selectPage(second);
      yield* expectReason(old.pointerMove({ x: 1, y: 2 }), "Stale");
      yield* expectReason(old.hover("#target"), "Stale");
      yield* expectReason(old.wheel(0, 120), "Stale");
      yield* expectReason(old.press("Enter", []), "Stale");
      yield* expectReason(old.type("typed"), "Stale");
      // Refused before dispatch: the page now selected received nothing meant for the old one.
      assert.deepEqual(f.state.input, []);
      yield* session.operations.pointerMove({ x: 1, y: 2 });
      assert.deepEqual(f.state.input, ["move page-2 1,2"]);
    })),
  test("native input is charged as an action and stamped on the owner's monotonic clock", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ maxActions: 2 });
      const session = yield* (yield* f.acquisition).connect;
      const handle = yield* session.retain;
      const moved = yield* handle.pointerMove({ x: 12.5, y: 40 });

      assert.deepEqual(moved.position, { x: 12.5, y: 40 });
      assert.equal(moved.target.pageId, "page-1");
      assert.ok(moved.completedMonotonicNanos >= moved.startedMonotonicNanos);
      // A wheel that names no point leaves the pointer where this owner last placed it.
      assert.deepEqual((yield* handle.wheel(0, 120)).position, { x: 12.5, y: 40 });
      const refused = yield* handle.hover("#target").pipe(Effect.result);

      assert.equal(refused._tag, "Failure");
      if (refused._tag === "Failure") {
        assert.equal(refused.failure.operation, "hover");
        assert.deepEqual(refused.failure.reason, {
          _tag: "Limit",
          dimension: "actions",
          maximum: 2,
          observed: 2,
        });
        assert.equal(refused.failure.outcome, "undispatched");
      }
      assert.deepEqual(f.state.input, ["move page-1 12.5,40", "wheel page-1 0,120"]);
    })),
  test("key input is one charged action per call, however many characters it carries", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ maxActions: 2 });
      const session = yield* (yield* f.acquisition).connect;
      const handle = yield* session.retain;
      const typed = yield* handle.type("six ch");

      assert.equal(typed.target.pageId, "page-1");
      assert.ok(typed.completedMonotonicNanos >= typed.startedMonotonicNanos);
      // Keys move no pointer: the position is still whatever this owner last commanded.
      assert.equal(typed.position, null);
      yield* handle.press("a", ["Control", "Shift"]);
      const refused = yield* handle.press("Enter", []).pipe(Effect.result);

      assert.equal(refused._tag, "Failure");
      if (refused._tag === "Failure") {
        assert.equal(refused.failure.operation, "press");
        assert.deepEqual(refused.failure.reason, {
          _tag: "Limit",
          dimension: "actions",
          maximum: 2,
          observed: 2,
        });
        assert.equal(refused.failure.outcome, "undispatched");
      }
      assert.deepEqual(f.state.input, ["type page-1 6", "press page-1 Control+Shift+a"]);
    })),
  test("a checkpoint charges only its host allowance and leaves the observation and revision alone", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ maxActions: 2, maxHostReads: 1 });
      const session = yield* (yield* f.acquisition).connect;
      const observed = yield* session.observe();
      const sampled = yield* session.checkpoint({ picture: true });

      // Passive: no second observation was taken, and nothing was invalidated to take it.
      assert.equal(yield* observations(f.control), 1);
      assert.equal(sampled.revision, observed.revision);
      assert.deepEqual(sampled.target, observed.target);
      assert.ok(sampled.picture !== undefined);
      assert.ok(sampled.completedMonotonicNanos >= sampled.startedMonotonicNanos);
      assert.equal(
        (yield* session.checkpoint({ picture: false }).pipe(Effect.result))._tag,
        "Failure",
      );
      const exhausted = yield* session.checkpoint({ picture: false }).pipe(Effect.result);

      assert.equal(exhausted._tag, "Failure");
      if (exhausted._tag !== "Failure") throw new Error("Host reads must remain bounded");
      assert.deepEqual(exhausted.failure.reason, {
        _tag: "Limit",
        dimension: "host-reads",
        maximum: 1,
        observed: 1,
      });
      assert.equal(exhausted.failure.outcome, "undispatched");
      // The model's second allowance is independent of the exhausted host sampling budget.
      yield* session.operations.click("#act");
      assert.equal(f.state.clicks, 1);
      yield* expectReason(session.operations.click("#act"), "Limit");
      assert.equal((yield* session.status).phase, "open");
    })),
  test("a reading may narrow the policy's text bound and never widen it", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const session = yield* (yield* f.acquisition).connect;

      // The fixture's policy returns at most 65536 bytes.
      yield* expectReason(
        session.observe({ scope: "viewport", maxTextBytes: 65537 }),
        "Configuration",
      );
      yield* expectReason(
        session.checkpoint({ picture: false, maxTextBytes: 65537 }),
        "Configuration",
      );
      assert.equal(yield* observations(f.control), 0);
      assert.equal((yield* session.observe({ scope: "viewport" })).scope, "viewport");
    })),
  test("an in-flight navigation keeps mutations off its page and lets everything else proceed", () =>
    Effect.gen(function* () {
      const flight = inFlight();
      const f = yield* fixture({ onNavigate: flight.script });
      const session = yield* (yield* f.acquisition).connect;
      const first = (yield* session.pages).find((page) => page.selected);
      // Another tab showing the same controls, set up before anything is in flight.
      const second = yield* session.createPage();

      const [initial] = ownerScript.documents;

      assert.ok(first !== undefined);
      assert.ok(initial !== undefined);
      yield* session.selectPage(second);
      yield* f.control.document.replace(initial);
      yield* session.selectPage(first);
      const handle = yield* session.retain;
      const operation = yield* handle.startNavigation("https://example.test/slow");

      // Dispatched exactly once, and the permit is free again while the browser loads.
      assert.deepEqual(flight.urls, ["https://example.test/slow"]);
      yield* expectReason(handle.click("#act"), "Busy");
      yield* expectReason(handle.navigate("https://example.test/other"), "Busy");
      yield* expectReason(handle.pointerMove({ x: 1, y: 1 }), "Busy");
      yield* expectReason(handle.press("Enter", []), "Busy");
      yield* expectReason(handle.type("typed"), "Busy");
      assert.equal(f.state.clicks, 0);
      assert.deepEqual(f.state.input, []);
      // Reads and passive evidence are admitted while it loads.
      assert.equal(yield* handle.readText(), "initial");
      yield* session.checkpoint({ picture: false });

      // Giving up on a wait stops nothing, and the navigation is not sent again.
      const abandoned = yield* elapse(operation.completed.pipe(Effect.timeoutOption(100)), 200);

      assert.equal(abandoned._tag, "None");
      assert.deepEqual(flight.urls, ["https://example.test/slow"]);
      assert.equal(flight.stops, 0);

      // Another page is not this page.
      yield* session.selectPage(second);
      yield* session.operations.click("#act");
      assert.equal(f.state.clicks, 1);

      flight.settle();
      assert.equal(yield* operation.completed, "https://example.test/slow");
      // Settled is a known outcome: the page it loaded takes input again.
      yield* session.selectPage(first);
      yield* session.operations.click("#act");
      assert.equal(f.state.clicks, 2);
    })),
  test("stopping a navigation is a known outcome and the session stays usable", () =>
    Effect.gen(function* () {
      const flight = inFlight();
      const f = yield* fixture({ onNavigate: flight.script });
      const session = yield* (yield* f.acquisition).connect;
      const handle = yield* session.retain;
      const operation = yield* handle.startNavigation("https://example.test/slow");

      yield* operation.stop;
      assert.equal(flight.stops, 1);
      // Decided by the browser's acknowledgement; the native promise never settled.
      yield* expectReason(operation.completed, "Interrupted");
      yield* handle.click("#act");
      assert.equal(f.state.clicks, 1);
      // The native promise rejecting later, as Playwright's does at its timeout, changes nothing.
      flight.fail();
      yield* handle.click("#act");
      assert.equal(f.state.clicks, 2);
    })),
  test("a navigation that fails after dispatch, or is left unsettled, fences the owner", () =>
    Effect.gen(function* () {
      for (const abandon of [false, true]) {
        const flight = inFlight();
        const f = yield* fixture({ onNavigate: flight.script });
        const session = yield* (yield* f.acquisition).connect;
        const handle = yield* session.retain;

        if (abandon) {
          // Its scope closes while the browser is still loading.
          yield* Effect.scoped(handle.startNavigation("https://example.test/slow"));
        } else {
          const operation = yield* handle.startNavigation("https://example.test/slow");

          flight.fail();
          const failed = yield* operation.completed.pipe(Effect.result);

          assert.equal(failed._tag, "Failure");
          if (failed._tag === "Failure") {
            assert.equal(failed.failure.operation, "navigate");
            assert.equal(failed.failure.outcome, "unknown");
          }
        }
        // Nothing knows what the browser did, so nothing more is sent. It is never replayed.
        assert.equal((yield* handle.click("#act").pipe(Effect.result))._tag, "Failure");
        assert.equal(f.state.clicks, 0);
        assert.deepEqual(flight.urls, ["https://example.test/slow"]);
      }
    })),
  test("elapsed expiry closes an idle browser while the outer scope stays open", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ lifetimeMillis: 50 });
      const session = yield* (yield* f.acquisition).connect;

      yield* advance(80);
      yield* session.close;
      yield* expectReason(session.operations.readText(), "Expired");
      assert.equal((yield* session.status).reason, "expired");
      assert.equal((yield* session.status).unresolvedDispatch, false);
      assert.equal(f.state.localCloses, 1);
    })),
  test("native failures serialize classification without SDK secrets", () =>
    Effect.gen(function* () {
      const owner = yield* makeOwner({
        maxActions: 2,
        maxHostReads: 10_000,
        maxElapsedMillis: 1000,
        actionTimeoutMillis: 100,
      });

      owner.state.phase = "open";

      const result = yield* owner
        .guard(
          "fill",
          (ticket) =>
            native("fill", ticket, async () => {
              ticket.dispatch();
              throw new Error("PRIVATE-FILL-SECRET private-page-content wss://private-url");
            }),
          { mutation: true },
        )
        .pipe(Effect.result);

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        // Schema failure here is a fixture defect, not part of the runtime error channel.
        const encoded = yield* Schema.encodeEffect(Schema.fromJsonString(BrowserError))(
          result.failure,
        ).pipe(Effect.orDie);

        assert.ok(encoded.includes('"unknown"'));
        assert.ok(!encoded.includes("PRIVATE"));
        assert.ok(!String(result.failure.stack).includes("PRIVATE"));
      }
    })),
  test("wall-clock movement does not spend the monotonic lifetime budget", () =>
    Effect.gen(function* () {
      const base = yield* Clock.Clock;
      let wall = 1000;

      const clock: Clock.Clock = {
        currentTimeMillisUnsafe: () => wall,
        currentTimeMillis: Effect.sync(() => wall),
        currentTimeNanosUnsafe: () => BigInt(wall) * 1000000n,
        currentTimeNanos: Effect.sync(() => BigInt(wall) * 1000000n),
        monotonicTimeNanosUnsafe: () => base.monotonicTimeNanosUnsafe(),
        monotonicTimeNanos: base.monotonicTimeNanos,
        sleep: (duration) => base.sleep(duration),
      };

      yield* Effect.gen(function* () {
        const owner = yield* makeOwner({
          maxActions: 2,
          maxHostReads: 10_000,
          maxElapsedMillis: 1000,
          actionTimeoutMillis: 100,
        });

        owner.state.phase = "open";
        wall = 999999999999;
        assert.equal(yield* owner.guard("read-text", () => Effect.succeed(1)), 1);
        wall = -9999999;
        assert.equal(yield* owner.guard("read-text", () => Effect.succeed(2)), 2);
      }).pipe(Effect.provideService(Clock.Clock, clock));
    })),
];

for (const test of ownershipCases) it.effect(test.name, () => test.run);
