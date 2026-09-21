import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import type { DownloadPolicy } from "effect-browserbase/downloads";
import { ArtifactError, FileError } from "effect-browserbase/errors";
import type { DownloadLimits } from "effect-browserbase/recordings";
import { ArtifactTransferPolicy } from "effect-browserbase/transfers";

import { downloadTransferPolicy, transferPolicy } from "../src/internal/artifact/TransferPolicy.ts";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const alias: Same<DownloadLimits, ArtifactTransferPolicy> = true;
const shape: Same<DownloadPolicy["maxBytes"], number> = true;

const invalidRecording = () =>
  ArtifactError.make({ operation: "recording-download", reason: "configuration" });

const invalidFile = () => FileError.make({ operation: "download", reason: "configuration" });

const error: Same<
  Effect.Error<ReturnType<typeof transferPolicy<ArtifactError>>>,
  ArtifactError
> = true;

type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

const environment: Same<
  Requirements<ReturnType<typeof transferPolicy<ArtifactError>>>,
  never
> = true;

it("shares a transport-data Schema and preserves the legacy public type shapes and error/environment", () => {
  expect(alias && shape && error && environment).toBe(true);
  expect(Schema.decodeSync(ArtifactTransferPolicy)({ maxBytes: 1 })).toEqual({ maxBytes: 1 });
  expect(
    Schema.decodeSync(ArtifactTransferPolicy)({ maxBytes: 2 ** 31 - 1, timeoutMillis: 600000 }),
  ).toEqual({ maxBytes: 2 ** 31 - 1, timeoutMillis: 600000 });
});

it.effect(
  "normalizes the existing default and owns scalars rather than returning caller data",
  () =>
    Effect.gen(function* () {
      const input = { maxBytes: 7 };
      const result = yield* transferPolicy(input, invalidRecording);

      input.maxBytes = 100;
      expect(result).toEqual({ maxBytes: 7, timeoutMillis: 60000 });
      expect(result).not.toBe(input);
    }),
);

it.effect("copies MIME entries without silently normalizing or widening their authority", () =>
  Effect.gen(function* () {
    const input = { maxBytes: 7, mimeTypes: ["text/plain", "IMAGE/PNG"] };
    const result = yield* downloadTransferPolicy(input, invalidFile);

    input.mimeTypes.push("application/octet-stream");
    expect(result.mimeTypes).toEqual(["text/plain", "IMAGE/PNG"]);
    expect(result.mimeTypes).not.toBe(input.mimeTypes);
  }),
);

it.effect("rejects empty or oversized MIME lists without exposing caller content", () =>
  Effect.gen(function* () {
    for (const mimeTypes of [[], Array.from({ length: 33 }, () => "PRIVATE")]) {
      const result = yield* downloadTransferPolicy({ maxBytes: 1, mimeTypes }, invalidFile).pipe(
        Effect.result,
      );

      expect(result._tag).toBe("Failure");
      if (result._tag === "Failure") {
        expect(result.failure.reason).toBe("configuration");
        expect(JSON.stringify(result.failure)).not.toContain("PRIVATE");
      }
    }
  }),
);
