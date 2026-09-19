import { Cause, Clock, Deferred, Effect, Exit, Queue, Schema, Stream } from "effect";

import type { Target } from "../Types.ts";
import { BrowserbaseError } from "../Types.ts";
import { type CaptureLease, type CaptureParent } from "./Association.ts";
import {
  CaptureSummary,
  type CaptureInterval,
  type CaptureOptions,
  type CapturedFrame,
} from "./CaptureTypes.ts";
import type { CaptureSource, NativeFrame } from "./Driver.ts";
import { FrameBuffer } from "./FrameBuffer.ts";
import { jpegGeometry } from "./Images.ts";

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
  const maxFrames = options.maxFrames ?? 4;
  const maxBytes = options.maxBufferedBytes ?? 16 * 1024 * 1024;
  const maxFrameBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
  const duration = options.maxDurationMillis ?? 60000;
  const quality = options.quality ?? 80;

  if (
    !Number.isSafeInteger(maxFrames) ||
    maxFrames < 1 ||
    maxFrames > 64 ||
    !Number.isSafeInteger(maxBytes) ||
    maxBytes < 1 ||
    maxBytes > 64 * 1024 * 1024 ||
    !Number.isSafeInteger(maxFrameBytes) ||
    maxFrameBytes < 1 ||
    maxFrameBytes > maxBytes ||
    !Number.isSafeInteger(duration) ||
    duration < 1 ||
    duration > 600000 ||
    !Number.isSafeInteger(quality) ||
    quality < 1 ||
    quality > 100
  ) {
    return yield* BrowserbaseError.make({
      operation: "capture",
      reason: "configuration",
      outcome: "undispatched",
    });
  }
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

  let ended = false,
    subscribed = false,
    cleanupFinished = false;

  let reason = "stopped";
  let error: BrowserbaseError | undefined;

  let received = 0,
    delivered = 0,
    rejected = 0,
    duplicates = 0;

  let first: number | undefined, last: number | undefined;

  let geometry:
    | { width: number; height: number; viewportWidth: number; viewportHeight: number }
    | undefined;

  let nativeStop: CaptureSummary["nativeStop"] = "unconfirmed";
  let lease: CaptureLease | undefined;

  const finish = (why: string, failure?: BrowserbaseError) => {
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
      peakBufferedFrames: buffer.highWaterFrames,
      peakBufferedBytes: buffer.highWaterBytes,
      bufferedFrames: buffer.size,
      bufferedBytes: buffer.bytes,
      sourceFirstMillis: first ?? null,
      sourceLastMillis: last ?? null,
      nativeStop,
      upstreamDrops: "unknown",
      ...(error === undefined ? {} : { error }),
    });
  };

  const performStop = yield* Effect.cached(
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        finish("stopped");
        // Wait for an in-flight start before stop. If it will not settle, quarantine this lease.
        if (startPromise !== undefined && !startSettled) {
          yield* restore(
            Effect.tryPromise({
              try: () => startPromise!,
              catch: () =>
                BrowserbaseError.make({ operation: "capture-start", reason: "provider" }),
            }).pipe(Effect.timeout(2000), Effect.exit),
          );
        }
        if (source !== undefined) {
          const stopped = yield* restore(
            Effect.tryPromise({
              try: () => source!.stop(),
              catch: () => BrowserbaseError.make({ operation: "capture-stop", reason: "provider" }),
            }).pipe(Effect.timeout(3000)),
          ).pipe(Effect.exit);

          if (Exit.isSuccess(stopped) && startSettled) nativeStop = "confirmed";
        } else nativeStop = "confirmed";
        // No older attachment may clear a new one. Unconfirmed native cleanup blocks another interval.
        if (nativeStop === "confirmed" && parent.captureLease === lease)
          parent.captureLease = undefined;
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
      finish(
        "parent-unavailable",
        BrowserbaseError.make({ operation: "capture", reason: "closed" }),
      );

      return;
    }
    const sequence = received++;

    try {
      const meta = parseMetadata(frame);

      if (!(frame.data instanceof Uint8Array) || frame.data.length > maxFrameBytes) {
        rejected++;
        finish("frame-limit", BrowserbaseError.make({ operation: "capture", reason: "limit" }));

        return;
      }
      if (last !== undefined && meta.timestamp < last) {
        rejected++;
        finish(
          "timestamp-discontinuity",
          BrowserbaseError.make({ operation: "capture", reason: "timestamp" }),
        );

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
        dimensions.width * dimensions.height > 33_554_432 ||
        frame.data[frame.data.length - 2] !== 255 ||
        frame.data[frame.data.length - 1] !== 217
      ) {
        rejected++;
        finish("frame-limit", BrowserbaseError.make({ operation: "capture", reason: "limit" }));

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
        finish("resized", BrowserbaseError.make({ operation: "capture", reason: "resized" }));

        return;
      }
      geometry ??= {
        ...dimensions,
        viewportWidth: meta.viewportWidth,
        viewportHeight: meta.viewportHeight,
      };
      first ??= meta.timestamp;
      last = meta.timestamp;
      buffer.offer({
        bytes: new Uint8Array(frame.data),
        mediaType: "image/jpeg",
        target,
        sequence,
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
      finish(
        "malformed-frame",
        BrowserbaseError.make({ operation: "capture", reason: "malformed" }),
      );
    }
  };

  yield* parent.owner
    .guard(
      "capture-start",
      (ticket) =>
        Effect.gen(function* () {
          if (parent.captureLease !== undefined)
            return yield* BrowserbaseError.make({
              operation: "capture",
              reason: "busy",
              outcome: "undispatched",
            });
          target = yield* Effect.try({
            try: parent.target,
            catch: () => BrowserbaseError.make({ operation: "capture", reason: "closed" }),
          });
          source = yield* parent.source(ticket);
          lease = {
            stop: stopNative.pipe(Effect.asVoid),
            invalidate: (why) =>
              finish(
                why,
                BrowserbaseError.make({
                  operation: "capture",
                  reason: why === "resized" ? "resized" : "target-changed",
                }),
              ),
          };
          parent.captureLease = lease;
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
              startPromise = source!.start(receive, quality);
              void startPromise.then(
                () => {
                  startSettled = true;
                  if (
                    cleanupFinished &&
                    nativeStop === "unconfirmed" &&
                    parent.captureLease === lease
                  ) {
                    // One late acquisition cleanup, not a callback-side worker. Keep the lease quarantined.
                    void source!.stop().catch(() => {});
                  }
                },
                () => {
                  startSettled = true;
                },
              );

              return startPromise;
            },
            catch: () => BrowserbaseError.make({ operation: "capture-start", reason: "provider" }),
          });
          ticket.check();
        }),
      { charge: false },
    )
    .pipe(
      Effect.onError(() => (target === undefined ? Effect.void : stopNative.pipe(Effect.asVoid))),
      Effect.onInterrupt(() =>
        target === undefined ? Effect.void : stopNative.pipe(Effect.asVoid),
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

  const next: Effect.Effect<CapturedFrame, BrowserbaseError | Cause.Done> = Effect.suspend(() => {
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
        return Effect.fail(BrowserbaseError.make({ operation: "capture-consume", reason: "busy" }));
      subscribed = true;

      return Effect.succeed(
        Stream.fromEffectRepeat(next).pipe(Stream.ensuring(stopNative.pipe(Effect.asVoid))),
      );
    }),
  );

  return {
    frames,
    stop: stopNative,
    completed: Deferred.await(completed).pipe(Effect.map(snapshot)),
  } satisfies CaptureInterval;
});
