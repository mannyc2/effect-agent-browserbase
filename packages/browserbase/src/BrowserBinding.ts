import { Context, Effect, Layer, Redacted } from "effect";
import * as BrowserRuntime from "effect-browser/browser-runtime";
import { BrowserError, Reasons } from "effect-browser/errors";

import { validateConnection } from "./internal/provider/Connection.ts";

export type BrowserBinding = BrowserRuntime.BrowserBinding;
export type PlaywrightOptions = BrowserRuntime.PlaywrightOptions;

/** Validate provider authority before invoking any trusted host routing. */
export const playwright = (options: PlaywrightOptions = {}): BrowserBinding => {
  const { resolveEndpoint, onConnected } = options;

  return BrowserRuntime.playwright({
    resolveEndpoint: ({ url }) =>
      Effect.gen(function* () {
        const validated = yield* Effect.try({
          try: () => validateConnection(Redacted.value(url)),
          catch: (error) =>
            error instanceof BrowserError
              ? error
              : BrowserError.make({
                  operation: "connect",
                  reason: Reasons.Malformed.make({}),
                  outcome: "undispatched",
                }),
        });

        return yield* resolveEndpoint === undefined
          ? Effect.succeed(validated)
          : resolveEndpoint({ url: Redacted.make(validated) });
      }),
    ...(onConnected === undefined ? {} : { onConnected }),
  });
};

const defaultBinding = playwright();

export const BrowserbaseBrowserBinding = Context.Reference<BrowserBinding>(
  "effect-browserbase/BrowserBinding",
  { defaultValue: () => defaultBinding },
);

export const layer = (binding: BrowserBinding): Layer.Layer<never> =>
  Layer.succeed(BrowserbaseBrowserBinding, binding);

export const layerPlaywright: Layer.Layer<never> = layer(defaultBinding);
