import assert from "node:assert/strict";

import { NodeCrypto } from "@effect/platform-node";
import { Context, Deferred, Effect, Fiber, Layer, Redacted, Schema, type Scope } from "effect";
import type { BrowserError } from "effect-browser/errors";
import { TestClock } from "effect/testing";
import { FetchHttpClient } from "effect/unstable/http";

import { layer as accountLayer } from "../../src/Account.ts";
import * as Allocation from "../../src/Allocation.ts";
import { CleanupResult } from "../../src/Cleanup.ts";
import {
  type ContextWriterPermit,
  reconcile,
  withWriter,
  type WriterSettlementFacts,
} from "../../src/ContextCoordination.ts";
import type { AllocationError, ClientError, ContextError, SessionError } from "../../src/Errors.ts";
import { requireContextWriterPermit } from "../../src/internal/session/ContextWriter.ts";
import { recipe } from "../../src/Launch.ts";
import { AllocationAttempt, ContextReference, SessionReference } from "../../src/References.ts";
import * as Testing from "../../src/Testing.ts";

const reference = () =>
  ContextReference.make({
    provider: "browserbase",
    projectId: "project",
    contextId: globalThis.crypto.randomUUID(),
  });

const attempt = () =>
  AllocationAttempt.make({
    projectId: "project",
    attemptId: globalThis.crypto.randomUUID(),
    requestedAtMillis: 1,
    timeoutSeconds: 60,
  });

const session = () =>
  SessionReference.make({
    provider: "browserbase",
    projectId: "project",
    sessionId: globalThis.crypto.randomUUID(),
  });

const cleanup = (reference: SessionReference, status: "COMPLETED" | "ERROR" = "COMPLETED") =>
  CleanupResult.make({
    reference,
    ownership: "owned",
    local: "closed",
    releaseRequested: true,
    remote: "confirmed",
    observedStatus: status,
    issues: [],
  });

const backend = (settlements: WriterSettlementFacts[]) => ({
  acquire: () =>
    Effect.succeed({
      settle: (facts: WriterSettlementFacts) =>
        Effect.sync(() => {
          settlements.push(facts);
        }),
    }),
});

const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") return result.failure;
      throw new Error("Expected a failure");
    }),
  );

class ApplicationFailure extends Schema.TaggedError<ApplicationFailure>()(
  "WriterApplicationFailure",
  { code: Schema.String },
) {}
class ApplicationService extends Context.Service<
  ApplicationService,
  { readonly read: Effect.Effect<number, ApplicationFailure> }
>()("writer-test/ApplicationService") {}
class ReadbackFailed extends Schema.TaggedError<ReadbackFailed>()("WriterReadbackFailed", {}) {}

type Failure = ContextError | ClientError | AllocationError | SessionError | BrowserError;

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, Failure>;
}

const test = (name: string, run: Effect.Effect<void, Failure, Scope.Scope>): Case => ({
  name,
  run: Effect.scoped(run),
});

/**
 * The real account services and allocation path over the scripted control plane, with one
 * Context to write. `write` allocates one persisting session under the permit and releases it.
 */
const scriptedWriter = (script: Testing.ProviderScript = {}) =>
  Effect.gen(function* () {
    const { fetch, control } = yield* Testing.provider(script);

    const services = Layer.merge(
      accountLayer({
        projectId: control.projectId,
        apiKey: Redacted.make(control.secrets.apiKey),
      }).pipe(Layer.provide(Layer.succeed(FetchHttpClient.Fetch, fetch))),
      NodeCrypto.layer,
    );

    const context = ContextReference.make({
      provider: "browserbase",
      projectId: control.projectId,
      contextId: globalThis.crypto.randomUUID(),
    });

    const write = (permit: ContextWriterPermit) =>
      Effect.scoped(
        Allocation.scoped(recipe({ context: { reference: context, persist: true } }), {
          contextWriter: permit,
        }),
      );

    const run = <A, E, R>(program: Effect.Effect<A, E, R>) =>
      program.pipe(Effect.provide(services));

    return { control, context, write, run };
  });

