import { Context, Effect, Layer, Schema } from "effect";

import { BrowserbaseClient } from "./Client.ts";
import { CertificateError } from "./Errors.ts";
import { resource } from "./internal/http/Resource.ts";
import { Identifier } from "./References.ts";
import { SafeFilename } from "./Transfers.ts";

const Timestamp = Schema.String.check(Schema.isMaxLength(64));
const MAX_CERTIFICATE_BYTES = 1024 * 1024;

/** Select a certificate at launch with `provider.proxySettings.caCertificates: [certificateId]`. */
export class CertificateMetadata extends Schema.Class<CertificateMetadata>(
  "BrowserbaseCertificateMetadata",
)({
  certificateId: Identifier,
  projectId: Identifier,
  createdAt: Timestamp,
  updatedAt: Timestamp,
}) {}

export interface CertificateUpload {
  /** PEM or DER bytes of one CA certificate. */
  readonly bytes: Uint8Array;
  /** Portable basename sent with the part; defaults to `certificate.pem`. */
  readonly filename?: string;
  readonly maxBytes?: number;
  readonly timeoutMillis?: number;
}

const Upload = Schema.Struct({
  filename: Schema.optionalKey(SafeFilename),
  maxBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: MAX_CERTIFICATE_BYTES })),
  ),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

const ProviderCertificate = Schema.Struct({
  id: Identifier,
  projectId: Identifier,
  createdAt: Timestamp,
  updatedAt: Timestamp,
});

/** Proxy CA certificates. Registration is one bounded multipart mutation, never retried. */
export class BrowserbaseCertificates extends Context.Service<
  BrowserbaseCertificates,
  {
    readonly create: (
      upload: CertificateUpload,
    ) => Effect.Effect<CertificateMetadata, CertificateError>;
    readonly list: Effect.Effect<ReadonlyArray<CertificateMetadata>, CertificateError>;
    readonly retrieve: (
      certificateId: string,
    ) => Effect.Effect<CertificateMetadata, CertificateError>;
    readonly delete: (certificateId: string) => Effect.Effect<void, CertificateError>;
  }
>()("@effect-agent/browserbase/Certificates") {
  static readonly layer: Layer.Layer<BrowserbaseCertificates, never, BrowserbaseClient> =
    Layer.effect(
      BrowserbaseCertificates,
      Effect.gen(function* () {
        const client = yield* BrowserbaseClient;
        const api = resource(client, (failure) => CertificateError.make(failure));

        const own = (operation: string, mutation: boolean) =>
          Effect.fnUntraced(function* (value: typeof ProviderCertificate.Type) {
            if (value.projectId !== client.projectId)
              return yield* api.malformed(operation, mutation);

            const { id, ...rest } = value;

            return CertificateMetadata.make({ certificateId: id, ...rest });
          });

        const create = Effect.fn("BrowserbaseCertificates.create")(function* (
          upload: CertificateUpload,
        ) {
          const { bytes, ...options } = upload;
          const value = yield* api.input(Upload, options, "certificate-create");
          const owned = new Uint8Array(bytes);

          const raw = yield* client
            .upload(
              "/v1/certificates",
              {
                field: "file",
                filename: value.filename ?? "certificate.pem",
                mediaType: "application/x-pem-file",
                bytes: owned,
              },
              {
                maxBytes: value.maxBytes ?? 64 * 1024,
                ...(value.timeoutMillis === undefined
                  ? {}
                  : { timeoutMillis: value.timeoutMillis }),
              },
            )
            .pipe(Effect.mapError(api.fromClient("certificate-create")));

          const created = yield* Schema.decodeUnknownEffect(ProviderCertificate)(raw).pipe(
            Effect.mapError(() => api.malformed("certificate-create", true)),
          );

          return yield* own("certificate-create", true)(created);
        });

        const list = api
          .request(
            "GET",
            "/v1/certificates",
            Schema.Array(ProviderCertificate).check(Schema.isMaxLength(1024)),
            "certificate-list",
          )
          .pipe(
            Effect.flatMap(Effect.forEach(own("certificate-list", false))),
            Effect.withSpan("BrowserbaseCertificates.list"),
          );

        const retrieve = Effect.fn("BrowserbaseCertificates.retrieve")(function* (
          certificateId: string,
        ) {
          const id = yield* api.input(Identifier, certificateId, "certificate-retrieve");

          const value = yield* api.request(
            "GET",
            `/v1/certificates/${api.segment(id)}`,
            ProviderCertificate,
            "certificate-retrieve",
          );

          if (value.id !== id) return yield* api.malformed("certificate-retrieve", false);

          return yield* own("certificate-retrieve", false)(value);
        });

        const remove = Effect.fn("BrowserbaseCertificates.delete")(function* (
          certificateId: string,
        ) {
          const id = yield* api.input(Identifier, certificateId, "certificate-delete");

          yield* api.remove(`/v1/certificates/${api.segment(id)}`, "certificate-delete");
        });

        return BrowserbaseCertificates.of({ create, list, retrieve, delete: remove });
      }),
    );
}
