import { Effect, Redacted, Schema } from "effect";

import type { BrowserbaseClient } from "../../Client.ts";
import { ClientError } from "../../Errors.ts";
import { Identifier, type SessionReference } from "../../References.ts";
import { browserRequestFailure } from "./RequestFailure.ts";

const LiveUrl = Schema.String.check(
  Schema.isMaxLength(16384),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "https:" &&
        !url.username &&
        !url.password &&
        (url.hostname === "browserbase.com" || url.hostname.endsWith(".browserbase.com"))
      );
    } catch {
      return false;
    }
  }),
);

const Live = Schema.Struct({
  debuggerFullscreenUrl: LiveUrl,
  pages: Schema.Array(Schema.Struct({ id: Identifier, debuggerFullscreenUrl: LiveUrl })).check(
    Schema.isMaxLength(64),
  ),
});

export interface LiveView {
  readonly session: Redacted.Redacted<string>;
  readonly pages: ReadonlyArray<{
    readonly liveViewPageId: string;
    readonly url: Redacted.Redacted<string>;
  }>;
  readonly requestedTtlSeconds: number;
}

/**
 * Issuing a debugger URL is an authorization step, not proof that an operator took control.
 * The URL is redacted here so it cannot be logged or returned as an ordinary model value.
 */
export const issueLiveUrls = Effect.fnUntraced(function* (
  client: BrowserbaseClient["Service"],
  reference: SessionReference,
  expiresInSeconds: number,
) {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 21600)
    return yield* ClientError.make({
      operation: "provider-read",
      reason: "configuration",
      outcome: "undispatched",
    });
  if (reference.projectId !== client.projectId)
    return yield* ClientError.make({
      operation: "provider-read",
      reason: "authorization",
      outcome: "undispatched",
    });

  const raw = yield* client.json(
    "GET",
    `/v1/sessions/${encodeURIComponent(reference.sessionId)}/debug?expiresIn=${expiresInSeconds}`,
  );

  const value = yield* Schema.decodeUnknownEffect(Live)(raw).pipe(
    Effect.mapError(() => ClientError.make({ operation: "provider-read", reason: "malformed" })),
  );

  return {
    session: Redacted.make(value.debuggerFullscreenUrl),
    pages: value.pages.map((page) => ({
      liveViewPageId: page.id,
      url: Redacted.make(page.debuggerFullscreenUrl),
    })),
    requestedTtlSeconds: expiresInSeconds,
  } satisfies LiveView;
});

export const issueLiveView = (
  client: BrowserbaseClient["Service"],
  reference: SessionReference,
  expiresInSeconds: number,
) =>
  issueLiveUrls(client, reference, expiresInSeconds).pipe(
    Effect.mapError((error) => browserRequestFailure("live-view", error)),
  );
