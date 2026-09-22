import { Schema } from "effect";

export const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 }));
const BufferedBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 }));

/** Defaults shared by runtime admission and the optional public data schema. */
export const CaptureDefaults = Object.freeze({
  maxFrames: 4,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxDurationMillis: 60000,
  quality: 80,
});

export const LimitFields = {
  maxFrames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 })),
  maxBufferedBytes: BufferedBytes,
  maxFrameBytes: BufferedBytes,
  maxDurationMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 600000 })),
  quality: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
};

export const FrameBudget = Schema.makeFilter(
  (value: { readonly maxFrameBytes?: number; readonly maxBufferedBytes?: number }) =>
    (value.maxFrameBytes ?? CaptureDefaults.maxFrameBytes) <=
    (value.maxBufferedBytes ?? CaptureDefaults.maxBufferedBytes),
  { message: "A frame must fit within the resolved buffer budget" },
);

/** Fully resolved admission values; callers supply the optional public CaptureOptions instead. */
export const CaptureLimits = Schema.Struct(LimitFields).check(FrameBudget);
