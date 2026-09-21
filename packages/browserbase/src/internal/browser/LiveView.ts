import { Effect, Redacted, Schema } from "effect";

import type { BrowserbaseClient } from "../../Client.ts";
import { BrowserError } from "../../Errors.ts";
import { Identifier, type SessionReference } from "../../References.ts";

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
export const issueLiveView = Effect.fnUntraced(function* (
  client: BrowserbaseClient["Service"],
  reference: SessionReference,
  expiresInSeconds: number,
) {
  if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 21600)
    return yield* BrowserError.make({ operation: "live-view", reason: "configuration" });
  if (reference.projectId !== client.projectId)
    return yield* BrowserError.make({ operation: "live-view", reason: "authorization" });

  const raw = yield* client
    .json(
      "GET",
      `/v1/sessions/${encodeURIComponent(reference.sessionId)}/debug?expiresIn=${expiresInSeconds}`,
    )
    .pipe(
      Effect.mapError((error) =>
        BrowserError.make({ operation: "live-view", reason: error.reason }),
      ),
    );

  const value = yield* Schema.decodeUnknownEffect(Live)(raw).pipe(
    Effect.mapError(() => BrowserError.make({ operation: "live-view", reason: "malformed" })),
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
