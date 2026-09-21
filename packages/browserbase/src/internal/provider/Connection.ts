import { Effect, Redacted, Schema } from "effect";

import type { BrowserbaseClient } from "../../Client.ts";
import { SessionError } from "../../Errors.ts";
import { SessionReference } from "../../References.ts";
import { ProviderSession } from "../../SessionData.ts";
import type { BrowserbaseSessions } from "../../Sessions.ts";
import { deadlineAfter, nowMillis, until } from "../Deadline.ts";

const Connection = Schema.Struct({
  ...ProviderSession.fields,
  connectUrl: Schema.String.check(Schema.isMaxLength(16384)),
});

/** A provider-issued endpoint is authority, not a persisted session identifier. */
export const connectionUrl = Schema.String.check(
  Schema.isMaxLength(16384),
  Schema.makeFilter((value) => {
    try {
      const url = new URL(value);

      return (
        url.protocol === "wss:" &&
        !url.username &&
        !url.password &&
        !url.port &&
        !url.hash &&
        url.hostname.endsWith(".browserbase.com")
      );
    } catch {
      return false;
    }
  }),
);

export const connectionAddress = Effect.fnUntraced(function* (
  client: BrowserbaseClient["Service"],
  sessions: BrowserbaseSessions["Service"],
  reference: SessionReference,
  timeoutMillis: number,
) {
  const fail = (reason: SessionError["reason"]) =>
    SessionError.make({ operation: "session-connect", reason });

  const ref = yield* Schema.decodeEffect(SessionReference)(reference).pipe(
    Effect.mapError(() => fail("configuration")),
  );

  if (ref.projectId !== client.projectId) return yield* fail("authorization");
  const deadline = yield* deadlineAfter(timeoutMillis);

  yield* sessions.waitUntilRunning(ref, { timeoutMillis });
  if ((yield* nowMillis) >= deadline) return yield* fail("timeout");

  const raw = yield* until(
    client.json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, undefined, deadline),
    deadline,
    () => fail("timeout"),
  ).pipe(Effect.mapError((error) => fail(error.reason)));

  const value = yield* Schema.decodeUnknownEffect(Connection)(raw).pipe(
    Effect.mapError(() => fail("malformed")),
  );

  if (value.id !== ref.sessionId || value.projectId !== ref.projectId)
    return yield* fail("malformed");
  if (value.status !== "RUNNING") return yield* fail("expired");

  const url = yield* Schema.decodeEffect(connectionUrl)(value.connectUrl).pipe(
    Effect.mapError(() => fail("unsafe-url")),
  );

  return Redacted.make(url);
});
