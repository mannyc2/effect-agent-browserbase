import assert from "node:assert/strict";

import { it } from "@effect/vitest";
import {
  Cause,
  Context,
  Deferred,
  Effect,
  Exit,
  Fiber,
  Option,
  Schema,
  SchemaGetter,
  Scope,
} from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import type { BrowserError } from "effect-browser/errors";
import { InitializationError } from "effect-browser/errors";
import { TestClock } from "effect/testing";

import {
  type Bindings,
  type NativeBindingCall,
  makeBindings,
  preparePlan,
} from "../src/internal/browser/Bindings.ts";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Metadata = Pick<
  Bootstrap.BindingOptions<number, number, number, number, never, never>,
  | "name"
  | "origins"
  | "maxConcurrent"
  | "maxInputBytes"
  | "maxOutputBytes"
  | "timeoutMillis"
  | "failureMode"
>;

const metadata: Metadata = {
  name: "readSettings",
  origins: ["https://portal.example"],
  maxConcurrent: 1,
  maxInputBytes: 128,
  maxOutputBytes: 128,
  timeoutMillis: 50,
  failureMode: "reject-call",
};

const numeric = <E, R>(
  handle: (value: number) => Effect.Effect<number, E, R>,
  overrides: Partial<Metadata> = {},
) =>
  Bootstrap.binding({
    ...metadata,
    ...overrides,
    input: Schema.Finite,
    output: Schema.Finite,
    handle,
  });

const acquire = Effect.fnUntraced(function* <E, R>(plan: Bootstrap.Plan<E, R>) {
  return yield* makeBindings(yield* preparePlan(plan));
});

const native = (text = "7", overrides: Partial<NativeBindingCall> = {}) => {
  const calls = { read: 0, check: 0, dispose: 0 };

  const call: NativeBindingCall = {
    read: (signal) => {
      calls.read++;

      return overrides.read?.(signal) ?? Promise.resolve(text);
    },
    check: (signal) => {
      calls.check++;

      return overrides.check?.(signal) ?? Promise.resolve();
    },
    dispose: () => {
      calls.dispose++;

      return overrides.dispose?.() ?? Promise.resolve();
    },
  };

  return { call, calls };
};

const rejection = Effect.fnUntraced(function* (promise: Promise<string>) {
  const error = yield* Effect.promise(() =>
    promise.then(
      () => undefined,
      (cause: unknown) => cause,
    ),
  );

  assert.ok(error instanceof Error);
  assert.equal(error.name, "BrowserBindingError");
  assert.equal(error.message, "Browser binding call rejected");
  assert.equal(error.stack, "");
  assert.equal(error.cause, undefined);
});

const firstBinding = <E>(owner: Bindings<E>) =>
  owner
    .connect(
      () => {},
      () => true,
    )
    .pipe(
      Effect.map((connection) => {
        const binding = connection.bindings[0];

        assert.ok(binding);

        return { connection, binding };
      }),
    );

class Settings extends Context.Service<Settings, { readonly value: number }>()(
  "bindings-test/Settings",
) {}
class Revision extends Context.Service<Revision, { readonly value: number }>()(
  "bindings-test/Revision",
) {}

const scopedPlan = numeric(
  Effect.fnUntraced(function* () {
    yield* Effect.addFinalizer(() => Effect.void);

    return (yield* Settings).value;
  }),
);

const revisionPlan = numeric(
  Effect.fnUntraced(function* () {
    yield* Revision;

    return yield* Effect.fail("revision-failure" as const);
  }),
  { name: "revision" },
);

const typedPlan = Bootstrap.combine(scopedPlan, revisionPlan);
const typedAcquisition = makeBindings(typedPlan);
const typedPreparation = preparePlan(typedPlan);

const requirements: Same<
  Bootstrap.PlanRequirements<typeof typedPlan>,
  Settings | Revision | Scope.Scope
> = true;

const acquiredRequirements: Same<
  Effect.Services<typeof typedAcquisition>,
  Settings | Revision | Scope.Scope
> = true;

const errors: Same<Bootstrap.PlanError<typeof typedPlan>, "revision-failure"> = true;
const prepareErrors: Same<Effect.Error<typeof typedPreparation>, BrowserError> = true;

const retainedErrors: Same<
  Effect.Error<Effect.Success<typeof typedAcquisition>["failure"]>,
  "revision-failure" | InitializationError
> = true;

