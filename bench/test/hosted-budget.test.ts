import { assert, describe, it } from "@effect/vitest";
import { Clock, Deferred, Effect, Exit, Fiber, Redacted, Ref, Scheduler } from "effect";
import * as BrowserbaseClient from "effect-browserbase/BrowserbaseClient";
import { HttpClient, HttpClientResponse } from "effect/http";
import { TestClock } from "effect/testing";

import * as Hosted from "../HostedBudget.ts";

type Operation = "create" | "release" | "get";
interface Plan {
  readonly failure?: Operation;
  readonly getStatus?: number;
  readonly statuses?: ReadonlyArray<string>;
  readonly returnedId?: string;
  readonly beforeGet?: (attempt: number) => Effect.Effect<void>;
  readonly endpoint?: boolean;
}

const transport = Effect.fnUntraced(function* (plan: Plan = {}) {
  const calls = yield* Ref.make<ReadonlyArray<Operation>>([]);

  const session = {
    id: "private-session-canary",
    status: "RUNNING",
    region: "test",
    keepAlive: false,
    createdAt: "",
    expiresAt: "",
    ...(plan.endpoint === false ? {} : { connectUrl: "wss://private-endpoint.invalid" }),
  };

  const http = HttpClient.make((request) =>
    Effect.gen(function* () {
      const operation: Operation =
        request.method === "GET"
          ? "get"
          : request.url.endsWith("/v1/sessions")
            ? "create"
            : "release";

      const previous = yield* Ref.getAndUpdate(calls, (values) => [...values, operation]);
      const attempt = previous.filter((value) => value === "get").length;

      if (operation === "get") yield* plan.beforeGet?.(attempt) ?? Effect.void;

      return HttpClientResponse.fromWeb(
        request,
        new Response(
          JSON.stringify(
            operation === "create"
              ? session
              : operation === "release"
                ? { status: "RUNNING" }
                : {
                    ...session,
                    id: plan.returnedId ?? session.id,
                    status: plan.statuses?.[attempt] ?? plan.statuses?.at(-1) ?? "COMPLETED",
                  },
          ),
          {
            status:
              plan.failure === operation
                ? 502
                : operation === "get"
                  ? (plan.getStatus ?? 200)
                  : 200,
            headers: { "content-type": "application/json" },
          },
        ),
      );
    }),
  );

  const client = yield* BrowserbaseClient.make({
    apiKey: Redacted.make("private-key-canary"),
  }).pipe(Effect.provideService(HttpClient.HttpClient, http));

  return { client, calls };
});

