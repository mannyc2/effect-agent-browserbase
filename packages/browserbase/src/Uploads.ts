import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { type ClientError, FileError } from "./Errors.ts";
import { recordIssuedUpload } from "./internal/upload/Issued.ts";
import type { SessionReference } from "./References.ts";
import { BrowserbaseSessions } from "./Sessions.ts";
import { RemoteFilePath, SafeFilename, UploadReceipt } from "./Transfers.ts";

/** The provider's documented per-file ceiling for a session upload. */
const MAX_UPLOAD_BYTES = 512 * 1024 * 1024;

const MediaType = Schema.NonEmptyString.check(
  Schema.isMaxLength(128),
  Schema.isPattern(/^[a-z0-9][a-z0-9!#$&^_+.-]*\/[a-z0-9][a-z0-9!#$&^_+.-]*$/),
);

const UploadOptions = Schema.Struct({
  filename: SafeFilename,
  mediaType: MediaType,
  maxBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_UPLOAD_BYTES })),
  ),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

/**
 * Only fields this package can validate are carried forward. `path` is the provider's own
 * remote location for the stored file; when the response omits it, the receipt says so
 * instead of inventing one, and attachment by path is refused rather than guessed.
 */
const ProviderUpload = Schema.Struct({
  message: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  path: Schema.optionalKey(RemoteFilePath),
});

export interface UploadFile {
  readonly filename: string;
  readonly mediaType: string;
  readonly bytes: Uint8Array;
  readonly maxBytes?: number;
  readonly timeoutMillis?: number;
}

const failure = (operation: string, reason: FileError["reason"]) =>
  FileError.make({ operation, reason, outcome: "undispatched" });

const fromClient = (operation: string) => (error: ClientError) =>
  FileError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

/**
 * A session upload places bytes where the remote browser can already reach them. It is the
 * large-file half of file selection; small in-memory selection needs no provisioning at all.
 */
export class BrowserbaseUploads extends Context.Service<
  BrowserbaseUploads,
  {
    readonly create: (
      reference: SessionReference,
      file: UploadFile,
    ) => Effect.Effect<UploadReceipt, FileError>;
  }
>()("@effect-agent/browserbase/Uploads") {
  static readonly layer: Layer.Layer<
    BrowserbaseUploads,
    never,
    BrowserbaseClient | BrowserbaseSessions
  > = Layer.effect(
    BrowserbaseUploads,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;
      const sessions = yield* BrowserbaseSessions;

      const create = Effect.fn("BrowserbaseUploads.create")(function* (
        reference: SessionReference,
        file: UploadFile,
      ) {
        const { bytes, ...rest } = file;

        const value = yield* Schema.decodeEffect(UploadOptions)(rest, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => failure("upload", "configuration")));

        if (!(bytes instanceof Uint8Array)) return yield* failure("upload", "configuration");
        const maxBytes = value.maxBytes ?? MAX_UPLOAD_BYTES;

        if (bytes.byteLength < 1 || bytes.byteLength > maxBytes)
          return yield* failure("upload", "limit");

        // The exact owning session admits the upload; a terminal session cannot receive files.
        const state = yield* sessions
          .retrieve(reference)
          .pipe(
            Effect.mapError((error) =>
              FileError.make({ operation: "upload", reason: error.reason }),
            ),
          );

        if (state.status !== "RUNNING") return yield* failure("upload", "expired");

        // Send the same immutable bytes that were measured a moment ago.
        const owned = new Uint8Array(bytes);

        const raw = yield* client
          .upload(
            `/v1/sessions/${encodeURIComponent(state.reference.sessionId)}/uploads`,
            {
              field: "file",
              filename: value.filename,
              mediaType: value.mediaType,
              bytes: owned,
            },
            {
              maxBytes,
              ...(value.timeoutMillis === undefined ? {} : { timeoutMillis: value.timeoutMillis }),
            },
          )
          .pipe(Effect.mapError(fromClient("upload")));

        const acknowledged = yield* Schema.decodeUnknownEffect(ProviderUpload)(raw).pipe(
          Effect.mapError(() =>
            FileError.make({ operation: "upload", reason: "malformed", outcome: "unknown" }),
          ),
        );

        const receipt = UploadReceipt.make({
          reference: state.reference,
          filename: value.filename,
          bytes: owned.byteLength,
          ...(acknowledged.path === undefined ? {} : { remotePath: acknowledged.path }),
          ...(acknowledged.message === undefined ? {} : { acknowledgement: acknowledged.message }),
        });

        if (acknowledged.path !== undefined)
          recordIssuedUpload(receipt, {
            reference: state.reference,
            remotePath: acknowledged.path,
          });

        return receipt;
      });

      return BrowserbaseUploads.of({ create });
    }),
  );
}
