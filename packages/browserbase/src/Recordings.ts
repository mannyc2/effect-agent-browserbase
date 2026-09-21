import { Context, Effect, Layer, Redacted, Schema, Semaphore, Stream } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { ArtifactError, type ClientError } from "./Errors.ts";
import { requireTerminalSession } from "./internal/artifact/Authorization.ts";
import { transferPolicy } from "./internal/artifact/TransferPolicy.ts";
import { deadlineAfter, nowMillis, until } from "./internal/Deadline.ts";
import { Identifier, type SessionReference } from "./References.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import {
  type ArtifactTransferPolicy,
  RecordingBatch,
  RecordingPage,
  RecordingPageReference,
} from "./Transfers.ts";

const RawPage = Schema.Struct({
  pageId: Identifier,
  status: Schema.Literals(["NOT_REQUESTED", "PENDING", "COMPLETED", "FAILED"]),
  completedAt: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(64))),
  downloadUrl: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(16384))),
});

const RawBatch = Schema.Struct({ downloads: Schema.Array(RawPage).check(Schema.isMaxLength(256)) });

export interface PollOptions {
  readonly timeoutMillis?: number;
  readonly intervalMillis?: number;
}

/** Recording transfers share the canonical artifact bounds. */
export type DownloadLimits = ArtifactTransferPolicy;

const failure = (operation: ArtifactError["operation"], reason: ArtifactError["reason"]) =>
  ArtifactError.make({ operation, reason });

const fromClient = (operation: ArtifactError["operation"]) => (error: ClientError) =>
  ArtifactError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

const within = <A, E, R>(
  effect: Effect.Effect<A, E, R>,
  deadline: number,
  operation: ArtifactError["operation"],
) => until(effect, deadline, () => failure(operation, "timeout"));

/** Independent of a live browser. Merely building this Layer performs no provider calls. */
export class BrowserbaseRecordings extends Context.Service<
  BrowserbaseRecordings,
  {
    readonly request: (
      reference: SessionReference,
      mode?: "initial" | "retry-failed",
    ) => Effect.Effect<RecordingBatch, ArtifactError>;
    readonly status: (reference: SessionReference) => Effect.Effect<RecordingBatch, ArtifactError>;
    readonly wait: (
      reference: SessionReference,
      options?: PollOptions,
    ) => Effect.Effect<RecordingBatch, ArtifactError>;
    readonly download: (
      reference: RecordingPageReference,
      limits: DownloadLimits,
    ) => Stream.Stream<Uint8Array, ArtifactError>;
  }