const needsServices: Same<
  typeof typedAcquisition extends Effect.Effect<Bindings<"revision-failure">, never, Scope.Scope>
    ? true
    : false,
  false
> = true;

it("preserves real consumer E/R and invocation Scope through heterogeneous composition", () => {
  assert.ok(
    requirements &&
      acquiredRequirements &&
      errors &&
      prepareErrors &&
      retainedErrors &&
      needsServices,
  );
});

it.effect(
  "copies admission metadata and authenticates registrations, including symbol-preserving copies",
  () =>
    Effect.gen(function* () {
      const origins = ["https://portal.example"];

      const options = {
        ...metadata,
        origins,
        input: Schema.Finite,
        output: Schema.Finite,
        handle: (value: number) => Effect.succeed(value),
      };

      const bindingPlan = Bootstrap.binding(options);

      options.handle = () => Effect.succeed(99);
      origins[0] = "https://changed.example";

      const script = {
        id: "init",
        content: "globalThis.ready = true;",
        origins: ["https://portal.example"],
      };

      const plan = Bootstrap.combine(bindingPlan, Bootstrap.init(script));
      const prepared = yield* preparePlan(plan);

      script.content = "changed";
      script.origins[0] = "https://changed.example";
      assert.equal(prepared.scripts[0]?.content, "globalThis.ready = true;");
      assert.deepEqual(prepared.scripts[0]?.origins, ["https://portal.example"]);
      assert.deepEqual(prepared.bindings?.[0]?.origins, ["https://portal.example"]);
      assert.ok(Object.isFrozen(prepared.scripts[0]));
      const registration = prepared.bindings?.[0];

      assert.ok(registration);
      assert.throws(() => Object.assign(registration, { maxConcurrent: 99 }));

      const fabricated = yield* preparePlan({ ...prepared, bindings: [{ ...registration }] }).pipe(
        Effect.result,
      );

      assert.equal(fabricated._tag, "Failure");
      yield* Effect.scoped(
        Effect.gen(function* () {
          const owner = yield* makeBindings(prepared);
          const { binding } = yield* firstBinding(owner);

          assert.equal(yield* Effect.promise(() => binding.invoke(native().call)), "7");
        }),
      );
    }),
);

it.effect("rejects duplicate names and more than sixteen registrations before acquisition", () =>
  Effect.gen(function* () {
    const one = numeric(Effect.succeed);
    const duplicate = yield* preparePlan(Bootstrap.combine(one, one)).pipe(Effect.result);

    assert.equal(duplicate._tag, "Failure");

    const seventeen = Bootstrap.combine(
      ...Array.from({ length: 17 }, (_, index) =>
        numeric(Effect.succeed, { name: `binding${index}` }),
      ),
    );

    const over = yield* preparePlan(seventeen).pipe(Effect.result);

    assert.equal(over._tag, "Failure");

    const sixteen = Bootstrap.combine(
      ...Array.from({ length: 16 }, (_, index) =>
        numeric(Effect.succeed, { name: `binding${index}` }),
      ),
    );

    assert.equal((yield* preparePlan(sixteen)).bindings?.length, 16);
  }),
);

it("refuses non-finite, fractional and out-of-range admission bounds", () => {
  const fields = ["maxConcurrent", "maxInputBytes", "maxOutputBytes", "timeoutMillis"] as const;

  for (const field of fields) {
    for (const value of [NaN, Infinity, -Infinity, 0, -1, 1.5, Number.MAX_SAFE_INTEGER]) {
      assert.throws(() => numeric(Effect.succeed, { [field]: value }));
    }
  }
});

it.effect(
  "rejects malformed registration collections even when supplied by untyped host code",
  () =>
    Effect.gen(function* () {
      for (const bindings of [null, {}, "bindings", [{}]]) {
        const plan: Bootstrap.Plan<never, never> = { scripts: [], permissions: [] };

        Reflect.set(plan, "bindings", bindings);
        const result = yield* preparePlan(plan).pipe(Effect.result);

        assert.equal(result._tag, "Failure");
      }
    }),
);

it.effect("rejects unknown plan fields while admitting the static plan and issued bindings", () =>
  Effect.gen(function* () {
    for (const unexpected of [
      { binding: [] },
      { runtime: undefined },
      { handle: () => Effect.void },
    ]) {
      const result = yield* preparePlan({ ...Bootstrap.empty, ...unexpected }).pipe(Effect.result);

      assert.equal(result._tag, "Failure");
    }
    assert.equal((yield* preparePlan(Bootstrap.empty)).bindings, undefined);
    assert.equal((yield* preparePlan(numeric(Effect.succeed))).bindings?.length, 1);
  }),
);

