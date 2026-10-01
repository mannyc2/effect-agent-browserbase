import type { Effect } from "effect";

import type { BrowserError, InitializationError } from "../../Errors.ts";
import type { Driver, DriverEvents, DriverOptions } from "./Driver.ts";

/**
 * Random values the owner draws from its `Crypto` service for one connection attempt. A native
 * engine has no randomness of its own.
 */
export interface ConnectionIdentity {
  /** Scopes the page, frame, observation and suspension ids this connection reports. */
  readonly namespace: string;
  /** Names the native binding channel's page globals. Never reported, so no page can claim them first. */
  readonly bindings: string;
}

/** What the owner asks of a native engine for one connection attempt. */
export interface ConnectRequest {
  /** The provider-issued connection address, unvalidated. */
  readonly connection: unknown;
  readonly identity: ConnectionIdentity;
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
