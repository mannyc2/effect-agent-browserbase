import { Crypto, Effect, type PlatformError, Schema, type Scope, Stream } from "effect";

import type { BrowserSession } from "./Browser.ts";
import { PageInfo } from "./BrowserData.ts";
import type {
  CapturedFrame,
  CaptureOptions,
  CaptureSnapshot,
  CaptureSummary,
  FrameReady,
  FrameSourceOptions,
  FrameSourceReport,
  FrameSourceSnapshot,
  FrameSubscriptionOptions,
  FrameSubscriptionReport,
  FrameSubscriptionSnapshot,
} from "./CaptureData.ts";
import type { Observation, ObservationError, ObservationOptions } from "./CaptureEvidence.ts";
import { BrowserError, Reasons } from "./Errors.ts";
import { captureParent } from "./internal/browser/Association.ts";
import { startCapture } from "./internal/capture/Capture.ts";
import { openFrameSource } from "./internal/capture/Source.ts";

export {
  CapturedFrame,
  CaptureOptions,
  CaptureSize,
  CaptureSnapshot,
  CaptureSummary,
  FrameReady,
  FrameSourceOptions,
  FrameSourceReport,
  FrameSourceSnapshot,
  FrameSubscriptionOptions,
  FrameSubscriptionReport,
  FrameSubscriptionSnapshot,
} from "./CaptureData.ts";

/** Live stream/Effect capabilities intentionally have no data schema or serialization contract. */
export interface CaptureInterval {
  /** Single subscription. Ending or interrupting it stops this interval, not its browser. */
  readonly frames: Stream.Stream<CapturedFrame, BrowserError>;
  /**
   * A bounded copy of recorded metadata, available during capture and after cleanup. No native
   * work, budget charge or subscription. Drain frames, then read `completed` for final accounting.
   */
  readonly snapshot: Effect.Effect<CaptureSnapshot>;
  readonly stop: Effect.Effect<CaptureSummary>;
  readonly completed: Effect.Effect<CaptureSummary>;
}

/** One independent, bounded, single-consumer view of a shared image source. */
export interface FrameSubscription {
  readonly sourceId: string;
  /** Each delivered image owns its byte copy; retaining it is the consumer's memory responsibility. */
  readonly frames: Stream.Stream<CapturedFrame, BrowserError>;
  readonly snapshot: Effect.Effect<FrameSubscriptionSnapshot>;
  /** Detach now and preserve admitted images for draining. Does not wait for that drain. */
  readonly stop: Effect.Effect<FrameSubscriptionReport>;
  /** Available once admitted images have drained or this subscription's scope has disposed them. */
  readonly completed: Effect.Effect<FrameSubscriptionReport>;
}

/** A source owns native capture; subscribers own only their independent delivery windows. */
export interface FrameSource {
  readonly sourceId: string;
  readonly subscribe: (
    options?: FrameSubscriptionOptions,
  ) => Effect.Effect<FrameSubscription, BrowserError, Scope.Scope>;
  readonly observe: (
    options?: ObservationOptions,
  ) => Effect.Effect<Observation, ObservationError, Scope.Scope>;
  readonly ready: Effect.Effect<FrameReady, BrowserError>;
  readonly snapshot: Effect.Effect<FrameSourceSnapshot>;
  readonly stop: Effect.Effect<FrameSourceReport>;
  readonly completed: Effect.Effect<FrameSourceReport>;
}

/**
 * Acquire one source over this exact browser owner. Acquisition installs capture; `ready`
 * separately waits for the first valid sample. It makes no promise about future paint coverage.
 * Ending a subscriber leaves the source and its siblings running until the source ends.
 */
export const openFrames = <E>(
  session: BrowserSession<E>,
  options: FrameSourceOptions = {},
): Effect.Effect<FrameSource, BrowserError, Scope.Scope> =>
  Effect.suspend(() => {
    const parent = captureParent(session);

    if (parent === undefined)
      return Effect.fail(
        BrowserError.make({
          operation: "capture",
          reason: Reasons.UnregisteredSession.make({}),
          outcome: "undispatched",
        }),
      );

    return Effect.flatMap(parent.newCaptureId, (sourceId) =>
      openFrameSource((captureOptions) => start(session, captureOptions), options, sourceId),
    );
  });