it.effect("uses the acquisition services and a fresh Scope for each invocation", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const acquisitionScope = yield* Scope.Scope;
      const invocationScopes: Array<Scope.Scope> = [];
      let finalized = 0;

      const plan = numeric(
        Effect.fnUntraced(function* () {
          invocationScopes.push(yield* Scope.Scope);
          yield* Effect.addFinalizer(() =>
            Effect.sync(() => {
              finalized++;
            }),
          );

          return (yield* Settings).value;
        }),
      );

      const owner = yield* acquire(plan).pipe(Effect.provideService(Settings, { value: 41 }));

      const { binding } = yield* firstBinding(owner).pipe(
        Effect.provideService(Settings, { value: 99 }),
      );

      assert.equal(yield* Effect.promise(() => binding.invoke(native().call)), "41");
      yield* Effect.yieldNow;
      assert.equal(yield* Effect.promise(() => binding.invoke(native().call)), "41");
      assert.equal(finalized, 2);
      assert.equal(invocationScopes.length, 2);
      assert.notEqual(invocationScopes[0], invocationScopes[1]);
      assert.notEqual(invocationScopes[0], acquisitionScope);
    }),
  ),
);

it.effect("decodes input and encodes output with the supplied codecs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* acquire(
        Bootstrap.binding({
          ...metadata,
          input: Schema.FiniteFromString,
          output: Schema.FiniteFromString,
          handle: (value) => Effect.succeed(value * 2),
        }),
      );

      const { binding } = yield* firstBinding(owner);
      const f = native('"21"');

      assert.equal(yield* Effect.promise(() => binding.invoke(f.call)), '"42"');
      assert.deepEqual(f.calls, { read: 1, check: 2, dispose: 1 });
    }),
  ),
);

it.effect("rejects malformed and oversized UTF-8 input before the consumer runs", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let calls = 0;

      const owner = yield* acquire(
        Bootstrap.binding({
          ...metadata,
          maxInputBytes: 6,
          input: Schema.String,
          output: Schema.String,
          handle: (value) => {
            calls++;

            return Effect.succeed(value);
          },
        }),
      );

      const { binding } = yield* firstBinding(owner);

      for (const text of ['"ééé"', "{", "12"]) {
        yield* rejection(binding.invoke(native(text).call));
        yield* Effect.yieldNow;
      }
      assert.equal(calls, 0);
      assert.equal(yield* Effect.promise(() => binding.invoke(native('"éé"').call)), '"éé"');
      assert.equal(calls, 1);
      const snapshot = yield* owner.diagnostics;

      assert.equal(snapshot.failures.length, 3);
      for (const record of snapshot.failures) {
        const error = Option.getOrUndefined(Cause.findErrorOption(record.cause));

        assert.ok(Schema.is(InitializationError)(error));
        assert.equal(error.reason, "input");
      }
    }),
  ),
);

it.effect("rejects output codec violations, non-JSON values and encoded byte overflow", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const plans = [
        Bootstrap.binding({
          ...metadata,
          input: Schema.Finite,
          output: Schema.NonEmptyString,
          handle: () => Effect.succeed(""),
        }),
        Bootstrap.binding({
          ...metadata,
          input: Schema.Finite,
          output: Schema.Unknown,
          handle: () => Effect.succeed(1n),
        }),
        Bootstrap.binding({
          ...metadata,
          input: Schema.Finite,
          output: Schema.Unknown,
          handle: () => Effect.succeed(NaN),
        }),
        Bootstrap.binding({
          ...metadata,
          maxOutputBytes: 5,
          input: Schema.Finite,
          output: Schema.String,
          handle: () => Effect.succeed("éé"),
        }),
      ];

      for (const plan of plans) {
        const owner = yield* acquire(plan);
        const { binding } = yield* firstBinding(owner);

        yield* rejection(binding.invoke(native().call));
        const record = (yield* owner.diagnostics).failures[0];

        assert.ok(record);
        const error = Option.getOrUndefined(Cause.findErrorOption(record.cause));

        assert.ok(Schema.is(InitializationError)(error));
        assert.equal(error.reason, "output");
      }
    }),
  ),
);

