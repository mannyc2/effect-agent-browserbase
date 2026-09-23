import { Cause, Deferred, Effect, Exit, Schema, Scope } from "effect";

import * as Bootstrap from "../../Bootstrap.ts";
import { BrowserError, InitializationError, Reasons } from "../../Errors.ts";
import * as Registration from "./BindingRegistration.ts";
import { makeBindingRunner } from "./BindingRunner.ts";
import { duplicateStep } from "./Bootstrap.ts";
import type { DriverFault } from "./Driver.ts";

export interface NativeBindingCall {
  /** Validate native membership, allowed origin and the captured document before returning JSON. */
  readonly read: (signal: AbortSignal) => Promise<string>;
  /** Revalidate the same native caller/document; never substitute a newly selected document. */
  readonly check: (signal: AbortSignal) => Promise<void>;
  /** Idempotently fence retained handles and dispose late arrivals as they become available. */
  readonly dispose: () => Promise<void>;
}

export interface NativeBinding {
  readonly name: string;
  readonly origins: ReadonlyArray<string>;
  readonly maxConcurrent: number;
  readonly maxInputBytes: number;
  readonly timeoutMillis: number;
  /** Rejected admission never calls read/check/dispose; the native callback still owns its handles. */
  readonly invoke: (call: NativeBindingCall) => Promise<string>;
}

export interface ConnectionBindings {
  readonly bindings: ReadonlyArray<NativeBinding>;
  readonly close: () => void;
  /** Native registration/transport failure supervises the owner, not a single page invocation. */
  readonly reportFailure: (error: InitializationError) => void;
  /** Drain scoped Effect fibers. Late native promises remain observed and occupy capacity. */
  readonly dispose: Effect.Effect<void>;
}

export interface Bindings<E> {
  readonly failure: Effect.Effect<never, E | InitializationError>;
  readonly diagnostics: Effect.Effect<Bootstrap.BindingDiagnostics<E>>;
  readonly connect: (
    onFault: (event: DriverFault) => void,
    isActive: () => boolean,
    isCurrent?: () => boolean,
  ) => Effect.Effect<ConnectionBindings, never, Scope.Scope>;
}

const invalidPlan = () =>
  BrowserError.make({
    operation: "configure",
    reason: Reasons.Configuration.make({}),
    outcome: "undispatched",
  });

const AdmissionPlan = Schema.Struct({
  ...Bootstrap.Plan.fields,
  bindings: Schema.optionalKey(Schema.Array(Schema.Unknown).check(Schema.isMaxLength(16))),
});

/** Validate before allocation and retain an immutable snapshot, including authenticated callbacks. */
export const preparePlan = Effect.fnUntraced(function* <E, R>(
  plan: Bootstrap.Plan<E, R>,
): Effect.fn.Return<Bootstrap.Plan<E, R>, BrowserError> {
  const source = yield* Effect.try({
    try: () => ({ ...plan }),
    catch: invalidPlan,
  });

  const data = yield* Schema.decodeEffect(AdmissionPlan, { onExcessProperty: "error" })(
    source,
  ).pipe(Effect.mapError(invalidPlan));

  if (duplicateStep({ scripts: data.scripts, permissions: data.permissions }))
    return yield* invalidPlan();
  const candidates = source.bindings === undefined ? [] : source.bindings;

  const bindings = yield* Effect.forEach([...candidates], (registration) =>
    Registration.snapshot(registration),
  );

  if (new Set(bindings.map((registration) => registration.name)).size !== bindings.length) {
    return yield* invalidPlan();
  }

  return Object.freeze({
    scripts: Object.freeze(
      data.scripts.map((script) =>
        Object.freeze({
          ...script,
          ...(script.origins === undefined ? {} : { origins: Object.freeze([...script.origins]) }),
          ...(script.readiness === undefined
            ? {}
            : { readiness: Object.freeze({ ...script.readiness }) }),
        }),
      ),
    ),
    permissions: Object.freeze(
      data.permissions.map((grant) =>
        Object.freeze({
          ...grant,
          permissions: Object.freeze([...grant.permissions]),
        }),
      ),
    ),
    ...(bindings.length === 0 ? {} : { bindings: Object.freeze(bindings) }),
  });
});

