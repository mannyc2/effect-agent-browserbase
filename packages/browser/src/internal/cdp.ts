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

export interface Options extends Browser.Options, Pick<ConnectOptions, "headers"> {
  /**
   * `ws://`, `wss://` or `http://` DevTools endpoint. Often a credential, so it may be redacted;
   * connect failures never include its userinfo, path or query.
   */
  readonly endpoint: string | Redacted.Redacted<string>;
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

/** Runtime facades supply the default transport; the shared lifetime imports no Node transport. */
export const make = (defaultConnect?: Connector) => {
  const open = Effect.fn("Cdp.open")(function* (options: Options) {
    const endpoint = Redacted.isRedacted(options.endpoint)
      ? Redacted.value(options.endpoint)
      : options.endpoint;

    const timeout = options.connectTimeoutMillis ?? 30_000;
    const connector = options.connect ?? defaultConnect;
    const headers = options.headers === undefined ? undefined : { ...options.headers };

    const invalid = (detail: string) =>
      undispatched("connect", new Errors.InvalidRequest({ detail }));

    if (!Number.isFinite(timeout) || timeout <= 0)
      return yield* invalid("connectTimeoutMillis must be finite and greater than zero");
    if (connector === undefined)
      return yield* invalid("This runtime requires a CDP connect callback");

    // Inspect before URL normalization or truncation. Withhold an echoed diagnostic entirely so
    // overlapping header values cannot leave fragments; other URLs keep only their scheme and host.
    const redact = (message: string) => {
      if (Object.values(headers ?? {}).some((value) => value !== "" && message.includes(value)))
        return "CDP diagnostic withheld";

      const origins = message.replace(Url.quoted, (url) => {
        const parsed = URL.parse(url);

        return parsed?.host ? `${parsed.protocol}//${parsed.host}` : "<url>";
      });

      return endpoint === "" ? origins : origins.replaceAll(endpoint, "<endpoint>");
    };

    const failed = (cause: unknown, timeoutMillis?: number) =>
      undispatched("connect", reasonOf(cause, timeoutMillis, "connection", redact));

    // The endpoint is often a credential, so the connect span names no part of it.
    const connected = yield* Effect.acquireRelease(
      Effect.tryPromise({
        try: (signal) =>
          connector(endpoint, {
            timeout,
            signal,
            ...(headers === undefined ? {} : { headers: { ...headers } }),
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
