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
 * A page's capture counts, over its life or a window of the latest minute: what Chromium sent,
 * what readers got, and why the rest went no further. Frames that came late are counted apart from
 * those a reader lost.
 */
export class CaptureStats extends Schema.Class<CaptureStats>("effect-browser/CaptureStats")({
  received: Count,
  accepted: Count,
  /**
   * Frames Chromium finished encoding after a newer one, dropped rather than reordered. It encodes
   * several at once, so a busy machine makes more of them; none was a paint readers missed.
   */
  late: Count,
  missingTimestamp: Count,
  /**
   * Frames dropped for their size. Most are other captures' frames, which a clipped screenshot
   * draws into a screencast. The rest are the page's own frames of a new size, dropped while still
   * unconfirmed: when another size replaced it, when its capture stopped, or beyond the 16 held.
   */
  foreignSize: Count,
  /**
   * Frames dropped because they may have been painted, or arrived, while the library took a clipped
   * or scaled picture of the page, such as a zoom: Chromium draws those into the screencast too.
   * Where Playwright emulates the viewport, the page's own frames from that time are among them; a
   * crop on the page's own session leaves out only frames of another size than the page's.
   */
  duringPictures: Count,
  /**
   * Frames a reader missed by falling behind. Each reader counts its own, so with several readers
   * this can exceed the frames accepted.
   */
  lost: Count,
  /**
   * Acknowledgements of frames sent and not yet answered, now, whatever the window. Chromium sends
   * a frame only while few are unacknowledged, so a backlog means fewer frames.
   */
  ackBacklog: Count,
  /** Paint-time gaps between consecutive accepted frames. */
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
