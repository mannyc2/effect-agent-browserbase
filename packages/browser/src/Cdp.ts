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
import { BrowserError, Failed, type Reason } from "./BrowserError.ts";
import { reasonOf } from "./Page.ts";

export interface Options extends Browser.Options {
  /**
   * `ws://`, `wss://` or `http://` DevTools endpoint. Often a credential, so it may be redacted;
   * connect failures never include its userinfo, path or query.
   */
  readonly endpoint: string | Redacted.Redacted<string>;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Identifies the session in `Browser.id`. Defaults to `"cdp"`. */
  readonly id?: string | undefined;
  readonly provider?: string | undefined;
  /** Bound on connecting. Defaults to 30 seconds. */
  readonly connectTimeoutMillis?: number | undefined;
}

const urls = /[a-z][a-z\d+.-]*:\/\/[^\s"'<>]+/gi;

/**
 * Playwright can echo the endpoint, or a URL derived from it with its query, userinfo or path, in
 * a connect failure. Those parts are often the credential, so a URL keeps its scheme, host and
 * port, and any other echo of the endpoint is replaced.
 */
const withoutEndpoint = (endpoint: string, reason: Reason): Reason => {
  if (reason._tag !== "Failed") return reason;

  const origins = reason.detail.replace(urls, (url) => {
    const parsed = URL.parse(url);

    return parsed === null || parsed.host === "" ? "<url>" : `${parsed.protocol}//${parsed.host}`;
  });

  return new Failed({
    detail: endpoint === "" ? origins : origins.replaceAll(endpoint, "<endpoint>"),
  });
};

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

  const timeout = options.connectTimeoutMillis ?? 30_000;

  const failed = (cause: unknown, timeoutMillis?: number) =>
    new BrowserError({
      operation: "connect",
      reason: withoutEndpoint(endpoint, reasonOf(cause, timeoutMillis)),
      dispatched: false,
    });

  const connected = yield* Effect.acquireRelease(
    Effect.tryPromise({
      try: () =>
        chromium.connectOverCDP(endpoint, {
          timeout,
          ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
        }),
      catch: (cause) => failed(cause, timeout),
    }),
    (browser) => Effect.tryPromise(() => browser.close()).pipe(Effect.ignore),
  );

  const context =
    connected.contexts()[0] ??
    (yield* Effect.tryPromise({
      try: () => connected.newContext(),
      catch: (cause) => failed(cause),
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
