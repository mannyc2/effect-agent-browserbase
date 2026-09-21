import { Schema } from "effect";

export const PositiveInt = Schema.Int.check(Schema.isGreaterThan(0));

/** Shared caller-owned transfer bounds. Omitted timeout retains the 60-second default. */
export const ArtifactTransferPolicy = Schema.Struct({
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 2 ** 31 - 1 })),
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600_000 })),
  ),
});

export type ArtifactTransferPolicy = typeof ArtifactTransferPolicy.Type;

/** Portable basename only; never a local or remote filesystem path. */
export const SafeFilename = Schema.NonEmptyString.check(
  Schema.isMaxLength(240),
  Schema.makeFilter(
    (value) =>
      value !== "." &&
      value !== ".." &&
      !/[\x00-\x1f\x7f/\\:]/.test(value) &&
      !/[. ]$/.test(value) &&
      !/^\s/.test(value) &&
      !/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(value),
    { title: "a portable, non-path download filename" },
  ),
);
