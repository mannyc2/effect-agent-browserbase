import { Clock, Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import type { ClientError } from "./Errors.ts";
import { SessionError } from "./Errors.ts";
import { issueLiveUrls, type LiveView } from "./internal/browser/LiveView.ts";
export type { LiveView } from "./internal/browser/LiveView.ts";
import { SessionReference } from "./References.ts";
import {
  ProviderSession,
  SessionMetadata,
  SessionStatus,
  isTerminalSessionStatus,
} from "./SessionData.ts";
export { SessionMetadata, SessionStatus, isTerminalSessionStatus } from "./SessionData.ts";

export const SessionListQuery = Schema.Struct({
  status: Schema.optionalKey(SessionStatus),
  q: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
});

export type SessionListQuery = typeof SessionListQuery.Type;

export const SessionWaitOptions = Schema.Struct({
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 })),
  pollIntervalMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 25, maximum: 5000 })),
  ),
});

export type SessionWaitOptions = typeof SessionWaitOptions.Type;

const Millis = Schema.Finite;

/**
 * One CDP-level log entry. Protocol payloads are present only when requested: they carry
 * page content, cookies and typed input, so they are host evidence, never model input.
 */
export class SessionLogEntry extends Schema.Class<SessionLogEntry>("BrowserbaseSessionLogEntry")({
  method: Schema.String.check(Schema.isMaxLength(256)),
  pageId: Schema.Int,
  frameId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  loaderId: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(256))),
  timestamp: Schema.optionalKey(Millis),
  requestTimestamp: Schema.optionalKey(Millis),
  responseTimestamp: Schema.optionalKey(Millis),
  params: Schema.optionalKey(Schema.Json),
  result: Schema.optionalKey(Schema.Json),
}) {}

const ProviderLog = Schema.Struct({
  method: SessionLogEntry.fields.method,
  pageId: Schema.Int,
  sessionId: Schema.String,
  frameId: SessionLogEntry.fields.frameId,
  loaderId: SessionLogEntry.fields.loaderId,
  timestamp: Schema.optionalKey(Millis),
  request: Schema.optionalKey(
    Schema.Struct({
      params: Schema.optionalKey(Schema.Json),
      timestamp: Schema.optionalKey(Millis),
    }),
  ),
  response: Schema.optionalKey(
    Schema.Struct({
      result: Schema.optionalKey(Schema.Json),
      timestamp: Schema.optionalKey(Millis),
    }),
  ),
});

export interface SessionLogOptions {
  /** Include CDP `params`/`result` payloads. Off by default; see `SessionLogEntry`. */
  readonly includePayloads?: boolean;
}

const now = Clock.monotonicTimeNanos.pipe(Effect.map((value) => Number(value) / 1000000));

const fromClient = (operation: SessionError["operation"], error: ClientError): SessionError =>
  SessionError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

const malformed = (operation: SessionError["operation"], mutation = false) =>
  SessionError.make({
    operation,
    reason: "malformed",
    ...(mutation ? { outcome: "unknown" as const } : {}),
  });

const configuration = (operation: SessionError["operation"]) =>
  SessionError.make({ operation, reason: "configuration", outcome: "undispatched" });

/** Passive inspection never releases a remote session. Release is a separate explicit mutation. */
export class BrowserbaseSessions extends Context.Service<
  BrowserbaseSessions,
  {
    readonly retrieve: (
      reference: SessionReference,
    ) => Effect.Effect<SessionMetadata, SessionError>;
    readonly list: (
      query?: SessionListQuery,
    ) => Effect.Effect<ReadonlyArray<SessionMetadata>, SessionError>;
    readonly requestRelease: (
      reference: SessionReference,
    ) => Effect.Effect<SessionMetadata, SessionError>;
    readonly waitForTerminal: (
      reference: SessionReference,
      options: SessionWaitOptions,
    ) => Effect.Effect<SessionMetadata, SessionError>;
    readonly waitUntilRunning: (
      reference: SessionReference,
      options: SessionWaitOptions,
    ) => Effect.Effect<SessionMetadata, SessionError>;
    /** Session logs, bounded by the 1 MiB control-plane reply limit (`reason: "limit"`). */
    readonly logs: (
      reference: SessionReference,
      options?: SessionLogOptions,
    ) => Effect.Effect<ReadonlyArray<SessionLogEntry>, SessionError>;
    /**
     * Redacted Live View URLs for any session in the project, owned or not. Issuing a URL
     * grants view and input access to whoever holds it; it does not pause automation.
     */
    readonly liveUrls: (
      reference: SessionReference,
      expiresInSeconds?: number,
    ) => Effect.Effect<LiveView, SessionError>;
  }
