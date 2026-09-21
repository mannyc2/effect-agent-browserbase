import { Effect, Schema } from "effect";

import { ArtifactTransferPolicy } from "../../Transfers.ts";

const DownloadTransferPolicy = Schema.Struct({
  ...ArtifactTransferPolicy.fields,
  mimeTypes: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});

/**
 * Own the validated scalars before crossing an asynchronous provider boundary. The caller
 * supplies its own declared failure so recordings, replays and files keep separate channels.
 */
export const transferPolicy = <E>(policy: ArtifactTransferPolicy, invalid: () => E) =>
  Schema.decodeEffect(ArtifactTransferPolicy)(policy).pipe(
    Effect.map(({ maxBytes, timeoutMillis }) =>
      Object.freeze({ maxBytes, timeoutMillis: timeoutMillis ?? 60_000 }),
    ),
    Effect.mapError(invalid),
  );

/** Preserve the existing case-sensitive allowlist while owning its contents. */
export const downloadTransferPolicy = <E>(
  policy: ArtifactTransferPolicy & { readonly mimeTypes: ReadonlyArray<string> },
  invalid: () => E,
) =>
  Schema.decodeEffect(DownloadTransferPolicy)(policy).pipe(
    Effect.map(({ maxBytes, timeoutMillis, mimeTypes }) =>
      Object.freeze({
        maxBytes,
        timeoutMillis: timeoutMillis ?? 60_000,
        mimeTypes: Object.freeze([...mimeTypes]),
      }),
    ),
    Effect.mapError(invalid),
  );
