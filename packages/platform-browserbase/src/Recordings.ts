import { Context, Effect, Layer, Redacted, Schema, Semaphore, Stream } from "effect";

import { deadlineAfter, nowMillis, within } from "./internal/Deadline.ts";
import { decode, makeHttp, type BrowserbaseOptions, type Http } from "./internal/Http.ts";
import { makeProvider, terminal } from "./internal/Provider.ts";
import { transferPolicy } from "./internal/TransferPolicy.ts";
import type { ArtifactTransferPolicy, SessionReference } from "./Types.ts";
import {
  BrowserbaseError,
  Identifier,
  RecordingBatch,
  RecordingPage,
  RecordingPageReference,
} from "./Types.ts";
export type { BrowserbaseOptions } from "./internal/Http.ts";

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

/** Compatibility alias; common transfer data is defined by Types.ArtifactTransferPolicy. */
export type DownloadLimits = ArtifactTransferPolicy;

/** Independent of a live browser. Merely building this Layer performs no provider calls. */
export class BrowserbaseRecordings extends Context.Service<
  BrowserbaseRecordings,
  {
    readonly request: (
      reference: SessionReference,
      mode?: "initial" | "retry-failed",
    ) => Effect.Effect<RecordingBatch, BrowserbaseError>;
    readonly status: (
      reference: SessionReference,
    ) => Effect.Effect<RecordingBatch, BrowserbaseError>;
    readonly wait: (
      reference: SessionReference,
      options?: PollOptions,
    ) => Effect.Effect<RecordingBatch, BrowserbaseError>;
    readonly download: (
      reference: RecordingPageReference,
      limits: DownloadLimits,
    ) => Stream.Stream<Uint8Array, BrowserbaseError>;
  }
>()("@effect-agent/platform-browserbase/BrowserbaseRecordings") {
  static layer(options: BrowserbaseOptions) {
    return Layer.effect(
      this,
      makeHttp(options).pipe(Effect.flatMap((http) => makeRecordings(http, options.projectId))),
    );
  }
}

/** Private construction seam retains the real HTTP/Schema implementation in tests. */
const makeRecordings = Effect.fnUntraced(function* (http: Http, projectId: string) {
  const provider = makeProvider(http, projectId);
  const requests = yield* Semaphore.make(1);

  const path = (ref: SessionReference) =>
    `/v1/sessions/${encodeURIComponent(ref.sessionId)}/recording/downloads`;

  const read = (ref: SessionReference, deadline?: number) =>
    http.json("GET", path(ref), undefined, deadline).pipe(
      Effect.flatMap((raw) => decode(RawBatch, raw, "recording-status")),
      Effect.filterOrFail(
        (raw) => new Set(raw.downloads.map((p) => p.pageId)).size === raw.downloads.length,
        () => BrowserbaseError.make({ operation: "recording-status", reason: "malformed" }),
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

  const authorize = Effect.fnUntraced(function* (ref: SessionReference, deadline?: number) {
    const status = yield* provider.metadata(ref, deadline);

    if (!terminal(status.status))
      return yield* BrowserbaseError.make({ operation: "recording", reason: "active" });
  });

  const status = Effect.fnUntraced(function* (ref: SessionReference) {
    yield* authorize(ref);

    return project(ref, yield* read(ref));
  });

  const request = (ref: SessionReference, mode: "initial" | "retry-failed" = "initial") =>
    requests.withPermits(1)(
      Effect.gen(function* () {
        if (mode !== "initial" && mode !== "retry-failed")
          return yield* BrowserbaseError.make({
            operation: "recording-request",
            reason: "configuration",
            outcome: "undispatched",
          });
        yield* authorize(ref);
        // A prior uncertain POST is reconciled by this GET before any resubmission.
        const before = yield* read(ref);

        const needed =
          mode === "retry-failed"
            ? before.downloads.some((p) => p.status === "FAILED")
            : before.downloads.every((p) => p.status === "NOT_REQUESTED");

        if (!needed) return project(ref, before);

        const raw = yield* http.json("POST", path(ref)).pipe(
          Effect.flatMap((value) => decode(RawBatch, value, "recording-request")),
          Effect.mapError((error) =>
            BrowserbaseError.make({
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
      return yield* BrowserbaseError.make({ operation: "recording-wait", reason: "configuration" });
    }
    const deadline = yield* deadlineAfter(timeout);

    yield* within(authorize(ref, deadline), deadline, "recording-wait");
    let latest: typeof RawBatch.Type = { downloads: [] };

    for (;;) {
      const result = yield* within(read(ref, deadline), deadline, "recording-wait").pipe(
        Effect.result,
      );

      if (result._tag === "Success") {
        latest = result.success;
        if (latest.downloads.every((p) => p.status === "COMPLETED" || p.status === "FAILED"))
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
        yield* decode(RecordingPageReference, ref, "recording-download");
        const { maxBytes, timeoutMillis } = yield* transferPolicy(limits, "recording-download");
        const deadline = yield* deadlineAfter(timeoutMillis);

        yield* within(authorize(ref.session, deadline), deadline, "recording-download");
        const latest = yield* within(read(ref.session, deadline), deadline, "recording-download");
        const page = latest.downloads.find((p) => p.pageId === ref.pageId);

        if (page === undefined)
          return yield* BrowserbaseError.make({
            operation: "recording-download",
            reason: "not-found",
          });
        if (page.status === "FAILED")
          return yield* BrowserbaseError.make({
            operation: "recording-download",
            reason: "failed",
          });
        if (page.status !== "COMPLETED")
          return yield* BrowserbaseError.make({
            operation: "recording-download",
            reason: "active",
          });
        if (page.downloadUrl === undefined)
          return yield* BrowserbaseError.make({ operation: "recording-download", reason: "byos" });

        // A fresh GET mints access for this subscription. No URL is persisted in the artifact reference.
        return http.media(
          Redacted.make(page.downloadUrl),
          maxBytes,
          ["video/mp4", "application/octet-stream"],
          timeoutMillis,
          deadline,
        );
      }),
    );

  return BrowserbaseRecordings.of({ request, status, wait, download });
});
