/**
 * A browser reached over the Chrome DevTools Protocol: a Chrome started with
 * `--remote-debugging-port`, or any provider that hands out a CDP WebSocket URL.
 *
 * Closing the scope disconnects. It does not close the remote browser; its owner does that.
 *
 * @since 0.3.0
 */
import { Effect, Layer, Redacted } from "effect";
import { chromium } from "playwright-core";

import * as Browser from "./Browser.ts";
import { BrowserError } from "./BrowserError.ts";
import { reasonOf } from "./Page.ts";

export interface Options extends Browser.Options {
  /** `ws://`, `wss://` or `http://` DevTools endpoint. Often a credential, so it may be redacted. */
  readonly endpoint: string | Redacted.Redacted<string>;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Identifies the session in `Browser.id`. Defaults to `"cdp"`. */
  readonly id?: string | undefined;
  readonly provider?: string | undefined;
  /** Bound on connecting. Defaults to 30 seconds. */
  readonly connectTimeoutMillis?: number | undefined;
}

/** Connect and open a `Browser` over the endpoint's first context. */
export const open = Effect.fn("Cdp.open")(function* (
  options: Options,
  // Constructor metadata belongs to the provider. Merely connecting or observing a blank URL
  // cannot establish freshness; attach paths leave this at the borrowed default.
  metadata: { readonly contextOrigin?: Browser.ContextOrigin | undefined } = {},
) {
  const endpoint = Redacted.isRedacted(options.endpoint)
    ? Redacted.value(options.endpoint)
    : options.endpoint;

  const connected = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        chromium.connectOverCDP(endpoint, {
          timeout: options.connectTimeoutMillis ?? 30_000,
          ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
        }),
      catch: (cause) =>
        new BrowserError({ operation: "connect", reason: reasonOf(cause), dispatched: false }),
    }),
    (browser) => Effect.tryPromise(() => browser.close()).pipe(Effect.ignore),
  );

  const context =
    connected.contexts()[0] ??
    (yield* Effect.tryPromise({
      try: () => connected.newContext(),
      catch: (cause) =>
        new BrowserError({ operation: "connect", reason: reasonOf(cause), dispatched: false }),
    }));

  return yield* Browser.make(
    context,
    {
      id: options.id ?? "cdp",
      provider: options.provider ?? "cdp",
      contextOrigin: metadata.contextOrigin,
    },
    options,
  );
});

export const layer = (options: Options): Layer.Layer<Browser.Browser, BrowserError> =>
  Layer.effect(Browser.Browser, open(options));
