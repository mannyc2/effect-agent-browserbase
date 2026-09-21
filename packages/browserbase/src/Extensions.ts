import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import type { ClientError } from "./Errors.ts";
import { ExtensionError } from "./Errors.ts";
import { ExtensionReference, Identifier } from "./References.ts";

const MAX_ZIP_BYTES = 100 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_PATH_BYTES = 1024;
const EOCD_SIGNATURE = 0x06054b50;
const CENTRAL_SIGNATURE = 0x02014b50;

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const FileName = Schema.NonEmptyString.check(
  Schema.isMaxLength(255),
  Schema.makeFilter(
    (value) =>
      value.endsWith(".zip") &&
      !value.includes("/") &&
      !value.includes("\\") &&
      value !== "." &&
      value !== "..",
  ),
);

const ProviderExtension = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  fileName: Schema.String.check(Schema.isMaxLength(1024)),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

export class ExtensionMetadata extends Schema.Class<ExtensionMetadata>("BrowserbaseExtensionMetadata")({
  reference: ExtensionReference,
  fileName: Schema.String.check(Schema.isMaxLength(1024)),
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export interface ExtensionArchive {
  readonly fileName: string;
  readonly bytes: Uint8Array;
}

class ZipValidationError extends Error {
  constructor(readonly reason: "configuration" | "limit") {
    super(reason);
  }
}

const u16 = (view: DataView, offset: number) => view.getUint16(offset, true);
const u32 = (view: DataView, offset: number) => view.getUint32(offset, true);

const inspectZip = (bytes: Uint8Array): void => {
  if (bytes.byteLength < 22 || bytes.byteLength > MAX_ZIP_BYTES) {
    throw new ZipValidationError("limit");
  }

  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const firstEocd = Math.max(0, bytes.byteLength - 65_557);
  let eocd = -1;

  for (let offset = bytes.byteLength - 22; offset >= firstEocd; offset--) {
    if (
      u32(view, offset) === EOCD_SIGNATURE &&
      offset + 22 + u16(view, offset + 20) === bytes.byteLength
    ) {
      eocd = offset;
      break;
    }
  }
  if (eocd < 0) throw new ZipValidationError("configuration");

  const disk = u16(view, eocd + 4);
  const directoryDisk = u16(view, eocd + 6);
  const diskEntries = u16(view, eocd + 8);
  const entries = u16(view, eocd + 10);
  const directoryBytes = u32(view, eocd + 12);
  const directoryOffset = u32(view, eocd + 16);
  const commentBytes = u16(view, eocd + 20);

  if (
    disk !== 0 ||
    directoryDisk !== 0 ||
    diskEntries !== entries ||
    entries === 0xffff ||
    directoryBytes === 0xffffffff ||
    directoryOffset === 0xffffffff ||
    entries > MAX_ENTRIES
  ) {
    throw new ZipValidationError(entries > MAX_ENTRIES ? "limit" : "configuration");
  }
  if (eocd + 22 + commentBytes !== bytes.byteLength || directoryOffset + directoryBytes !== eocd) {
    throw new ZipValidationError("configuration");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const names = new Set<string>();
  let offset = directoryOffset;
  let totalUncompressed = 0;
  let hasManifest = false;

  for (let index = 0; index < entries; index++) {
    if (offset + 46 > eocd || u32(view, offset) !== CENTRAL_SIGNATURE) {
      throw new ZipValidationError("configuration");
    }

    const flags = u16(view, offset + 8);
    const method = u16(view, offset + 10);
    const compressedBytes = u32(view, offset + 20);
    const uncompressedBytes = u32(view, offset + 24);
    const nameBytes = u16(view, offset + 28);
    const extraBytes = u16(view, offset + 30);
    const entryCommentBytes = u16(view, offset + 32);
    const localOffset = u32(view, offset + 42);
    const next = offset + 46 + nameBytes + extraBytes + entryCommentBytes;

    if (
      (flags & 1) !== 0 ||
      ![0, 8].includes(method) ||
      nameBytes === 0 ||
      nameBytes > MAX_PATH_BYTES ||
      compressedBytes === 0xffffffff ||
      uncompressedBytes === 0xffffffff ||
      localOffset === 0xffffffff ||
      localOffset >= directoryOffset ||
      next > eocd
    ) {
      throw new ZipValidationError("configuration");
    }

    totalUncompressed += uncompressedBytes;
    if (totalUncompressed > MAX_ZIP_BYTES) throw new ZipValidationError("limit");

    let name: string;
    try {
      name = decoder.decode(bytes.subarray(offset + 46, offset + 46 + nameBytes));
    } catch {
      throw new ZipValidationError("configuration");
    }

    if (localOffset + 30 > directoryOffset || u32(view, localOffset) !== 0x04034b50) {
      throw new ZipValidationError("configuration");
    }
    const localFlags = u16(view, localOffset + 6);
    const localMethod = u16(view, localOffset + 8);
    const localNameBytes = u16(view, localOffset + 26);
    const localExtraBytes = u16(view, localOffset + 28);
    const localNameStart = localOffset + 30;
    const localNameEnd = localNameStart + localNameBytes;

    if (
      (localFlags & 1) !== 0 ||
      localMethod !== method ||
      localNameBytes !== nameBytes ||
      localNameEnd + localExtraBytes + compressedBytes > directoryOffset
    ) {
      throw new ZipValidationError("configuration");
    }
    try {
      if (decoder.decode(bytes.subarray(localNameStart, localNameEnd)) !== name) {
        throw new ZipValidationError("configuration");
      }
    } catch (cause) {
      if (cause instanceof ZipValidationError) throw cause;
      throw new ZipValidationError("configuration");
    }

    const directory = name.endsWith("/");
    const path = directory ? name.slice(0, -1) : name;
    const parts = path.split("/");

    if (
      path.length === 0 ||
      name.includes("\\") ||
      name.includes("\0") ||
      name.startsWith("/") ||
      /^[A-Za-z]:/.test(name) ||
      parts.some((part) => part === "" || part === "." || part === "..") ||
      names.has(name)
    ) {
      throw new ZipValidationError("configuration");
    }
    names.add(name);
    if (!directory && name === "manifest.json") hasManifest = true;
    offset = next;
  }

  if (offset !== directoryOffset + directoryBytes || !hasManifest) {
    throw new ZipValidationError("configuration");
  }
};

const fromClient = (operation: string, error: ClientError): ExtensionError =>
  ExtensionError.make({
    operation,
    reason: error.reason,
    ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
    ...(error.status === undefined ? {} : { status: error.status }),
    ...(error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis }),
  });

const configuration = (operation: string, reason: "configuration" | "limit" = "configuration") =>
  ExtensionError.make({ operation, reason, outcome: "undispatched" });

const malformed = (operation: string, mutation = false) =>
  ExtensionError.make({
    operation,
    reason: "malformed",
    ...(mutation ? { outcome: "unknown" as const } : {}),
  });

const metadata = (
  clientProjectId: string,
  value: typeof ProviderExtension.Type,
  operation: string,
  mutation = false,
) => {
  if (value.projectId !== clientProjectId) return Effect.fail(malformed(operation, mutation));

  return Effect.succeed(
    ExtensionMetadata.make({
      reference: ExtensionReference.make({
        provider: "browserbase",
        projectId: value.projectId,
        extensionId: value.id,
      }),
      fileName: value.fileName,
      createdAt: value.createdAt,
      updatedAt: value.updatedAt,
    }),
  );
};

/** Uploaded extensions are durable project resources, never a browser-scope finalizer. */
export class BrowserbaseExtensions extends Context.Service<
  BrowserbaseExtensions,
  {
    readonly create: (archive: ExtensionArchive) => Effect.Effect<ExtensionMetadata, ExtensionError>;
    readonly retrieve: (
      reference: ExtensionReference,
    ) => Effect.Effect<ExtensionMetadata, ExtensionError>;
    readonly delete: (reference: ExtensionReference) => Effect.Effect<void, ExtensionError>;
  }
>()("@effect-agent/browserbase/Extensions") {
  static readonly layer: Layer.Layer<BrowserbaseExtensions, never, BrowserbaseClient> = Layer.effect(
    BrowserbaseExtensions,
    Effect.gen(function* () {
      const client = yield* BrowserbaseClient;

      const validateReference = Effect.fnUntraced(function* (
        reference: ExtensionReference,
        operation: string,
      ) {
        const ref = yield* Schema.decodeEffect(ExtensionReference)(reference, {
          onExcessProperty: "error",
        }).pipe(Effect.mapError(() => configuration(operation)));

        if (ref.projectId !== client.projectId) {
          return yield* ExtensionError.make({
            operation,
            reason: "authorization",
            outcome: "undispatched",
          });
        }

        return ref;
      });

      const create = Effect.fn("BrowserbaseExtensions.create")(function* (archive: ExtensionArchive) {
        const input = yield* Schema.decodeEffect(
          Schema.Struct({ fileName: FileName, bytes: Schema.Uint8Array }),
        )(archive, { onExcessProperty: "error" }).pipe(
          Effect.mapError(() => configuration("extension-create")),
        );
        const bytes = Uint8Array.from(input.bytes);

        yield* Effect.try({
          try: () => inspectZip(bytes),
          catch: (cause) =>
            cause instanceof ZipValidationError
              ? configuration("extension-create", cause.reason)
              : configuration("extension-create"),
        });

        const raw = yield* client
          .multipartJson("/v1/extensions", {
            field: "file",
            fileName: input.fileName,
            mediaType: "application/zip",
            bytes,
          })
          .pipe(Effect.mapError((error) => fromClient("extension-create", error)));
        const value = yield* Schema.decodeUnknownEffect(ProviderExtension)(raw).pipe(
          Effect.mapError(() => malformed("extension-create", true)),
        );

        return yield* metadata(client.projectId, value, "extension-create", true);
      });

      const retrieve = Effect.fn("BrowserbaseExtensions.retrieve")(function* (
        reference: ExtensionReference,
      ) {
        const ref = yield* validateReference(reference, "extension-retrieve");
        const raw = yield* client
          .json("GET", `/v1/extensions/${encodeURIComponent(ref.extensionId)}`)
          .pipe(Effect.mapError((error) => fromClient("extension-retrieve", error)));
        const value = yield* Schema.decodeUnknownEffect(ProviderExtension)(raw).pipe(
          Effect.mapError(() => malformed("extension-retrieve")),
        );

        if (value.id !== ref.extensionId || value.projectId !== ref.projectId) {
          return yield* malformed("extension-retrieve");
        }

        return yield* metadata(client.projectId, value, "extension-retrieve");
      });

      const remove = Effect.fn("BrowserbaseExtensions.delete")(function* (
        reference: ExtensionReference,
      ) {
        const ref = yield* validateReference(reference, "extension-delete");

        yield* client
          .noContent("DELETE", `/v1/extensions/${encodeURIComponent(ref.extensionId)}`)
          .pipe(Effect.mapError((error) => fromClient("extension-delete", error)));
      });

      return BrowserbaseExtensions.of({ create, retrieve, delete: remove });
    }),
  );
}
