import assert from "node:assert/strict";

import { Effect, Fiber, Redacted } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { type BrowserError, type InitializationError, Reasons } from "effect-browser/errors";
import type { Script } from "effect-browser/testing";
import { TestClock } from "effect/testing";

import { BrowserbaseBrowser } from "../../src/Browser.ts";
import type { CleanupResult } from "../../src/Cleanup.ts";
import { withWriter, type WriterSettlementFacts } from "../../src/ContextCoordination.ts";
import type { AllocationError, ClientError, ContextError } from "../../src/Errors.ts";
import { recipe } from "../../src/Launch.ts";
import { ContextReference } from "../../src/References.ts";
import * as Testing from "../../src/Testing.ts";
import { elapse, timed } from "./Time.ts";

/** Acquisition keeps its own declared channel; local browser operations stay BrowserError. */
type OwnershipFailure =
  | AllocationError
  | BrowserError
  | ClientError
  | ContextError
  | InitializationError;

/** Allocation uncertainty is an outcome, not a reason conflated into the failure name. */
const expectUncertainAllocation = <A, R>(
  effect: Effect.Effect<A, OwnershipFailure, R>,
  reason: AllocationError["reason"],
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") {
        assert.equal(result.failure._tag, "AllocationError");
        if (result.failure._tag === "AllocationError") {
          assert.equal(result.failure.outcome, "unknown");
          assert.equal(result.failure.reason, reason);
        }
      }
    }),
  );

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

/** The scripted provider answers in memory, a few scheduler turns after a request is sent. */
const eventually = (condition: Effect.Effect<boolean>) =>
  Effect.gen(function* () {
    for (let turn = 0; turn < 100 && !(yield* condition); turn++) yield* Effect.yieldNow;
    assert.ok(yield* condition);
  });

/**
 * Terminal-status polling sleeps on the Effect clock between reads. Advance it one poll at a
 * time, so a read the provider can now confirm is taken before the status bound runs out.
 */
const polled = <A, E>(fiber: Fiber.Fiber<A, E>) =>
  Effect.gen(function* () {
    for (let poll = 0; poll < 16 && fiber.pollUnsafe() === undefined; poll++)
      yield* TestClock.adjust(250);

    return yield* Fiber.join(fiber);
  });

const controls = ["act", "button"].map((id) => ({ id, kind: "button" as const, label: id }));

/** Every address these cases visit shows the same page, so each case is about the provider. */
const script: Script = {
  documents: ["", "next"].map((path) => ({
    url: `https://example.test/${path}`,
    text: "initial",
    controls,
  })),
};

const policy = BrowserPolicy.unrestricted({ maxActions: 20 });

/** The real account and browser Layers over the scripted provider and engine. */
const layer = (options: Partial<Testing.ScriptedLayerOptions> = {}) =>
  Testing.layer({ browser: script, ...options });

/** The scripted browser behind the one provider session a case has connected to. */
const scriptedBrowser = Effect.gen(function* () {
  const [browser] = yield* (yield* Testing.ScriptedBrowserbase).browsers;

  assert.ok(browser !== undefined);

  return browser;
});

const reporting = (reports: Array<CleanupResult>) => ({
  onCleanup: (report: CleanupResult) =>
    Effect.sync(() => {
      reports.push(report);
    }),
});

const uncertainty = (attempts: Array<string>) => ({
  onAllocationUncertain: (attempt: { readonly attemptId: string }) =>
    Effect.sync(() => {
      attempts.push(attempt.attemptId);
    }),
});

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, OwnershipFailure>;
}

const test = (name: string, body: () => Effect.Effect<void, OwnershipFailure>): Case => ({
  name,
  run: timed(Effect.suspend(body)),
});

