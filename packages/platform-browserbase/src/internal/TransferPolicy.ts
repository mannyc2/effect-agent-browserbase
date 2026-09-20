import { Effect, Schema } from "effect";

import { ArtifactTransferPolicy, BrowserbaseError } from "../Types.ts";

const DownloadTransferPolicy = Schema.Struct({
  ...ArtifactTransferPolicy.fields,
  mimeTypes: Schema.Array(Schema.String).check(Schema.isMinLength(1), Schema.isMaxLength(32)),
});

/** Own the validated scalars before crossing an asynchronous provider boundary. */
export const transferPolicy = (
  policy: ArtifactTransferPolicy,
  operation: "recording-download" | "replay-media",
) =>
  Schema.decodeEffect(ArtifactTransferPolicy)(policy).pipe(
    Effect.map(({ maxBytes, timeoutMillis }) =>
      Object.freeze({ maxBytes, timeoutMillis: timeoutMillis ?? 60_000 }),
    ),
    Effect.mapError(() => BrowserbaseError.make({ operation, reason: "configuration" })),
  );

/** Preserve the existing case-sensitive allowlist while owning its contents. */
export const downloadTransferPolicy = (
  policy: ArtifactTransferPolicy & { readonly mimeTypes: ReadonlyArray<string> },
) =>
  Schema.decodeEffect(DownloadTransferPolicy)(policy).pipe(
    Effect.map(({ maxBytes, timeoutMillis, mimeTypes }) =>
      Object.freeze({
        maxBytes,
        timeoutMillis: timeoutMillis ?? 60_000,
        mimeTypes: Object.freeze([...mimeTypes]),
      }),
    ),
    Effect.mapError(() =>
      BrowserbaseError.make({ operation: "download", reason: "configuration" }),
    ),
  );