describe("hosted lifetime admission", () => {
  for (const status of ["COMPLETED", "ERROR", "TIMED_OUT"]) {
    it.effect(
      "confirms " + status + " on the owned session and retains aggregate evidence only",
      () =>
        Effect.gen(function* () {
          const { client, calls } = yield* transport({ statuses: [status] });
          const budget = yield* Hosted.make(600);

          yield* budget.open(client).pipe(Effect.scoped);
          const state = yield* budget.snapshot;

          assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
          assert.deepStrictEqual(state, {
            creates: 1,
            allocated: 1,
            releasesRequested: 1,
            releasesAcknowledged: 1,
            terminalConfirmed: 1,
            knownSeconds: 0,
            reservedSeconds: 0,
            uncertainSessions: 0,
            stopped: false,
          });
          assert.notInclude(JSON.stringify(state), "private");
        }),
    );
  }

  it.effect(
    "holds the full reservation after release acknowledgment until terminal confirmation",
    () =>
      Effect.gen(function* () {
        const firstRead = yield* Deferred.make<void>();

        const { client, calls } = yield* transport({
          statuses: ["RUNNING", "COMPLETED"],
          beforeGet: () => Deferred.succeed(firstRead, undefined).pipe(Effect.asVoid),
        });

        const budget = yield* Hosted.make(601);
        const owner = yield* budget.open(client).pipe(Effect.scoped, Effect.forkChild);

        yield* Deferred.await(firstRead);
        const pending = yield* budget.snapshot;

        assert.strictEqual(pending.releasesAcknowledged, 1);
        assert.strictEqual(pending.terminalConfirmed, 0);
        assert.strictEqual(pending.reservedSeconds, 600);
        assert.strictEqual(pending.knownSeconds, 0);
        const waiting = yield* budget.open(client).pipe(Effect.scoped, Effect.forkChild);

        yield* Effect.yieldNow;
        assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
        yield* TestClock.adjust("1 second");
        yield* Fiber.join(owner);
        yield* Fiber.join(waiting);
        const settled = yield* budget.snapshot;

        assert.strictEqual(settled.creates, 2);
        assert.strictEqual(settled.terminalConfirmed, 2);
        assert.strictEqual(settled.knownSeconds, 1);
        assert.strictEqual(settled.reservedSeconds, 0);
        assert.isFalse(settled.stopped);
      }),
  );

  it.effect("stops after ten nonterminal reads without returning reserved capacity", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport({ statuses: ["RUNNING"] });
      const budget = yield* Hosted.make(1200);
      const owner = yield* budget.open(client).pipe(Effect.scoped, Effect.forkChild);

      yield* TestClock.adjust("10 seconds");
      yield* Fiber.join(owner);
      const state = yield* budget.snapshot;
      const requests = yield* Ref.get(calls);

      assert.strictEqual(requests.filter((operation) => operation === "get").length, 10);
      assert.strictEqual(requests.filter((operation) => operation === "release").length, 1);
      assert.strictEqual(state.releasesAcknowledged, 1);
      assert.strictEqual(state.terminalConfirmed, 0);
      assert.strictEqual(state.reservedSeconds, 600);
      assert.strictEqual(state.uncertainSessions, 1);
      assert.isTrue(state.stopped);
      yield* budget.open(client).pipe(Effect.scoped, Effect.flip);
      assert.deepStrictEqual(yield* Ref.get(calls), requests);
    }),
  );

  it.effect(
    "resolves a lost release acknowledgment with a terminal read without repeating the write",
    () =>
      Effect.gen(function* () {
        const { client, calls } = yield* transport({ failure: "release" });
        const budget = yield* Hosted.make(600);

        yield* budget.open(client).pipe(Effect.scoped);
        const state = yield* budget.snapshot;

        assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
        assert.strictEqual(state.releasesAcknowledged, 0);
        assert.strictEqual(state.terminalConfirmed, 1);
        assert.strictEqual(state.reservedSeconds, 0);
        assert.strictEqual(state.uncertainSessions, 0);
        assert.isFalse(state.stopped);
      }),
  );

  it.effect("retains the full reservation when creation has no usable receipt", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport({ failure: "create" });
      const budget = yield* Hosted.make(1200);
      const error = yield* budget.open(client).pipe(Effect.scoped, Effect.flip);
      const state = yield* budget.snapshot;

      assert.strictEqual(error.code, "Create");
      assert.deepStrictEqual(yield* Ref.get(calls), ["create"]);
      assert.strictEqual(state.allocated, 0);
      assert.strictEqual(state.terminalConfirmed, 0);
      assert.strictEqual(state.reservedSeconds, 600);
      assert.strictEqual(state.uncertainSessions, 1);
      assert.isTrue(state.stopped);
    }),
  );

  it.effect("refuses a terminal response for another session", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport({ returnedId: "private-other-session" });
      const budget = yield* Hosted.make(600);

      yield* budget.open(client).pipe(Effect.scoped);
      const state = yield* budget.snapshot;

      assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
      assert.strictEqual(state.terminalConfirmed, 0);
      assert.strictEqual(state.reservedSeconds, 600);
      assert.strictEqual(state.uncertainSessions, 1);
      assert.isTrue(state.stopped);
      assert.notInclude(JSON.stringify(state), "private");
    }),
  );

  it.effect("allows the real client's bounded read retries without repeating release", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport({ failure: "get" });
      const budget = yield* Hosted.make(600);
      const owner = yield* budget.open(client).pipe(Effect.scoped, Effect.forkChild);

      yield* TestClock.adjust("5 seconds");
      yield* Fiber.join(owner);
      const state = yield* budget.snapshot;

      assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get", "get", "get"]);
      assert.strictEqual(state.releasesAcknowledged, 1);
      assert.strictEqual(state.terminalConfirmed, 0);
      assert.strictEqual(state.reservedSeconds, 600);
      assert.isTrue(state.stopped);
    }),
  );

  it.effect("bounds a stalled read to five seconds and preserves its reservation", () =>
    Effect.gen(function* () {
      const interrupted = yield* Ref.make(false);

      const { client, calls } = yield* transport({
        beforeGet: () => Effect.never.pipe(Effect.onInterrupt(() => Ref.set(interrupted, true))),
      });

      const budget = yield* Hosted.make(600);

      const owner = yield* budget
        .open(client)
        .pipe(Effect.scoped, Effect.andThen(Clock.monotonicTimeNanos), Effect.forkChild);

      yield* TestClock.adjust("6 seconds");
      const ended = yield* Fiber.join(owner);

      assert.strictEqual(ended, 5_000_000_000n);
      assert.isTrue(yield* Ref.get(interrupted));
      assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
      assert.strictEqual((yield* budget.snapshot).reservedSeconds, 600);
      assert.isTrue((yield* budget.snapshot).stopped);
    }),
  );

  it.effect("bounds the entire confirmation phase even when each individual read finishes", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport({
        statuses: ["RUNNING"],
        beforeGet: () => Effect.sleep("4 seconds"),
      });

      const budget = yield* Hosted.make(600);

      const owner = yield* budget
        .open(client)
        .pipe(Effect.scoped, Effect.andThen(Clock.monotonicTimeNanos), Effect.forkChild);

      yield* TestClock.adjust("31 seconds");
      const ended = yield* Fiber.join(owner);
      const requests = yield* Ref.get(calls);

      assert.strictEqual(ended, 30_000_000_000n);
      assert.isAtMost(requests.filter((operation) => operation === "get").length, 10);
      assert.strictEqual(requests.filter((operation) => operation === "release").length, 1);
      assert.strictEqual((yield* budget.snapshot).reservedSeconds, 600);
      assert.isTrue((yield* budget.snapshot).stopped);
    }),
  );

  it.effect(
    "releases a created session with no connection endpoint before reporting setup failure",
    () =>
      Effect.gen(function* () {
        const { client, calls } = yield* transport({ endpoint: false });
        const budget = yield* Hosted.make(600);
        const error = yield* budget.open(client).pipe(Effect.scoped, Effect.flip);

        assert.strictEqual(error.code, "MissingEndpoint");
        assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
        assert.strictEqual((yield* budget.snapshot).terminalConfirmed, 1);
        assert.strictEqual((yield* budget.snapshot).reservedSeconds, 0);
      }),
  );

  it.effect("cancels a queued owner without borrowing the active session's reservation", () =>
    Effect.gen(function* () {
      const reading = yield* Deferred.make<void>();
      const terminal = yield* Deferred.make<void>();

      const { client, calls } = yield* transport({
        beforeGet: () =>
          Deferred.succeed(reading, undefined).pipe(Effect.andThen(Deferred.await(terminal))),
      });

      const budget = yield* Hosted.make(600);
      const owner = yield* budget.open(client).pipe(Effect.scoped, Effect.forkChild);

      yield* Deferred.await(reading);
      const waiting = yield* budget.open(client).pipe(Effect.scoped, Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(waiting);
      assert.deepStrictEqual(yield* Ref.get(calls), ["create", "release", "get"]);
      assert.strictEqual((yield* budget.snapshot).reservedSeconds, 600);
      yield* Deferred.succeed(terminal, undefined);
      yield* Fiber.join(owner);
      assert.strictEqual((yield* budget.snapshot).reservedSeconds, 0);
      assert.strictEqual((yield* budget.snapshot).terminalConfirmed, 1);
    }),
  );

  it.effect("returns unused capacity when interrupted exactly after admission", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport();
      const budget = yield* Hosted.make(600);
      const base = yield* Scheduler.Scheduler;
      const observe = Effect.runSyncWith(yield* Effect.context<never>());
      let interrupted = false;

      // The scheduler observes the actual Ref transition between Effect operations. This
      // makes the pending interrupt deterministic without replacing admission or ownership.
      const scheduler: Scheduler.Scheduler = {
        executionMode: base.executionMode,
        makeDispatcher: () => base.makeDispatcher(),
        shouldYield: (fiber) => {
          const state = observe(budget.snapshot);

          if (!interrupted && state.reservedSeconds === 600 && state.creates === 0) {
            interrupted = true;
            fiber.interruptUnsafe();
          }

          return base.shouldYield(fiber);
        },
      };

      const owner = yield* budget
        .open(client)
        .pipe(
          Effect.scoped,
          Effect.provideService(Scheduler.Scheduler, scheduler),
          Effect.forkChild,
        );

      const exit = yield* Fiber.await(owner);

      assert.isTrue(interrupted);
      assert.isTrue(Exit.isFailure(exit));
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      assert.strictEqual((yield* budget.snapshot).reservedSeconds, 0);
      assert.strictEqual((yield* budget.snapshot).uncertainSessions, 0);
      assert.isFalse((yield* budget.snapshot).stopped);
      yield* budget.open(client).pipe(Effect.scoped);
      assert.strictEqual((yield* budget.snapshot).terminalConfirmed, 1);
    }),
  );

  it.effect("does not allocate when stopped before admission", () =>
    Effect.gen(function* () {
      const { client, calls } = yield* transport();
      const budget = yield* Hosted.make(600);

      yield* budget.stop;
      const error = yield* budget.open(client).pipe(Effect.scoped, Effect.flip);

      assert.strictEqual(error.code, "Limit");
      assert.deepStrictEqual(yield* Ref.get(calls), []);
      assert.strictEqual((yield* budget.snapshot).reservedSeconds, 0);
    }),
  );
});
