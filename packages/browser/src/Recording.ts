import { Cause, Clock, Deferred, Effect, Exit, Option, Scope, Schema, Stream } from "effect";

import type { FrameSource } from "./Capture.ts";
import {
  type CapturedFrame,
  CaptureSnapshot,
  type FrameSubscriptionReport,
} from "./CaptureData.ts";
import { type BrowserError } from "./Errors.ts";
import {
  RecordingError,
  RecordingOptions,
  RecordingReport,
  RecordingSample,
  RecordingSnapshot,
} from "./RecordingData.ts";

const freezeError = (error: BrowserError): BrowserError => {
  Object.freeze(error.reason);

  return Object.freeze(error);
};

// Schema constructors can clone nested structs and arrays. Freeze the constructed fields.
const freezeCapture = (capture: CaptureSnapshot): CaptureSnapshot => {
  Object.freeze(capture.target);
  for (const boundary of capture.documentBoundaries) Object.freeze(boundary);
  Object.freeze(capture.documentBoundaries);
  if (capture.error !== undefined) freezeError(capture.error);

  return Object.freeze(capture);
};

const freezeSubscription = (report: FrameSubscriptionReport): FrameSubscriptionReport => {
  if (report.error !== null) freezeError(report.error);

  return Object.freeze(report);
};

const freezeSnapshot = (snapshot: RecordingSnapshot): RecordingSnapshot => {
  if (snapshot.first !== null) Object.freeze(snapshot.first);
  if (snapshot.last !== null) Object.freeze(snapshot.last);

  return Object.freeze(snapshot);
};

const freezeReport = (report: RecordingReport): RecordingReport => {
  if (report.first !== null) Object.freeze(report.first);
  if (report.last !== null) Object.freeze(report.last);
  freezeCapture(report.captureAtStart);
  freezeCapture(report.captureAtEnd);
  freezeSubscription(report.subscription);

  return Object.freeze(report);
};

/**
 * A host-acquired writer. Dependencies are captured when acquired; writes are sequential and
 * never retried. finish establishes the adapter's artifact guarantee; abort promises no artifact.
 * Implementations own native cancellation and scoped cleanup, including late native completion.
 */
export interface FrameWriter<A, E = never> {
  readonly write: (frame: CapturedFrame) => Effect.Effect<void, E>;
  readonly finish: Effect.Effect<A, E>;
  readonly abort: Effect.Effect<void, E>;
}

/** Live scoped capability. Its typed Exit and artifact are intentionally not serialized. */
export interface RecordingJob<A, E = never> {
  /** Acknowledged first real write; source registration alone never establishes readiness. */
  readonly ready: Effect.Effect<RecordingSample, E | BrowserError | RecordingError>;
  readonly snapshot: Effect.Effect<RecordingSnapshot>;
  /** Detach only this subscription, drain its admitted prefix, and finalize exactly once. */
  readonly stop: Effect.Effect<RecordingReport>;
  readonly completed: Effect.Effect<RecordingReport>;
  readonly checkCompleted: Effect.Effect<void, E | BrowserError | RecordingError>;
  readonly artifact: Effect.Effect<A, E | BrowserError | RecordingError>;
  /** An established artifact may contain only a prefix when capture failed. Await settlement. */
  readonly retainedArtifact: Effect.Effect<Option.Option<A>>;
  /** Used by scoped to supervise failure; successful completion leaves this pending. */
  readonly failure: Effect.Effect<never, E | BrowserError | RecordingError>;
}

/**
 * Borrow a source and acquire a writer once. Returned readiness is a separate bounded first-write
 * acknowledgement. The job owns its subscription, writer and worker; stopping a waiter owns none
 * of them. Scope closure requests the same drain, then closes resources. Timeouts interrupt
 * cooperative Effects; arbitrary uninterruptible callbacks/finalizers can delay scope closure.
 */