it.effect(
  "checks document authority before the handler and again before returning its result",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const events: Array<string> = [];

        const owner = yield* acquire(
          numeric((value) => {
            events.push("handle");

            return Effect.succeed(value);
          }),
        );

        const { binding } = yield* firstBinding(owner);

        const f = native("7", {
          read: async () => {
            events.push("read");

            return "7";
          },
          check: async () => {
            events.push("check");
            if (events.includes("handle"))
              throw InitializationError.make({
                operation: "callback",
                step: metadata.name,
                reason: "stale",
              });
          },
          dispose: async () => {
            events.push("dispose");
          },
        });

        yield* rejection(binding.invoke(f.call));
        assert.deepEqual(events, ["read", "check", "handle", "check", "dispose"]);
        const record = (yield* owner.diagnostics).failures[0];

        assert.ok(record);
        const error = Option.getOrUndefined(Cause.findErrorOption(record.cause));

        assert.ok(Schema.is(InitializationError)(error));
        assert.equal(error.reason, "stale");
      }),
    ),
);

it.effect(
  "default reject-call retains the original typed consumer failure and accepts later work",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const expected = { _tag: "ConsumerError" as const, secret: "host-only" };
        let faults = 0;

        const owner = yield* acquire(
          Bootstrap.binding({
            name: metadata.name,
            origins: metadata.origins,
            input: Schema.Finite,
            output: Schema.Finite,
            handle: (value) => (value < 0 ? Effect.fail(expected) : Effect.succeed(value)),
          }),
        );

        const connection = yield* owner.connect(
          () => {
            faults++;
          },
          () => true,
        );

        const binding = connection.bindings[0];

        assert.ok(binding);
        yield* rejection(binding.invoke(native("-1").call));
        yield* Effect.yieldNow;
        const snapshot = yield* owner.diagnostics;
        const record = snapshot.failures[0];

        assert.ok(record);
        assert.equal(Option.getOrUndefined(Cause.findErrorOption(record.cause)), expected);
        assert.equal(snapshot.faulted, false);
        assert.equal(faults, 0);
        assert.equal(yield* Effect.promise(() => binding.invoke(native().call)), "7");
        assert.equal(snapshot.bindings[0]?.succeeded, 0);
        assert.equal((yield* owner.diagnostics).bindings[0]?.succeeded, 1);
      }),
    ),
);

it.effect("completes the typed fail-session signal before invoking the owner fence", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* acquire(
        numeric(() => Effect.fail("consumer-secret" as const), { failureMode: "fail-session" }),
      );

      let faults = 0;
      let observed: Exit.Exit<never, "consumer-secret" | InitializationError> | undefined;

      const connection = yield* owner.connect(
        () => {
          faults++;
          observed = Effect.runSyncExit(owner.failure);
        },
        () => true,
      );

      const binding = connection.bindings[0];

      assert.ok(binding);
      yield* rejection(binding.invoke(native().call));
      assert.equal(faults, 1);
      assert.ok(observed && Exit.isFailure(observed));
      assert.equal(Option.getOrUndefined(Cause.findErrorOption(observed.cause)), "consumer-secret");
      const neverAdmitted = native();

      yield* rejection(binding.invoke(neverAdmitted.call));
      assert.deepEqual(neverAdmitted.calls, { read: 0, check: 0, dispose: 0 });
      assert.equal(faults, 1);
    }),
  ),
);

