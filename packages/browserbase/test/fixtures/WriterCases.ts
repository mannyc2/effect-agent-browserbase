import assert from "node:assert/strict";
import { Context, Deferred, Effect, Fiber, Schema, type Scope } from "effect";
import { TestClock } from "effect/testing";
import { CleanupResult } from "../../src/Cleanup.ts";
import { withWriter, type WriterSettlementFacts } from "../../src/ContextCoordination.ts";
import { ContextError } from "../../src/Errors.ts";
import { AllocationAttempt, ContextReference, SessionReference } from "../../src/References.ts";
import { requireContextWriterPermit } from "../../src/internal/session/ContextWriter.ts";

const reference = () => ContextReference.make({ provider: "browserbase", projectId: "project", contextId: globalThis.crypto.randomUUID() });
const attempt = () => AllocationAttempt.make({ projectId: "project", attemptId: globalThis.crypto.randomUUID(), requestedAtMillis: 1, timeoutSeconds: 60 });
const session = () => SessionReference.make({ provider: "browserbase", projectId: "project", sessionId: globalThis.crypto.randomUUID() });
const cleanup = (reference: SessionReference, status: "COMPLETED" | "ERROR" = "COMPLETED") => CleanupResult.make({ reference, ownership: "owned", local: "closed", releaseRequested: true, remote: "confirmed", observedStatus: status, issues: [] });
const backend = (settlements: WriterSettlementFacts[]) => ({ acquire: () => Effect.succeed({ settle: (facts: WriterSettlementFacts) => Effect.sync(() => { settlements.push(facts); }) }) });
const expectFailure = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.result, Effect.map((result) => {
  assert.equal(result._tag, "Failure");
  if (result._tag === "Failure") return result.failure;
  throw new Error("Expected a failure");
}));

class ApplicationFailure extends Schema.TaggedError<ApplicationFailure>()("WriterApplicationFailure", { code: Schema.String }) {}
class ApplicationService extends Context.Service<ApplicationService, { readonly read: Effect.Effect<number, ApplicationFailure> }>()("writer-test/ApplicationService") {}
interface Case { readonly name: string; readonly run: Effect.Effect<void, ContextError> }
const test = (name: string, run: Effect.Effect<void, ContextError, Scope.Scope>): Case => ({ name, run: Effect.scoped(run) });