export const start = Effect.fnUntraced(function* <A, E, AE, R>(
  source: FrameSource,
  acquireWriter: Effect.Effect<FrameWriter<A, E>, AE, R>,
  options: RecordingOptions = {},
): Effect.fn.Return<RecordingJob<A, E>, AE | E | BrowserError | RecordingError, R | Scope.Scope> {
  const limits = yield* Schema.decodeEffect(RecordingOptions)(options, {
    onExcessProperty: "error",
  }).pipe(Effect.mapError(() => new RecordingError({ reason: "configuration" })));

  const readyTimeout = limits.readyTimeoutMillis ?? 10_000;
  const writeTimeout = limits.writeTimeoutMillis ?? 10_000;
  const drainTimeout = limits.drainTimeoutMillis ?? 10_000;
  const finalizeTimeout = limits.finalizeTimeoutMillis ?? 10_000;

  return yield* Effect.uninterruptibleMask(function (restore) {
    return Effect.gen(function* () {
      const resources = yield* Scope.make();
      const workers = yield* Scope.make();
      let drain: Effect.Effect<unknown> = Effect.void;
      let acquiredWriter: FrameWriter<A, E> | undefined;

      yield* Effect.addFinalizer((exit) =>
        drain.pipe(
          Effect.ensuring(Scope.close(workers, exit)),
          Effect.ensuring(Scope.close(resources, exit)),
        ),
      );

      return yield* Effect.gen(function* () {
        const writer = yield* restore(Scope.provide(acquireWriter, resources));

        acquiredWriter = writer;

        const subscription = yield* restore(
          Scope.provide(
            source.subscribe({
              policy: "fail",
              replayLatest: false,
              maxFrames: limits.maxFrames ?? 16,
              maxBufferedBytes: limits.maxBufferedBytes ?? 16 * 1024 * 1024,
            }),
            resources,
          ),
        );

        const initial = freezeCapture(new CaptureSnapshot((yield* source.snapshot).capture));
        const clock = yield* Clock.Clock;
        const ready = yield* Deferred.make<RecordingSample, E | BrowserError | RecordingError>();
        const terminal = yield* Deferred.make<RecordingReport>();
        const outcome = yield* Deferred.make<A, E | BrowserError | RecordingError>();
        const failure = yield* Deferred.make<never, E | BrowserError | RecordingError>();
        const detached = yield* Deferred.make<void>();
        let stopping = false;
        let phase: RecordingSnapshot["phase"] = "recording";
        let writtenFrames = 0;
        let writtenBytes = 0;
        let first: RecordingSample | null = null;
        let last: RecordingSample | null = null;
        let retained: Option.Option<A> = Option.none();
        let writeFailed = false;
        let captureAtEnd: CaptureSnapshot | undefined;

        const detach = Effect.gen(function* () {
          yield* subscription.stop;
          if (captureAtEnd === undefined)
            captureAtEnd = freezeCapture(new CaptureSnapshot((yield* source.snapshot).capture));
        });

        const snapshot = Effect.sync(() =>
          freezeSnapshot(
            new RecordingSnapshot({ phase, writtenFrames, writtenBytes, first, last }),
          ),
        );

        const consume = Stream.runForEach(
          subscription.frames,
          Effect.fnUntraced(function* (frame) {
            yield* Effect.suspend(() => writer.write(frame)).pipe(
              Effect.timeoutOrElse({
                duration: writeTimeout,
                orElse: () => Effect.fail(new RecordingError({ reason: "write-timeout" })),
              }),
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isFailure(exit)) writeFailed = true;
                }),
              ),
            );
            writtenFrames++;
            writtenBytes += frame.bytes.byteLength;
            last = Object.freeze(
              RecordingSample.make({
                sequence: frame.sequence,
                document: frame.document,
                sourceTimeMillis: frame.sourceTimeMillis,
                sourceClock: frame.sourceClock,
                receivedMonotonicNanos: frame.receivedMonotonicNanos,
                writtenMonotonicNanos: clock.monotonicTimeNanosUnsafe(),
              }),
            );
            if (first === null) {
              first = last;
              yield* Deferred.succeed(ready, first);
            }
          }),
        );

        const readinessDeadline = Deferred.await(ready).pipe(
          Effect.timeoutOrElse({
            duration: readyTimeout,
            orElse: () => Effect.fail(new RecordingError({ reason: "ready-timeout" })),
          }),
          Effect.andThen(Effect.never),
        );

        const drainDeadline = Deferred.await(detached).pipe(
          Effect.andThen(Effect.sleep(drainTimeout)),
          Effect.andThen(Effect.fail(new RecordingError({ reason: "drain-timeout" }))),
        );

        const worker = Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            const consumed = yield* resume(
              consume.pipe(Effect.raceFirst(readinessDeadline), Effect.raceFirst(drainDeadline)),
            ).pipe(Effect.exit);

            yield* detach;
            phase = "finalizing";
            let result: Exit.Exit<A, E | BrowserError | RecordingError>;
            let writerState: RecordingReport["writer"] = "unresolved";

            const primary =
              writtenFrames === 0 && Exit.isSuccess(consumed)
                ? Exit.fail(new RecordingError({ reason: "empty" }))
                : consumed;

            if (
              writtenFrames > 0 &&
              !writeFailed &&
              !(Exit.isFailure(primary) && Cause.hasInterrupts(primary.cause))
            ) {
              const finished = yield* resume(
                Effect.suspend(() => writer.finish).pipe(
                  Effect.timeoutOrElse({
                    duration: finalizeTimeout,
                    orElse: () => Effect.fail(new RecordingError({ reason: "finalize-timeout" })),
                  }),
                ),
              ).pipe(Effect.exit);

              if (Exit.isSuccess(finished)) {
                retained = Option.some(finished.value);
                writerState = "finalized";
                result = Exit.isFailure(primary) ? Exit.failCause(primary.cause) : finished;
              } else {
                result = Exit.isFailure(primary)
                  ? Exit.failCause(Cause.combine(primary.cause, finished.cause))
                  : Exit.failCause(finished.cause);
              }
            } else {
              result = Exit.isFailure(primary)
                ? Exit.failCause(primary.cause)
                : Exit.fail(new RecordingError({ reason: "empty" }));
            }

            if (writerState !== "finalized") {
              const aborted = yield* resume(
                Effect.suspend(() => writer.abort).pipe(
                  Effect.timeoutOrElse({
                    duration: finalizeTimeout,
                    orElse: () => Effect.fail(new RecordingError({ reason: "abort-timeout" })),
                  }),
                ),
              ).pipe(Effect.exit);

              if (Exit.isSuccess(aborted)) writerState = "aborted";
              else
                result = Exit.isFailure(result)
                  ? Exit.failCause(Cause.combine(result.cause, aborted.cause))
                  : Exit.failCause(aborted.cause);
            }

            const released = yield* Scope.close(resources, result).pipe(Effect.exit);

            if (Exit.isFailure(released))
              result = Exit.isFailure(result)
                ? Exit.failCause(Cause.combine(result.cause, released.cause))
                : Exit.failCause(released.cause);

            const subscriptionReport = yield* subscription.completed;

            const report = freezeReport(
              new RecordingReport({
                writtenFrames,
                writtenBytes,
                first,
                last,
                sourceId: source.sourceId,
                status: Exit.isSuccess(result)
                  ? "complete"
                  : writtenFrames > 0
                    ? "partial"
                    : "failed",
                writer: writerState,
                artifactRetained: Option.isSome(retained),
                captureAtStart: initial,
                captureAtEnd: captureAtEnd ?? initial,
                subscription: freezeSubscription(subscriptionReport),
                upstreamDrops: "unknown",
              }),
            );

            phase = "settled";
            yield* Deferred.done(outcome, result);
            if (Exit.isFailure(result)) {
              yield* Deferred.failCause(ready, result.cause);
              yield* Deferred.failCause(failure, result.cause);
            }
            yield* Deferred.succeed(terminal, report);
          }),
        );

        const stop = Effect.uninterruptibleMask((resume) =>
          Effect.gen(function* () {
            if (!stopping) {
              stopping = true;
              if (phase === "recording") phase = "draining";
              yield* detach;
              yield* Deferred.succeed(detached, undefined);
            }

            return yield* resume(Deferred.await(terminal));
          }),
        );

        drain = stop;
        yield* Effect.forkIn(
          worker.pipe(
            Effect.onExit((exit) =>
              Effect.gen(function* () {
                if (Exit.isSuccess(exit) || (yield* Deferred.isDone(terminal))) return;
                const released = yield* Scope.close(resources, exit).pipe(Effect.exit);

                const cause = Exit.isFailure(released)
                  ? Cause.combine(exit.cause, released.cause)
                  : exit.cause;

                const subscriptionReport = yield* subscription.completed;

                phase = "settled";
                yield* Deferred.failCause(ready, cause);
                yield* Deferred.failCause(failure, cause);
                yield* Deferred.failCause(outcome, cause);
                yield* Deferred.succeed(
                  terminal,
                  freezeReport(
                    new RecordingReport({
                      sourceId: source.sourceId,
                      writtenFrames,
                      writtenBytes,
                      first,
                      last,
                      status: writtenFrames > 0 ? "partial" : "failed",
                      writer: "unresolved",
                      artifactRetained: Option.isSome(retained),
                      captureAtStart: initial,
                      captureAtEnd: captureAtEnd ?? initial,
                      subscription: freezeSubscription(subscriptionReport),
                      upstreamDrops: "unknown",
                    }),
                  ),
                );
              }),
            ),
          ),
          workers,
        );

        return Object.freeze({
          ready: Deferred.await(ready),
          snapshot,
          stop,
          completed: Deferred.await(terminal),
          checkCompleted: Deferred.await(outcome).pipe(Effect.asVoid),
          artifact: Deferred.await(outcome),
          retainedArtifact: Deferred.await(terminal).pipe(Effect.map(() => retained)),
          failure: Deferred.await(failure),
        });
      }).pipe(
        Effect.onExit((exit) =>
          Exit.isFailure(exit)
            ? Scope.close(workers, exit).pipe(
                Effect.onExit(() => {
                  const writer = acquiredWriter;

                  return writer === undefined
                    ? Effect.void
                    : Effect.suspend(() => writer.abort).pipe(
                        Effect.timeoutOrElse({
                          duration: finalizeTimeout,
                          orElse: () =>
                            Effect.fail(new RecordingError({ reason: "abort-timeout" })),
                        }),
                      );
                }),
                Effect.onExit(() => Scope.close(resources, exit)),
              )
            : Effect.void,
        ),
      );
    });
  });
});

/**
 * Supervise a required recording alongside use. The body's child scope closes before checked
 * stop/drain. onExit retains both body and recording causes; acquisition errors and requirements
 * stay inferred. Use start directly when recording failure should not fail the host workflow.
 */
export const scoped = <A, E, AE, AR, B, E2, R2>(
  acquire: Effect.Effect<RecordingJob<A, E>, AE, AR>,
  use: (job: RecordingJob<A, E>) => Effect.Effect<B, E2, R2>,
): Effect.Effect<B, AE | E | E2 | BrowserError | RecordingError, Exclude<AR | R2, Scope.Scope>> =>
  Effect.scoped(
    Effect.flatMap(acquire, (job) =>
      Effect.scoped(
        Effect.raceFirst(
          job.failure,
          Effect.suspend(() => use(job)),
        ),
      ).pipe(Effect.onExit(() => job.stop.pipe(Effect.andThen(job.checkCompleted)))),
    ),
  );
