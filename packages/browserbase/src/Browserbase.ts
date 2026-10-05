/**
 * A `Browser` running on Browserbase.
 *
 * `open` creates a session and connects to it over CDP. When its scope closes it disconnects and
 * releases the session, so billing stops then rather than at the session's timeout.
 *
 * @since 0.3.0
 */
import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import * as Cdp from "effect-browser/Cdp";

import { BrowserbaseClient, type Session, type SessionOptions } from "./BrowserbaseClient.ts";
import { BrowserbaseError, Decode } from "./BrowserbaseError.ts";

export interface Options extends Browser.Options {
  readonly session?: SessionOptions | undefined;
  /** Bound on connecting to the session. Defaults to 30 seconds. */
  readonly connectTimeoutMillis?: number | undefined;
}

const connect = (
  operation: string,
  session: Session,
  options: Options,
  contextOrigin: Browser.ContextOrigin,
) =>
  session.connectUrl === undefined
    ? Effect.fail(
        new BrowserbaseError({
          operation,
          reason: new Decode({ detail: `session ${session.id} has no connectUrl` }),
        }),
      )
    : Cdp.open(
        {
          ...options,
          endpoint: session.connectUrl,
          id: session.id,
          provider: "browserbase",
        },
        { contextOrigin },
      );

/** Create a session and open a `Browser` on it, for as long as the scope is open. */
export const open = Effect.fn("Browserbase.open")(function* (options: Options = {}) {
  const client = yield* BrowserbaseClient;

  const session = yield* Effect.acquireRelease(client.createSession(options.session), (session) =>
    client
      .releaseSession(session.id)
      .pipe(Effect.ignore({ log: "Warn", message: "Browserbase session release failed" })),
  );

  return yield* connect("open", session, options, "fresh");
});

/**
 * Open a `Browser` on a session that already exists, such as a `keepAlive` session. Closing the
 * scope disconnects and leaves the session running.
 */
export const attach = Effect.fn("Browserbase.attach")(function* (
  sessionId: string,
  options: Options = {},
) {
  const client = yield* BrowserbaseClient;
  const session = yield* client.getSession(sessionId);

  return yield* connect("attach", session, options, "borrowed");
});

export const layer = (
  options: Options = {},
): Layer.Layer<Browser.Browser, BrowserError | BrowserbaseError, BrowserbaseClient> =>
  Layer.effect(Browser.Browser, open(options));