export const providerOwnershipCases: ReadonlyArray<Case> = [
  test("one scoped session spans successive operations and closes once", () =>
    Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;
      const acquired = yield* BrowserbaseBrowser.acquire(policy);
      const session = yield* acquired.connect;
      const handle = yield* session.retain;

      yield* handle.navigate({ url: "https://example.test/next" });
      assert.equal((yield* handle.readText({})).text, "initial");
      assert.equal((yield* session.observe()).url, "https://example.test/next");
      const report = yield* session.close;

      assert.equal(report.remote, "confirmed");
      assert.equal(report.local, "closed");
      yield* session.close;
      // One allocation, one release request, and one connection closed by its owner.
      const sessions = yield* scripted.provider.sessions;
      const browser = yield* scriptedBrowser;

      assert.equal(sessions.length, 1);
      assert.equal(sessions[0]?.releaseRequests, 1);
      assert.deepEqual(yield* browser.connections, ["closed"]);
    }).pipe(Effect.scoped, Effect.provide(layer()))),
  test("failed connection retains exact identity and still releases", () =>
    Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;
      const acquired = yield* BrowserbaseBrowser.acquire(policy);

      assert.equal(acquired.reference.sessionId, "session-1");
      yield* expectReason(acquired.connect, "Provider");
      const browser = yield* scriptedBrowser;

      assert.equal((yield* scripted.provider.sessions)[0]?.releaseRequests, 1);
      assert.deepEqual(yield* browser.connections, ["refused"]);
      yield* expectReason(acquired.connect, "Closed");
      assert.deepEqual(yield* browser.connections, ["refused"]);
    }).pipe(
      Effect.scoped,
      Effect.provide(layer({ browser: { ...script, connections: ["refuse"] } })),
    )),
  test("lost create reply is not retried and reports an allocation nonce", () => {
    const uncertain: Array<string> = [];

    return Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;

      yield* expectUncertainAllocation(BrowserbaseBrowser.acquire(policy), "transport");
      // One creation request, and no release: there is no session identity to release.
      assert.deepEqual(
        (yield* scripted.provider.calls).map((call) => `${call.method} ${call.path}`),
        ["POST /v1/sessions"],
      );
      assert.equal(uncertain.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer({ provider: { create: { _tag: "Lost" } }, options: uncertainty(uncertain) }),
      ),
    );
  }),
  test("malformed allocation does not fabricate a session identity", () => {
    const uncertain: Array<string> = [];

    return Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;

      yield* expectUncertainAllocation(BrowserbaseBrowser.acquire(policy), "malformed");
      assert.deepEqual(yield* scripted.browsers, []);
      assert.deepEqual(
        (yield* scripted.provider.calls).map((call) => `${call.method} ${call.path}`),
        ["POST /v1/sessions"],
      );
      assert.equal(uncertain.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        layer({ provider: { create: { _tag: "Malformed" } }, options: uncertainty(uncertain) }),
      ),
    );
  }),
  test("pending release needs an exact-session terminal read", () =>
    Effect.gen(function* () {
      const { provider } = yield* Testing.ScriptedBrowserbase;
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      const closing = yield* session.close.pipe(Effect.forkChild);

      // The release request is accepted with the session still running; it ends afterwards.
      yield* eventually(provider.sessions.pipe(Effect.map(([row]) => row?.releaseRequests === 1)));
      yield* provider.setStatus("session-1", "COMPLETED");
      const report = yield* polled(closing);
      const calls = (yield* provider.calls).map((call) => `${call.method} ${call.path}`);
      const released = calls.indexOf("POST /v1/sessions/session-1");

      assert.equal(report.remote, "confirmed");
      assert.ok(released >= 0);
      assert.ok(calls.slice(released + 1).includes("GET /v1/sessions/session-1"));
      assert.equal((yield* provider.sessions)[0]?.releaseRequests, 1);
    }).pipe(Effect.scoped, Effect.provide(layer({ provider: { release: "pending" } })))),
  test("unconfirmed provider close still disconnects and reports", () => {
    const reports: Array<CleanupResult> = [];

    return Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      // The terminal-status read owns its own bounded budget after a rejected release.
      const report = yield* elapse(session.close, 12_000);
      const browser = yield* scriptedBrowser;

      assert.notEqual(report.remote, "confirmed");
      assert.equal(report.local, "closed");
      assert.deepEqual(yield* browser.connections, ["closed"]);
      assert.equal((yield* scripted.provider.sessions)[0]?.releaseRequests, 1);
      assert.equal(reports.length, 1);
    }).pipe(
      Effect.scoped,
      Effect.provide(layer({ provider: { release: "failed" }, options: reporting(reports) })),
    );
  }),
  test("a long execution budget still produces a valid provider wait", () =>
    Effect.gen(function* () {
      // The resource service accepts at most a ten-minute wait. A business budget above
      // that must bound the connect wait, not be passed through as invalid configuration.
      const long = BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 900_000 });
      const session = yield* (yield* BrowserbaseBrowser.acquire(long)).connect;

      assert.equal((yield* session.readText({})).text, "initial");
      assert.equal((yield* session.close).remote, "confirmed");
    }).pipe(
      Effect.scoped,
      Effect.provide(layer({ launch: recipe({ remoteTimeoutSeconds: 900 }) })),
    )),
  test("checked close rejects failed disconnection even when the provider confirms termination", () =>
    Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      const browser = yield* scriptedBrowser;

      yield* browser.next("disconnect", {
        _tag: "Fail",
        reason: Reasons.Provider.make({}),
        outcome: "unknown",
      });
      const outcome = yield* session.closeChecked.pipe(Effect.result);
      const report = yield* session.close;

      assert.equal(outcome._tag, "Failure");
      if (outcome._tag === "Failure") {
        assert.equal(outcome.failure.reason._tag, "Provider");
        assert.equal(outcome.failure.outcome, "unknown");
      }
      assert.equal(report.remote, "confirmed");
      assert.equal(report.local, "failed");
      assert.ok(report.issues.some((issue) => issue.step === "disconnect"));
      assert.deepEqual(yield* browser.connections, ["close-failed"]);
      assert.equal((yield* scripted.provider.sessions)[0]?.releaseRequests, 1);
    }).pipe(Effect.scoped, Effect.provide(layer()))),
  test("other-session metadata never proves attachment or termination", () =>
    Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;
      const acquired = yield* BrowserbaseBrowser.acquire(policy);

      // The endpoint belongs to the exact allocated session; a foreign identity is
      // refused before CDP attachment, and no read of it can confirm a release.
      const refused = yield* acquired.connect.pipe(Effect.result);

      assert.ok(refused._tag === "Failure" && refused.failure._tag === "BrowserError");
      assert.equal(refused.failure.operation, "connect");
      assert.equal(refused.failure.reason._tag, "Malformed");
      const report = yield* elapse(acquired.close, 12_000);

      assert.equal(report.remote, "unknown");
      assert.equal(report.local, "not-connected");
      assert.deepEqual(yield* scripted.browsers, []);
    }).pipe(Effect.scoped, Effect.provide(layer({ provider: { identity: "foreign-session" } })))),
  test("close wakes an in-flight native waiter and coalesces teardown", () =>
    Effect.gen(function* () {
      const scripted = yield* Testing.ScriptedBrowserbase;
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      const browser = yield* scriptedBrowser;
      const entered = yield* browser.gate;

      // Dispatched, and never acknowledged.
      yield* browser.next("click", { _tag: "Hold", gate: entered, dispatched: true });

      const fiber = yield* session
        .click({ selector: "#button" })
        .pipe(Effect.result, Effect.forkChild);

      yield* entered.reached;
      yield* Effect.all([session.close, session.close], { concurrency: 2 });
      const result = yield* Fiber.join(fiber);

      assert.equal(result._tag, "Failure");
      assert.equal((yield* scripted.provider.sessions)[0]?.releaseRequests, 1);
      assert.deepEqual(yield* browser.connections, ["closed"]);
    }).pipe(Effect.scoped, Effect.provide(layer()))),
  test("handoff pauses automation and fresh observation commits under one permit", () =>
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      const browser = yield* scriptedBrowser;
      const observed = yield* browser.gate;
      const old = yield* session.retain;
      const handoff = yield* session.beginHandoff(60);

      yield* browser.document.update({
        ...(yield* browser.document.current),
        text: "human changed this",
      });
      yield* browser.next("observe", { _tag: "Hold", gate: observed, dispatched: false });
      const resumed = yield* session.resume(handoff.token, true).pipe(Effect.forkChild);

      yield* observed.reached;
      yield* expectReason(session.click({ selector: "#button" }), "Busy");
      yield* observed.open;
      assert.equal((yield* Fiber.join(resumed)).text, "human changed this");
      yield* expectReason(old.readText({}), "Stale");
      assert.deepEqual(
        (yield* browser.calls).filter((call) => call.operation === "click"),
        [],
      );
    }).pipe(Effect.scoped, Effect.provide(layer()))),
  test("failed Live View acquisition does not automatically resume", () =>
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;

      yield* expectReason(session.beginHandoff(60), "Authorization");
      yield* expectReason(session.click({ selector: "#button" }), "Busy");
    }).pipe(Effect.scoped, Effect.provide(layer({ provider: { liveView: "denied" } })))),
  test("resume requires the operator acknowledgement and matching token", () =>
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      const handoff = yield* session.beginHandoff(60);

      yield* expectReason(session.resume(handoff.token, false), "Authorization");
      yield* expectReason(session.resume(Redacted.make("wrong"), true), "Authorization");
      yield* expectReason(session.click({ selector: "#button" }), "Busy");
    }).pipe(Effect.scoped, Effect.provide(layer()))),
  test("keep-alive reconnect establishes a new generation and observes actual state", () =>
    Effect.gen(function* () {
      const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;
      const browser = yield* scriptedBrowser;
      const old = yield* session.retain;

      yield* session.detach;
      yield* browser.document.update({
        ...(yield* browser.document.current),
        text: "changed while detached",
      });
      const fresh = yield* session.reconnect(true);

      assert.equal(fresh.text, "changed while detached");
      assert.deepEqual(yield* browser.connections, ["closed", "open"]);
      yield* expectReason(old.readText({}), "Stale");
    }).pipe(Effect.scoped, Effect.provide(layer({ launch: recipe({ keepAlive: true }) })))),
  test("a persistent writer settles with the exact attempt's provider cleanup facts", () =>
    Effect.gen(function* () {
      const settlements: WriterSettlementFacts[] = [];

      const backend = {
        acquire: () =>
          Effect.succeed({
            settle: (facts: WriterSettlementFacts) =>
              Effect.sync(() => {
                settlements.push(facts);
              }),
          }),
      };

      const reference = ContextReference.make({
        provider: "browserbase",
        projectId: "project-1",
        contextId: "context-1",
      });

      yield* withWriter(backend, reference, (permit) =>
        Effect.gen(function* () {
          const session = yield* (yield* BrowserbaseBrowser.acquire(policy)).connect;

          yield* session.close;
        }).pipe(
          Effect.scoped,
          Effect.provide(
            layer({
              launch: recipe({ context: { reference, persist: true } }),
              options: { contextWriter: permit },
            }),
          ),
        ),
      );

      assert.equal(settlements.length, 1);
      const facts = settlements[0]!;

      assert.equal(facts.attempts.length, 1);
      assert.equal(facts.attempts[0]!.state, "terminal");
      assert.equal(facts.attempts[0]!.cleanup?.remote, "confirmed");
    })),
];
