import assert from "node:assert/strict";

import { Deferred, Effect, Fiber, Layer, Redacted } from "effect";
import { TestClock } from "effect/testing";

import { BrowserbaseClient } from "../../src/Client.ts";
import { withWriter, type WriterSettlementFacts } from "../../src/ContextCoordination.ts";
import { AllocationError, BrowserError } from "../../src/Errors.ts";
import { acquireRemote } from "../../src/internal/session/Acquisition.ts";
import { makeCleanup, type LocalCleanup } from "../../src/internal/session/Cleanup.ts";
import type { LaunchRecipe } from "../../src/Launch.ts";
import { ContextReference, SessionReference } from "../../src/References.ts";
import { BrowserbaseSessions } from "../../src/Sessions.ts";

const recipe: LaunchRecipe = {
  remoteTimeoutSeconds: 60,
  keepAlive: true,
  viewport: { _tag: "ProviderManaged" },
  provider: { region: "us-east-1", browserSettings: { verified: true } },
};

const limits = { localStepMillis: 25, releaseMillis: 25, terminalMillis: 25 };
const account = { projectId: "allocation-project", apiKey: Redacted.make("allocation-test-key") };

const ref = SessionReference.make({
  provider: "browserbase",
  projectId: account.projectId,
  sessionId: "session-1",
});

const context = () =>
  ContextReference.make({
    provider: "browserbase",
    projectId: account.projectId,
    contextId: globalThis.crypto.randomUUID(),
  });

const metadata = (status = "RUNNING", projectId = account.projectId) => ({
  id: "session-1",
  projectId,
  status,
  createdAt: "2026-09-20T00:00:00Z",
  startedAt: "2026-09-20T00:00:00Z",
  updatedAt: "2026-09-20T00:00:00Z",
  expiresAt: "2026-09-20T00:01:00Z",
  keepAlive: true,
  proxyBytes: 0,
  region: "us-east-1",
  connectUrl: "wss://connect.browserbase.com/connect?sessionId=session-1",
});

const layers = BrowserbaseSessions.layer.pipe(Layer.provideMerge(BrowserbaseClient.layer(account)));

const fail = (operation: string) =>
  BrowserError.make({ operation, reason: "provider", outcome: "unknown" });

const expectFailure = <A, E, R>(value: Effect.Effect<A, E, R>) =>
  value.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") return result.failure;
      throw new Error("Expected failure");
    }),
  );

interface Scenario {
  readonly create?: (request: Request) => Promise<Response>;
  readonly release?: () => Promise<Response>;
  readonly retrieve?: () => Promise<Response>;
  readonly localFailure?: "fence" | "capture" | "initialization" | "disconnect";
}

const fixture = (scenario: Scenario = {}) => {
  const order: string[] = [];
  const bodies: unknown[] = [];
  let released = false;

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname;

    if (path === "/v1/sessions" && request.method === "POST") {
      order.push("allocate");
      bodies.push(await request.clone().json());

      return scenario.create === undefined ? Response.json(metadata()) : scenario.create(request);
    }
    if (path === "/v1/sessions/session-1" && request.method === "POST") {
      order.push("release");
      released = true;

      return scenario.release === undefined
        ? Response.json(metadata("RUNNING"))
        : scenario.release();
    }
    if (path === "/v1/sessions/session-1" && request.method === "GET") {
      order.push("status");

      return scenario.retrieve === undefined
        ? Response.json(metadata(released ? "COMPLETED" : "RUNNING"))
        : scenario.retrieve();
    }
    throw new Error(`Unexpected provider operation ${request.method} ${path}`);
  };

  const action = (step: NonNullable<Scenario["localFailure"]>) =>
    Effect.suspend(() => {
      order.push(step);

      return scenario.localFailure === step ? Effect.fail(fail(step)) : Effect.void;
    });

  const local: LocalCleanup = {
    fence: Effect.sync(() => {
      order.push("fence");
      if (scenario.localFailure === "fence") throw new Error("fence failpoint");
    }),
    capture: action("capture"),
    initialization: action("initialization"),
    disconnect: action("disconnect").pipe(Effect.as("closed" as const)),
  };

  const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
    program.pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, fetch));

  return { order, bodies, local, run };
};

import { FetchHttpClient } from "effect/unstable/http";

const testTime = <A, E, R>(program: Effect.Effect<A, E, R>) =>
  Effect.scoped(
    Effect.gen(function* () {
      const fiber = yield* program.pipe(Effect.forkChild);

      yield* TestClock.adjust(200);

      return yield* Fiber.join(fiber);
    }),
  ).pipe(Effect.provide(TestClock.layer()));

