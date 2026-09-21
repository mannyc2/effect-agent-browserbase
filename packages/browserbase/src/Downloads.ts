import { Context, Effect, Layer, Schema, Stream } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { type ClientError, FileError } from "./Errors.ts";
import { downloadTransferPolicy } from "./internal/artifact/TransferPolicy.ts";
import { deadlineAfter, nowMillis, until } from "./internal/Deadline.ts";
import { Identifier, type SessionReference } from "./References.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import { type ArtifactTransferPolicy, DownloadMetadata } from "./Transfers.ts";

export interface DownloadPolicy extends ArtifactTransferPolicy {
  readonly mimeTypes: ReadonlyArray<string>;
}

export interface DownloadListing {
  readonly downloads: ReadonlyArray<DownloadMetadata>;
  readonly total: number;
  readonly offset: number;
  readonly complete: boolean;
}

const Timestamp = Schema.String.check(Schema.isMaxLength(64));

/** Provider-side filters over one session's files; every bound is optional. */
export const DownloadQuery = Schema.Struct({
  offset: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 10_000 }))),
  filename: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(1024))),
  mimeType: Schema.optionalKey(Schema.NonEmptyString.check(Schema.isMaxLength(256))),
  minSize: Schema.optionalKey(Schema.Natural),
  maxSize: Schema.optionalKey(Schema.Natural),
  createdAfter: Schema.optionalKey(Timestamp),
  createdBefore: Schema.optionalKey(Timestamp),
});

export type DownloadQuery = typeof DownloadQuery.Type;

const Listing = Schema.Struct({
  downloads: Schema.Array(DownloadMetadata).check(Schema.isMaxLength(100)),
  total: Schema.Natural,
});

const failure = (operation: string, reason: FileError["reason"]) =>
  FileError.make({ operation, reason });

const fromClient = (operation: string) => (error: ClientError) =>
  FileError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

const within = <A, E, R>(effect: Effect.Effect<A, E, R>, deadline: number, operation: string) =>
  until(effect, deadline, () => failure(operation, "timeout"));

/** Website files are not session-recording MP4s. They retain their own provider download ID. */
export class BrowserbaseDownloads extends Context.Service<
  BrowserbaseDownloads,
  {
    readonly list: (
      reference: SessionReference,
      query?: DownloadQuery,
    ) => Effect.Effect<DownloadListing, FileError>;
    readonly metadata: (
      reference: SessionReference,
      downloadId: string,
    ) => Effect.Effect<DownloadMetadata, FileError>;
    readonly stream: (
      reference: SessionReference,
      downloadId: string,
      policy: DownloadPolicy,
    ) => Stream.Stream<Uint8Array, FileError>;
    /** Deletes one stored file. A lost reply is `outcome: "unknown"` and is never retried. */
    readonly delete: (
      reference: SessionReference,
      downloadId: string,
    ) => Effect.Effect<void, FileError>;
    readonly waitForNew: (
      reference: SessionReference,
      previousIds: ReadonlyArray<string>,
      timeoutMillis?: number,
    ) => Effect.Effect<ReadonlyArray<DownloadMetadata>, FileError>;
  }
