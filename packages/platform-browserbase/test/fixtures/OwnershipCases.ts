import assert from "node:assert/strict";

import { Clock, Effect, Fiber, Redacted, Schema, type Scope } from "effect";

import { makeOwner, native } from "../../src/internal/Owner.ts";
import { BrowserbaseError } from "../../src/Types.ts";
import { fixture, gate } from "./ScriptedProvider.ts";
import { advance, elapse, timed } from "./Time.ts";

const expectReason = <A, R>(
  effect: Effect.Effect<A, BrowserbaseError, R>,
  reason: BrowserbaseError["reason"],
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, reason);
    }),
  );

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, BrowserbaseError>;
}

const test = (
  name: string,
  body: () => Effect.Effect<void, BrowserbaseError, Scope.Scope>,
): Case => ({ name, run: timed(Effect.scoped(Effect.suspend(body))) });

export const ownershipCases: ReadonlyArray<Case> = [
  test("one scoped session spans successive operations and closes once", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const acquired = yield* f.acquisition;
      const session = yield* acquired.connect;
      const handle = session.bind();

      yield* handle.navigate("https://example.test/next");
      assert.equal(yield* handle.readText(), "initial");
      assert.equal((yield* session.observe()).url, "https://example.test/next");
      const report = yield* session.close;

      assert.equal(report.remote, "confirmed");
      assert.equal(report.local, "closed");
      yield* session.close;
      assert.equal(f.state.allocations, 1);
      assert.equal(f.state.releases, 1);
      assert.equal(f.state.localCloses, 1);
    })),
  test("failed connection retains exact identity and still releases", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ connectFails: true });
      const acquired = yield* f.acquisition;

      assert.equal(acquired.reference.sessionId, "session-1");
      yield* expectReason(acquired.connect, "provider");
      assert.equal(f.state.releases, 1);
      assert.equal(f.state.connects, 1);
      yield* expectReason(acquired.connect, "closed");
      assert.equal(f.state.connects, 1);
    })),
  test("lost create reply is not retried and reports an allocation nonce", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ createFails: true });

      yield* expectReason(f.acquisition, "allocation-unknown");
      assert.equal(f.state.allocations, 1);
      assert.equal(f.state.releases, 0);
      assert.equal(f.uncertain.length, 1);
    })),
  test("malformed allocation does not fabricate a session identity", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ malformedCreate: true });

      yield* expectReason(f.acquisition, "allocation-unknown");
      assert.equal(f.state.connects, 0);
      assert.equal(f.state.releases, 0);
      assert.equal(f.uncertain.length, 1);
    })),
  test("pending release needs an exact-session terminal read", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ releasePending: true });
      const session = yield* (yield* f.acquisition).connect;
      const report = yield* session.close;

      assert.equal(report.remote, "confirmed");
      assert.ok(f.calls.includes("GET /v1/sessions/session-1"));
      assert.equal(f.state.releases, 1);
    })),
  test("unconfirmed provider close still disconnects and reports", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ releaseFails: true });
      const session = yield* (yield* f.acquisition).connect;
      const report = yield* elapse(session.close, 2000);

      assert.notEqual(report.remote, "confirmed");
      assert.equal(report.local, "closed");
      assert.equal(f.state.localCloses, 1);
      assert.equal(f.state.releases, 1);
      assert.equal(f.reports.length, 1);
    })),
  test("other-session metadata never proves termination", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ statusMismatch: true });
      const session = yield* (yield* f.acquisition).connect;
      const report = yield* elapse(session.close, 2000);

      assert.equal(report.remote, "unknown");
      assert.equal(f.state.localCloses, 1);
    })),
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
      const fiber = yield* session.bind().click("#button").pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      queried.resolve();
      yield* Effect.promise(() => settled.promise);
      assert.equal(dispatches, 0);
      assert.equal(yield* session.bind().readText(), "initial");
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
      const fiber = yield* session.bind().click("#button").pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* Fiber.interrupt(fiber);
      yield* expectReason(session.bind().readText(), "closed");
      done.resolve();
      assert.equal(dispatches, 1);
    })),
  test("close wakes an in-flight native waiter and coalesces teardown", () =>
    Effect.gen(function* () {
      const entered = gate<void>();

      const f = yield* fixture({
        onClick: async (ticket) => {
          ticket.dispatch();
          entered.resolve();
          await new Promise(() => {});

          return "https://example.test/";
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const fiber = yield* session.bind().click("#button").pipe(Effect.result, Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* Effect.all([session.close, session.close], { concurrency: 2 });
      const result = yield* Fiber.join(fiber);

      assert.equal(result._tag, "Failure");
      assert.equal(f.state.releases, 1);
      assert.equal(f.state.localCloses, 1);
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
      assert.equal(f.state.releases, 1);
    })),
  test("handoff pauses automation and fresh observation commits under one permit", () =>
    Effect.gen(function* () {
      const entered = gate<void>(),
        observed = gate<void>();

      const f = yield* fixture({
        onObserve: async () => {
          entered.resolve();
          await observed.promise;
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const old = session.bind();
      const handoff = yield* session.beginHandoff(60);

      f.state.text = "human changed this";
      const resumed = yield* session.resume(handoff.token, true).pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* expectReason(session.bind().click("#button"), "busy");
      observed.resolve();
      assert.equal((yield* Fiber.join(resumed)).text, "human changed this");
      yield* expectReason(old.readText(), "stale");
      assert.equal(f.state.clicks, 0);
    })),
  test("failed Live View acquisition does not automatically resume", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ liveViewFails: true });
      const session = yield* (yield* f.acquisition).connect;

      yield* expectReason(session.beginHandoff(60), "authorization");
      yield* expectReason(session.bind().click("#button"), "busy");
    })),
  test("resume requires the operator acknowledgement and matching token", () =>
    Effect.gen(function* () {
      const f = yield* fixture();
      const session = yield* (yield* f.acquisition).connect;
      const handoff = yield* session.beginHandoff(60);

      yield* expectReason(session.resume(handoff.token, false), "authorization");
      yield* expectReason(session.resume(Redacted.make("wrong"), true), "authorization");
      yield* expectReason(session.bind().click("#button"), "busy");
    })),
  test("selecting a tab invalidates old handles without spending an action", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ maxActions: 1 });
      const session = yield* (yield* f.acquisition).connect;
      const old = session.bind();

      yield* session.selectPage("page-2");
      yield* expectReason(old.readText(), "stale");
      assert.equal((yield* session.currentTarget).pageId, "page-2");
      assert.equal(yield* session.bind().readText(), "initial");
    })),
  test("keep-alive reconnect establishes a new generation and observes actual state", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ keepAlive: true });
      const session = yield* (yield* f.acquisition).connect;
      const old = session.bind();

      yield* session.detach;
      f.state.text = "changed while detached";
      const fresh = yield* session.reconnect(true);

      assert.equal(fresh.text, "changed while detached");
      assert.equal(f.state.connects, 2);
      yield* expectReason(old.readText(), "stale");
    })),
  test("elapsed expiry closes an idle browser while the outer scope stays open", () =>
    Effect.gen(function* () {
      const f = yield* fixture({ lifetimeMillis: 50 });
      const session = yield* (yield* f.acquisition).connect;

      yield* advance(80);
      yield* session.close;
      yield* expectReason(session.bind().readText(), "closed");
      assert.equal(f.state.localCloses, 1);
    })),
  test("persistent writer lease sees provider cleanup before its finalizer", () =>
    Effect.gen(function* () {
      let observed = "none";

      const f = yield* fixture({
        contextLease: () =>
          Effect.succeed({
            finalize: ({ cleanup }) =>
              Effect.sync(() => {
                observed = cleanup._tag === "Some" ? cleanup.value.remote : "unknown";
              }),
          }),
      });

      const session = yield* (yield* f.acquisition).connect;

      yield* session.close;
      assert.equal(observed, "confirmed");
    })),
  test("native failures serialize classification without SDK secrets", () =>
    Effect.gen(function* () {
      const owner = yield* makeOwner({
        maxActions: 2,
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
        // @effect-diagnostics-next-line schemaSyncInEffect:off
        const encoded = Schema.encodeSync(Schema.fromJsonString(BrowserbaseError))(result.failure);

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
          maxElapsedMillis: 1000,
          actionTimeoutMillis: 100,
        });

        owner.state.phase = "open";
        wall = 999999999999;
        assert.equal(yield* owner.guard("read", () => Effect.succeed(1)), 1);
        wall = -9999999;
        assert.equal(yield* owner.guard("read", () => Effect.succeed(2)), 2);
      }).pipe(Effect.provideService(Clock.Clock, clock));
    })),
];