>()("effect-browserbase/Sessions") {
  static readonly layer: Layer.Layer<BrowserbaseSessions, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseSessions,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const validate = Effect.fnUntraced(function* (
        reference: SessionReference,
        operation: SessionError["operation"],
      ) {
        const ref = yield* Schema.decodeEffect(SessionReference)(reference, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration(operation)));

        if (ref.projectId !== client.projectId)
          return yield* SessionError.make({
            operation,
            reason: "authorization",
            outcome: "undispatched",
          });

        return ref;
      });

      const decode = Effect.fnUntraced(function* (
        raw: unknown,
        operation: SessionError["operation"],
        expected?: SessionReference,
        mutation = false,
      ) {
        const value = yield* Schema.decodeUnknownEffect(ProviderSession)(raw).pipe(
          Effect.mapError(() => malformed(operation, mutation)),
        );

        if (
          value.projectId !== client.projectId ||
          (expected !== undefined &&
            (value.id !== expected.sessionId || value.projectId !== expected.projectId))
        )
          return yield* malformed(operation, mutation);
        const { id, projectId, ...metadata } = value;

        return SessionMetadata.make({
          reference: SessionReference.make({ provider: "browserbase", projectId, sessionId: id }),
          ...metadata,
        });
      });

      const read = Effect.fnUntraced(function* (reference: SessionReference, deadline?: number) {
        const ref = yield* validate(reference, "session-retrieve");

        const raw = yield* client
          .json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, undefined, deadline)
          .pipe(Effect.mapError((error) => fromClient("session-retrieve", error)));

        return yield* decode(raw, "session-retrieve", ref);
      });

      const retrieve = Effect.fn("BrowserbaseSessions.retrieve")(function* (
        reference: SessionReference,
      ) {
        return yield* read(reference);
      });

      const list = Effect.fn("BrowserbaseSessions.list")(function* (query: SessionListQuery = {}) {
        const checked = yield* Schema.decodeEffect(SessionListQuery)(query, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration("session-list")));

        const search = new URLSearchParams();

        if (checked.status !== undefined) search.set("status", checked.status);
        if (checked.q !== undefined) search.set("q", checked.q);

        const raw = yield* client
          .json("GET", `/v1/sessions${search.size === 0 ? "" : `?${search}`}`)
          .pipe(Effect.mapError((error) => fromClient("session-list", error)));

        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ProviderSession).check(Schema.isMaxLength(1024)),
        )(raw).pipe(Effect.mapError(() => malformed("session-list")));

        if (new Set(rows.map((row) => row.id)).size !== rows.length)
          return yield* malformed("session-list");
        const output: SessionMetadata[] = [];

        for (const row of rows) output.push(yield* decode(row, "session-list"));

        return output;
      });

      const requestRelease = Effect.fn("BrowserbaseSessions.requestRelease")(function* (
        reference: SessionReference,
      ) {
        const ref = yield* validate(reference, "session-release");

        const raw = yield* client
          .json("POST", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, {
            projectId: ref.projectId,
            status: "REQUEST_RELEASE",
          })
          .pipe(Effect.mapError((error) => fromClient("session-release", error)));

        return yield* decode(raw, "session-release", ref, true);
      });

      const wait = Effect.fnUntraced(function* (
        reference: SessionReference,
        options: SessionWaitOptions,
        untilRunning: boolean,
      ) {
        const bounds = yield* Schema.decodeEffect(SessionWaitOptions)(options, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration("session-wait")));

        const deadline = (yield* now) + bounds.timeoutMillis;

        for (;;) {
          const remaining = deadline - (yield* now);

          if (remaining <= 0)
            return yield* SessionError.make({ operation: "session-wait", reason: "timeout" });

          // The deadline bounds the provider read too, not just sleeps between reads.
          const metadata = yield* read(reference, deadline).pipe(
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () =>
                Effect.fail(SessionError.make({ operation: "session-wait", reason: "timeout" })),
            }),
          );

          if (
            untilRunning ? metadata.status === "RUNNING" : isTerminalSessionStatus(metadata.status)
          )
            return metadata;
          if (untilRunning && isTerminalSessionStatus(metadata.status))
            return yield* SessionError.make({ operation: "session-wait", reason: "expired" });
          yield* Effect.sleep(
            Math.max(0, Math.min(bounds.pollIntervalMillis ?? 250, deadline - (yield* now))),
          );
        }
      });

      const logs = Effect.fn("BrowserbaseSessions.logs")(function* (
        reference: SessionReference,
        options: SessionLogOptions = {},
      ) {
        const ref = yield* validate(reference, "session-logs");

        const raw = yield* client
          .json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/logs`)
          .pipe(Effect.mapError((error) => fromClient("session-logs", error)));

        const rows = yield* Schema.decodeUnknownEffect(
          Schema.Array(ProviderLog).check(Schema.isMaxLength(100_000)),
        )(raw).pipe(Effect.mapError(() => malformed("session-logs")));

        if (rows.some((row) => row.sessionId !== ref.sessionId))
          return yield* malformed("session-logs");

        return rows.map((row) =>
          SessionLogEntry.make({
            method: row.method,
            pageId: row.pageId,
            ...(row.frameId === undefined ? {} : { frameId: row.frameId }),
            ...(row.loaderId === undefined ? {} : { loaderId: row.loaderId }),
            ...(row.timestamp === undefined ? {} : { timestamp: row.timestamp }),
            ...(row.request?.timestamp === undefined
              ? {}
              : { requestTimestamp: row.request.timestamp }),
            ...(row.response?.timestamp === undefined
              ? {}
              : { responseTimestamp: row.response.timestamp }),
            ...(options.includePayloads === true && row.request?.params !== undefined
              ? { params: row.request.params }
              : {}),
            ...(options.includePayloads === true && row.response?.result !== undefined
              ? { result: row.response.result }
              : {}),
          }),
        );
      });

      const liveUrls = Effect.fn("BrowserbaseSessions.liveUrls")(function* (
        reference: SessionReference,
        expiresInSeconds = 300,
      ) {
        const ref = yield* validate(reference, "session-live-view");

        return yield* issueLiveUrls(client, ref, expiresInSeconds).pipe(
          Effect.mapError((error) => fromClient("session-live-view", error)),
        );
      });

      return BrowserbaseSessions.of({
        logs,
        liveUrls,
        retrieve,
        list,
        requestRelease,
        waitForTerminal: (ref, options) => wait(ref, options, false),
        waitUntilRunning: (ref, options) => wait(ref, options, true),
      });
    }),
  );
}