>()("@effect-agent/browserbase/Downloads") {
  static readonly layer: Layer.Layer<
    BrowserbaseDownloads,
    never,
    BrowserbaseClient | BrowserbaseSessions
  > = Layer.effect(
    BrowserbaseDownloads,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const sessions = yield* BrowserbaseSessions;

      // Files are readable while the session runs; only the exact owning session is admitted.
      const owned = (ref: SessionReference, operation: string) =>
        sessions.retrieve(ref).pipe(
          Effect.mapError((error) => FileError.make({ operation, reason: error.reason })),
          Effect.asVoid,
        );

      const list = Effect.fnUntraced(function* (ref: SessionReference, query: DownloadQuery = {}) {
        const checked = yield* Schema.decodeEffect(DownloadQuery)(query, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => failure("downloads-list", "configuration")));

        const offset = checked.offset ?? 0;

        yield* owned(ref, "downloads-list");

        const search = new URLSearchParams({
          sessionId: ref.sessionId,
          limit: "100",
          offset: String(offset),
        });

        for (const key of [
          "filename",
          "mimeType",
          "minSize",
          "maxSize",
          "createdAfter",
          "createdBefore",
        ] as const) {
          const value = checked[key];

          if (value !== undefined) search.set(key, String(value));
        }

        const raw = yield* client.json("GET", `/v1/downloads?${search}`).pipe(
          Effect.mapError(fromClient("downloads-list")),
          Effect.flatMap((value) =>
            Schema.decodeUnknownEffect(Listing)(value).pipe(
              Effect.mapError(() => failure("downloads-list", "malformed")),
            ),
          ),
        );

        if (
          raw.downloads.some((entry) => entry.sessionId !== ref.sessionId) ||
          new Set(raw.downloads.map((entry) => entry.id)).size !== raw.downloads.length
        ) {
          return yield* failure("downloads-list", "malformed");
        }

        return { ...raw, offset, complete: offset + raw.downloads.length >= raw.total };
      });

      const metadata = Effect.fnUntraced(function* (ref: SessionReference, id: string) {
        yield* Schema.decodeEffect(Identifier)(id).pipe(
          Effect.mapError(() => failure("download-metadata", "configuration")),
        );

        yield* owned(ref, "download-metadata");

        const value = yield* client.json("GET", `/v1/downloads/${encodeURIComponent(id)}`).pipe(
          Effect.mapError(fromClient("download-metadata")),
          Effect.flatMap((raw) =>
            Schema.decodeUnknownEffect(DownloadMetadata)(raw).pipe(
              Effect.mapError(() => failure("download-metadata", "malformed")),
            ),
          ),
        );

        if (value.id !== id || value.sessionId !== ref.sessionId)
          return yield* failure("download-metadata", "malformed");

        return value;
      });

      const stream = (ref: SessionReference, id: string, policy: DownloadPolicy) =>
        Stream.unwrap(
          Effect.gen(function* () {
            const { maxBytes, timeoutMillis, mimeTypes } = yield* downloadTransferPolicy(
              policy,
              () => failure("download", "configuration"),
            );

            const deadline = yield* deadlineAfter(timeoutMillis);
            const file = yield* within(metadata(ref, id), deadline, "download");

            if (!mimeTypes.includes(file.mimeType.toLowerCase()))
              return yield* failure("download", "content-type");
            if (file.size > maxBytes) return yield* failure("download", "limit");
            let received = 0;

            return client
              .bytes(
                `/v1/downloads/${encodeURIComponent(id)}`,
                maxBytes,
                ["application/octet-stream", file.mimeType.toLowerCase()],
                "download",
                timeoutMillis,
                deadline,
              )
              .pipe(
                Stream.mapError(fromClient("download")),
                Stream.tap((chunk) =>
                  Effect.sync(() => {
                    received += chunk.byteLength;
                  }),
                ),
                Stream.concat(
                  Stream.fromEffect(
                    Effect.suspend(() =>
                      received === file.size
                        ? Effect.void
                        : Effect.fail(failure("download", "malformed")),
                    ),
                  ).pipe(Stream.drain),
                ),
              );
          }),
        );

      const waitForNew = Effect.fnUntraced(function* (
        ref: SessionReference,
        previousIds: ReadonlyArray<string>,
        timeoutMillis = 30_000,
      ) {
        if (
          previousIds.length > 10_000 ||
          !Number.isSafeInteger(timeoutMillis) ||
          timeoutMillis < 1 ||
          timeoutMillis > 300_000
        ) {
          return yield* failure("download-wait", "configuration");
        }
        const previous = new Set(previousIds);
        const deadline = yield* deadlineAfter(timeoutMillis);

        do {
          const result = yield* within(list(ref), deadline, "downloads-wait");

          // Never claim a complete candidate set from a partial listing.
          if (!result.complete) return yield* failure("download-wait", "limit");
          const fresh = result.downloads.filter((entry) => !previous.has(entry.id));

          if (fresh.length > 0) return fresh;
          const remaining = deadline - (yield* nowMillis);

          if (remaining <= 0) break;
          yield* Effect.sleep(Math.min(500, remaining));
        } while ((yield* nowMillis) < deadline);

        return yield* failure("download-wait", "timeout");
      });

      const remove = Effect.fnUntraced(function* (ref: SessionReference, id: string) {
        yield* Schema.decodeEffect(Identifier)(id).pipe(
          Effect.mapError(() =>
            FileError.make({
              operation: "download-delete",
              reason: "configuration",
              outcome: "undispatched",
            }),
          ),
        );

        // Ownership is proved by reading the file's session before any mutation.
        yield* metadata(ref, id).pipe(
          Effect.mapError((error) =>
            FileError.make({
              operation: "download-delete",
              reason: error.reason,
              outcome: "undispatched",
              ...(error.status === undefined ? {} : { status: error.status }),
              ...(error.retryAfterMillis === undefined
                ? {}
                : { retryAfterMillis: error.retryAfterMillis }),
            }),
          ),
        );

        yield* client
          .noContent("DELETE", `/v1/downloads/${encodeURIComponent(id)}`)
          .pipe(Effect.mapError(fromClient("download-delete")));
      });

      return BrowserbaseDownloads.of({ list, metadata, stream, waitForNew, delete: remove });
    }),
  );
}