/**
 * Capture one remote page independently of the session's selected page.
 *
 * Requires the exact live session returned by the host; copying a session object or decoding
 * a durable reference cannot copy its capture authority. The private owner is not frame data.
 * `CapturedFrame` and `CaptureOptions` are Schema values as well as structural types. Frame
 * decoding checks binary/metadata fields, not the complete JPEG bitstream or target authority,
 * and does not copy bytes. Options decoding preserves omissions; admission applies defaults.
 * `CaptureInterval` remains a live scoped capability, not a schema or JSON/Tool value.
 */
export const start = <E>(
  session: BrowserSession<E>,
  options: CaptureOptions = {},
): Effect.Effect<CaptureInterval, BrowserError, Scope.Scope> =>
  Effect.suspend(() => {
    const parent = captureParent(session);

    if (parent === undefined)
      return Effect.fail(
        BrowserError.make({
          operation: "capture",
          reason: Reasons.UnregisteredSession.make({}),
          outcome: "undispatched",
        }),
      );
    if (options.target === undefined) return startCapture(parent, options);

    return Schema.decodeEffect(PageInfo)(options.target, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() =>
        BrowserError.make({
          operation: "capture",
          reason: Reasons.Configuration.make({}),
          outcome: "undispatched",
        }),
      ),
      Effect.flatMap((target) => startCapture(parent, { ...options, target })),
    );
  });

/**
 * A lazy, scoped frame stream. Each subscription acquires one interval and finalizes it when
 * consumption ends, fails or is interrupted; the browser remains owned by its caller.
 * Concurrent subscriptions on the same page are refused by the existing capture reservation.
 * Unconfirmed native cleanup retains the page reservation. Use start when the host needs
 * explicit stop acknowledgement, interval snapshots and the final capture summary.
 */
export const stream = <E>(
  session: BrowserSession<E>,
  options: CaptureOptions = {},
): Stream.Stream<CapturedFrame, BrowserError> =>
  Stream.unwrap(start(session, options).pipe(Effect.map((interval) => interval.frames)));

/** A `multipart/x-mixed-replace` body and the content type that names its boundary. */
export interface MultipartBody<E, R> {
  readonly contentType: string;
  readonly body: Stream.Stream<Uint8Array, E, R>;
}

/**
 * Frames as motion JPEG for an `<img>`: one `multipart/x-mixed-replace` response, as WHATWG HTML
 * defines it for images. Each frame is followed at once by the next part's delimiter and headers,
 * because a browser shows a part only when it has read the headers of the one after it; without
 * that, a still page's last picture would never be shown. Parts carry no metadata, so nothing
 * but the pictures reaches a viewer. The boundary is drawn from `Crypto` for each response, so a
 * page cannot shape its pixels into it. Call it once per viewer.
 */
export const multipart = <E, R>(
  frames: Stream.Stream<CapturedFrame, E, R>,
): Effect.Effect<MultipartBody<E, R>, PlatformError.PlatformError, Crypto.Crypto> =>
  Effect.map(
    Effect.flatMap(Crypto.Crypto, (crypto) => crypto.randomUUIDv4),
    (uuid) => {
      const boundary = `frame-${uuid.replaceAll("-", "")}`;
      const encoder = new TextEncoder();
      const opening = encoder.encode(`--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`);
      const next = encoder.encode(`\r\n--${boundary}\r\nContent-Type: image/jpeg\r\n\r\n`);

      return {
        contentType: `multipart/x-mixed-replace; boundary=${boundary}`,
        body: Stream.make(opening).pipe(
          Stream.concat(frames.pipe(Stream.flatMap((frame) => Stream.make(frame.bytes, next)))),
          Stream.concat(Stream.make(encoder.encode(`--${boundary}--\r\n`))),
        ),
      };
    },
  );