it.effect(
  "a native registration failure reaches the typed supervisor and interrupts a waiting consumer",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* acquire(numeric(Effect.succeed));
        const started = yield* Deferred.make<void>();

        const expected = InitializationError.make({
          operation: "register",
          step: "bindings",
          reason: "native",
        });

        let active = true;
        let faults = 0;
        let finalized = 0;
        let observed: Exit.Exit<never, InitializationError> | undefined;

        const connection = yield* owner.connect(
          () => {
            observed = Effect.runSyncExit(owner.failure);
            active = false;
            faults++;
          },
          () => active,
        );

        const waiting = yield* Effect.raceFirst(
          owner.failure,
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.ensuring(
              Effect.sync(() => {
                finalized++;
              }),
            ),
          ),
        ).pipe(Effect.exit, Effect.forkChild);

        yield* Deferred.await(started);
        // Native registration rejects on a Promise turn, after the waiting consumer has entered.
        yield* Effect.promise(() =>
          Promise.resolve().then(() => {
            connection.reportFailure(expected);
            connection.reportFailure(
              InitializationError.make({
                operation: "register",
                step: "bindings",
                reason: "busy",
              }),
            );
          }),
        );

        const result = yield* Fiber.join(waiting);

        assert.ok(Exit.isFailure(result));
        assert.equal(Option.getOrUndefined(Cause.findErrorOption(result.cause)), expected);
        assert.ok(observed && Exit.isFailure(observed));
        assert.equal(Option.getOrUndefined(Cause.findErrorOption(observed.cause)), expected);
        assert.equal(faults, 1);
        assert.equal(finalized, 1);

        const binding = connection.bindings[0];
        const neverAdmitted = native();

        assert.ok(binding);
        yield* rejection(binding.invoke(neverAdmitted.call));
        assert.deepEqual(neverAdmitted.calls, { read: 0, check: 0, dispose: 0 });

        const diagnostics = yield* owner.diagnostics;

        assert.equal(diagnostics.faulted, true);
        assert.equal(diagnostics.failures.length, 1);
        assert.equal(diagnostics.failures[0]?.name, "bindings");
        assert.equal(diagnostics.failures[0]?.mode, "fail-session");
        assert.equal(diagnostics.bindings[0]?.accepted, 0);
      }),
    ),
);

for (const retirement of ["close", "lease-replaced"] as const) {
  it.effect(`late registration failure after ${retirement} leaves the replacement usable`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* acquire(numeric(Effect.succeed));
        let current = true;
        let faults = 0;

        const old = yield* owner.connect(
          () => {
            faults++;
          },
          () => true,
          () => current,
        );

        if (retirement === "close") old.close();
        else current = false;

        const replacement = yield* firstBinding(owner);

        old.reportFailure(
          InitializationError.make({
            operation: "register",
            step: "bindings",
            reason: "native",
          }),
        );

        assert.equal(yield* Effect.promise(() => replacement.binding.invoke(native().call)), "7");

        const diagnostics = yield* owner.diagnostics;

        assert.equal(faults, 0);
        assert.equal(diagnostics.faulted, false);
        assert.deepEqual(diagnostics.failures, []);
        assert.equal(diagnostics.bindings[0]?.succeeded, 1);
      }),
    ),
  );
}

it.effect(
  "a paused current connection rejects page calls but still reports registration failure",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* acquire(numeric(Effect.succeed));
        let faults = 0;

        const connection = yield* owner.connect(
          () => {
            faults++;
          },
          () => false,
          () => true,
        );

        const binding = connection.bindings[0];
        const neverAdmitted = native();

        assert.ok(binding);
        yield* rejection(binding.invoke(neverAdmitted.call));
        assert.deepEqual(neverAdmitted.calls, { read: 0, check: 0, dispose: 0 });

        const expected = InitializationError.make({
          operation: "register",
          step: "bindings",
          reason: "native",
        });

        connection.reportFailure(expected);

        const result = yield* Effect.exit(owner.failure);

        assert.ok(Exit.isFailure(result));
        assert.equal(Option.getOrUndefined(Cause.findErrorOption(result.cause)), expected);
        assert.equal(faults, 1);
        assert.equal((yield* owner.diagnostics).faulted, true);
      }),
    ),
);

for (const mode of ["reject-call", "fail-session"] as const) {
  it.effect(`${mode} reserves finite capacity before native validation or fibers`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const gate = yield* Deferred.make<void>();
        let handlerCalls = 0;
        let faults = 0;

        const owner = yield* acquire(
          numeric(
            (value) =>
              Effect.sync(() => {
                handlerCalls++;
              }).pipe(Effect.andThen(Deferred.await(gate)), Effect.as(value)),
            { failureMode: mode },
          ),
        );

        const connection = yield* owner.connect(
          () => {
            faults++;
          },
          () => true,
        );

        const binding = connection.bindings[0];

        assert.ok(binding);
        const first = native();
        const pressure = native();
        const pending = binding.invoke(first.call);

        yield* rejection(binding.invoke(pressure.call));
        assert.deepEqual(pressure.calls, { read: 0, check: 0, dispose: 0 });
        assert.ok(handlerCalls <= 1);
        assert.equal(faults, mode === "fail-session" ? 1 : 0);
        yield* Deferred.succeed(gate, undefined);
        if (mode === "fail-session") yield* rejection(pending);
        else assert.equal(yield* Effect.promise(() => pending), "7");
        assert.equal((yield* owner.diagnostics).bindings[0]?.accepted, 1);
      }),
    ),
  );
}

