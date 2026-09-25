import { Schema } from "effect";

import { PageInfo, Target } from "./BrowserData.ts";
import { BrowserError } from "./Errors.ts";
import { Dimension, FrameBudget, LimitFields } from "./internal/capture/Options.ts";

/**
 * Binary frame data, not a live capability or a JSON/thread/Tool value. Decoding validates
 * fields; it does not copy bytes, decode JPEG pixels, prove target authority, or repair clocks.
 * Capture itself owns the byte copy, freezes its shared target identity, and verifies JPEG framing.
 */
export const CapturedFrame = Schema.Struct({
  bytes: Schema.Uint8Array.check(Schema.isMinLength(4), Schema.isMaxLength(64 * 1024 * 1024)),
  mediaType: Schema.Literal("image/jpeg"),
  target: Target,
  sequence: Schema.Natural,
  /**
   * Which document of its page this frame was received during: 0 at the start, one more for each
   * main-frame navigation the interval observed. It is attribution by receipt order, not proof
   * of whose pixels these are: a frame received just after a navigation can still show the
   * document before it. Always 0 for an interval that lasts one document.
   */
  document: Schema.Natural,
  sourceTimeMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
  sourceClock: Schema.Literal("presentation-unix-millis"),
  receivedMonotonicNanos: Schema.BigInt,
  width: Dimension,
  height: Dimension,
  viewportWidth: Dimension,
  viewportHeight: Dimension,
}).check(
  Schema.makeFilter((frame) => frame.width * frame.height <= 33_554_432, {
    message: "Frame geometry exceeds the capture pixel bound",
  }),
);

export type CapturedFrame = typeof CapturedFrame.Type;

/** Source-fit request in pixels. Actual JPEG bounds are checked before any frame is delivered. */
export const CaptureSize = Schema.Struct({ width: Dimension, height: Dimension });

export type CaptureSize = typeof CaptureSize.Type;

/** Optional capture data. Defaults are applied at admission, not during schema decoding. */
export const CaptureOptions = Schema.Struct({
  /** Pin to a page from `session.pages`; omission preserves selected-page behavior. */
  target: Schema.optionalKey(PageInfo),
  /**
   * Frames held until the consumer takes them (4 by default, at most 1024), oldest dropped first
   * and counted as `overflow`. A consumer that delays its output leaves frames here, so this and
   * `maxBufferedBytes` are the delay's memory bound.
   */
  maxFrames: Schema.optionalKey(LimitFields.maxFrames),
  maxBufferedBytes: Schema.optionalKey(LimitFields.maxBufferedBytes),
  maxFrameBytes: Schema.optionalKey(LimitFields.maxFrameBytes),
  /** 60 seconds by default, at most six hours: as long as a session may last. */
  maxDurationMillis: Schema.optionalKey(LimitFields.maxDurationMillis),
  quality: Schema.optionalKey(LimitFields.quality),
  /** Source fit only. Does not resize the viewport or impose an FPS cap. */
  size: Schema.optionalKey(CaptureSize),
  /**
   * `document`, the default, ends the interval when its page navigates. `page` follows the page
   * across documents, so a capture started before a navigation covers the loading in between.
   * It applies to a page's main frame; a capture bound to a child frame still ends with it.
   */
  lifetime: Schema.optionalKey(Schema.Literals(["document", "page"])),
}).check(FrameBudget);

export type CaptureOptions = typeof CaptureOptions.Type;

/** An address as the browser reported it. One longer than this is recorded as null, not cut. */
const DocumentUrl = Schema.NullOr(Schema.String.check(Schema.isMaxLength(8192)));

export class CaptureSummary extends Schema.Class<CaptureSummary>("BrowserCaptureSummary")({
  target: Target,
  reason: Schema.String.check(Schema.isMaxLength(64)),
  received: Schema.Natural,
  delivered: Schema.Natural,
  /** All frames this package omitted; the sum of the four disjoint components below. */
  discarded: Schema.Natural,
  /** Evicted by the frame-count or buffered-byte bound. */
  overflow: Schema.Natural,
  duplicates: Schema.Natural,
  /** Arrived after a newer frame was accepted; never reordered in. */
  late: Schema.Natural,
  /** Other refused frames, including malformed data, bounds and undelivered scope cleanup. */
  rejected: Schema.Natural,
  peakBufferedFrames: Schema.Natural,
  peakBufferedBytes: Schema.Natural,
  bufferedFrames: Schema.Natural,
  bufferedBytes: Schema.Natural,
  sourceFirstMillis: Schema.NullOr(Schema.Finite),
  sourceLastMillis: Schema.NullOr(Schema.Finite),
  /**
   * The captured frame's address when this interval began watching it: the URL of document 0.
   * It is read in the same turn the watch is installed, so no navigation can fall between them.
   */
  initialUrl: DocumentUrl,
  /**
   * Each main-frame URL change a `page` interval observed, in order, with the last frame
   * received before it and the address it reached. `sameDocument` is true when the existing
   * document changed its URL; it retains the current document number. The native screencast is
   * never restarted for one, so a boundary is not a gap this package introduced; what Chromium
   * omitted while loading stays `upstreamDrops`. A boundary is the commit. When that navigation
   * started and when its document finished loading are the caller's to stamp, on this same
   * clock, around the operation that caused it. A title is page state, not part of a transition.
   */
  documentBoundaries: Schema.Array(
    Schema.Struct({
      document: Schema.Natural,
      sameDocument: Schema.Boolean,
      observedMonotonicNanos: Schema.BigInt,
      afterSequence: Schema.NullOr(Schema.Natural),
      url: DocumentUrl,
    }),
  ).check(Schema.isMaxLength(64)),
  /**
   * More navigations were observed than are recorded above, so the earliest were let go: the
   * record keeps the latest 64. Frames still count them all.
   */
  documentBoundariesTruncated: Schema.Boolean,
  nativeStop: Schema.Literals(["confirmed", "unconfirmed"]),
  /** Package accounting cannot measure frames omitted by Chromium, transport, or the provider. */
  upstreamDrops: Schema.Literal("unknown"),
  error: Schema.optionalKey(BrowserError),
}) {}

const { reason: StopReason, nativeStop: NativeStop, ...SnapshotFields } = CaptureSummary.fields;

/**
 * Host-side metadata at one instant, without reading or waking the page. The boundary prefix
 * and loss counters are the same facts as the final summary, independent of frame consumption.
 * `stopped` means native cleanup settled; buffered frames may still be drained afterwards.
 */
export class CaptureSnapshot extends Schema.Class<CaptureSnapshot>("BrowserCaptureSnapshot")({
  ...SnapshotFields,
  phase: Schema.Literals(["capturing", "stopping", "stopped"]),
  observedMonotonicNanos: Schema.BigInt,
  /** Keeps counting when the bounded boundary prefix is truncated. */
  currentDocument: Schema.Natural,
  /** No reason is reported while the capture still accepts frames. */
  reason: Schema.NullOr(StopReason),
  /** Null until the native cleanup attempt settles; unconfirmed never means stopped remotely. */
  nativeStop: Schema.NullOr(NativeStop),
}) {}
