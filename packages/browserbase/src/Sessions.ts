import { Clock, Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { ClientError, SessionError } from "./Errors.ts";
import { Identifier, SessionReference } from "./References.ts";

export const SessionStatus = Schema.Literals([
  "PENDING",
  "RUNNING",
  "ERROR",
  "TIMED_OUT",
  "COMPLETED",
]);
export type SessionStatus = typeof SessionStatus.Type;

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const Region = Schema.Literals(["us-west-2", "us-east-1", "eu-central-1", "ap-southeast-1"]);
const ProviderSession = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  status: SessionStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  keepAlive: Schema.Boolean,
  proxyBytes: Schema.Finite,
  region: Region,
  contextId: Schema.optionalKey(Identifier),
});

export class SessionMetadata extends Schema.Class<SessionMetadata>("BrowserbaseSessionMetadata")({
  reference: SessionReference,
  status: SessionStatus,
  createdAt: Timestamp,
  updatedAt: Timestamp,
  expiresAt: Timestamp,
  startedAt: Timestamp,
  endedAt: Schema.optionalKey(Timestamp),
  keepAlive: Schema.Boolean,
  proxyBytes: Schema.Finite,
  region: Region,
  contextId: Schema.optionalKey(Identifier),
}) {}

export const SessionListQuery = Schema.Struct({
  status: Schema.optionalKey(SessionStatus),
  q: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(2048))),
});
export type SessionListQuery = typeof SessionListQuery.Type;

const WaitOptions = Schema.Struct({
  timeoutMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  pollIntervalMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 25, maximum: 5_000 })),
  ),
});

const nowMillis = Clock.monotonicTimeNanos.pipe(Effect.map((value) => Number(value) / 1_000_000));

export const isTerminalSessionStatus = (status: SessionStatus): boolean =>
  status === "COMPLETED" || status === "ERROR" || status === "TIMED_OUT";

const fromClient = (operation: string, error: ClientError): SessionError =>
  SessionError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

const malformed = (operation: string) => SessionError.make({ operation, reason: "malformed" });
const configuration = (operation: string) =>
  SessionError.make({ operation, reason: "configuration", outcome: "undispatched" });

export class BrowserbaseSessions extends Context.Service<
  BrowserbaseSessions,
  {
    readonly retrieve: (reference: SessionReference) => Effect.Effect<SessionMetadata, SessionError>;
    readonly list: (query?: SessionListQuery) => Effect.Effect<ReadonlyArray<SessionMetadata>, SessionError>;
    readonly requestRelease: (reference: SessionReference) => Effect.Effect<SessionMetadata, SessionError>;
    readonly waitForTerminal: (
      reference: SessionReference,
      options: typeof WaitOptions.Type,
    ) => Effect.Effect<SessionMetadata, SessionError>;
  }
>()("@effect-agent/browserbase/Sessions") {
  static readonly layer: Layer.Layer<BrowserbaseSessions, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseSessions,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const validateReference = Effect.fnUntraced(function* (
        reference: SessionReference,
        operation: string,
      ) {
        const decoded = yield* Schema.decodeUnknownEffect(SessionReference)(reference, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration(operation)));
        if (decoded.projectId !== client.projectId) {
          return yield* SessionError.make({
            operation,
            reason: "authorization",
            outcome: "undispatched",
          });
        }
        return decoded;
      });

      const decodeSession = Effect.fnUntraced(function* (
        operation: string,
        expected: SessionReference | undefined,
        raw: unknown,
      ) {
        const value = yield* Schema.decodeUnknownEffect(ProviderSession)(raw).pipe(
          Effect.mapError(() => malformed(operation)),
        );
        if (value.projectId !== client.projectId) return yield* malformed(operation);
        if (
          expected !== undefined &&
          (value.id !== expected.sessionId || value.projectId !== expected.projectId)
        ) {
          return yield* malformed(operation);
        }
        return SessionMetadata.make({
          reference: SessionReference.make({
            provider: "browserbase",
            projectId: value.projectId,
            sessionId: value.id,
          }),
          status: value.status,
          createdAt: value.createdAt,
          updatedAt: value.updatedAt,
          expiresAt: value.expiresAt,
          startedAt: value.startedAt,
          ...(value.endedAt === undefined ? {} : { endedAt: value.endedAt }),
          keepAlive: value.keepAlive,
          proxyBytes: value.proxyBytes,
          region: value.region,
          ...(value.contextId === undefined ? {} : { contextId: value.contextId }),
        });
      });

      const retrieve = Effect.fn("BrowserbaseSessions.retrieve")(function* (
        reference: SessionReference,
      ) {
        const ref = yield* validateReference(reference, "session-retrieve");
        const raw = yield* client
          .json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`)
          .pipe(Effect.mapError((error) => fromClient("session-retrieve", error)));
        return yield* decodeSession("session-retrieve", ref, raw);
      });

      const list = Effect.fn("BrowserbaseSessions.list")(function* (query: SessionListQuery = {}) {
        const decoded = yield* Schema.decodeUnknownEffect(SessionListQuery)(query, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration("session-list")));
        const search = new URLSearchParams();
        if (decoded.status !== undefined) search.set("status", decoded.status);
        if (decoded.q !== undefined) search.set("q", decoded.q);
        const suffix = search.size === 0 ? "" : `?${search.toString()}`;
        const raw = yield* client
          .json("GET", `/v1/sessions${suffix}`)
          .pipe(Effect.mapError((error) => fromClient("session-list", error)));
        const values = yield* Schema.decodeUnknownEffect(
          Schema.Array(ProviderSession).check(Schema.isMaxLength(1024)),
        )(raw).pipe(Effect.mapError(() => malformed("session-list")));
        const result: SessionMetadata[] = [];
        for (const value of values) {
          result.push(yield* decodeSession("session-list", undefined, value));
        }
        return result;
      });

      const requestRelease = Effect.fn("BrowserbaseSessions.requestRelease")(function* (
        reference: SessionReference,
      ) {
        const ref = yield* validateReference(reference, "session-release");
        const raw = yield* client
          .json("POST", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, {
            projectId: ref.projectId,
            status: "REQUEST_RELEASE",
          })
          .pipe(Effect.mapError((error) => fromClient("session-release", error)));
        return yield* decodeSession("session-release", ref, raw);
      });

      const waitForTerminal = Effect.fn("BrowserbaseSessions.waitForTerminal")(function* (
        reference: SessionReference,
        options: typeof WaitOptions.Type,
      ) {
        const bounds = yield* Schema.decodeUnknownEffect(WaitOptions)(options, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration("session-wait")));
        const deadline = (yield* nowMillis) + bounds.timeoutMillis;
        const interval = bounds.pollIntervalMillis ?? 250;

        for (;;) {
          const state = yield* retrieve(reference);
          if (isTerminalSessionStatus(state.status)) return state;
          const remaining = deadline - (yield* nowMillis);
          if (remaining <= 0) {
            return yield* SessionError.make({ operation: "session-wait", reason: "timeout" });
          }
          yield* Effect.sleep(Math.min(interval, remaining));
        }
      });

      return BrowserbaseSessions.of({ retrieve, list, requestRelease, waitForTerminal });
    }),
  );
}