it.effect("the whole deadline includes native read and retains late work across reconnect", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let resolveRead!: (text: string) => void;
      let signal: AbortSignal | undefined;
      let handlers = 0;

      const late = new Promise<string>((resolve) => {
        resolveRead = resolve;
      });

      const owner = yield* acquire(
        numeric((value) => {
          handlers++;

          return Effect.succeed(value);
        }),
      );

      const { connection, binding } = yield* firstBinding(owner);

      const f = native("7", {
        read: (received) => {
          signal = received;

          return late;
        },
      });

      const pending = binding.invoke(f.call);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(51);
      yield* rejection(pending);
      assert.ok(signal?.aborted);
      const snapshot = yield* owner.diagnostics;

      assert.equal(snapshot.bindings[0]?.inFlight, 1);
      assert.equal(snapshot.bindings[0]?.pendingNative, 1);
      assert.equal(snapshot.bindings[0]?.retired, 1);
      assert.equal(handlers, 0);
      yield* connection.dispose;
      const replacement = yield* firstBinding(owner);
      const blocked = native();

      yield* rejection(replacement.binding.invoke(blocked.call));
      assert.equal(blocked.calls.read, 0);
      resolveRead("7");
      yield* Effect.yieldNow;
      assert.equal((yield* owner.diagnostics).bindings[0]?.inFlight, 0);
      assert.equal(handlers, 0);
      assert.equal(yield* Effect.promise(() => replacement.binding.invoke(native().call)), "7");
    }),
  ),
);

it.effect(
  "the handler deadline finalizes its invocation Scope without failing a reject-call owner",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let finalized = 0;
        const entered = yield* Deferred.make<void>();

        const owner = yield* acquire(
          numeric(
            Effect.fnUntraced(function* () {
              yield* Effect.addFinalizer(() =>
                Effect.sync(() => {
                  finalized++;
                }),
              );
              yield* Deferred.succeed(entered, undefined);

              return yield* Effect.never;
            }),
          ),
        );

        const { binding } = yield* firstBinding(owner);
        const pending = binding.invoke(native().call);

        yield* Deferred.await(entered);
        yield* TestClock.adjust(51);
        yield* rejection(pending);
        assert.equal(finalized, 1);
        const snapshot = yield* owner.diagnostics;

        assert.equal(snapshot.faulted, false);
        const record = snapshot.failures[0];

        assert.ok(record);
        const error = Option.getOrUndefined(Cause.findErrorOption(record.cause));

        assert.ok(Schema.is(InitializationError)(error));
        assert.equal(error.reason, "timeout");
      }),
    ),
);

it.effect(
  "parallel parent teardown closes admission before handler finalizers and creates no fault",
  () =>
    Effect.gen(function* () {
      const parent = yield* Scope.make("parallel");
      const entered = yield* Deferred.make<void>();
      let faults = 0;
      let probe: Promise<string> | undefined;
      const neverAdmitted = native();

      const owner = yield* acquire(
        numeric(
          Effect.fnUntraced(function* () {
            yield* Effect.addFinalizer(() =>
              Effect.sync(() => {
                probe = binding.invoke(neverAdmitted.call);
              }),
            );
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
          { failureMode: "fail-session" },
        ),
      ).pipe(Scope.provide(parent));

      const connection = yield* owner
        .connect(
          () => {
            faults++;
          },
          () => true,
        )
        .pipe(Scope.provide(parent));

      const binding = connection.bindings[0];

      assert.ok(binding);
      const pending = binding.invoke(native().call);

      yield* Deferred.await(entered);
      yield* Scope.close(parent, Exit.void);
      yield* rejection(pending);
      assert.ok(probe);
      yield* rejection(probe);
      assert.deepEqual(neverAdmitted.calls, { read: 0, check: 0, dispose: 0 });
      assert.equal(faults, 0);
      assert.equal((yield* owner.diagnostics).faulted, false);
    }),
);

for (const phase of ["input", "output"] as const) {
  it.effect(`the deadline includes a suspended ${phase} codec`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        let handlers = 0;

        const blocked = SchemaGetter.transformEffect<number, number>(() =>
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        );

        const codec = Schema.Finite.pipe(
          Schema.decodeTo(Schema.Finite, {
            decode: phase === "input" ? blocked : SchemaGetter.passthrough<number>(),
            encode: phase === "output" ? blocked : SchemaGetter.passthrough<number>(),
          }),
        );

        const owner = yield* acquire(
          Bootstrap.binding({
            ...metadata,
            input: codec,
            output: codec,
            handle: (value) => {
              handlers++;

              return Effect.succeed(value);
            },
          }),
        );

        const { binding } = yield* firstBinding(owner);
        const pending = binding.invoke(native().call);

        yield* Deferred.await(entered);
        yield* TestClock.adjust(51);
        yield* rejection(pending);
        assert.equal(handlers, phase === "input" ? 0 : 1);
        const record = (yield* owner.diagnostics).failures[0];

        assert.ok(record);
        const error = Option.getOrUndefined(Cause.findErrorOption(record.cause));

        assert.ok(Schema.is(InitializationError)(error));
        assert.equal(error.reason, "timeout");
      }),
    ),
  );
}

