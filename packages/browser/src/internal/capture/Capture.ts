import { Cause, Clock, Deferred, Effect, Exit, Queue, Schema, Stream } from "effect";

import type { Target } from "../../BrowserData.ts";
import type { CaptureInterval } from "../../Capture.ts";
import {
  CaptureSize,
  CaptureSnapshot,
  CaptureSummary,
  type CaptureOptions,
  type CapturedFrame,
} from "../../CaptureData.ts";
import { BrowserError } from "../../Errors.ts";
import { type CaptureLease, type CaptureParent } from "../browser/Association.ts";
import type { CaptureSource, NativeFrame } from "../browser/Driver.ts";
import { jpegGeometry } from "../browser/Images.ts";
import { FrameBuffer } from "./FrameBuffer.ts";
import { CaptureDefaults, CaptureLimits } from "./Options.ts";

const MaxParentCaptures = 4;
const MaxParentBufferedBytes = 64 * 1024 * 1024;
const MaxDocumentBoundaries = 64;
const MaxDocumentUrlLength = 8192;

/** An over-long address is recorded as null rather than cut into one that was never shown. */
const documentUrl = (url: unknown): string | null =>
  typeof url === "string" && url.length <= MaxDocumentUrlLength ? url : null;

/**
 * Chromium stamps a screencast frame on its UI thread, encodes it on an unsequenced thread
 * pool, and emits it when that encode completes. It admits a new frame while at most two are
 * unacknowledged (`kMaxScreencastFramesInFlight`), so up to three encode at once and two
 * frames stamped close together can complete in either order. Every frame stamped before an
 * accepted one was already in flight when that one was stamped, so at most two late frames
 * can arrive in a row. A longer run is source time that really went backwards.
 */
const MaxConsecutiveLateFrames = 2;

// Synchronous Schema decoding at the callback boundary; no Effect/Fiber is allocated for each frame.
const Metadata = Schema.Struct({
  timestamp: Schema.Finite.check(Schema.isGreaterThan(0)),
  viewportWidth: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
  viewportHeight: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 16384 })),
});

const parseMetadata = Schema.decodeUnknownSync(Metadata);

