import { Effect, Schema } from "effect";

import { BrowserError, InitializationError, Reasons } from "../../Errors.ts";
import type { BindingImplementation, ConnectRequest } from "./Binding.ts";
import type { Driver } from "./Driver.ts";
import { providerReason, publicError } from "./NativeCalls.ts";

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
              reason: providerReason(error),
              outcome: "unknown",
            }),
    }),
});