export const writerCases: ReadonlyArray<Case> = [
  test("unused writer lease settles once with no allocation", Effect.gen(function* () {
    const facts: WriterSettlementFacts[] = [];
    assert.equal(yield* withWriter(backend(facts), reference(), () => Effect.succeed(42)), 42);
    assert.equal(facts.length, 1); assert.equal(facts[0].disposition, "release"); assert.equal(facts[0].attempts.length, 0);
  })),
  test("one writer permit refuses overlapping allocation attempts", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [];
    yield* withWriter(backend(facts), ref, (publicPermit) => Effect.gen(function* () {
      const permit = yield* requireContextWriterPermit(publicPermit, ref);
      yield* permit.recordAttempt(attempt());
      assert.equal((yield* expectFailure(permit.recordAttempt(attempt()))).reason, "active");
    }));
    assert.equal(facts[0].attempts.length, 1); assert.equal(facts[0].disposition, "quarantine");
  })),
  test("spreading a writer permit does not copy allocation authority", Effect.gen(function* () {
    const ref = reference();
    yield* withWriter(backend([]), ref, (permit) => Effect.gen(function* () {
      const error = yield* expectFailure(requireContextWriterPermit({ ...permit }, ref));
      assert.equal(error.reason, "authorization");
    }));
  })),
  test("a writer permit cannot authorize another Context", Effect.gen(function* () {
    const ref = reference();
    yield* withWriter(backend([]), ref, (permit) => Effect.gen(function* () {
      assert.equal((yield* expectFailure(requireContextWriterPermit(permit, reference()))).reason, "authorization");
    }));
  })),
  test("terminal cleanup remains tied to its exact attempt and session", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [], request = attempt(), allocated = session();
    yield* withWriter(backend(facts), ref, (value) => Effect.gen(function* () {
      const permit = yield* requireContextWriterPermit(value, ref); yield* permit.recordAttempt(request);
      permit.recordSession(request, allocated); permit.completed(request, cleanup(session()));
    }));
    assert.equal(facts[0].attempts[0].session?.sessionId, allocated.sessionId);
    assert.equal(facts[0].disposition, "quarantine"); assert.notEqual(facts[0].attempts[0].state, "terminal");
  })),
  test("COMPLETED does not manufacture a Context flush receipt", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [], request = attempt(), allocated = session();
    yield* withWriter(backend(facts), ref, (value) => Effect.gen(function* () {
      const permit = yield* requireContextWriterPermit(value, ref); yield* permit.recordAttempt(request);
      permit.recordSession(request, allocated); permit.completed(request, cleanup(allocated));
      assert.equal((yield* expectFailure(permit.recordAttempt(attempt()))).reason, "active");
    }));
    assert.equal(facts[0].attempts[0].state, "terminal");
    assert.deepEqual(facts[0].persistence, { _tag: "Unconfirmed", reason: "flush-unacknowledged" });
    assert.equal(facts[0].disposition, "quarantine");
  })),
  test("explicit consumer readback follows cleanup before releasing the writer", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [], request = attempt(), allocated = session(), order: string[] = [];
    yield* withWriter(backend(facts), ref, (value) => Effect.gen(function* () {
      const permit = yield* requireContextWriterPermit(value, ref); yield* permit.recordAttempt(request);
      permit.recordSession(request, allocated);
      yield* Effect.addFinalizer(() => Effect.sync(() => { order.push("cleanup"); permit.completed(request, cleanup(allocated)); }));
      return 7;
    }), { verify: (value) => Effect.sync(() => { assert.equal(value, 7); order.push("readback"); }) });
    assert.deepEqual(order, ["cleanup", "readback"]); assert.equal(facts[0].persistence._tag, "Observed"); assert.equal(facts[0].disposition, "release");
  })),
  test("known allocation rejection records no session and permits explicit next attempt", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [], request = attempt();
    yield* withWriter(backend(facts), ref, (value) => Effect.gen(function* () {
      const permit = yield* requireContextWriterPermit(value, ref); yield* permit.recordAttempt(request); permit.rejected(request);
      const next = attempt(); yield* permit.recordAttempt(next); permit.rejected(next);
    }));
    assert.equal(facts[0].attempts.length, 2); assert.ok(facts[0].attempts.every((value) => value.state === "rejected" && value.session === undefined));
    assert.equal(facts[0].disposition, "release");
  })),
  test("abnormal termination remains quarantined after a verification callback", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [], request = attempt(), allocated = session();
    const failure = yield* expectFailure(withWriter(backend(facts), ref, (value) => Effect.gen(function* () {
      const permit = yield* requireContextWriterPermit(value, ref); yield* permit.recordAttempt(request);
      permit.recordSession(request, allocated); permit.completed(request, cleanup(allocated, "ERROR"));
    }), { verify: () => Effect.void }));
    assert.equal(failure.reason, "active"); assert.equal(facts[0].disposition, "quarantine");
  })),
  test("consumer service and failure survive writer composition", Effect.gen(function* () {
    const error = ApplicationFailure.make({ code: "expected" });
    const result = yield* withWriter(backend([]), reference(), () => ApplicationService.pipe(Effect.flatMap((service) => service.read))).pipe(
      Effect.provideService(ApplicationService, { read: Effect.fail(error) }), Effect.result,
    );
    assert.equal(result._tag, "Failure"); if (result._tag === "Failure") assert.equal(result.failure, error);
  })),
  test("interruption settles quarantine after child finalization", Effect.gen(function* () {
    const ref = reference(), facts: WriterSettlementFacts[] = [], entered = yield* Deferred.make<void>(), order: string[] = [];
    const fiber = yield* withWriter({ acquire: () => Effect.succeed({ settle: (value: WriterSettlementFacts) => Effect.sync(() => { order.push("settle"); facts.push(value); }) }) }, ref, () => Effect.gen(function* () {
      yield* Effect.addFinalizer(() => Effect.sync(() => { order.push("child-finalizer"); }));
      yield* Deferred.succeed(entered, undefined); yield* Effect.never;
    })).pipe(Effect.forkChild);
    yield* Deferred.await(entered); yield* Fiber.interrupt(fiber);
    assert.deepEqual(order, ["child-finalizer", "settle"]); assert.equal(facts[0].disposition, "quarantine");
  })),
  test("concurrent writer claims do not call the backend twice", Effect.gen(function* () {
    const ref = reference(), entered = yield* Deferred.make<void>(), finish = yield* Deferred.make<void>(); let acquired = 0;
    const service = { acquire: () => Effect.sync(() => { acquired++; return { settle: () => Effect.void }; }) };
    const first = yield* withWriter(service, ref, () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(finish)))).pipe(Effect.forkChild);
    yield* Deferred.await(entered);
    assert.equal((yield* expectFailure(withWriter(service, ref, () => Effect.void))).reason, "active");
    yield* Deferred.succeed(finish, undefined); yield* Fiber.join(first); assert.equal(acquired, 1);
  })),
  test("backend settlement deadline fails without claiming release", Effect.gen(function* () {
    const running = withWriter({ acquire: () => Effect.succeed({ settle: () => Effect.never }) }, reference(), () => Effect.void, { settlementTimeoutMillis: 25 });
    const failure = yield* Effect.gen(function* () {
      const fiber = yield* running.pipe(Effect.result, Effect.forkChild); yield* TestClock.adjust(100); return yield* Fiber.join(fiber);
    }).pipe(Effect.provide(TestClock.layer()));
    assert.equal(failure._tag, "Failure"); if (failure._tag === "Failure") assert.equal(failure.failure.reason, "timeout");
  })),
];