it.effect("the invocation deadline is not restarted when decoding hands off to the handler", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const entered = yield* Deferred.make<void>();

      const input = Schema.Finite.pipe(
        Schema.decodeTo(Schema.Finite, {
          decode: SchemaGetter.transformEffect<number, number>((value) =>
            Effect.sleep(30).pipe(Effect.as(value)),
          ),
          encode: SchemaGetter.passthrough<number>(),
        }),
      );

      const owner = yield* acquire(
        Bootstrap.binding({
          ...metadata,
          input,
          output: Schema.Finite,
          handle: () => Deferred.succeed(entered, undefined).pipe(Effect.andThen(Effect.never)),
        }),
      );

      const { binding } = yield* firstBinding(owner);
      const pending = binding.invoke(native().call);

      yield* Effect.yieldNow;
      yield* TestClock.adjust(30);
      yield* Deferred.await(entered);
      yield* TestClock.adjust(21);
      yield* rejection(pending);
      const record = (yield* owner.diagnostics).failures[0];

      assert.ok(record);
      const error = Option.getOrUndefined(Cause.findErrorOption(record.cause));

      assert.ok(Schema.is(InitializationError)(error));
      assert.equal(error.reason, "timeout");
    }),
  ),
);

it.effect(
  "late native disposal keeps successful work reserved across a connection replacement",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let release!: () => void;

        const disposed = new Promise<void>((resolve) => {
          release = resolve;
        });

        const owner = yield* acquire(numeric(Effect.succeed));
        const { connection, binding } = yield* firstBinding(owner);
        const f = native("7", { dispose: () => disposed });

        assert.equal(yield* Effect.promise(() => binding.invoke(f.call)), "7");
        yield* connection.dispose;
        const replacement = yield* firstBinding(owner);
        const pressure = native();

        yield* rejection(replacement.binding.invoke(pressure.call));
        assert.deepEqual(pressure.calls, { read: 0, check: 0, dispose: 0 });
        const snapshot = yield* owner.diagnostics;

        assert.equal(snapshot.bindings[0]?.inFlight, 1);
        assert.equal(snapshot.bindings[0]?.retired, 1);
        assert.equal(snapshot.bindings[0]?.pendingNative, 1);
        release();
        yield* Effect.yieldNow;
        assert.equal((yield* owner.diagnostics).bindings[0]?.inFlight, 0);
        assert.equal(yield* Effect.promise(() => replacement.binding.invoke(native().call)), "7");
        assert.equal(f.calls.dispose, 1);
      }),
    ),
);

it.effect(
  "keeps only thirty-two typed host failures and never projects consumer defects to the page",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const secret = new Error("host credentials must not cross into the page");
        const owner = yield* acquire(numeric(() => Effect.die(secret), { maxConcurrent: 64 }));
        const { binding } = yield* firstBinding(owner);
        const promises = Array.from({ length: 40 }, () => binding.invoke(native().call));

        for (const promise of promises) yield* rejection(promise);
        const snapshot = yield* owner.diagnostics;

        assert.equal(snapshot.failures.length, 32);
        assert.equal(snapshot.droppedFailures, 8);
        assert.equal(snapshot.bindings[0]?.accepted, 40);
        assert.equal(snapshot.bindings[0]?.rejected, 40);
        assert.equal(snapshot.faulted, false);
        assert.ok(Object.isFrozen(snapshot.failures));
        assert.equal(snapshot.failures[0]?.cause.reasons[0]?._tag, "Die");
      }),
    ),
);
