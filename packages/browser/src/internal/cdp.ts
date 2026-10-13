/**
 * A browser reached over the Chrome DevTools Protocol: a Chrome started with
 * `--remote-debugging-port`, or any provider that hands out a CDP WebSocket URL.
 *
 * Closing the scope disconnects. It does not close the remote browser; its owner does that.
 *
 * @since 0.3.0
 */
import { type DateTime, Effect, Layer, Redacted } from "effect";
import type { Browser as PlaywrightBrowser } from "playwright-core";

import * as Browser from "../Browser.ts";
import * as Errors from "../BrowserError.ts";
import { reasonOf, undispatched } from "./page/context.ts";
import * as Url from "./page/url.ts";

/** The runtime connector receives the bound and cancellation signal owned by the opening scope. */
export interface ConnectOptions {
  readonly timeout: number;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  readonly signal: AbortSignal;
}

/**
 * Return a real Playwright CDP browser whose `close()` disconnects without ending the remote
 * browser. Honor `signal` to cancel work; a browser returned after cancellation is disconnected.
 * The endpoint and headers may contain credentials and must not be logged.
 */
export type Connector = (endpoint: string, options: ConnectOptions) => Promise<PlaywrightBrowser>;

export interface Options extends Browser.Options {
  /**
   * `ws://`, `wss://` or `http://` DevTools endpoint. Often a credential, so it may be redacted;
   * connect failures never include its userinfo, path or query.
   */
  readonly endpoint: string | Redacted.Redacted<string>;
  readonly headers?: Readonly<Record<string, string>> | undefined;
  /** Runtime-supplied Playwright connection. Required by the `workerd` entry. */
  readonly connect?: Connector | undefined;
  /** Identifies the session in `Browser.id`. Defaults to `"cdp"`. */
  readonly id?: string | undefined;
  readonly provider?: string | undefined;
  /** Bound on connecting. Defaults to 30 seconds. */
  readonly connectTimeoutMillis?: number | undefined;
  /** When the provider ends the session on its own, as a hosted session's timeout does. */
  readonly expiresAt?: DateTime.Utc | undefined;
  /**
   * A connection apart from this one for the pages' screencasts, as a hosted provider supplies.
   * Without one, each page's capture runs on its own session.
   */
  readonly capture?: Browser.CaptureSource | undefined;
}

/**
 * Playwright can echo the endpoint, or a URL derived from it with its query, userinfo or path, in
 * a connect failure. Those parts are often the credential, so a URL keeps its scheme, host and
 * port, and any other echo of the endpoint is replaced.
 */
const withoutEndpoint = (endpoint: string, reason: Errors.Reason): Errors.Reason => {
  if (reason._tag !== "Failed") return reason;

  const origins = reason.detail.replace(Url.quoted, (url) => {
    const parsed = URL.parse(url);

    return parsed === null || parsed.host === "" ? "<url>" : `${parsed.protocol}//${parsed.host}`;
  });

  return new Errors.Failed({
    detail: endpoint === "" ? origins : origins.replaceAll(endpoint, "<endpoint>"),
  });
};

/** Runtime facades supply the default transport; the shared lifetime imports no Node transport. */
export const make = (defaultConnect?: Connector) => {
  const open = Effect.fn("Cdp.open")(function* (options: Options) {
    const endpoint = Redacted.isRedacted(options.endpoint)
      ? Redacted.value(options.endpoint)
      : options.endpoint;

    const timeout = options.connectTimeoutMillis ?? 30_000;
    const connector = options.connect ?? defaultConnect;

    const invalid = (detail: string) =>
      undispatched("connect", new Errors.InvalidRequest({ detail }));

    if (!Number.isFinite(timeout) || timeout <= 0)
      return yield* invalid("connectTimeoutMillis must be finite and greater than zero");
    if (connector === undefined)
      return yield* invalid("This runtime requires a CDP connect callback");

    const failed = (cause: unknown, timeoutMillis?: number) =>
      undispatched("connect", withoutEndpoint(endpoint, reasonOf(cause, timeoutMillis)));

    // The endpoint is often a credential, so the connect span names no part of it.
    const connected = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          connector(endpoint, {
            timeout,
            signal,
            ...(options.headers === undefined ? {} : { headers: { ...options.headers } }),
          }).then(async (browser) => {
            // Cancellation can precede a connector that ignores its signal. Its late browser still
            // belongs to this acquisition, so disconnect it before dropping the promise result.
            if (signal.aborted) await browser.close().catch(() => undefined);

            return browser;
          }),
        catch: (cause) => failed(cause, timeout),
      }).pipe(
        Effect.timeoutOrElse({
          duration: timeout,
          orElse: () =>
            Effect.fail(undispatched("connect", new Errors.Timeout({ millis: timeout }))),
        }),
        Effect.withSpan("Cdp.connect", {}, { captureStackTrace: false }),
      ),
      (browser) => Effect.tryPromise(() => browser.close()).pipe(Effect.ignore),
      { interruptible: true },
    );

    const context =
      connected.contexts()[0] ??
      (yield* Effect.tryPromise({
        try: () => connected.newContext(),
        catch: (cause) => failed(cause),
      }));

    const { id = "cdp", provider = "cdp", expiresAt, capture } = options;

    return yield* Browser.make(context, { id, provider, expiresAt, capture }, options);
  });

  const layer = (options: Options): Layer.Layer<Browser.Browser, Errors.BrowserError> =>
    Layer.effect(Browser.Browser, open(options));

  return { open, layer };
};
