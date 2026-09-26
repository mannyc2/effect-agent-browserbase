import { Cause, Deferred, Effect, Exit, Option, Queue, Schema, Scope, Stream } from "effect";

import type { CaptureInterval, FrameSource, FrameSubscription } from "../../Capture.ts";
import {
  CaptureSummary,
  FrameReady,
  FrameSourceOptions,
  FrameSourceReport,
  FrameSourceSnapshot,
  FrameSubscriptionOptions,
  FrameSubscriptionReport,
  FrameSubscriptionSnapshot,
  type CapturedFrame,
  type CaptureOptions,
} from "../../CaptureData.ts";
import { BrowserError, type LimitDimension, Reasons } from "../../Errors.ts";
import { makeEvidence } from "./Evidence.ts";
import { FrameBuffer } from "./FrameBuffer.ts";
import { CaptureDefaults } from "./Options.ts";

const configuration = () =>
  BrowserError.make({
    operation: "capture-source",
    reason: Reasons.Configuration.make({}),
    outcome: "undispatched",
  });

const closed = () =>
  BrowserError.make({
    operation: "capture-source",
    reason: Reasons.Closed.make({}),
    outcome: "undispatched",
  });

const overflow = (dimension: typeof LimitDimension.Type, maximum: number, observed: number) =>
  BrowserError.make({
    operation: "capture-subscribe",
    reason: Reasons.Limit.make({ dimension, maximum, observed }),
    outcome: "undispatched",
  });

const freezeError = (error: BrowserError): BrowserError => {
  const copied = BrowserError.make({
    operation: error.operation,
    reason: { ...error.reason },
    outcome: error.outcome,
  });

  Object.freeze(copied.reason);

  return Object.freeze(copied);
};

const readiness = (sourceId: string, frame: CapturedFrame): FrameReady =>
  Object.freeze(
    FrameReady.make({
      sourceId,
      target: frame.target,
      sequence: frame.sequence,
      document: frame.document,
      sourceTimeMillis: frame.sourceTimeMillis,
      sourceClock: frame.sourceClock,
      receivedMonotonicNanos: frame.receivedMonotonicNanos,
      width: frame.width,
      height: frame.height,
    }),
  );

const freezeCapture = (capture: CaptureSummary): CaptureSummary => {
  for (const boundary of capture.documentBoundaries) Object.freeze(boundary);
  Object.freeze(capture.documentBoundaries);
  if (capture.error !== undefined) {
    Object.freeze(capture.error.reason);
    Object.freeze(capture.error);
  }

  return Object.freeze(capture);
};

interface Subscriber {
  readonly offer: (frame: CapturedFrame) => void;
  readonly end: (
    reason: NonNullable<FrameSubscriptionReport["reason"]>,
    error: BrowserError | null,
  ) => void;
  readonly dispose: () => void;
  readonly failSourceLoss: (count: number) => void;
}

