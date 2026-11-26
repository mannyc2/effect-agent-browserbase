/**
 * Pictures of a page: its viewport as a frame of a stated age, crops of it, its screencast with
 * frames stamped by the browser's clock, and how it paints. Each function takes the page first.
 *
 * @stability stable
 * @since 0.3.0
 */
import { type Duration, type Effect, Function, type Scope, Schema, type Stream } from "effect";

import type { BrowserError } from "./BrowserError.ts";
import { functionsOf, isPage } from "./internal/page/functions.ts";
import type { Page } from "./Page.ts";

/**
 * An encoded picture with its pixel dimensions. Crops also need their viewport origin.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Image extends Schema.Class<Image>("effect-browser/Frame/Image")({
  data: Schema.Uint8Array,
  mediaType: Schema.Literals(["image/jpeg", "image/png"]),
  width: Schema.Finite,
  height: Schema.Finite,
}) {}

const Nonnegative = Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

/**
 * Native CDP paint time mapped to the owning host clock, with transport uncertainty retained.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class BrowserPaint extends Schema.TaggedClass<BrowserPaint>(
  "effect-browser/Frame/BrowserPaint",
)("BrowserPaint", {
  timestamp: Schema.Finite,
  hostTime: Schema.Finite,
  uncertaintyMillis: Nonnegative,
}) {}

/**
 * A screenshot's host capture interval; it has no native browser paint timestamp.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Screenshot extends Schema.TaggedClass<Screenshot>("effect-browser/Frame/Screenshot")(
  "Screenshot",
  {
    hostTime: Schema.Finite,
    uncertaintyMillis: Nonnegative,
  },
) {}

/**
 * An image and its timing evidence. Paint time and screenshot capture time cannot be confused in
 * serialized data. `receivedAt` records delivery on the owning host's monotonic clock; it does
 * not make an old paint current.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Frame extends Schema.Class<Frame>("effect-browser/Frame")({
  page: Schema.String,
  /** The page's browser session: its provider's session id, as `Browser.Service.id` gives it. */
  session: Schema.String,
  /** Owning Browser connection; document counters restart on adoption or reattachment. */
  connection: Schema.String.check(Schema.isNonEmpty()),
  /** Native capture identity. Screenshots have no capture generation or sequence. */
  capture: Schema.optionalKey(Schema.Struct({ generation: Count, sequence: Count })),
  data: Schema.Uint8Array,
  /** The picture's type, when a new picture gave it; one without is a JPEG, as screencast frames are. */
  mediaType: Schema.optionalKey(Schema.Literals(["image/jpeg", "image/png"])),
  timing: Schema.Union([BrowserPaint, Screenshot]),
  receivedAt: Schema.Finite,
  width: Schema.Finite,
  height: Schema.Finite,
  /**
   * The page's document committed before the frame arrived, as `Navigated` counts them. Just
   * after a commit a browser can still show the old document's paint, so a frame may show the
   * document before its own, never one after it.
   */
  document: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The page's address when the frame arrived. */
  url: Schema.String,
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
      mediaType: this.mediaType ?? "image/jpeg",
      width: this.width,
      height: this.height,
    });
  }
}

/**
 * Equal capture lineage survives an image copy; untagged pictures retain object identity only.
 *
 * @stability stable
 * @category predicates
 * @since 0.3.0
 */
export const sameCapture = (frame: Frame, other: Frame | undefined): boolean =>
  other !== undefined &&
  (frame === other ||
    (frame.capture !== undefined &&
      frame.page === other.page &&
      frame.session === other.session &&
      frame.connection === other.connection &&
      frame.document === other.document &&
      frame.capture.generation === other.capture?.generation &&
      frame.capture.sequence === other.capture?.sequence));

/**
 * A page's capture counts, over its life or a window of the latest minute: what Chromium sent,
 * what readers got, and why the rest went no further. Frames that came late are counted apart from
 * those a reader lost.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class CaptureStats extends Schema.Class<CaptureStats>("effect-browser/Frame/CaptureStats")({
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
   * Frames discarded while native capture is paused for a library picture and its restoration.
   * A pause can produce no callbacks, so this count may remain zero even when pictures were taken.
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
 *
 * @stability stable
 * @category options
 * @since 0.3.0
 */
export interface ScreencastOptions {
  /** JPEG quality, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
  /** Frames are scaled down to fit this box. Defaults to the viewport in CSS pixels. */
  readonly size?: { readonly width: number; readonly height: number } | undefined;
}

/**
 * An integer rectangle in viewport CSS pixels.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Region extends Schema.Class<Region>("effect-browser/Frame/Region")({
  x: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  y: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  width: Schema.Int.check(Schema.isGreaterThan(0)),
  height: Schema.Int.check(Schema.isGreaterThan(0)),
}) {}

/**
 * A crop and its viewport origin: add that origin to a point read from the crop.
 *
 * @stability stable
 * @category schemas
 * @since 0.3.0
 */
export class Zoom extends Schema.Class<Zoom>("effect-browser/Frame/Zoom")({
  page: Schema.String,
  region: Region,
  image: Image,
}) {}

/**
 * How current a picture must be, and how a new one is taken. The newest screencast frame serves
 * when it qualifies, at no cost; otherwise a new screenshot is taken.
 *
 * @stability stable
 * @category options
 * @since 0.3.0
 */
