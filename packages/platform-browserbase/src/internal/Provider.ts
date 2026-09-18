import { Effect, Redacted, Schema } from "effect";
import { AllocationAttempt, BrowserbaseError, CleanupResult, Identifier, SessionReference, SessionStatus } from "../Types.ts";
import { decode, type Http } from "./Http.ts";
import { deadlineAfter, nowMillis, within } from "./Deadline.ts";

const Metadata = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  status: SessionStatus,
  connectUrl: Schema.optionalKey(Schema.Unknown),
  expiresAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
});
const Allocated = Schema.Struct({ id: Identifier, projectId: Identifier, connectUrl: Schema.optionalKey(Schema.Unknown) });
const LiveURL = Schema.String.check(Schema.isMaxLength(16384), Schema.makeFilter((value) => {
  try {
    const u = new URL(value);
    return u.protocol === "https:" && !u.username && !u.password &&
      (u.hostname === "browserbase.com" || u.hostname.endsWith(".browserbase.com"));
  } catch { return false; }
}));
const Live = Schema.Struct({
  debuggerFullscreenUrl: LiveURL,
  pages: Schema.Array(Schema.Struct({
    id: Identifier, debuggerFullscreenUrl: LiveURL,
  })).check(Schema.isMaxLength(64)),
});

export const terminal = (status: SessionStatus): boolean =>
  status === "COMPLETED" || status === "ERROR" || status === "TIMED_OUT";

export interface SessionSettings {
  readonly recordSession: boolean;
  readonly keepAlive: boolean;
  readonly context?: { readonly id: string; readonly persist: boolean };
  readonly viewport: { readonly width: number; readonly height: number };
}

export const makeProvider = (http: Http, projectId: string) => {
  const reference = (value: { id: string; projectId: string }) => SessionReference.make({
    provider: "browserbase", projectId: value.projectId, sessionId: value.id,
  });
  const check = (ref: SessionReference, data: typeof Metadata.Type) => {
    if (ref.projectId !== projectId || data.projectId !== ref.projectId || data.id !== ref.sessionId) {
      return Effect.fail(BrowserbaseError.make({ operation: "session-identity", reason: "malformed" }));
    }
    return Effect.succeed(data);
  };
  const metadata = (ref: SessionReference, deadline?: number) =>
    decode(SessionReference, ref, "session-identity").pipe(
      Effect.flatMap((r) => r.projectId !== projectId ?
        Effect.fail(BrowserbaseError.make({ operation: "session-identity", reason: "authorization" })) :
        http.json("GET", `/v1/sessions/${encodeURIComponent(r.sessionId)}`, undefined, deadline)),
      Effect.flatMap((value) => decode(Metadata, value, "session-metadata")),
      Effect.flatMap((value) => check(ref, value)),
    );

  const create = (attempt: AllocationAttempt, settings: SessionSettings, known: (ref: SessionReference) => void) =>
    Effect.uninterruptibleMask((restore) => Effect.gen(function* () {
      const raw = yield* restore(http.json("POST", "/v1/sessions", {
        projectId, timeout: attempt.timeoutSeconds, keepAlive: settings.keepAlive,
        proxies: false,
        browserSettings: {
          recordSession: settings.recordSession, logSession: false, solveCaptchas: false,
          viewport: settings.viewport,
          ...(settings.context === undefined ? {} : { context: settings.context }),
        },
        userMetadata: { effectAgentAttempt: attempt.attemptId },
      }));
      const value = yield* decode(Allocated, raw, "session-create");
      const ref = reference(value);
      // The owner's finalizer is installed before POST; retain identity before validating anything else.
      known(ref);
      if (value.projectId !== projectId) return yield* BrowserbaseError.make({ operation: "session-create", reason: "malformed" });
      return { reference: ref, connection: Redacted.make(value.connectUrl) };
    }));

  const release = (ref: SessionReference) => http.json("POST", `/v1/sessions/${encodeURIComponent(ref.sessionId)}`, {
    projectId: ref.projectId, status: "REQUEST_RELEASE",
  }).pipe(
    Effect.flatMap((value) => decode(Metadata, value, "release")),
    Effect.flatMap((value) => check(ref, value)),
  );

  const reconcile = Effect.fnUntraced(function* (ref: SessionReference, requestRelease = true) {
    yield* decode(SessionReference, ref, "release");
    if (ref.projectId !== projectId) return yield* BrowserbaseError.make({ operation: "release", reason: "authorization" });
    const deadline = yield* deadlineAfter(8000);
    let requested = false;
    let status: SessionStatus | undefined;
    let error: BrowserbaseError | undefined;
    if (requestRelease) {
      const result = yield* within(release(ref), deadline, "release").pipe(Effect.result);
      if (result._tag === "Success") { requested = true; status = result.success.status; }
      else error = result.failure;
    }
    // Accepted release and a broken local CDP connection are not terminal evidence.
    for (let reads = 0; !terminalStatus(status) && reads < 5 && (yield* nowMillis) < deadline; reads++) {
      const result = yield* metadata(ref, deadline).pipe(Effect.result);
      if (result._tag === "Success") { status = result.success.status; error = undefined; }
      else { error = result.failure; if (error.reason === "authorization" || error.reason === "not-found") break; }
      if (!terminalStatus(status)) yield* within(Effect.sleep(250), deadline, "release").pipe(Effect.ignore);
    }
    return CleanupResult.make({
      reference: ref, releaseRequested: requested,
      remote: terminalStatus(status) ? "confirmed" : status === undefined ? "unknown" : "pending",
      local: "not-connected",
      ...(status === undefined ? {} : { observedStatus: status }),
      ...(error === undefined ? {} : { error }),
    });
  });

  const liveView = Effect.fnUntraced(function* (ref: SessionReference, expiresInSeconds: number) {
    if (!Number.isSafeInteger(expiresInSeconds) || expiresInSeconds < 1 || expiresInSeconds > 21600) {
      return yield* BrowserbaseError.make({ operation: "live-view", reason: "configuration" });
    }
    yield* metadata(ref);
    const value = yield* http.json("GET", `/v1/sessions/${encodeURIComponent(ref.sessionId)}/debug?expiresIn=${expiresInSeconds}`).pipe(
      Effect.flatMap((raw) => decode(Live, raw, "live-view")),
    );
    return {
      session: Redacted.make(value.debuggerFullscreenUrl),
      pages: value.pages.map((page) => ({ liveViewPageId: page.id, url: Redacted.make(page.debuggerFullscreenUrl) })),
      requestedTtlSeconds: expiresInSeconds,
    };
  });
  return { create, metadata, release, reconcile, liveView, http };
};

const terminalStatus = (status: SessionStatus | undefined) => status !== undefined && terminal(status);
export type Provider = ReturnType<typeof makeProvider>;