/** Counts the backend's acquisitions, so a local refusal is told apart from the backend's. */
const counted = () => {
  const settlements: WriterSettlementFacts[] = [];
  let acquired = 0;

  return {
    settlements,
    acquired: () => acquired,
    backend: {
      acquire: () =>
        Effect.sync(() => {
          acquired++;

          return {
            settle: (facts: WriterSettlementFacts) =>
              Effect.sync(() => {
                settlements.push(facts);
              }),
          };
        }),
    },
  };
};

/** Cleanup waits on the Effect clock for a terminal read; advance it until the program ends. */
const polled = <A, E>(program: Effect.Effect<A, E>) =>
  Effect.gen(function* () {
    const fiber = yield* program.pipe(Effect.forkChild);

    for (let poll = 0; poll < 64 && fiber.pollUnsafe() === undefined; poll++)
      yield* TestClock.adjust(250);

    return yield* Fiber.join(fiber);
  });

export const writerCases: ReadonlyArray<Case> = [
  test(
    "unused writer lease settles once with no allocation",
    Effect.gen(function* () {
      const facts: WriterSettlementFacts[] = [];

      assert.equal(yield* withWriter(backend(facts), reference(), () => Effect.succeed(42)), 42);
      assert.equal(facts.length, 1);
      assert.equal(facts[0]!.disposition, "release");
      assert.equal(facts[0]!.attempts.length, 0);
    }),
  ),
  test(
    "one writer permit refuses overlapping allocation attempts",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [];

      yield* withWriter(backend(facts), ref, (publicPermit) =>
        Effect.gen(function* () {
          const permit = yield* requireContextWriterPermit(publicPermit, ref);

          yield* permit.recordAttempt(attempt());
          assert.equal((yield* expectFailure(permit.recordAttempt(attempt()))).reason, "active");
        }),
      );
      assert.equal(facts[0]!.attempts.length, 1);
      assert.equal(facts[0]!.disposition, "quarantine");
    }),
  ),
  test(
    "spreading a writer permit does not copy allocation authority",
    Effect.gen(function* () {
      const ref = reference();

      yield* withWriter(backend([]), ref, (permit) =>
        Effect.gen(function* () {
          const error = yield* expectFailure(requireContextWriterPermit({ ...permit }, ref));

          assert.equal(error.reason, "authorization");
        }),
      );
    }),
  ),
  test(
    "a writer permit cannot authorize another Context",
    Effect.gen(function* () {
      const ref = reference();

      yield* withWriter(backend([]), ref, (permit) =>
        Effect.gen(function* () {
          assert.equal(
            (yield* expectFailure(requireContextWriterPermit(permit, reference()))).reason,
            "authorization",
          );
        }),
      );
    }),
  ),
  test(
    "terminal cleanup remains tied to its exact attempt and session",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [],
        request = attempt(),
        allocated = session();

      yield* withWriter(backend(facts), ref, (value) =>
        Effect.gen(function* () {
          const permit = yield* requireContextWriterPermit(value, ref);

          yield* permit.recordAttempt(request);
          permit.recordSession(request, allocated);
          permit.completed(request, cleanup(session()));
        }),
      );
      assert.equal(facts[0]!.attempts[0]!.session?.sessionId, allocated.sessionId);
      assert.equal(facts[0]!.disposition, "quarantine");
      assert.notEqual(facts[0]!.attempts[0]!.state, "terminal");
    }),
  ),
  test(
    "COMPLETED does not manufacture a Context flush receipt",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [],
        request = attempt(),
        allocated = session();

      yield* withWriter(backend(facts), ref, (value) =>
        Effect.gen(function* () {
          const permit = yield* requireContextWriterPermit(value, ref);

          yield* permit.recordAttempt(request);
          permit.recordSession(request, allocated);
          permit.completed(request, cleanup(allocated));
          assert.equal((yield* expectFailure(permit.recordAttempt(attempt()))).reason, "active");
        }),
      );
      assert.equal(facts[0]!.attempts[0]!.state, "terminal");
      assert.deepEqual(facts[0]!.persistence, {
        _tag: "Unconfirmed",
        reason: "flush-unacknowledged",
      });
      assert.equal(facts[0]!.disposition, "quarantine");
    }),
  ),
  test(
    "explicit consumer readback follows cleanup before releasing the writer",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [],
        request = attempt(),
        allocated = session(),
        order: string[] = [];

      yield* withWriter(
        backend(facts),
        ref,
        (value) =>
          Effect.gen(function* () {
            const permit = yield* requireContextWriterPermit(value, ref);

            yield* permit.recordAttempt(request);
            permit.recordSession(request, allocated);
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                order.push("cleanup");
                permit.completed(request, cleanup(allocated));
              }),
            );

            return 7;
          }),
        {
          verify: (value) =>
            Effect.sync(() => {
              assert.equal(value, 7);
              order.push("readback");
            }),
        },
      );
      assert.deepEqual(order, ["cleanup", "readback"]);
      assert.equal(facts[0]!.persistence._tag, "Observed");
      assert.equal(facts[0]!.disposition, "release");
    }),
  ),
  test(
    "known allocation rejection records no session and permits explicit next attempt",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [],
        request = attempt();

      yield* withWriter(backend(facts), ref, (value) =>
        Effect.gen(function* () {
          const permit = yield* requireContextWriterPermit(value, ref);

          yield* permit.recordAttempt(request);
          permit.rejected(request);
          const next = attempt();

          yield* permit.recordAttempt(next);
          permit.rejected(next);
        }),
      );
      assert.equal(facts[0]!.attempts.length, 2);
      assert.ok(
        facts[0]!.attempts.every(
          (value) => value.state === "rejected" && value.session === undefined,
        ),
      );
      assert.equal(facts[0]!.disposition, "release");
    }),
  ),
  test(
    "abnormal termination remains quarantined after a verification callback",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [],
        request = attempt(),
        allocated = session();

      const failure = yield* expectFailure(
        withWriter(
          backend(facts),
          ref,
          (value) =>
            Effect.gen(function* () {
              const permit = yield* requireContextWriterPermit(value, ref);

              yield* permit.recordAttempt(request);
              permit.recordSession(request, allocated);
              permit.completed(request, cleanup(allocated, "ERROR"));
            }),
          { verify: () => Effect.void },
        ),
      );

      assert.equal(failure.reason, "active");
      assert.equal(facts[0]!.disposition, "quarantine");
    }),
  ),
  test(
    "consumer service and failure survive writer composition",
    Effect.gen(function* () {
      const error = ApplicationFailure.make({ code: "expected" });

      const result = yield* withWriter(backend([]), reference(), () =>
        ApplicationService.pipe(Effect.flatMap((service) => service.read)),
      ).pipe(
        Effect.provideService(ApplicationService, { read: Effect.fail(error) }),
        Effect.result,
      );

      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure, error);
    }),
  ),
  test(
    "interruption settles quarantine after child finalization",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [],
        entered = yield* Deferred.make<void>(),
        order: string[] = [];

      const fiber = yield* withWriter(
        {
          acquire: () =>
            Effect.succeed({
              settle: (value: WriterSettlementFacts) =>
                Effect.sync(() => {
                  order.push("settle");
                  facts.push(value);
                }),
            }),
        },
        ref,
        () =>
          Effect.gen(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                order.push("child-finalizer");
              }),
            );
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(fiber);
      assert.deepEqual(order, ["child-finalizer", "settle"]);
      assert.equal(facts[0]!.disposition, "quarantine");
    }),
  ),
  test(
    "concurrent writer claims do not call the backend twice",
    Effect.gen(function* () {
      const ref = reference(),
        entered = yield* Deferred.make<void>(),
        finish = yield* Deferred.make<void>();

      let acquired = 0;

      const service = {
        acquire: () =>
          Effect.sync(() => {
            acquired++;

            return { settle: () => Effect.void };
          }),
      };

      const first = yield* withWriter(service, ref, () =>
        Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish))),
      ).pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      assert.equal(
        (yield* expectFailure(withWriter(service, ref, () => Effect.void))).reason,
        "active",
      );
      yield* Deferred.succeed(finish, undefined);
      yield* Fiber.join(first);
      assert.equal(acquired, 1);
    }),
  ),
  test(
    "backend settlement deadline fails without claiming release",
    Effect.gen(function* () {
      const running = withWriter(
        { acquire: () => Effect.succeed({ settle: () => Effect.never }) },
        reference(),
        () => Effect.void,
        { settlementTimeoutMillis: 25 },
      );

      const failure = yield* Effect.gen(function* () {
        const fiber = yield* running.pipe(Effect.result, Effect.forkChild);

        yield* TestClock.adjust(100);

        return yield* Fiber.join(fiber);
      }).pipe(Effect.provide(TestClock.layer()));

      assert.equal(failure._tag, "Failure");
      if (failure._tag === "Failure") assert.equal(failure.failure.reason, "timeout");
    }),
  ),
  test(
    "an unacknowledged flush keeps its Context refused until its session is terminal and a readback passes",
    Effect.gen(function* () {
      const f = yield* scriptedWriter(),
        lease = counted();

      yield* f.run(withWriter(lease.backend, f.context, f.write));
      assert.equal(lease.settlements[0]!.disposition, "quarantine");
      assert.equal(
        (yield* expectFailure(withWriter(lease.backend, f.context, () => Effect.void))).reason,
        "active",
      );

      const failed = yield* expectFailure(
        f.run(reconcile(f.context, Effect.fail(ReadbackFailed.make({})))),
      );

      assert.equal(failed._tag, "WriterReadbackFailed");
      assert.equal(
        (yield* expectFailure(withWriter(lease.backend, f.context, () => Effect.void))).reason,
        "active",
      );
      assert.equal(lease.acquired(), 1);

      const prior = (yield* f.control.calls).length;

      let before: ReadonlyArray<Testing.ProviderCall> = [];

      yield* f.run(
        reconcile(
          f.context,
          f.control.calls.pipe(
            Effect.map((calls) => {
              before = calls.slice(prior);
            }),
          ),
        ),
      );
      // The readback ran after a fresh terminal read of the writer's own session.
      assert.deepEqual(before, [{ method: "GET", path: "/v1/sessions/session-1" }]);
      assert.equal(yield* withWriter(lease.backend, f.context, () => Effect.succeed(7)), 7);
      assert.equal(lease.acquired(), 2);
      assert.equal(lease.settlements[1]!.disposition, "release");
    }),
  ),
  test(
    "a session the provider has not ended keeps its Context refused without a readback",
    Effect.gen(function* () {
      const f = yield* scriptedWriter({ release: "pending" }),
        lease = counted();

      let readbacks = 0;

      const readback = Effect.sync(() => {
        readbacks++;
      });

      yield* polled(f.run(withWriter(lease.backend, f.context, f.write)));
      assert.equal(lease.settlements[0]!.attempts[0]!.cleanup?.remote, "pending");

      const refused = yield* expectFailure(f.run(reconcile(f.context, readback)));

      assert.equal(refused._tag, "ContextError");
      assert.equal(refused.reason, "active");
      assert.equal(readbacks, 0);
      assert.equal(
        (yield* expectFailure(withWriter(lease.backend, f.context, () => Effect.void))).reason,
        "active",
      );

      // The provider ends it on its own lifetime; reconciliation follows the provider, not a guess.
      yield* f.control.setStatus("session-1", "TIMED_OUT");
      yield* f.run(reconcile(f.context, readback));
      assert.equal(readbacks, 1);
      yield* withWriter(lease.backend, f.context, () => Effect.void);
      assert.equal(lease.acquired(), 2);
    }),
  ),
  test(
    "an allocation whose outcome stayed unknown keeps its Context refused",
    Effect.gen(function* () {
      const f = yield* scriptedWriter({ create: { _tag: "Lost" } }),
        lease = counted();

      let readbacks = 0;

      yield* expectFailure(f.run(withWriter(lease.backend, f.context, f.write)));
      assert.equal(lease.settlements[0]!.attempts[0]!.state, "unknown");

      const refused = yield* expectFailure(
        f.run(
          reconcile(
            f.context,
            Effect.sync(() => {
              readbacks++;
            }),
          ),
        ),
      );

      assert.equal(refused.reason, "active");
      assert.equal(readbacks, 0);
      assert.equal(
        (yield* expectFailure(withWriter(lease.backend, f.context, () => Effect.void))).reason,
        "active",
      );
    }),
  ),
  test(
    "reconciliation refuses a live writer, and admits none while it runs",
    Effect.gen(function* () {
      const f = yield* scriptedWriter(),
        lease = counted(),
        entered = yield* Deferred.make<void>(),
        release = yield* Deferred.make<void>();

      yield* withWriter(lease.backend, f.context, () =>
        Effect.gen(function* () {
          const refused = yield* expectFailure(f.run(reconcile(f.context, Effect.void)));

          assert.equal(refused.reason, "active");
        }),
      );
      assert.equal(lease.settlements[0]!.disposition, "release");

      const reconciling = yield* f
        .run(
          reconcile(
            f.context,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      assert.equal(
        (yield* expectFailure(withWriter(lease.backend, f.context, () => Effect.void))).reason,
        "active",
      );
      assert.equal(
        (yield* expectFailure(f.run(reconcile(f.context, Effect.void)))).reason,
        "active",
      );
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(reconciling);
      yield* withWriter(lease.backend, f.context, () => Effect.void);
      assert.equal(lease.acquired(), 2);
    }),
  ),
  test(
    "an interrupted reconciliation leaves its Context quarantined",
    Effect.gen(function* () {
      const f = yield* scriptedWriter(),
        lease = counted(),
        entered = yield* Deferred.make<void>();

      yield* f.run(withWriter(lease.backend, f.context, f.write));
      assert.equal(lease.settlements[0]!.disposition, "quarantine");

      const reconciling = yield* f
        .run(
          reconcile(
            f.context,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
          ),
        )
        .pipe(Effect.forkChild);

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(reconciling);
      assert.equal(
        (yield* expectFailure(withWriter(lease.backend, f.context, () => Effect.void))).reason,
        "active",
      );
      assert.equal(lease.acquired(), 1);

      yield* f.run(reconcile(f.context, Effect.void));
      yield* withWriter(lease.backend, f.context, () => Effect.void);
      assert.equal(lease.acquired(), 2);
    }),
  ),
  test(
    "a failed lease acquisition leaves the Context free for the next writer",
    Effect.gen(function* () {
      const ref = reference(),
        facts: WriterSettlementFacts[] = [];

      let acquired = 0;

      const failure = yield* expectFailure(
        withWriter(
          {
            acquire: () =>
              Effect.suspend(() => {
                acquired++;

                return Effect.fail(ApplicationFailure.make({ code: "lease-unanswered" }));
              }),
          },
          ref,
          () => Effect.void,
        ),
      );

      assert.equal(failure._tag, "WriterApplicationFailure");
      yield* withWriter(
        {
          acquire: () =>
            Effect.suspend(() => {
              acquired++;

              return backend(facts).acquire();
            }),
        },
        ref,
        () => Effect.void,
      );
      assert.equal(acquired, 2);
      assert.equal(facts[0]!.disposition, "release");
    }),
  ),
];
