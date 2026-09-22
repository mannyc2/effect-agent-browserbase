import { Effect, Schema } from "effect";

import { BrowserError, InitializationError, Reasons } from "../../Errors.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";
import { publicError } from "./NativeCalls.ts";

/** What the owner asks of a native engine for one connection attempt. */
export interface ConnectRequest {
  /** The provider-issued connection address, unvalidated. */
  readonly connection: unknown;
  readonly options: DriverOptions;
  readonly events: DriverEvents;
  /** A connection that completes after the attempt was interrupted is disposed through this. */
  readonly onAbandoned: () => void;
  /** Called once the native attempt settles, whether or not anyone still waits for it. */
  readonly onSettled: () => void;
}

export interface BindingImplementation {
  readonly connect: (
    request: ConnectRequest,
  ) => Effect.Effect<Driver, BrowserError | InitializationError>;
}

/**
 * A native attempt as a Promise with its own abort signal. Interruption aborts the signal; a
 * connection that still arrives afterwards is fenced and disconnected here, so a late native
 * success can never become a live, unowned browser.
 */
export type NativeAttempt = (request: ConnectRequest, signal: AbortSignal) => Promise<Driver>;

export const fromNativeAttempt = (attempt: NativeAttempt): BindingImplementation => ({
  connect: (request) =>
    Effect.tryPromise({
      try: (signal) => {
        const pending = attempt(request, signal).then(async (driver) => {
          if (signal.aborted) {
            request.onAbandoned();
            driver.fenceInitialization?.();
            await driver.disconnect().catch(() => {});
            throw BrowserError.make({
              operation: "connect",
              reason: Reasons.Interrupted.make({}),
              outcome: "unknown",
            });
          }

          return driver;
        });

        void pending.then(request.onSettled, request.onSettled);

        return pending;
      },
      catch: (error) =>
        Schema.is(InitializationError)(error)
          ? error
          : publicError(error, "connect", {
              reason: Reasons.Provider.make({}),
              outcome: "unknown",
            }),
    }),
});

/**
 * Binding identity is issuance, never shape: a value that merely looks like a binding has no
 * entry here and cannot reach the owner, so only this package's constructors supply an engine.
 */
const issued = new WeakMap<object, BindingImplementation>();

export const issueBinding = <B extends object>(
  binding: B,
  implementation: BindingImplementation,
) => {
  issued.set(binding, implementation);

  return Object.freeze(binding);
};

export const bindingImplementation = (binding: object): BindingImplementation | undefined =>
  issued.get(binding);
