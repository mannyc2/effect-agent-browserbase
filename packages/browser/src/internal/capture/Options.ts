import { Schema } from "effect";

export const Dimension = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 }));
const BufferedBytes = Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 64 * 1024 * 1024 }));

/**
 * Upper bounds of one interval. Frames can be held for as long as a consumer delays them, so the
 * frame bound is set by memory (the byte bound), not by a short hand-off; an interval can last
 * as long as a session may.
 */
export const CaptureMaxima = Object.freeze({ frames: 1024, durationMillis: 21_600_000 });

/** Defaults shared by runtime admission and the optional public data schema. */
export const CaptureDefaults = Object.freeze({
  maxFrames: 4,
  maxBufferedBytes: 16 * 1024 * 1024,
  maxFrameBytes: 4 * 1024 * 1024,
  maxDurationMillis: 60000,
  quality: 80,
});

export const LimitFields = {
  maxFrames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: CaptureMaxima.frames })),
  maxBufferedBytes: BufferedBytes,
  maxFrameBytes: BufferedBytes,
  maxDurationMillis: Schema.Int.check(
    Schema.isBetween({ minimum: 1, maximum: CaptureMaxima.durationMillis }),
  ),
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