/** One worker drains the existing owner; callbacks and consumers never create per-frame fibers. */
const buildFrameSource = Effect.fnUntraced(function* (
  acquire: (options: CaptureOptions) => Effect.Effect<CaptureInterval, BrowserError, Scope.Scope>,
  input: FrameSourceOptions,
  sourceId: string,
): Effect.fn.Return<FrameSource, BrowserError, Scope.Scope> {
  const options = yield* Schema.decodeEffect(FrameSourceOptions)(input, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(configuration));

  const captureOptions = options.capture ?? {};
  const maximumBytes = options.maxBufferedBytes ?? 64 * 1024 * 1024;
  const maximumSubscribers = options.maxSubscribers ?? 8;

  // Reserve the native queue and one retained image before any subscriber can be admitted.
  // The worker and latest replay use this same private image, never a consumer's byte copy.
  let reservedBytes =
    (captureOptions.maxBufferedBytes ?? CaptureDefaults.maxBufferedBytes) +
    (captureOptions.maxFrameBytes ?? CaptureDefaults.maxFrameBytes);

  if (reservedBytes > maximumBytes) return yield* configuration();
  const interval = yield* acquire(captureOptions);
  const evidence = yield* makeEvidence(sourceId);
  const ready = yield* Deferred.make<FrameReady, BrowserError>();
  const completed = yield* Deferred.make<FrameSourceReport>();
  const subscribers = new Set<Subscriber>();
  let first: FrameReady | null = null;
  let latest: CapturedFrame | undefined;
  let stopping = false;
  let finished = false;
  let sourceLoss = 0;

  const subscribe = Effect.fnUntraced(function* (input: FrameSubscriptionOptions = {}) {
    const settings = yield* Schema.decodeEffect(FrameSubscriptionOptions)(input, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(configuration));

    const maximumFrames = settings.maxFrames ?? 4;
    const subscriptionBytes = settings.maxBufferedBytes ?? 8 * 1024 * 1024;
    const policy = settings.policy ?? "latest";

    const subscription = yield* Effect.acquireRelease(
      Effect.gen(function* () {
        const wake = yield* Queue.dropping<void>(1);
        const completion = yield* Deferred.make<FrameSubscriptionReport>();
        const buffer = new FrameBuffer<CapturedFrame>(maximumFrames, subscriptionBytes);
        let active = true;
        let consumed = false;
        let settled = false;
        let admitted = 0;
        let delivered = 0;
        let abandoned = 0;
        let refused = 0;
        let firstSequence: number | null = null;
        let lastSequence: number | null = null;
        let reason: FrameSubscriptionReport["reason"] = null;
        let error: BrowserError | null = null;

        const snapshot = (): FrameSubscriptionSnapshot =>
          FrameSubscriptionSnapshot.make({
            sourceId,
            phase: settled ? "completed" : active ? "active" : "detached",
            policy,
            admitted,
            delivered,
            discarded: buffer.dropped + abandoned + refused,
            overflow: buffer.dropped + refused,
            bufferedFrames: buffer.size,
            bufferedBytes: buffer.bytes,
            peakBufferedFrames: buffer.highWaterFrames,
            peakBufferedBytes: buffer.highWaterBytes,
            firstSequence,
            lastSequence,
            reason,
            error,
          });

        const settle = () => {
          if (settled || active || buffer.size > 0) return;
          settled = true;
          subscribers.delete(subscriber);
          reservedBytes -= subscriptionBytes;
          Deferred.doneUnsafe(
            completion,
            Effect.succeed(Object.freeze(FrameSubscriptionReport.make(snapshot()))),
          );
        };

        const end: Subscriber["end"] = (why, failure) => {
          if (!active) return;
          active = false;
          reason = why;
          error = failure === null ? null : freezeError(failure);
          Queue.offerUnsafe(wake, undefined);
          settle();
        };

        const offer = (frame: CapturedFrame) => {
          if (!active) return;
          if (
            policy === "fail" &&
            (buffer.size >= maximumFrames || buffer.bytes + frame.bytes.length > subscriptionBytes)
          ) {
            refused++;
            end(
              "overflow",
              buffer.size >= maximumFrames
                ? overflow("subscriber-frames", maximumFrames, buffer.size + 1)
                : overflow(
                    "subscriber-bytes",
                    subscriptionBytes,
                    buffer.bytes + frame.bytes.length,
                  ),
            );

            return;
          }
          if (buffer.offer(frame)) {
            admitted++;
            firstSequence ??= frame.sequence;
            lastSequence = frame.sequence;
          }
          Queue.offerUnsafe(wake, undefined);
        };

        const dispose = () => {
          end("interrupted", null);
          abandoned += buffer.size;
          buffer.clear();
          settle();
        };

        const subscriber: Subscriber = {
          offer,
          end,
          dispose,
          failSourceLoss: (count) => {
            if (policy === "fail") end("overflow", overflow("source-discarded-frames", 0, count));
          },
        };

        if (stopping || finished) return yield* closed();
        if (subscribers.size >= maximumSubscribers)
          return yield* overflow("subscribers", maximumSubscribers, subscribers.size + 1);
        if (reservedBytes + subscriptionBytes > maximumBytes)
          return yield* overflow(
            "source-reserved-bytes",
            maximumBytes,
            reservedBytes + subscriptionBytes,
          );
        reservedBytes += subscriptionBytes;
        subscribers.add(subscriber);
        if ((settings.replayLatest ?? true) && latest !== undefined) offer(latest);

        const next: Effect.Effect<CapturedFrame, BrowserError | Cause.Done> = Effect.suspend(() => {
          const frame = buffer.take();

          if (frame !== undefined) {
            delivered++;

            // Mutable payload ownership crosses the boundary here, once per delivered frame.
            return Effect.succeed({ ...frame, bytes: new Uint8Array(frame.bytes) });
          }
          if (!active) {
            settle();

            return error === null ? Cause.done() : Effect.fail(error);
          }

          return Queue.take(wake).pipe(Effect.andThen(next));
        });

        const frames = Stream.unwrap(
          Effect.suspend(() => {
            if (consumed)
              return Effect.fail(
                BrowserError.make({
                  operation: "capture-consume",
                  reason: Reasons.Busy.make({}),
                  outcome: "undispatched",
                }),
              );
            consumed = true;

            return Effect.succeed(
              Stream.fromEffectRepeat(next).pipe(Stream.ensuring(Effect.sync(dispose))),
            );
          }),
        );

        const handle: FrameSubscription = {
          sourceId,
          frames,
          snapshot: Effect.sync(snapshot),
          stop: Effect.sync(() => {
            end("stopped", null);

            return Object.freeze(FrameSubscriptionReport.make(snapshot()));
          }),
          completed: Deferred.await(completion),
        };

        return { subscriber, handle, wake };
      }),
      ({ subscriber, wake }) =>
        Effect.sync(subscriber.dispose).pipe(Effect.andThen(Queue.shutdown(wake))),
    );

    return subscription.handle;
  });

  const distribute = (frame: CapturedFrame, loss: number) => {
    latest = frame;
    evidence.frame(frame);
    if (first === null) {
      first = readiness(sourceId, frame);
      Deferred.doneUnsafe(ready, Effect.succeed(first));
    }
    if (loss > sourceLoss) {
      for (const subscriber of subscribers) subscriber.failSourceLoss(loss - sourceLoss);
      sourceLoss = loss;
    }
    for (const subscriber of subscribers) subscriber.offer(frame);
  };

  const worker = interval.frames.pipe(
    Stream.runForEach((frame) =>
      interval.snapshot.pipe(
        Effect.flatMap((snapshot) =>
          Effect.sync(() => distribute(frame, snapshot.overflow + snapshot.rejected)),
        ),
      ),
    ),
    Effect.exit,
    Effect.flatMap((exit) =>
      interval.completed.pipe(
        Effect.flatMap((capture) =>
          Effect.sync(() => {
            stopping = true;
            finished = true;
            evidence.end(capture.reason);

            const failure = Exit.isFailure(exit)
              ? Option.getOrElse(Cause.findErrorOption(exit.cause), closed)
              : capture.error;

            const loss = capture.overflow + capture.rejected;

            if (loss > sourceLoss)
              for (const subscriber of subscribers) subscriber.failSourceLoss(loss - sourceLoss);
            for (const subscriber of subscribers) subscriber.end("source-ended", failure ?? null);
            if (first === null) Deferred.doneUnsafe(ready, Effect.fail(failure ?? closed()));
            latest = undefined;
            Deferred.doneUnsafe(
              completed,
              Effect.succeed(
                Object.freeze(
                  FrameSourceReport.make({
                    sourceId,
                    capture: freezeCapture(
                      failure !== undefined && capture.error === undefined
                        ? CaptureSummary.make({ ...capture, error: failure })
                        : capture,
                    ),
                    ready: first,
                  }),
                ),
              ),
            );
          }),
        ),
      ),
    ),
  );

  yield* Effect.forkScoped(worker);

  const stop = Effect.sync(() => {
    stopping = true;
  }).pipe(
    Effect.andThen(interval.stop),
    Effect.andThen(Deferred.await(completed)),
    Effect.uninterruptible,
  );

  // Registered after the worker: stop/drain runs while that worker and native owner still exist.
  yield* Effect.addFinalizer(() =>
    stop.pipe(
      Effect.andThen(
        Effect.sync(() => {
          for (const subscriber of subscribers) subscriber.dispose();
        }),
      ),
    ),
  );

  return {
    sourceId,
    subscribe,
    observe: evidence.observe,
    ready: Deferred.await(ready).pipe(
      Effect.timeoutOrElse({
        duration: options.readyTimeoutMillis ?? 10_000,
        orElse: () =>
          Effect.fail(
            BrowserError.make({
              operation: "capture-ready",
              reason: Reasons.Timeout.make({}),
              outcome: "undispatched",
            }),
          ),
      }),
    ),
    snapshot: interval.snapshot.pipe(
      Effect.map((capture) =>
        FrameSourceSnapshot.make({
          sourceId,
          capture,
          ready: first,
          subscribers: subscribers.size,
          reservedBufferedBytes: reservedBytes,
          maximumBufferedBytes: maximumBytes,
        }),
      ),
    ),
    stop,
    completed: Deferred.await(completed),
  };
});

/** Failed or interrupted acquisition closes its private scope before returning control. */
export const openFrameSource = Effect.fnUntraced(function* (
  acquire: (options: CaptureOptions) => Effect.Effect<CaptureInterval, BrowserError, Scope.Scope>,
  input: FrameSourceOptions,
  sourceId: string,
): Effect.fn.Return<FrameSource, BrowserError, Scope.Scope> {
  return yield* Effect.uninterruptibleMask((restore) =>
    Effect.gen(function* () {
      const scope = yield* Effect.acquireRelease(Scope.make(), (owned, exit) =>
        Scope.close(owned, exit),
      );

      return yield* restore(Scope.provide(buildFrameSource(acquire, input, sourceId), scope)).pipe(
        Effect.onExit((exit) => (Exit.isFailure(exit) ? Scope.close(scope, exit) : Effect.void)),
      );
    }),
  );
});
