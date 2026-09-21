import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import type { ClientError } from "./Errors.ts";
import { ExtensionError } from "./Errors.ts";
import { inspectExtensionArchive } from "./internal/extension/Archive.ts";
import { ExtensionReference, Identifier } from "./References.ts";
import { SafeFilename } from "./Transfers.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));

/** The provider documents a 100 MB archive; a caller may request less, never more. */
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;

const ProviderExtension = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  fileName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
});

/** Only fields the provider actually returned are reported; absence is never invented. */
export class ExtensionMetadata extends Schema.Class<ExtensionMetadata>(
  "BrowserbaseExtensionMetadata",
)({
  reference: ExtensionReference,
  fileName: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(1024))),
  createdAt: Schema.optionalKey(Timestamp),
  updatedAt: Schema.optionalKey(Timestamp),
}) {}

/** Registration evidence is what this package inspected, not a provider load receipt. */
export class ExtensionRegistration extends Schema.Class<ExtensionRegistration>(
  "BrowserbaseExtensionRegistration",
)({
  reference: ExtensionReference,
  archiveBytes: Schema.Natural,
  entries: Schema.Natural,
  declaredBytes: Schema.Natural,
}) {}

export interface ExtensionUploadOptions {
  /** Portable basename sent with the part; defaults to `extension.zip`. */
  readonly filename?: string;
  readonly maxBytes?: number;
  readonly timeoutMillis?: number;
}

const Upload = Schema.Struct({
  filename: Schema.optionalKey(
    SafeFilename.check(Schema.makeFilter((value) => value.toLowerCase().endsWith(".zip"))),
  ),
  maxBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_ARCHIVE_BYTES })),
  ),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

const fromClient = (operation: ExtensionError["operation"], error: ClientError): ExtensionError =>
  ExtensionError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

const configuration = (operation: ExtensionError["operation"]) =>
  ExtensionError.make({ operation, reason: "configuration", outcome: "undispatched" });

const malformed = (operation: ExtensionError["operation"], mutation = false) =>
  ExtensionError.make({
    operation,
    reason: "malformed",
    ...(mutation ? { outcome: "unknown" as const } : {}),
  });

/**
 * A provisioned extension is a durable project resource selected at launch, never uploaded
 * again on connect. The archive is inspected before transport; loading remains the provider's.
 */
export class BrowserbaseExtensions extends Context.Service<
  BrowserbaseExtensions,
  {
    readonly register: (
      archive: Uint8Array,
      options?: ExtensionUploadOptions,
    ) => Effect.Effect<ExtensionRegistration, ExtensionError>;
    readonly retrieve: (
      reference: ExtensionReference,
    ) => Effect.Effect<ExtensionMetadata, ExtensionError>;
    readonly delete: (reference: ExtensionReference) => Effect.Effect<void, ExtensionError>;
  }
>()("effect-browserbase/Extensions") {
  static readonly layer: Layer.Layer<BrowserbaseExtensions, never, BrowserbaseClient> =
    Layer.effect(
      BrowserbaseExtensions,
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;

        const validate = Effect.fnUntraced(function* (
          reference: ExtensionReference,
          operation: ExtensionError["operation"],
        ) {
          const ref = yield* Schema.decodeEffect(ExtensionReference)(reference, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(() => configuration(operation)));

          if (ref.projectId !== client.projectId)
            return yield* ExtensionError.make({
              operation,
              reason: "authorization",
              outcome: "undispatched",
            });

          return ref;
        });

        const register = Effect.fn("BrowserbaseExtensions.register")(function* (
          archive: Uint8Array,
          options: ExtensionUploadOptions = {},
        ) {
          const value = yield* Schema.decodeEffect(Upload)(options, {
            onExcessProperty: "error",
          }).pipe(Effect.mapError(() => configuration("extension-register")));

          if (!(archive instanceof Uint8Array)) return yield* configuration("extension-register");
          const maxBytes = value.maxBytes ?? MAX_ARCHIVE_BYTES;

          if (archive.byteLength < 1 || archive.byteLength > maxBytes)
            return yield* ExtensionError.make({
              operation: "extension-archive",
              reason: "limit",
              outcome: "undispatched",
            });

          // Inspect and send the same immutable bytes: a caller cannot swap the
          // archive between its manifest check and the multipart encoding.
          const owned = new Uint8Array(archive);
          const inspected = inspectExtensionArchive(owned);

          if (inspected._tag === "Rejected") {
            return yield* ExtensionError.make({
              operation: "extension-archive",
              reason:
                inspected.reason === "limit"
                  ? "limit"
                  : inspected.reason === "name"
                    ? "unsafe-filename"
                    : "configuration",
              outcome: "undispatched",
            });
          }

          const raw = yield* client
            .upload(
              "/v1/extensions",
              {
                field: "file",
                filename: value.filename ?? "extension.zip",
                mediaType: "application/zip",
                bytes: owned,
              },
              {
                maxBytes,
                ...(value.timeoutMillis === undefined
                  ? {}
                  : { timeoutMillis: value.timeoutMillis }),
              },
            )
            .pipe(Effect.mapError((error) => fromClient("extension-register", error)));

          const created = yield* Schema.decodeUnknownEffect(ProviderExtension)(raw).pipe(
            Effect.mapError(() => malformed("extension-register", true)),
          );

          if (created.projectId !== client.projectId)
            return yield* malformed("extension-register", true);

          return ExtensionRegistration.make({
            reference: ExtensionReference.make({
              provider: "browserbase",
              projectId: client.projectId,
              extensionId: created.id,
            }),
            archiveBytes: owned.byteLength,
            entries: inspected.facts.entries,
            declaredBytes: inspected.facts.declaredBytes,
          });
        });

        const retrieve = Effect.fn("BrowserbaseExtensions.retrieve")(function* (
          reference: ExtensionReference,
        ) {
          const ref = yield* validate(reference, "extension-retrieve");

          const raw = yield* client
            .json("GET", `/v1/extensions/${encodeURIComponent(ref.extensionId)}`)
            .pipe(Effect.mapError((error) => fromClient("extension-retrieve", error)));

          const value = yield* Schema.decodeUnknownEffect(ProviderExtension)(raw).pipe(
            Effect.mapError(() => malformed("extension-retrieve")),
          );

          if (value.id !== ref.extensionId || value.projectId !== ref.projectId)
            return yield* malformed("extension-retrieve");

          return ExtensionMetadata.make({
            reference: ref,
            ...(value.fileName === undefined ? {} : { fileName: value.fileName }),
            ...(value.createdAt === undefined ? {} : { createdAt: value.createdAt }),
            ...(value.updatedAt === undefined ? {} : { updatedAt: value.updatedAt }),
          });
        });

        const remove = Effect.fn("BrowserbaseExtensions.delete")(function* (
          reference: ExtensionReference,
        ) {
          const ref = yield* validate(reference, "extension-delete");

          yield* client
            .noContent("DELETE", `/v1/extensions/${encodeURIComponent(ref.extensionId)}`)
            .pipe(Effect.mapError((error) => fromClient("extension-delete", error)));
        });

        return BrowserbaseExtensions.of({ register, retrieve, delete: remove });
      }),
    );
}
