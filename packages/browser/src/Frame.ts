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

/**
 * One screencast frame. `timestamp` is when the browser painted it, by the browser's clock, which
 * spaces frames exactly. `receivedAt` is its arrival in host monotonic milliseconds, on the owning
 * browser’s Effect `Clock`, shared with `BrowserEvent` and `Moment`. The clocks have distinct origins;
 * subtract stamps only within one clock. A screenshot fallback uses host wall time for `timestamp`.
 */
export class Frame extends Schema.Class<Frame>("effect-browser/Frame")({
  page: Schema.String,
  data: Schema.Uint8Array,
  timestamp: Schema.Finite,
  receivedAt: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
}) {
  get image(): Image {
    return new Image({
      data: this.data,
      mediaType: "image/jpeg",
      width: this.width,
      height: this.height,
    });
  }
}

export interface ScreencastOptions {
  /** JPEG quality, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
  /** Frames are scaled down to fit this box. Defaults to the viewport. */
  readonly size?: { readonly width: number; readonly height: number } | undefined;
}
