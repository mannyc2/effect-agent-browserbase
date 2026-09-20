import { Clock, Context, Effect, Layer, Schema } from "effect";
import { BrowserbaseClient } from "./Client.ts";
import { ClientError, SessionError } from "./Errors.ts";
import { SessionReference } from "./References.ts";
import { ProviderSession, SessionMetadata, SessionStatus, isTerminalSessionStatus } from "./SessionData.ts";
export { SessionMetadata, SessionStatus, isTerminalSessionStatus } from "./SessionData.ts";

export const SessionListQuery = Schema.Struct({
  status: Schema.optionalKey(SessionStatus),
  q: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
});
export type SessionListQuery = typeof SessionListQuery.Type;
export const SessionWaitOptions = Schema.Struct({
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 })),
  pollIntervalMillis: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 25, maximum: 5000 }))),
});
export type SessionWaitOptions = typeof SessionWaitOptions.Type;
const now = Clock.monotonicTimeNanos.pipe(Effect.map((value) => Number(value) / 1000000));
const fromClient = (operation: string, error: ClientError): SessionError => SessionError.make({
  operation, reason: error.reason,
  ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
  ...(error.status === undefined ? {} : { status: error.status }),
  ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
});
const malformed = (operation: string, mutation = false) => SessionError.make({ operation, reason: "malformed", ...(mutation ? { outcome: "unknown" as const } : {}) });
const configuration = (operation: string) => SessionError.make({ operation, reason: "configuration", outcome: "undispatched" });

/** Passive inspection never releases a remote session. Release is a separate explicit mutation. */
export class BrowserbaseSessions extends Context.Service<BrowserbaseSessions, {
  readonly retrieve: (reference: SessionReference) => Effect.Effect<SessionMetadata, SessionError>;
  readonly list: (query?: SessionListQuery) => Effect.Effect<ReadonlyArray<SessionMetadata>, SessionError>;
  readonly requestRelease: (reference: SessionReference) => Effect.Effect<SessionMetadata, SessionError>;
  readonly waitForTerminal: (reference: SessionReference, options: SessionWaitOptions) => Effect.Effect<SessionMetadata, SessionError>;
  readonly waitUntilRunning: (reference: SessionReference, options: SessionWaitOptions) => Effect.Effect<SessionMetadata, SessionError>;
}>()("@effect-agent/browserbase/Sessions") {
  static readonly layer: Layer.Layer<BrowserbaseSessions, never, BrowserbaseClient> = Layer.effect(BrowserbaseSessions, Effect.gen(function* () {
    const client = yield* BrowserbaseClient;
    const validate = Effect.fnUntraced(function* (reference: SessionReference, operation: string) {
      const ref = yield* Schema.decodeUnknownEffect(SessionReference)(reference, { onExcessProperty: "error" }).pipe(Effect.mapError(() => configuration(operation)));
      if (ref.projectId !== client.projectId) return yield* SessionError.make({ operation, reason: "authorization", outcome: "undispatched" });
      return ref;
    });
    const decode = Effect.fnUntraced(function* (raw: unknown, operation: string, expected?: SessionReference, mutation = false) {
      const value = yield* Schema.decodeUnknownEffect(ProviderSession)(raw).pipe(Effect.mapError(() => malformed(operation, mutation)));
      if (value.projectId !== client.projectId || (expected !== undefined && (value.id !== expected.sessionId || value.projectId !== expected.projectId))) return yield* malformed(operation, mutation);
      const { id, projectId, ...metadata } = value;
      return SessionMetadata.make({ reference: SessionReference.make({ provider: "browserbase", projectId, sessionId: id }), ...metadata });
    });
    const read = Effect.fnUntraced(function* (reference: SessionReference, deadline?: number) {
      const ref = yield* validate(reference, "session-retrieve");
      const raw = yield* client.json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, undefined, deadline).pipe(Effect.mapError((error) => fromClient("session-retrieve", error)));
      return yield* decode(raw, "session-retrieve", ref);
    });
    const retrieve = Effect.fn("BrowserbaseSessions.retrieve")(function* (reference: SessionReference) { return yield* read(reference); });
    const list = Effect.fn("BrowserbaseSessions.list")(function* (query: SessionListQuery = {}) {
      const checked = yield* Schema.decodeUnknownEffect(SessionListQuery)(query, { onExcessProperty: "error" }).pipe(Effect.mapError(() => configuration("session-list")));
      const search = new URLSearchParams();
      if (checked.status !== undefined) search.set("status", checked.status);
      if (checked.q !== undefined) search.set("q", checked.q);
      const raw = yield* client.json("GET", `/v1/sessions${search.size === 0 ? "" : `?${search}`}`).pipe(Effect.mapError((error) => fromClient("session-list", error)));
      const rows = yield* Schema.decodeUnknownEffect(Schema.Array(ProviderSession).check(Schema.isMaxLength(1024)))(raw).pipe(Effect.mapError(() => malformed("session-list")));
      if (new Set(rows.map((row) => row.id)).size !== rows.length) return yield* malformed("session-list");
      const output: SessionMetadata[] = [];
      for (const row of rows) output.push(yield* decode(row, "session-list"));
      return output;
    });
    const requestRelease = Effect.fn("BrowserbaseSessions.requestRelease")(function* (reference: SessionReference) {
      const ref = yield* validate(reference, "session-release");
      const raw = yield* client.json("POST", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, { projectId: ref.projectId, status: "REQUEST_RELEASE" }).pipe(Effect.mapError((error) => fromClient("session-release", error)));
      return yield* decode(raw, "session-release", ref, true);
    });
    const wait = Effect.fnUntraced(function* (reference: SessionReference, options: SessionWaitOptions, untilRunning: boolean) {
      const bounds = yield* Schema.decodeUnknownEffect(SessionWaitOptions)(options, { onExcessProperty: "error" }).pipe(Effect.mapError(() => configuration("session-wait")));
      const deadline = (yield* now) + bounds.timeoutMillis;
      for (;;) {
        const remaining = deadline - (yield* now);
        if (remaining <= 0) return yield* SessionError.make({ operation: "session-wait", reason: "timeout" });
        // The deadline bounds the provider read too, not just sleeps between reads.
        const metadata = yield* read(reference, deadline).pipe(Effect.timeoutOrElse({
          duration: remaining,
          orElse: () => Effect.fail(SessionError.make({ operation: "session-wait", reason: "timeout" })),
        }));
        if (untilRunning ? metadata.status === "RUNNING" : isTerminalSessionStatus(metadata.status)) return metadata;
        if (untilRunning && isTerminalSessionStatus(metadata.status)) return yield* SessionError.make({ operation: "session-wait", reason: "expired" });
        yield* Effect.sleep(Math.max(0, Math.min(bounds.pollIntervalMillis ?? 250, deadline - (yield* now))));
      }
    });
    return BrowserbaseSessions.of({ retrieve, list, requestRelease,
      waitForTerminal: (ref, options) => wait(ref, options, false),
      waitUntilRunning: (ref, options) => wait(ref, options, true),
    });
  }));
}
