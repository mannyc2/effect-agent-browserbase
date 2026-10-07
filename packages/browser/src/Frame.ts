/**
 * Pictures of a page: screenshots, and screencast frames stamped with the browser's clock.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

/** An encoded picture with its pixel dimensions. Crops also need their viewport origin. */
export class Image extends Schema.Class<Image>("effect-browser/Image")({
  data: Schema.Uint8Array,
  mediaType: Schema.Literals(["image/jpeg", "image/png"]),
  width: Schema.Finite,
  height: Schema.Finite,
}) {}

const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/** Native CDP paint time mapped to the owning host clock, with transport uncertainty retained. */
export class BrowserPaint extends Schema.TaggedClass<BrowserPaint>()("BrowserPaint", {
  timestamp: Schema.Finite,
  hostTime: Schema.Finite,
  uncertaintyMillis: Nonnegative,
}) {}

/** A screenshot's host capture interval; it has no native browser paint timestamp. */
export class Screenshot extends Schema.TaggedClass<Screenshot>()("Screenshot", {
  hostTime: Schema.Finite,
  uncertaintyMillis: Nonnegative,
}) {}

/**
 * An image and its timing evidence. Paint time and screenshot capture time cannot be confused in
 * serialized data. `receivedAt` records delivery on the owning host's monotonic clock; it does
 * not make an old paint current.
 */
export class Frame extends Schema.Class<Frame>("effect-browser/Frame")({
  page: Schema.String,
  data: Schema.Uint8Array,
  timing: Schema.Union([BrowserPaint, Screenshot]),
  receivedAt: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
}) {
  get timestamp(): number | undefined {
    return this.timing._tag === "BrowserPaint" ? this.timing.timestamp : undefined;
  }

  get hostTime(): number {
    return this.timing.hostTime;
  }

  get image(): Image {
    return new Image({
      data: this.data,
      mediaType: "image/jpeg",
      width: this.width,
      height: this.height,
    });
  }
}

/**
 * Startup measurements from a private blank page. The first captured image containing a probe
 * bounds its observed presentation delay; it does not measure the first paint or future page load.
 */
export class CaptureCalibration extends Schema.Class<CaptureCalibration>(
  "effect-browser/CaptureCalibration",
)({
  clock: Schema.Struct({
    offsetMillis: Schema.Finite,
    uncertaintyMillis: Nonnegative,
    roundTripMillis: Nonnegative,
    sampledAt: Schema.Finite,
  }),
  paintSamples: Schema.Array(Schema.Struct({ sentAt: Schema.Finite, timestamp: Schema.Finite })),
}) {
  /**
   * Combined send-to-captured-image delay on this frame's mapping. Recomputing the offset preserves
   * the cancellation of clock-estimation bias when capture starts with a newer calibration.
   */
  delayFor(frame: Frame): number | undefined {
    if (frame.timing._tag !== "BrowserPaint" || this.paintSamples.length === 0) return undefined;

    const offsets = this.paintSamples
      .map((sample) => sample.timestamp - sample.sentAt)
      .toSorted((left, right) => left - right);

    const middle = Math.floor(offsets.length / 2);
    const upper = offsets[middle];

    if (upper === undefined) return undefined;
    const median = offsets.length % 2 === 0 ? ((offsets[middle - 1] ?? upper) + upper) / 2 : upper;

    return median - (frame.timing.timestamp - frame.hostTime);
  }
}

/** Lifetime capture counters. Subscriber loss is observed per reader, so totals can exceed frames. */
export class CaptureStats extends Schema.Class<CaptureStats>("effect-browser/CaptureStats")({
  received: Count,
  accepted: Count,
  outOfOrder: Count,
  missingTimestamp: Count,
  /**
   * Frames dropped for their size: other captures' frames, as a clipped screenshot draws into a
   * screencast, and the oldest of a new size's frames beyond the 16 kept while it is confirmed.
   */
  foreignSize: Count,
  subscriberMissed: Count,
  gaps: Schema.Struct({
    count: Count,
    totalMillis: Nonnegative,
    minMillis: Schema.NullOr(Nonnegative),
    maxMillis: Schema.NullOr(Nonnegative),
    lastMillis: Schema.NullOr(Nonnegative),
  }),
}) {}

/**
 * Settings for a page's one native capture. Readers that join a running capture share its
 * settings: one without options accepts them, and one whose explicit options differ fails with
 * `InvalidRequest`.
 */
export interface ScreencastOptions {
  /** JPEG quality, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
  /** Frames are scaled down to fit this box. Defaults to the viewport in CSS pixels. */
  readonly size?: { readonly width: number; readonly height: number } | undefined;
}
