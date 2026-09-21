import { Effect, Exit, FiberSet, Scope } from "effect";

import type { CallbackFailureMode } from "./CallbackTasks.ts";

export type BindingRejection = "closed" | "capacity";

export type BindingAdmission<A, E> =
  | { readonly _tag: "Rejected"; readonly reason: BindingRejection }
  | { readonly _tag: "Accepted"; readonly result: Promise<Exit.Exit<A, E>> };

/**
 * Scoped host runner for future page-callable bindings. Admission is synchronous and finite:
 * no Fiber exists until a slot has been reserved. The owning Scope interrupts accepted work;
 * consumer failures remain in an Exit on the host and are never page reply material here.
 */
export interface BindingRunner<I, A, E> {
  readonly submit: (
    input: I,
    failureMode?: CallbackFailureMode,
  ) => BindingAdmission<A, E>;
}

export const makeBindingRunner = <I, A, E, R>(
  capacity: number,
  handle: (input: I) => Effect.Effect<A, E, R>,
  onFault: () => void,
): Effect.Effect<BindingRunner<I, A, E>, never, R | Scope.Scope> => {
  if (!Number.isSafeInteger(capacity) || capacity < 1)
    throw new RangeError("Invalid binding callback capacity");

  return Effect.gen(function* () {
    const parent = yield* Scope.Scope;
    // Do not depend on an application's ambient finalizer strategy for callback ordering.
    // One private sequential child owns both FiberSet and the admission fence.
    const runtimeScope = yield* Scope.fork(parent, "sequential");
    const run = yield* FiberSet.makeRuntimePromise<R, Exit.Exit<A, E>, never>().pipe(
      Scope.provide(runtimeScope),
    );

    let accepting = true;
    let faulted = false;
    let inFlight = 0;

    const fault = () => {
      if (!accepting || faulted) return;
      faulted = true;
      onFault();
    };

    // FiberSet registered its child-scope finalizer first. Sequential reverse registration
    // order therefore closes admission before the set interrupts accepted callbacks.
    yield* Scope.addFinalizer(
      runtimeScope,
      Effect.sync(() => {
        accepting = false;
      }),
    );

    const submit = (
      input: I,
      failureMode: CallbackFailureMode = "fail-session",
    ): BindingAdmission<A, E> => {
      if (!accepting || faulted) return { _tag: "Rejected", reason: "closed" };
      if (inFlight >= capacity) {
        if (failureMode === "fail-session") fault();

        return { _tag: "Rejected", reason: "capacity" };
      }

      inFlight++;
      // Construct the consumer Effect inside the admitted fiber as well: a consumer callback
      // that throws while producing its Effect is a host defect, not work allowed before admission.
      const execution = run(Effect.exit(Effect.suspend(() => handle(input))));
      const result = execution
        .then(
          (exit) => {
            if (failureMode === "fail-session" && Exit.isFailure(exit)) fault();

            return exit;
          },
          (error) => {
            if (failureMode === "fail-session") fault();
            throw error;
          },
        )
        .finally(() => {
          inFlight--;
        });

      // A native caller may disappear while the host callback is still settling. Keep the
      // Promise observed without consuming the Exit returned to a caller that is still present.
      void result.catch(() => {});

      return { _tag: "Accepted", result };
    };

    return { submit };
  });
};
