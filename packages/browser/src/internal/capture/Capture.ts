import {
  Cause,
  Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Option,
  Queue,
  Schema,
  Stream,
} from "effect";

import type { Target } from "../../BrowserData.ts";
import type { CaptureInterval } from "../../Capture.ts";
import {
  CaptureSize,
  CaptureSnapshot,
  CaptureSummary,
  type CaptureQualification,
  type CaptureOptions,
  type CapturedFrame,
} from "../../CaptureData.ts";
import { BrowserError, Reasons } from "../../Errors.ts";
import type { CaptureReason } from "../../TimelineData.ts";
import {
  type CaptureLease,
  type CaptureParent,
  type CaptureResolution,
  type CaptureMetadata,
} from "../browser/Association.ts";
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

const decodeMetadata = Schema.decodeUnknownOption(Metadata);

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
              reason: Reasons.Configuration.make({}),
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
        reason: Reasons.Configuration.make({}),
        outcome: "undispatched",
      }),
    ),
  );
  const clock = parent.owner.clock;
  const captureId = yield* parent.newCaptureId;
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
  let targetStatus: CaptureResolution["status"];
  let metadata: CaptureResolution["metadata"];
  let terminalAuthority: "closing" | "closed" | undefined;

  let ended = false,
    subscribed = false,
    cleanupFinished = false;

  let reason: CaptureReason = "stopped";
  let error: BrowserError | undefined;

  let received = 0,
    delivered = 0,
    rejected = 0,
    duplicates = 0,
    late = 0,
    lateRun = 0;

  let first: number | undefined, last: number | undefined;
  let document = 0;
  let captureBoundary = 0;
  let acceptedBoundary = -1;
  let initialUrl: string | null = null;
  let initialUrlQualification: "NativeCached" | "Unread" | "Omitted" = "Unread";
  let documentBoundariesTruncated = false;
  const documentBoundaries: Array<CaptureSummary["documentBoundaries"][number]> = [];

  /** A URL change is recorded; only a new document advances the frame attribution. */
  const nextDocument = (url: string, sameDocument = false): void => {
    if (ended) return;
    captureBoundary++;
    if (!sameDocument) document++;
    // The latest boundaries are kept: a live consumer needs the address of what it is showing now.
    if (documentBoundaries.length >= MaxDocumentBoundaries) {
      documentBoundaries.shift();
      documentBoundariesTruncated = true;
    }

    const boundary = {
      document,
      sameDocument,
      observedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
      afterSequence: received === 0 ? null : received - 1,
      url: documentUrl(url),
    };

    documentBoundaries.push(boundary);
    if (target !== undefined)
      metadata?.({
        _tag: "CaptureBoundary",
        captureId,
        target,
        captureBoundary,
        captureDocument: document,
        sameDocument: boundary.sameDocument,
        observedMonotonicNanos: boundary.observedMonotonicNanos,
        afterSequence: boundary.afterSequence,
        url: boundary.url,
        urlQualification: boundary.url === null ? "Omitted" : "NativeCached",
      });
  };

  let geometry:
    | { width: number; height: number; viewportWidth: number; viewportHeight: number }
    | undefined;

  let nativeStop: CaptureSummary["nativeStop"] = "unconfirmed";
  let lease: CaptureLease | undefined;
  let reservationReleased = false;
  let preStartStopConfirmed = false;
  let postStartStopStarted = false;

  const releaseReservation = () => {
    if (reservationReleased) return;
    reservationReleased = true;
    source?.release?.();
    if (
      leaseKey !== undefined &&
      lease !== undefined &&
      parent.captureLeases.get(leaseKey) === lease
    ) {
      parent.captureLeases.delete(leaseKey);
      parent.captureReservedBytes = Math.max(0, parent.captureReservedBytes - lease.reservedBytes);
    }
  };

  let confirmPostStartStop = () => {};

  const observeStop = (stopping: Promise<void>, afterStart: boolean) => {
    void stopping.then(
      () => {
        if (afterStart) {
          nativeStop = "confirmed";
          releaseReservation();
          if (cleanupFinished) publishCapture("Stopped");
        } else {
          preStartStopConfirmed = true;
          confirmPostStartStop();
        }
      },
      () => {},
    );
  };

  confirmPostStartStop = () => {
    const stoppingSource = source;

    if (
      !preStartStopConfirmed ||
      !startSettled ||
      postStartStopStarted ||
      stoppingSource === undefined ||
      leaseKey === undefined ||
      lease === undefined ||
      parent.captureLeases.get(leaseKey) !== lease
    )
      return;

    postStartStopStarted = true;
    observeStop(
      Promise.resolve().then(() => stoppingSource.stop()),
      true,
    );
  };

  const finish = (why: CaptureReason, failure?: BrowserError) => {
    if (ended) return;
    ended = true;
    reason = why;
    error = failure;
    publishCapture("Ended");
    Queue.offerUnsafe(wake, undefined);
    Queue.offerUnsafe(finished, undefined);
  };

  const snapshot = (): CaptureSummary => {
    if (target === undefined) throw new Error("Capture target was not admitted");
    const status = targetStatus?.();
    const ownerPhase = parent.owner.state.phase;
    const ownerGeneration = parent.owner.state.generation;
    const sessionFenced = ["uncertain", "faulted", "closing", "closed"].includes(ownerPhase);

    const containment =
      status !== undefined && status.containment._tag !== "NotRequired"
        ? { ...status.containment }
        : sessionFenced
          ? { _tag: "SessionFenced" as const, generation: ownerGeneration }
          : { _tag: "NotRequired" as const };

    const qualification: CaptureQualification = {
      authority:
        status?.phase === "closed" || terminalAuthority === "closed"
          ? "closed"
          : target.generation !== ownerGeneration
            ? "stale"
            : (status?.phase ?? terminalAuthority ?? "open"),
      containment,
      ownerPhase,
      ownerGeneration,
    };

    return CaptureSummary.make({
      target,
      qualification,
      reason,
      received,
      delivered,
      discarded: buffer.dropped + rejected + late + duplicates,
      overflow: buffer.dropped,
      duplicates,
      late,
      rejected,
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
              reason: { ...error.reason },
              outcome: error.outcome,
              ...(error.containment !== undefined
                ? { containment: { ...error.containment } }
                : containment._tag === "NotRequired"
                  ? {}
                  : { containment }),
            }),
          }),
    });
  };

  const publishCapture = (
    phase: Extract<CaptureMetadata, { readonly _tag: "Capture" }>["phase"],
  ) => {
    if (metadata === undefined || target === undefined) return;
    const facts = snapshot();

    metadata({
      _tag: "Capture",
      captureId,
      target,
      phase,
      latePhase: ended && (phase === "Watching" || phase === "Started"),
      observedMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
      captureBoundary,
      captureDocument: document,
      qualification: facts.qualification,
      initialUrl,
      initialUrlQualification,
      reason: ended ? reason : null,
      nativeStop: phase === "Stopped" ? nativeStop : null,
      received,
      delivered,
      discarded: facts.discarded,
      overflow: facts.overflow,
      late,
      duplicates,
      rejected,
      upstreamDrops: "unknown",
    });
  };

  const performStop = yield* Effect.cached(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        finish("stopped");
        // Wait for an in-flight start before stop. If it will not settle, quarantine this page lease.
        if (startPromise !== undefined && !startSettled) {
          const starting = startPromise;

          yield* restore(
            Effect.tryPromise({
              try: () => starting,
              catch: () =>
                BrowserError.make({
                  operation: "capture-start",
                  reason: Reasons.Provider.make({}),
                  outcome: "unknown",
                }),
            }).pipe(Effect.timeout(2000), Effect.exit),
          );
        }
        if (source !== undefined) {
          const stopping = source;
          const afterStart = startSettled;
          const stop = Promise.resolve().then(() => stopping.stop());

          observeStop(stop, afterStart);

          const stopped = yield* restore(
            Effect.tryPromise({
              try: () => stop,
              catch: () =>
                BrowserError.make({
                  operation: "capture-stop",
                  reason: Reasons.Provider.make({}),
                  outcome: "unknown",
                }),
            }).pipe(Effect.timeout(3000)),
          ).pipe(Effect.exit);

          if (Exit.isSuccess(stopped) && afterStart) {
            nativeStop = "confirmed";
            releaseReservation();
          }
        } else nativeStop = "confirmed";
        if (nativeStop === "confirmed") releaseReservation();
        cleanupFinished = true;
        publishCapture("Stopped");

        return snapshot();
      }),
    ).pipe(Effect.provideService(Clock.Clock, clock)),
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
      finish(
        "parent-unavailable",
        BrowserError.make({
          operation: "capture",
          reason: Reasons.Closed.make({}),
          outcome: "undispatched",
        }),
      );

      return;
    }
    const sequence = received++;

    try {
      const decoded = decodeMetadata(frame);

      if (Option.isNone(decoded)) {
        rejected++;
        finish(
          "malformed-frame",
          BrowserError.make({
            operation: "capture",
            reason: Reasons.Malformed.make({}),
            outcome: "undispatched",
          }),
        );

        return;
      }
      const meta = decoded.value;

      if (!(frame.data instanceof Uint8Array)) {
        rejected++;
        finish(
          "malformed-frame",
          BrowserError.make({
            operation: "capture",
            reason: Reasons.Malformed.make({ path: "bytes" }),
            outcome: "undispatched",
          }),
        );

        return;
      }
      if (frame.data.length > maxFrameBytes) {
        rejected++;
        finish(
          "frame-limit",
          BrowserError.make({
            operation: "capture",
            reason: Reasons.Limit.make({
              dimension: "frame-bytes",
              maximum: maxFrameBytes,
              observed: frame.data.length,
            }),
            outcome: "undispatched",
          }),
        );

        return;
      }
      if (last !== undefined && meta.timestamp < last) {
        // A newer frame is already accepted, so this one can no longer be presented in order.
        // It is discarded and counted rather than sorted in or given an invented time.
        late++;
        if (++lateRun > MaxConsecutiveLateFrames) {
          finish(
            "timestamp-discontinuity",
            BrowserError.make({
              operation: "capture",
              reason: Reasons.Timestamp.make({}),
              outcome: "undispatched",
            }),
          );
        }

        return;
      }
      if (last === meta.timestamp) {
        duplicates++;

        return;
      }
      const dimensions = jpegGeometry(frame.data);

      if (frame.data[frame.data.length - 2] !== 255 || frame.data[frame.data.length - 1] !== 217) {
        rejected++;
        finish(
          "malformed-frame",
          BrowserError.make({
            operation: "capture",
            reason: Reasons.Malformed.make({ path: "bytes" }),
            outcome: "undispatched",
          }),
        );

        return;
      }
      const maximumWidth = Math.min(16384, size?.width ?? 16384);
      const maximumHeight = Math.min(16384, size?.height ?? 16384);

      const excessive =
        dimensions.width > maximumWidth
          ? Reasons.Limit.make({
              dimension: "width",
              maximum: maximumWidth,
              observed: dimensions.width,
            })
          : dimensions.height > maximumHeight
            ? Reasons.Limit.make({
                dimension: "height",
                maximum: maximumHeight,
                observed: dimensions.height,
              })
            : dimensions.width * dimensions.height > 33_554_432
              ? Reasons.Limit.make({
                  dimension: "pixels",
                  maximum: 33_554_432,
                  observed: dimensions.width * dimensions.height,
                })
              : undefined;

      if (excessive !== undefined) {
        rejected++;
        finish(
          "frame-limit",
          BrowserError.make({ operation: "capture", reason: excessive, outcome: "undispatched" }),
        );

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
        finish(
          "resized",
          BrowserError.make({
            operation: "capture",
            reason: Reasons.Resized.make({}),
            outcome: "undispatched",
          }),
        );

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
      const receivedMonotonicNanos = clock.monotonicTimeNanosUnsafe();

      buffer.offer({
        bytes: new Uint8Array(frame.data),
        mediaType: "image/jpeg",
        target,
        sequence,
        document,
        sourceTimeMillis: meta.timestamp,
        sourceClock: "presentation-unix-millis",
        receivedMonotonicNanos,
        ...dimensions,
        viewportWidth: meta.viewportWidth,
        viewportHeight: meta.viewportHeight,
      });
      if (captureBoundary !== acceptedBoundary) {
        acceptedBoundary = captureBoundary;
        metadata?.({
          _tag: "FirstFrame",
          captureId,
          target,
          captureBoundary,
          captureDocument: document,
          frameSequence: sequence,
          sourceTimeMillis: meta.timestamp,
          sourceClock: "presentation-unix-millis",
          receivedMonotonicNanos,
          ...dimensions,
          viewportWidth: meta.viewportWidth,
          viewportHeight: meta.viewportHeight,
        });
      }
      Queue.offerUnsafe(wake, undefined);
    } catch {
      rejected++;
      finish(
        "malformed-frame",
        BrowserError.make({
          operation: "capture",
          reason: Reasons.Malformed.make({}),
          outcome: "undispatched",
        }),
      );
    }
  };

  yield* parent.validate ?? Effect.void;

  const requested = yield* Effect.try({
    try: () => parent.selectedPage(),
    catch: () =>
      BrowserError.make({
        operation: "capture-start",
        reason: Reasons.Stale.make({}),
        outcome: "undispatched",
      }),
  });

  const generation = parent.owner.state.generation;

  yield* parent.owner
    .guard(
      "capture-start",
      (ticket) =>
        Effect.gen(function* () {
          const resolved = yield* parent.resolve(ticket, requested);

          // Frames and summaries share this identity with the generation guard. It must not
          // become writable through consumer-owned frame data.
          target = Object.freeze(resolved.target);
          targetStatus = resolved.status;
          metadata = resolved.metadata;
          const resolvedSource = resolved.source;

          source = resolvedSource;
          leaseKey = resolved.key;
          if (parent.captureLeases.has(leaseKey)) {
            return yield* BrowserError.make({
              operation: "capture",
              reason: Reasons.Busy.make({}),
              outcome: "undispatched",
            });
          }
          if (
            parent.captureLeases.size >= MaxParentCaptures ||
            parent.captureReservedBytes + maxBytes > MaxParentBufferedBytes
          ) {
            return yield* BrowserError.make({
              operation: "capture",
              reason:
                parent.captureLeases.size >= MaxParentCaptures
                  ? Reasons.Limit.make({
                      dimension: "captures",
                      maximum: MaxParentCaptures,
                      observed: parent.captureLeases.size + 1,
                    })
                  : Reasons.Limit.make({
                      dimension: "buffered-bytes",
                      maximum: MaxParentBufferedBytes,
                      observed: parent.captureReservedBytes + maxBytes,
                    }),
              outcome: "undispatched",
            });
          }
          lease = {
            pageId: target.pageId,
            reservedBytes: maxBytes,
            stop: stopNative.pipe(Effect.asVoid),
            invalidate: (why) => {
              if (why === "target-closed") terminalAuthority = "closed";
              else if (why === "closed") terminalAuthority ??= "closing";
              if (why === "target-closed") releaseReservation();
              finish(
                why === "resized" ? "resized" : "target-changed",
                BrowserError.make({
                  operation: "capture",
                  reason:
                    why === "resized" ? Reasons.Resized.make({}) : Reasons.TargetChanged.make({}),
                  outcome: "undispatched",
                }),
              );
            },
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
          publishCapture("Reserved");
          startSettled = false;
          yield* Effect.tryPromise({
            try: () => {
              try {
                startPromise = resolvedSource.start({
                  receive,
                  quality,
                  invalidate: (why) => lease?.invalidate(why),
                  opened: (url) => {
                    initialUrl = documentUrl(url);
                    initialUrlQualification = initialUrl === null ? "Omitted" : "NativeCached";
                    publishCapture("Watching");
                  },
                  ...(size === undefined ? {} : { size }),
                  ...(options.lifetime === "page" ? { document: nextDocument } : {}),
                });
              } catch (error) {
                startSettled = true;

                throw error;
              }

              const cleanupAfterLateStart = () => {
                startSettled = true;
                // A pre-start stop must settle successfully before a post-start stop is sent.
                confirmPostStartStop();
              };

              void startPromise.then(cleanupAfterLateStart, cleanupAfterLateStart);

              return startPromise;
            },
            catch: () =>
              BrowserError.make({
                operation: "capture-start",
                reason: Reasons.Provider.make({}),
                outcome: "unknown",
              }),
          });
          publishCapture("Started");
          ticket.check();
        }),
      {
        charge: false,
        admission: options.admission,
        targetScope: () => ({ pageId: requested.pageId }),
        preflight: (parent.validate ?? Effect.void).pipe(
          Effect.andThen(
            Effect.suspend(() =>
              generation === parent.owner.state.generation
                ? Effect.void
                : Effect.fail(
                    BrowserError.make({
                      operation: "capture-start",
                      reason: Reasons.Stale.make({}),
                      outcome: "undispatched",
                    }),
                  ),
            ),
          ),
        ),
      },
    )
    .pipe(
      Effect.provideService(Clock.Clock, clock),
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
    clock.sleep(Duration.millis(duration)).pipe(Effect.as(true)),
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
        return Effect.fail(
          BrowserError.make({
            operation: "capture-consume",
            reason: Reasons.Busy.make({}),
            outcome: "undispatched",
          }),
        );
      subscribed = true;

      return Effect.succeed(
        Stream.fromEffectRepeat(next).pipe(Stream.ensuring(stopNative.pipe(Effect.asVoid))),
      );
    }),
  );

  return {
    id: captureId,
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