export const acquisitionCases = [
  {
    name: "allocation compiler and Context permit use the same exact attempt before POST",
    run: Effect.gen(function* () {
      const f = fixture(),
        contextRef = context(),
        facts: WriterSettlementFacts[] = [];

      const backend = {
        acquire: () =>
          Effect.sync(() => {
            f.order.push("lease");

            return {
              settle: (value: WriterSettlementFacts) =>
                Effect.sync(() => {
                  f.order.push("settle");
                  facts.push(value);
                }),
            };
          }),
      };

      const attempt = yield* f.run(
        withWriter(
          backend,
          contextRef,
          (permit) =>
            Effect.gen(function* () {
              const allocation = yield* acquireRemote(
                {
                  launch: { ...recipe, context: { reference: contextRef, persist: true } },
                  contextWriter: permit,
                },
                f.local,
              );

              return allocation.attempt;
            }),
          {
            verify: () =>
              Effect.sync(() => {
                f.order.push("readback");
              }),
          },
        ),
      );

      assert.deepEqual(f.order, [
        "lease",
        "allocate",
        "fence",
        "capture",
        "initialization",
        "disconnect",
        "release",
        "status",
        "readback",
        "settle",
      ]);
      assert.equal(facts.length, 1);
      assert.equal(facts[0].attempts[0].attempt, attempt);
      assert.equal(facts[0].attempts[0].session?.sessionId, "session-1");
      assert.equal(facts[0].attempts[0].cleanup?.observedStatus, "COMPLETED");
      assert.equal(facts[0].disposition, "release");
      assert.equal(facts[0].persistence._tag, "Observed");
      assert.deepEqual(f.bodies[0], {
        projectId: account.projectId,
        timeout: 60,
        keepAlive: true,
        region: "us-east-1",
        proxies: false,
        browserSettings: {
          verified: true,
          recordSession: false,
          logSession: false,
          solveCaptchas: false,
          context: { id: contextRef.contextId, persist: true },
        },
        userMetadata: { browserbaseIntegrationAttempt: attempt.attemptId },
      });
    }),
  },
  ...[401, 429].map((status) => ({
    name: `known ${status} allocation rejection stays rejected and is not retried`,
    run: Effect.gen(function* () {
      const f = fixture({
        create: async () =>
          Response.json(
            { error: "private upstream message" },
            { status, headers: { "retry-after": "2" } },
          ),
      });

      const result = yield* f.run(
        Effect.scoped(expectFailure(acquireRemote({ launch: recipe }, f.local))),
      );

      assert.ok(result instanceof AllocationError);
      if (result instanceof AllocationError) {
        assert.equal(result.outcome, "rejected");
        assert.equal(result.status, status);
        assert.equal(result.retryAfterMillis, 2000);
        assert.equal(result.reason, status === 401 ? "authorization" : "rate-limited");
        assert.equal(JSON.stringify(result).includes("private upstream"), false);
      }
      assert.deepEqual(f.order, ["allocate"]);
    }),
  })),
  {
    name: "lost allocation response quarantines its exact writer attempt without a fabricated session",
    run: Effect.gen(function* () {
      const f = fixture({
          create: async () => {
            throw new Error("network reply lost");
          },
        }),
        facts: WriterSettlementFacts[] = [];

      yield* f.run(
        withWriter(
          {
            acquire: () =>
              Effect.succeed({
                settle: (value: WriterSettlementFacts) =>
                  Effect.sync(() => {
                    facts.push(value);
                  }),
              }),
          },
          context(),
          (permit) =>
            expectFailure(
              acquireRemote(
                {
                  launch: { ...recipe, context: { reference: permit.reference, persist: true } },
                  contextWriter: permit,
                },
                f.local,
              ),
            ),
        ),
      );
      assert.deepEqual(f.order, ["allocate"]);
      assert.equal(facts[0].attempts[0].state, "unknown");
      assert.equal(facts[0].attempts[0].session, undefined);
      assert.equal(facts[0].disposition, "quarantine");
    }),
  },
  {
    name: "malformed connection credentials do not lose a known allocation or suppress release",
    run: Effect.gen(function* () {
      let reads = 0;

      const f = fixture({
        retrieve: async () =>
          Response.json({
            ...metadata(++reads >= 3 ? "COMPLETED" : "RUNNING"),
            connectUrl: "ws://localhost:9222",
          }),
      });

      const value = yield* f.run(
        Effect.scoped(
          Effect.gen(function* () {
            const allocation = yield* acquireRemote({ launch: recipe }, f.local, limits);
            const error = yield* expectFailure(allocation.connection(1000));

            assert.equal(error.reason, "unsafe-url");
            const result = yield* allocation.release;

            assert.equal(result.reference.sessionId, "session-1");

            return result;
          }),
        ),
      );

      assert.equal(value.releaseRequested, true);
    }),
  },
  ...(["fence", "capture", "initialization", "disconnect"] as const).map((localFailure) => ({
    name: `${localFailure} failure cannot suppress later cleanup steps`,
    run: Effect.gen(function* () {
      const f = fixture({ localFailure });

      const result = yield* f.run(
        Effect.scoped(
          Effect.gen(function* () {
            const allocation = yield* acquireRemote({ launch: recipe }, f.local);

            return yield* allocation.release;
          }),
        ),
      );

      assert.deepEqual(f.order, [
        "allocate",
        "fence",
        "capture",
        "initialization",
        "disconnect",
        "release",
        "status",
      ]);
      assert.deepEqual(
        result.issues.map((issue) => issue.step),
        [localFailure],
      );
      assert.equal(result.remote, "confirmed");
      assert.equal(result.local, localFailure === "disconnect" ? "failed" : "closed");
    }),
  })),
  {
    name: "a rejected release request still permits an independent exact-session terminal read",
    run: Effect.gen(function* () {
      const f = fixture({ release: async () => Response.json({}, { status: 403 }) });

      const result = yield* f.run(
        Effect.scoped(
          Effect.gen(function* () {
            const allocation = yield* acquireRemote({ launch: recipe }, f.local);

            return yield* allocation.release;
          }),
        ),
      );

      assert.equal(result.releaseRequested, false);
      assert.equal(result.remote, "confirmed");
      assert.deepEqual(
        result.issues.map((issue) => issue.step),
        ["release"],
      );
      assert.equal(f.order.at(-1), "status");
    }),
  },
  {
    name: "concurrent explicit and scope release callers share one immutable cleanup result",
    run: Effect.scoped(
      Effect.gen(function* () {
        const f = fixture(),
          entered = yield* Deferred.make<void>(),
          done = yield* Deferred.make<void>();

        yield* f.run(
          Effect.gen(function* () {
            const local = {
              ...f.local,
              capture: f.local.capture.pipe(
                Effect.andThen(Deferred.succeed(entered, undefined)),
                Effect.andThen(Deferred.await(done)),
              ),
            };

            const allocation = yield* acquireRemote({ launch: recipe }, local);
            const first = yield* allocation.release.pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            const second = yield* allocation.release.pipe(Effect.forkChild);

            yield* Deferred.succeed(done, undefined);

            const a = yield* Fiber.join(first),
              b = yield* Fiber.join(second);

            assert.equal(a, b);
            assert.equal(Object.isFrozen(a), true);
            assert.equal(yield* allocation.release, a);
          }),
        );
        assert.equal(f.order.filter((value) => value === "release").length, 1);
        assert.equal(f.order.filter((value) => value === "disconnect").length, 1);
      }),
    ),
  },
  {
    name: "a borrowed connection's cleanup never reads or releases the remote resource",
    run: Effect.gen(function* () {
      const f = fixture();

      const result = yield* f.run(
        Effect.gen(function* () {
          const coordinator = yield* makeCleanup(
            ref,
            "borrowed",
            yield* BrowserbaseSessions,
            f.local,
            () => {},
          );

          return yield* coordinator.close;
        }),
      );

      assert.equal(result.remote, "not-owned");
      assert.equal(result.releaseRequested, false);
      assert.deepEqual(f.order, ["fence", "capture", "initialization", "disconnect"]);
    }),
  },
  {
    name: "missing writer authority and invalid launch settings fail before allocation",
    run: Effect.gen(function* () {
      const f = fixture();

      yield* f.run(
        Effect.scoped(
          Effect.gen(function* () {
            const error = yield* expectFailure(
              acquireRemote({
                launch: { ...recipe, context: { reference: context(), persist: true } },
              }),
            );

            assert.equal(error.reason, "authorization");

            const invalid = yield* expectFailure(
              acquireRemote({
                launch: { ...recipe, viewport: { _tag: "Fixed", width: 800, height: 600 } },
              }),
            );

            assert.equal(invalid.reason, "configuration");
          }),
        ),
      );
      assert.equal(f.order.length, 0);
    }),
  },
  {
    name: "interruption during POST settles an unknown exact attempt, without replay",
    run: Effect.scoped(
      Effect.gen(function* () {
        let signalEntered: () => void = () => {};

        const entered = new Promise<void>((resolve) => {
          signalEntered = resolve;
        });

        const facts: WriterSettlementFacts[] = [];

        const f = fixture({
          create: async (request) => {
            signalEntered();

            return new Promise<Response>((_resolve, reject) => {
              request.signal.addEventListener(
                "abort",
                () => reject(new Error("create interrupted")),
                { once: true },
              );
            });
          },
        });

        const running = f.run(
          withWriter(
            {
              acquire: () =>
                Effect.succeed({
                  settle: (value: WriterSettlementFacts) =>
                    Effect.sync(() => {
                      facts.push(value);
                    }),
                }),
            },
            context(),
            (permit) =>
              acquireRemote(
                {
                  launch: { ...recipe, context: { reference: permit.reference, persist: true } },
                  contextWriter: permit,
                },
                f.local,
              ),
          ),
        );

        const fiber = yield* running.pipe(Effect.forkChild);

        yield* Effect.promise(() => entered);
        yield* Fiber.interrupt(fiber);
        assert.deepEqual(f.order, ["allocate"]);
        assert.equal(facts.length, 1);
        assert.equal(facts[0].attempts[0].state, "unknown");
        assert.equal(facts[0].attempts[0].session, undefined);
        assert.equal(facts[0].disposition, "quarantine");
      }),
    ),
  },
  {
    name: "a foreign-project create reply cannot authorize destructive cleanup",
    run: Effect.gen(function* () {
      const f = fixture({
        create: async () => Response.json(metadata("RUNNING", "foreign-project")),
      });

      const error = yield* f.run(
        Effect.scoped(expectFailure(acquireRemote({ launch: recipe }, f.local))),
      );

      assert.ok(error instanceof AllocationError);
      if (error instanceof AllocationError) {
        assert.equal(error.outcome, "unknown");
        assert.equal(error.reference?.projectId, "foreign-project");
      }
      assert.equal(f.order.includes("release"), false);
      assert.equal(f.order.includes("status"), false);
      assert.equal(f.order.includes("disconnect"), true);
    }),
  },
  {
    name: "failed terminal inspection remains pending instead of trusting the release POST",
    run: Effect.gen(function* () {
      const f = fixture({ retrieve: async () => Response.json({}, { status: 403 }) });

      const result = yield* f.run(
        Effect.scoped(
          Effect.gen(function* () {
            const allocation = yield* acquireRemote({ launch: recipe }, f.local);

            return yield* allocation.release;
          }),
        ),
      );

      assert.equal(result.remote, "pending");
      assert.equal(result.releaseRequested, true);
      assert.equal(result.observedStatus, undefined);
      assert.deepEqual(
        result.issues.map((issue) => issue.step),
        ["status"],
      );
    }),
  },
  ...(["capture", "initialization", "disconnect"] as const).map((hung) => ({
    name: `${hung} deadline records timeout and still requests remote release`,
    run: testTime(
      Effect.gen(function* () {
        const f = fixture();
        const local = { ...f.local, [hung]: Effect.never };

        const result = yield* f.run(
          Effect.scoped(
            Effect.gen(function* () {
              const allocation = yield* acquireRemote({ launch: recipe }, local, limits);

              return yield* allocation.release;
            }),
          ),
        );

        assert.equal(result.remote, "confirmed");
        assert.deepEqual(
          result.issues.map((issue) => [issue.step, issue.reason]),
          [[hung, "timeout"]],
        );
        assert.equal(f.order.includes("release"), true);
      }),
    ),
  })),
  {
    name: "interrupting one close caller does not abandon remote release or duplicate it",
    run: Effect.scoped(
      Effect.gen(function* () {
        const f = fixture(),
          entered = yield* Deferred.make<void>(),
          done = yield* Deferred.make<void>();

        yield* f.run(
          Effect.gen(function* () {
            const local = {
              ...f.local,
              capture: Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(done)),
              ),
            };

            const allocation = yield* acquireRemote({ launch: recipe }, local);
            const closing = yield* allocation.release.pipe(Effect.forkChild);

            yield* Deferred.await(entered);
            const interruption = yield* Fiber.interrupt(closing).pipe(Effect.forkChild);

            yield* Deferred.succeed(done, undefined);
            yield* Fiber.join(interruption);
            const result = yield* allocation.release;

            assert.equal(result.remote, "confirmed");
          }),
        );
        assert.equal(f.order.filter((item) => item === "release").length, 1);
      }),
    ),
  },
];
