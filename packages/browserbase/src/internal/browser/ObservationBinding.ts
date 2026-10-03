import type { Effect, Redacted } from "effect";
import type { BrowserBinding } from "effect-browser/browser-runtime";
import type { BrowserError } from "effect-browser/errors";

export type ObservationEndpoint = (connection: {
  readonly url: Redacted.Redacted<string>;
}) => Effect.Effect<string, BrowserError>;

const endpoints = new WeakMap<BrowserBinding, ObservationEndpoint>();

/** Native bindings share one validated routing decision between control and observation. */
export const registerObservationEndpoint = (
  binding: BrowserBinding,
  endpoint: ObservationEndpoint,
): BrowserBinding => {
  endpoints.set(binding, endpoint);

  return binding;
};

export const observationEndpoint = (binding: BrowserBinding): ObservationEndpoint | undefined =>
  endpoints.get(binding);