const rejected = (): Promise<never> => {
  const error = new Error("Browser binding call rejected");

  error.name = "BrowserBindingError";
  error.stack = "";
  const result = Promise.reject(error);

  void result.catch(() => {});

  return result;
};

const increment = (value: number) => Math.min(Number.MAX_SAFE_INTEGER, value + 1);

/** The caller must pass preparePlan's snapshot; dependencies are captured at acquisition. */
export const makeBindings = Effect.fnUntraced(function* <E, R>(
  plan: Bootstrap.Plan<E, R>,
): Effect.fn.Return<Bindings<E>, never, Exclude<R, Scope.Scope> | Scope.Scope> {
  // Effect.scoped installs a fresh invocation Scope inside this captured context. A consumer
  // handler never receives the acquisition Scope even when the actual context contains it.
  const consumer = yield* Effect.context<Exclude<R, Scope.Scope>>();
  const ownerScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
  const failure = yield* Deferred.make<never, E | InitializationError>();
  const connections = new Set<ConnectionBindings>();
  const failures: Array<Bootstrap.BindingFailure<E>> = [];
  let droppedFailures = 0;
  let faulted = false;
  let ownerClosed = false;

  const entries = (plan.bindings ?? []).map((registration) => ({
    registration,
    state: {
      name: registration.name,
      inFlight: 0,
      pendingNative: 0,
      retired: 0,
      accepted: 0,
      succeeded: 0,
      rejected: 0,
    },
  }));

  yield* Scope.addFinalizer(
    ownerScope,
    Effect.suspend(() => {
      ownerClosed = true;
      const owned = [...connections];

      for (const connection of owned) connection.close();

      return Effect.forEach(owned, (connection) => connection.dispose, { discard: true });
    }),
  );

  const connect = Effect.fnUntraced(function* (
    onFault: (event: DriverFault) => void,
    isActive: () => boolean,
    isCurrent: () => boolean = isActive,
  ): Effect.fn.Return<ConnectionBindings, never, Scope.Scope> {
    const connectionScope = yield* Scope.fork(yield* Scope.Scope, "sequential");
    let closed = ownerClosed || faulted;
    const fences: Array<() => void> = [];
    const current = () => !closed && !ownerClosed && !faulted && isCurrent();
    const active = () => current() && isActive();

    const close = () => {
      closed = true;
      for (const fence of fences) fence();
    };

    const record = (
      registration: Pick<Registration.Registration<E, R>, "name" | "failureMode">,
      cause: Cause.Cause<E | InitializationError>,
      event: DriverFault = { source: "binding", reason: "callback-failure", disposition: "known" },
    ) => {
      if (failures.length === 32) {
        failures.shift();
        droppedFailures = increment(droppedFailures);
      }
      failures.push(
        Object.freeze({ name: registration.name, mode: registration.failureMode, cause }),
      );
      if (registration.failureMode === "fail-session" && current()) {
        faulted = true;
        // The host can observe the original typed cause as soon as its owner is fenced.
        Deferred.doneUnsafe(failure, Effect.failCause(cause));
        // The owner must fence browser admission before interrupted callback finalizers run.
        onFault(event);
        for (const connection of connections) connection.close();
      }
    };

    const bindings = yield* Effect.forEach(entries, ({ registration, state }) =>
      Effect.gen(function* () {
        const error = (
          reason: InitializationError["reason"],
          operation: InitializationError["operation"] = "callback",
        ) => InitializationError.make({ operation, step: registration.name, reason });

        interface Work {
          readonly call: NativeBindingCall;
          pending: number;
          finished: boolean;
          released: boolean;
          nativeFault?: Extract<DriverFault, { readonly source: "native" }>;
        }

        const release = (work: Work) => {
          if (!work.finished || work.pending !== 0 || work.released) return;
          work.released = true;
          state.inFlight--;
          state.retired--;
        };

        const track = <A>(work: Work, promise: Promise<A>): Promise<A> => {
          work.pending++;
          state.pendingNative++;

          const settled = () => {
            work.pending--;
            state.pendingNative--;
            release(work);
          };

          void promise.then(settled, settled);

          return promise;
        };

        const finish = (work: Work) => {
          if (work.finished) return;
          work.finished = true;
          state.retired++;

          // Disposal may complete before an abort-ignoring read. Both remain accounted for.
          const disposing = Promise.resolve()
            .then(() => work.call.dispose())
            .catch(() => {
              record(registration, Cause.fail(error("native", "dispose")), {
                source: "native",
                reason: "callback",
                disposition: "unknown",
              });
            });

          void track(work, disposing);
        };

        const native = <A>(work: Work, action: (signal: AbortSignal) => Promise<A>) =>
          Effect.tryPromise({
            try: (signal) => track(work, action(signal)),
            catch: (cause) => {
              work.nativeFault = { source: "native", reason: "callback", disposition: "unknown" };

              return Schema.is(InitializationError)(cause) ? error(cause.reason) : error("native");
            },
          });

        const execute = Effect.fnUntraced(function* (work: Work) {
          const check = Effect.suspend(() =>
            active() ? native(work, work.call.check) : Effect.fail(error("closed")),
          );

          if (!active()) return yield* error("closed");
          const text = yield* native(work, work.call.read);
          const result = yield* Registration.invoke(registration, text, check);

          yield* check;

          return result;
        });

        const runner = yield* makeBindingRunner(
          registration.maxConcurrent,
          (work: Work) =>
            Effect.scoped(execute(work)).pipe(
              Effect.timeoutOrElse({
                duration: registration.timeoutMillis,
                orElse: () => Effect.fail(error("timeout")),
              }),
              Effect.provideContext(consumer),
            ),
          () => {},
        ).pipe(Scope.provide(connectionScope));

        fences.push(runner.interrupt);

        const invoke = (call: NativeBindingCall): Promise<string> => {
          if (!active()) {
            state.rejected = increment(state.rejected);

            return rejected();
          }
          if (state.inFlight >= registration.maxConcurrent) {
            state.rejected = increment(state.rejected);
            record(registration, Cause.fail(error("busy")));

            return rejected();
          }
          // This reservation also covers codec work, native validation and late native disposal.
          // It is shared across connections, so reconnect cannot reset quarantined capacity.
          state.inFlight++;
          state.accepted = increment(state.accepted);
          const work: Work = { call, pending: 0, finished: false, released: false };
          const admission = runner.submit(work, "reject-call");

          if (admission._tag === "Rejected") {
            state.rejected = increment(state.rejected);
            finish(work);

            return rejected();
          }

          const result = admission.result
            .then(
              (exit) => {
                if (Exit.isFailure(exit)) {
                  state.rejected = increment(state.rejected);
                  record(registration, exit.cause, work.nativeFault);

                  return rejected();
                }
                if (!active()) {
                  state.rejected = increment(state.rejected);

                  return rejected();
                }
                state.succeeded = increment(state.succeeded);

                return exit.value;
              },
              () => {
                state.rejected = increment(state.rejected);
                if (active())
                  record(registration, Cause.fail(error("native")), {
                    source: "native",
                    reason: "callback",
                    disposition: "unknown",
                  });

                return rejected();
              },
            )
            .finally(() => finish(work));

          void result.catch(() => {});

          return result;
        };

        return Object.freeze({
          name: registration.name,
          origins: registration.origins,
          maxConcurrent: registration.maxConcurrent,
          maxInputBytes: registration.maxInputBytes,
          timeoutMillis: registration.timeoutMillis,
          invoke,
        });
      }),
    );

    const connection: ConnectionBindings = {
      bindings: Object.freeze(bindings),
      close,
      reportFailure: (error) => {
        if (!current()) return;
        record({ name: error.step, failureMode: "fail-session" }, Cause.fail(error), {
          source: "native",
          reason: "registration",
          disposition: "unknown",
        });
      },
      dispose: Effect.sync(close).pipe(Effect.andThen(Scope.close(connectionScope, Exit.void))),
    };

    connections.add(connection);
    yield* Scope.addFinalizer(
      connectionScope,
      Effect.sync(() => {
        close();
        connections.delete(connection);
      }),
    );

    return connection;
  }, Effect.uninterruptible);

  return {
    failure: Deferred.await(failure),
    diagnostics: Effect.sync(() =>
      Object.freeze({
        faulted,
        bindings: Object.freeze(entries.map(({ state }) => Object.freeze({ ...state }))),
        failures: Object.freeze([...failures]),
        droppedFailures,
      }),
    ),
    connect,
  };
});
