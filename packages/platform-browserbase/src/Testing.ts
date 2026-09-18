import { Effect, Layer } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { browserbaseInteractiveLayer, type InteractiveOptions } from "./InteractiveBrowser.ts";
import { BrowserbaseError } from "./Types.ts";
import { NativeConnector } from "./internal/Connector.ts";
import { connectEndpoint } from "./internal/Playwright.ts";

/**
 * Local acceptance only: require both an explicit loopback CDP endpoint and a
 * scripted provider transport. This uses the production ownership/control path,
 * not a replacement browser or framework. No browser is launched by this Layer.
 * The caller owns the local Chromium process. Never imported from a production
 * entrypoint, and never a way to broaden production Browserbase URL validation.
 */
export const localCdpLayer = (
  options: InteractiveOptions,
  local: { readonly endpoint: string; readonly fetch: typeof globalThis.fetch },
) => Layer.unwrap(Effect.gen(function* () {
  const endpoint = yield* Effect.try({
    try: () => new URL(local.endpoint),
    catch: () => new BrowserbaseError({ operation: "local-test-endpoint", reason: "configuration" }),
  });

  if (!['ws:', 'http:'].includes(endpoint.protocol) || endpoint.username || endpoint.password ||
      !['127.0.0.1', '[::1]', 'localhost'].includes(endpoint.hostname) || endpoint.hash) {
    return yield* new BrowserbaseError({ operation: "local-test-endpoint", reason: "configuration" });
  }

  return browserbaseInteractiveLayer(options).pipe(
    Layer.provide(Layer.succeed(NativeConnector, (_connection, signal, settings, events) =>
      connectEndpoint(endpoint.href, signal, settings, events))),
    Layer.provide(Layer.succeed(FetchHttpClient.Fetch, local.fetch)),
  );
}));