>()("effect-browserbase/Recordings") {
  static readonly layer: Layer.Layer<
    BrowserbaseRecordings,
    never,
    BrowserbaseClient | BrowserbaseSessions
  > = Layer.effect(
    BrowserbaseRecordings,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const sessions = yield* BrowserbaseSessions;
      const requests = yield* Semaphore.make(1);

      const path = (ref: SessionReference) =>
        `/v1/sessions/${encodeURIComponent(ref.sessionId)}/recording/downloads`;

      const read = (ref: SessionReference, deadline?: number) =>
        client.json("GET", path(ref), undefined, deadline).pipe(
          Effect.mapError(fromClient("recording-status")),
          Effect.flatMap((raw) =>
            Schema.decodeUnknownEffect(RawBatch)(raw).pipe(
              Effect.mapError(() => failure("recording-status", "malformed")),
            ),
          ),
          Effect.filterOrFail(
            (raw) =>
              new Set(raw.downloads.map((page) => page.pageId)).size === raw.downloads.length,
            () => failure("recording-status", "malformed"),
          ),
        );

      const project = (ref: SessionReference, raw: typeof RawBatch.Type, timedOut = false) =>
        RecordingBatch.make({
          reference: ref,
          timedOut,
          pages: raw.downloads.map((page) =>
            RecordingPage.make({
              pageId: page.pageId,
              status: page.status,
              delivery:
                page.status !== "COMPLETED"
                  ? "not-ready"
                  : page.downloadUrl === undefined
                    ? "external-storage"
                    : "download",
              ...(page.completedAt === undefined ? {} : { completedAt: page.completedAt }),
            }),
          ),
        });

      const authorize = (ref: SessionReference) =>
        requireTerminalSession(
          sessions,
          ref,
          () => failure("recording", "active"),
          (error) => ArtifactError.make({ operation: "recording", reason: error.reason }),
        );

      const status = Effect.fnUntraced(function* (ref: SessionReference) {
        yield* authorize(ref);

        return project(ref, yield* read(ref));
      });

      const request = (ref: SessionReference, mode: "initial" | "retry-failed" = "initial") =>
        requests.withPermits(1)(
          Effect.gen(function* () {
            if (mode !== "initial" && mode !== "retry-failed")
              return yield* ArtifactError.make({
                operation: "recording-request",
                reason: "configuration",
                outcome: "undispatched",
              });
            yield* authorize(ref);
            // A prior uncertain POST is reconciled by this GET before any resubmission.
            const before = yield* read(ref);

            const needed =
              mode === "retry-failed"
                ? before.downloads.some((page) => page.status === "FAILED")
                : before.downloads.every((page) => page.status === "NOT_REQUESTED");

            if (!needed) return project(ref, before);

            const raw = yield* client.json("POST", path(ref)).pipe(
              Effect.mapError((error) =>
                ArtifactError.make({
                  operation: "recording-request",
                  reason:
                    error.status !== undefined && error.status >= 400 && error.status < 500
                      ? error.reason
                      : "assembly-unknown",
                  outcome:
                    error.status !== undefined && error.status >= 400 && error.status < 500
                      ? "rejected"
                      : "unknown",
                  ...(error.status === undefined ? {} : { status: error.status }),
                  ...(error.retryAfterMillis === undefined
                    ? {}
                    : { retryAfterMillis: error.retryAfterMillis }),
                }),
              ),
              Effect.flatMap((value) =>
                Schema.decodeUnknownEffect(RawBatch)(value).pipe(
                  Effect.mapError(() =>
                    ArtifactError.make({
                      operation: "recording-request",
                      reason: "malformed",
                      outcome: "unknown",
                    }),
                  ),
                ),
              ),
            );

            return project(ref, raw);
          }),
        );

      const wait = Effect.fnUntraced(function* (ref: SessionReference, options: PollOptions = {}) {
        const timeout = options.timeoutMillis ?? 120_000;
        const interval = options.intervalMillis ?? 3000;

        if (
          !Number.isSafeInteger(timeout) ||
          timeout < 1 ||
          timeout > 600_000 ||
          !Number.isSafeInteger(interval) ||
          interval < 10 ||
          interval > 30_000
        ) {
          return yield* failure("recording-wait", "configuration");
        }
        const deadline = yield* deadlineAfter(timeout);

        yield* within(authorize(ref), deadline, "recording-wait");
        let latest: typeof RawBatch.Type = { downloads: [] };

        for (;;) {
          const result = yield* within(read(ref, deadline), deadline, "recording-wait").pipe(
            Effect.result,
          );

          if (result._tag === "Success") {
            latest = result.success;
            if (
              latest.downloads.every(
                (page) => page.status === "COMPLETED" || page.status === "FAILED",
              )
            )
              return project(ref, latest);
          } else if (
            !["timeout", "rate-limited", "provider", "transport"].includes(result.failure.reason)
          ) {
            return yield* result.failure;
          }
          const remaining = deadline - (yield* nowMillis);

          if (remaining <= 0) return project(ref, latest, true);
          yield* Effect.sleep(Math.min(interval, remaining));
        }
      });

      const download = (ref: RecordingPageReference, limits: DownloadLimits) =>
        Stream.unwrap(
          Effect.gen(function* () {
            yield* Schema.decodeEffect(RecordingPageReference)(ref).pipe(
              Effect.mapError(() => failure("recording-download", "configuration")),
            );

            const { maxBytes, timeoutMillis } = yield* transferPolicy(limits, () =>
              failure("recording-download", "configuration"),
            );

            const deadline = yield* deadlineAfter(timeoutMillis);

            yield* within(authorize(ref.session), deadline, "recording-download");

            const latest = yield* within(
              read(ref.session, deadline),
              deadline,
              "recording-download",
            );

            const page = latest.downloads.find((entry) => entry.pageId === ref.pageId);

            if (page === undefined) return yield* failure("recording-download", "not-found");
            if (page.status === "FAILED") return yield* failure("recording-download", "failed");
            if (page.status !== "COMPLETED") return yield* failure("recording-download", "active");
            if (page.downloadUrl === undefined) return yield* failure("recording-download", "byos");

            // A fresh GET mints access for this subscription. No URL is persisted in the reference.
            return client
              .media(
                Redacted.make(page.downloadUrl),
                maxBytes,
                ["video/mp4", "application/octet-stream"],
                timeoutMillis,
                deadline,
              )
              .pipe(Stream.mapError(fromClient("recording-download")));
          }),
        );

      return BrowserbaseRecordings.of({ request, status, wait, download });
    }),
  );
}