export interface FrameOptions {
  /**
   * The oldest a reused frame may be, from its paint, at the earliest its timing allows, to now.
   * Defaults to 250 milliseconds; 0 always takes a new screenshot.
   */
  readonly maxAge?: Duration.Input | undefined;
  /**
   * `"input"`: reuse only a frame painted after this page's latest input, including input of an
   * interrupted action, and never while an action is changing the page. For a caller that has
   * just acted on the page, so that it sees what its action did.
   */
  readonly after?: "input" | undefined;
  /** JPEG quality of a new picture, 0 to 100. Defaults to 80. */
  readonly quality?: number | undefined;
  /** `"jpeg"`, the default, or `"png"`, which is always a new picture. */
  readonly format?: "jpeg" | "png" | undefined;
  /**
   * `"css"`, the default, a picture pixel per CSS pixel; `"device"`, the screen's own pixels, as
   * many to a CSS pixel as its device scale factor, which is always a new picture.
   */
  readonly scale?: "css" | "device" | undefined;
}

/**
 * How a page paints for a scope; see `paint`.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Paint {
  /** Device pixels to each CSS pixel, more than 0 and at most 4. The layout keeps its size. */
  readonly scale?: number | undefined;
  /** False hides the page's scrollbars from its next document on, and its layout takes their room. */
  readonly scrollbars?: boolean | undefined;
}

/**
 * Scoped access to one page's shared capture and its current-document evidence.
 *
 * @stability stable
 * @category models
 * @since 0.3.0
 */
export interface Capture {
  /**
   * Screencast frames for as long as the stream runs. Concurrent streams share one screencast and
   * its settings; explicit options that differ from a running screencast's fail with
   * InvalidRequest.
   */
  readonly stream: Stream.Stream<Frame, BrowserError>;
  readonly current: Frame | undefined;
  readonly isCurrent: (frame: Frame) => boolean;
  readonly confirm: (frame: Frame) => Effect.Effect<boolean, BrowserError>;
  readonly sync: Effect.Effect<void, BrowserError>;
  /**
   * What this page's captures received, delivered and dropped, over its life or the latest
   * `window`, which reaches back at most a minute; a longer one is an `InvalidRequest`. It reads
   * the page's counts, so it serves after the lease's scope has closed.
   */
  readonly stats: (options?: {
    readonly window?: Duration.Input | undefined;
  }) => Effect.Effect<CaptureStats, BrowserError>;
}

/**
 * The viewport with its timing: the newest screencast frame if it qualifies, else a new
 * screenshot timed by the host interval in which it was taken. A frame of a stated age that the
 * screencast has costs nothing and waits for no action; one that must follow the latest input, or
 * a new screenshot, waits for the action in flight.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const read: {
  (options?: FrameOptions): (page: Page) => Effect.Effect<Frame, BrowserError>;
  (page: Page, options?: FrameOptions): Effect.Effect<Frame, BrowserError>;
} = Function.dual(
  (args) => isPage(args[0]),
  (page: Page, options?: FrameOptions) => functionsOf(page).frame(options),
);

/**
 * A crop in CSS pixels, unmagnified, with the origin that keeps later input in viewport pixels.
 * A crop is always a new picture; with `scale: "device"` it has the screen's own pixels.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const zoom: {
  (
    region: Region,
    options?: Pick<FrameOptions, "quality" | "format" | "scale">,
  ): (page: Page) => Effect.Effect<Zoom, BrowserError>;
  (
    page: Page,
    region: Region,
    options?: Pick<FrameOptions, "quality" | "format" | "scale">,
  ): Effect.Effect<Zoom, BrowserError>;
} = Function.dual(
  (args) => isPage(args[0]),
  (page: Page, region: Region, options?: Pick<FrameOptions, "quality" | "format" | "scale">) =>
    functionsOf(page).zoom(region, options),
);

/**
 * A scoped lease on the page's capture, which starts at once, independently of its first frame.
 *
 * @stability stable
 * @category constructors
 * @since 0.3.0
 */
export const capture: {
  (options?: ScreencastOptions): (page: Page) => Effect.Effect<Capture, BrowserError, Scope.Scope>;
  (page: Page, options?: ScreencastOptions): Effect.Effect<Capture, BrowserError, Scope.Scope>;
} = Function.dual(
  (args) => isPage(args[0]),
  (page: Page, options?: ScreencastOptions) => functionsOf(page).capture(options),
);

/**
 * The page's screencast frames painted within the browser's `frameHistory` of the newest, oldest first.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const recent = (page: Page): Effect.Effect<ReadonlyArray<Frame>> =>
  functionsOf(page).recentFrames;

/**
 * Paint the page at `scale` device pixels to each CSS pixel, or without its scrollbars, for a
 * scope: a frame with `scale: "device"` then has that many more pixels, while the layout, its
 * boxes and input keep their CSS pixels. Scrollbars go from the next document on, and come back
 * from the next after the scope, so paint, then load the page, then measure it. One at a time. A
 * browser this library launched paints at the scale of its launch (Chromium's
 * `deviceScaleFactor`), and refuses another.
 *
 * @stability stable
 * @category combinators
 * @since 0.3.0
 */
export const paint: {
  (options: Paint): (page: Page) => Effect.Effect<void, BrowserError, Scope.Scope>;
  (page: Page, options: Paint): Effect.Effect<void, BrowserError, Scope.Scope>;
} = Function.dual(2, (page: Page, options: Paint) => functionsOf(page).paint(options));