/** Private seam for deterministic callback/lifetime tests. The public start accepts a real live session. */
export const startCapture = Effect.fnUntraced(function* (
  parent: CaptureParent,
  options: CaptureOptions = {},
) {
  const maxFrames = options.maxFrames ?? CaptureDefaults.maxFrames;
  const maxBytes = options.maxBufferedBytes ?? CaptureDefaults.maxBufferedBytes;
  const maxFrameBytes = options.maxFrameBytes ?? CaptureDefaults.maxFrameBytes;
  const duration = options.maxDurationMillis ?? CaptureDefaults.maxDurationMillis;
  const quality = options.quality ?? CaptureDefaults.quality;

  const size =
    options.size === undefined
      ? undefined
      : yield* Schema.decodeEffect(CaptureSize)(options.size, { onExcessProperty: "error" }).pipe(
          Effect.map(({ width, height }) => Object.freeze({ width, height })),
          Effect.mapError(() =>
            BrowserError.make({
              operation: "capture",
              reason: "configuration",
              outcome: "undispatched",
            }),
          ),
        );

  yield* Schema.decodeEffect(CaptureLimits)({
    maxFrames,
    maxBufferedBytes: maxBytes,
    maxFrameBytes,
    maxDurationMillis: duration,
    quality,
  }).pipe(
    Effect.mapError(() =>
      BrowserError.make({
        operation: "capture",
        reason: "configuration",
        outcome: "undispatched",
      }),
    ),
  );
  const clock = yield* Clock.Clock;
  const wake = yield* Queue.dropping<void>(1);
  const finished = yield* Queue.dropping<void>(1);
  const completed = yield* Deferred.make<void>();

  yield* Effect.addFinalizer(() =>
    Queue.shutdown(wake).pipe(Effect.andThen(Queue.shutdown(finished)), Effect.asVoid),
  );
  const buffer = new FrameBuffer<CapturedFrame>(maxFrames, maxBytes);
  let source: CaptureSource | undefined;
  let startPromise: Promise<void> | undefined;
  let startSettled = true;
  let target: Target | undefined;
  let leaseKey: string | undefined;

  let ended = false,
    subscribed = false,
    cleanupFinished = false;

  let reason = "stopped";
  let error: BrowserError | undefined;

  let received = 0,
    delivered = 0,
    rejected = 0,
    duplicates = 0,
    late = 0,
    lateRun = 0;

  let first: number | undefined, last: number | undefined;
  let document = 0;
  let initialUrl: string | null = null;
  let documentBoundariesTruncated = false;
  const documentBoundaries: Array<CaptureSummary["documentBoundaries"][number]> = [];

  /** The page navigated and its screencast kept running: later frames belong to a new document. */
  const nextDocument = (url: string): void => {
    if (ended) return;
    document++;
    if (documentBoundaries.length >= MaxDocumentBoundaries) documentBoundariesTruncated = true;
    else
      documentBoundaries.push({
        document,
        observedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
        afterSequence: received === 0 ? null : received - 1,
        url: documentUrl(url),
      });
  };

  let geometry:
    | { width: number; height: number; viewportWidth: number; viewportHeight: number }
    | undefined;

  let nativeStop: CaptureSummary["nativeStop"] = "unconfirmed";
  let lease: CaptureLease | undefined;

  const finish = (why: string, failure?: BrowserError) => {
    if (ended) return;
    ended = true;
    reason = why;
    error = failure;
    Queue.offerUnsafe(wake, undefined);
    Queue.offerUnsafe(finished, undefined);
  };

  const snapshot = (): CaptureSummary => {
    if (target === undefined) throw new Error("Capture target was not admitted");

    return CaptureSummary.make({
      target,
      reason,
      received,
      delivered,
      dropped: buffer.dropped + rejected,
      duplicates,
      late,
      peakBufferedFrames: buffer.highWaterFrames,
      peakBufferedBytes: buffer.highWaterBytes,
      bufferedFrames: buffer.size,
      bufferedBytes: buffer.bytes,
      sourceFirstMillis: first ?? null,
      sourceLastMillis: last ?? null,
      initialUrl,
      documentBoundaries: documentBoundaries.map((boundary) => ({ ...boundary })),
      documentBoundariesTruncated,
      nativeStop,
      upstreamDrops: "unknown",
      ...(error === undefined
        ? {}
        : {
            error: BrowserError.make({
              operation: error.operation,
              reason: error.reason,
              ...(error.outcome === undefined ? {} : { outcome: error.outcome }),
              ...(error.status === undefined ? {} : { status: error.status }),
              ...(error.retryAfterMillis === undefined
                ? {}
                : { retryAfterMillis: error.retryAfterMillis }),
            }),
          }),
    });
  };

  const performStop = yield* Effect.cached(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        finish("stopped");
        // Wait for an in-flight start before stop. If it will not settle, quarantine this page lease.
        if (startPromise !== undefined && !startSettled) {
          yield* restore(
            Effect.tryPromise({
              try: () => startPromise!,
              catch: () => BrowserError.make({ operation: "capture-start", reason: "provider" }),
            }).pipe(Effect.timeout(2000), Effect.exit),
          );
        }
        if (source !== undefined) {
          const stopped = yield* restore(
            Effect.tryPromise({
              try: () => source!.stop(),
              catch: () => BrowserError.make({ operation: "capture-stop", reason: "provider" }),
            }).pipe(Effect.timeout(3000)),
          ).pipe(Effect.exit);

          if (Exit.isSuccess(stopped) && startSettled) nativeStop = "confirmed";
        } else nativeStop = "confirmed";
        // No older attachment may clear a replacement. Unconfirmed native cleanup quarantines only this page.
        if (
          nativeStop === "confirmed" &&
          leaseKey !== undefined &&
          lease !== undefined &&
          parent.captureLeases.get(leaseKey) === lease
        ) {
          parent.captureLeases.delete(leaseKey);
          parent.captureReservedBytes = Math.max(
            0,
            parent.captureReservedBytes - lease.reservedBytes,
          );
        }
        cleanupFinished = true;

        return snapshot();
      }),
    ),
  );

  // Publish completion only after the cached cleanup Exit has settled. Publishing
  // inside it lets the caller close Scope and interrupt the caching fiber first.
  const stopNative = performStop.pipe(Effect.tap(() => Deferred.succeed(completed, undefined)));

  const receive = (frame: NativeFrame): void => {
    if (ended) return;
    if (
      target === undefined ||
      parent.owner.state.generation !== target.generation ||
      parent.owner.state.phase !== "open"
    ) {
      finish("parent-unavailable", BrowserError.make({ operation: "capture", reason: "closed" }));

      return;
    }
    const sequence = received++;

    try {
      const meta = parseMetadata(frame);

      if (!(frame.data instanceof Uint8Array) || frame.data.length > maxFrameBytes) {
        rejected++;
        finish("frame-limit", BrowserError.make({ operation: "capture", reason: "limit" }));

        return;
      }
      if (last !== undefined && meta.timestamp < last) {
        // A newer frame is already accepted, so this one can no longer be presented in order.
        // It is discarded and counted rather than sorted in or given an invented time.
        rejected++;
        late++;
        if (++lateRun > MaxConsecutiveLateFrames) {
          finish(
            "timestamp-discontinuity",
            BrowserError.make({ operation: "capture", reason: "timestamp" }),
          );
        }

        return;
      }
      if (last === meta.timestamp) {
        duplicates++;
        rejected++;

        return;
      }
      const dimensions = jpegGeometry(frame.data);

      if (
        dimensions.width > 16384 ||
        dimensions.height > 16384 ||
        (size !== undefined &&
          (dimensions.width > size.width || dimensions.height > size.height)) ||
        dimensions.width * dimensions.height > 33_554_432 ||
        frame.data[frame.data.length - 2] !== 255 ||
        frame.data[frame.data.length - 1] !== 217
      ) {
        rejected++;
        finish("frame-limit", BrowserError.make({ operation: "capture", reason: "limit" }));

        return;
      }
      if (
        geometry !== undefined &&
        (geometry.width !== dimensions.width ||
          geometry.height !== dimensions.height ||
          geometry.viewportWidth !== meta.viewportWidth ||
          geometry.viewportHeight !== meta.viewportHeight)
      ) {
        rejected++;
        finish("resized", BrowserError.make({ operation: "capture", reason: "resized" }));

        return;
      }
      geometry ??= {
        ...dimensions,
        viewportWidth: meta.viewportWidth,
        viewportHeight: meta.viewportHeight,
      };
      first ??= meta.timestamp;
      last = meta.timestamp;
      lateRun = 0;
      buffer.offer({
        bytes: new Uint8Array(frame.data),
        mediaType: "image/jpeg",
        target,
        sequence,
        document,
        sourceTimeMillis: meta.timestamp,
        sourceClock: "presentation-unix-millis",
        receivedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
        ...dimensions,
        viewportWidth: meta.viewportWidth,
        viewportHeight: meta.viewportHeight,
      });
      Queue.offerUnsafe(wake, undefined);
    } catch {
      rejected++;
      finish("malformed-frame", BrowserError.make({ operation: "capture", reason: "malformed" }));
    }
  };

  yield* parent.owner
    .guard(
      "capture-start",
      (ticket) =>
        Effect.gen(function* () {
          const resolved = yield* parent.resolve(ticket, options.target);

          // Frames and summaries share this identity with the generation guard. It must not
          // become writable through consumer-owned frame data.
          target = Object.freeze(resolved.target);
          source = resolved.source;
          leaseKey = resolved.key;
          if (parent.captureLeases.has(leaseKey)) {
            return yield* BrowserError.make({
              operation: "capture",
              reason: "busy",
              outcome: "undispatched",
            });
          }
          if (
            parent.captureLeases.size >= MaxParentCaptures ||
            parent.captureReservedBytes + maxBytes > MaxParentBufferedBytes
          ) {
            return yield* BrowserError.make({
              operation: "capture",
              reason: "limit",
              outcome: "undispatched",
            });
          }
          lease = {
            reservedBytes: maxBytes,
            stop: stopNative.pipe(Effect.asVoid),
            invalidate: (why) =>
              finish(
                why,
                BrowserError.make({
                  operation: "capture",
                  reason: why === "resized" ? "resized" : "target-changed",
                }),
              ),
          };
          parent.captureLeases.set(leaseKey, lease);
          parent.captureReservedBytes += maxBytes;
          // Installed before native acquisition. A cancelled capture cannot escape its caller's scope.
          yield* Effect.addFinalizer(() =>
            stopNative.pipe(
              Effect.andThen(
                Effect.sync(() => {
                  rejected += buffer.size;
                  buffer.clear();
                }),
              ),
            ),
          );
          startSettled = false;
          yield* Effect.tryPromise({
            try: () => {
              startPromise = source!.start({
                receive,
                quality,
                invalidate: (why) => lease?.invalidate(why),
                opened: (url) => {
                  initialUrl = documentUrl(url);
                },
                ...(size === undefined ? {} : { size }),
                ...(options.lifetime === "page" ? { document: nextDocument } : {}),
              });
              void startPromise.then(
                () => {
                  startSettled = true;
                  if (
                    cleanupFinished &&
                    nativeStop === "unconfirmed" &&
                    leaseKey !== undefined &&
                    parent.captureLeases.get(leaseKey) === lease
                  ) {
                    // One late acquisition cleanup, not a callback-side worker. Keep the page quarantined.
                    void source!.stop().catch(() => {});
                  }
                },
                () => {
                  startSettled = true;
                },
              );

              return startPromise;
            },
            catch: () => BrowserError.make({ operation: "capture-start", reason: "provider" }),
          });
          ticket.check();
        }),
      { charge: false },
    )
    .pipe(
      Effect.onError(() => (lease === undefined ? Effect.void : stopNative.pipe(Effect.asVoid))),
      Effect.onInterrupt(() =>
        lease === undefined ? Effect.void : stopNative.pipe(Effect.asVoid),
      ),
    );
  // One monitor, not a fiber per frame. The finalizer also calls stop directly if this monitor is interrupted.
  // The timeout and explicit-finish branches intentionally carry different
  // values before shared cleanup; preserve the proven first-completion semantics.
  // @effect-diagnostics-next-line raceFirstWithSleepToTimeout:off
  yield* Effect.raceFirst(
    Queue.take(finished).pipe(Effect.as(false)),
    Effect.sleep(duration).pipe(Effect.as(true)),
  ).pipe(
    Effect.tap((expired) => (expired ? Effect.sync(() => finish("duration-limit")) : Effect.void)),
    Effect.andThen(stopNative),
    Effect.forkScoped,
  );

  const next: Effect.Effect<CapturedFrame, BrowserError | Cause.Done> = Effect.suspend(() => {
    const frame = buffer.take();

    if (frame !== undefined) {
      delivered++;

      return Effect.succeed(frame);
    }
    if (ended) return error === undefined ? Cause.done() : Effect.fail(error);

    return Queue.take(wake).pipe(Effect.andThen(next));
  });

  const frames = Stream.unwrap(
    Effect.suspend(() => {
      if (subscribed)
        return Effect.fail(BrowserError.make({ operation: "capture-consume", reason: "busy" }));
      subscribed = true;

      return Effect.succeed(
        Stream.fromEffectRepeat(next).pipe(Stream.ensuring(stopNative.pipe(Effect.asVoid))),
      );
    }),
  );

  return {
    frames,
    snapshot: Effect.sync(() => {
      const { reason, nativeStop, ...metadata } = snapshot();

      return CaptureSnapshot.make({
        ...metadata,
        phase: cleanupFinished ? "stopped" : ended ? "stopping" : "capturing",
        observedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
        currentDocument: document,
        reason: ended ? reason : null,
        nativeStop: cleanupFinished ? nativeStop : null,
      });
    }),
    stop: stopNative,
    completed: Deferred.await(completed).pipe(Effect.map(snapshot)),
  } satisfies CaptureInterval;
});
