import { Context, Effect, Layer, Redacted } from "effect";

import type { BrowserError } from "./Errors.ts";
import { fromNativeAttempt, issueBinding } from "./internal/browser/Binding.ts";
import { publicError } from "./internal/browser/NativeCalls.ts";
import { connectPlaywrightEndpoint, validateConnection } from "./internal/browser/Playwright.ts";

/**
 * The trusted native engine an owned or borrowed browser connects through. It is opaque: only
 * this module issues one, so a value that merely has this shape is refused before allocation
 * rather than trusted with a connection.
 */
export interface BrowserBinding {
  readonly _tag: "BrowserbaseBrowserBinding";
}

export interface PlaywrightOptions {
  /**
   * Trusted host routing. It runs only after the provider-issued address passed the same strict
   * checks as the default, and returns the CDP endpoint to connect to instead. A local engine
   * reached this way says nothing about how a hosted connection behaves.
   */
  readonly resolveEndpoint?: (provider: {
    readonly url: Redacted.Redacted<string>;
  }) => Effect.Effect<string, BrowserError>;
  /**
   * Trusted instrumentation of the engine's own browser object, called once per connection with
   * the endpoint it reached, before the owner drives it. The object is typed `unknown` so that
   * no declaration of this package names the optional native peer; it is host configuration,
   * never model-facing.
   */
  readonly onConnected?: (connection: {
    readonly native: unknown;
    readonly endpoint: string;
  }) => void;
}

const invalid = (connection: unknown) =>
  Effect.try({
    try: () => validateConnection(connection),
    catch: (error) => publicError(error, "connect", { reason: "malformed" }),
  });

/** Playwright over CDP, lazily loaded at connection time and never at Layer construction. */
export const playwright = (options: PlaywrightOptions = {}): BrowserBinding => {
  const { resolveEndpoint, onConnected } = options;

  return issueBinding(
    { _tag: "BrowserbaseBrowserBinding" },
    {
      connect: (request) =>
        Effect.gen(function* () {
          const validated = yield* invalid(request.connection);

          const endpoint =
            resolveEndpoint === undefined
              ? validated
              : yield* resolveEndpoint({ url: Redacted.make(validated) });

          return yield* fromNativeAttempt((attempt, signal) =>
            connectPlaywrightEndpoint(
              endpoint,
              signal,
              attempt.options,
              attempt.events,
              onConnected === undefined ? undefined : (native) => onConnected({ native, endpoint }),
            ),
          ).connect(request);
        }),
    },
  );
};

const defaultBinding = playwright();

/** Defaults to Playwright with the provider's own address, so no consumer has to provide it. */
export const BrowserbaseBrowserBinding = Context.Reference<BrowserBinding>(
  "effect-browserbase/BrowserBinding",
  { defaultValue: () => defaultBinding },
);

/** Supply a binding to every browser Layer built beneath it. */
export const layer = (binding: BrowserBinding): Layer.Layer<never> =>
  Layer.succeed(BrowserbaseBrowserBinding, binding);

export const layerPlaywright: Layer.Layer<never> = layer(defaultBinding);
