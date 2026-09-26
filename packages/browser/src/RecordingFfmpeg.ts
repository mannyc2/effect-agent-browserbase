import {
  type Cause,
  Deferred,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Path,
  Queue,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { Target } from "./BrowserData.ts";
import { CapturedFrame } from "./CaptureData.ts";
import type { FrameWriter } from "./Recording.ts";

/** Host-only failures. Native diagnostics are not collected or exposed. */
export class EncoderError extends Schema.TaggedError<EncoderError>()(
  "BrowserRecordingEncoderError",
  {
    operation: Schema.Literals([
      "configuration",
      "start",
      "frame",
      "write",
      "finish",
      "abort",
      "closed",
    ]),
    reason: Schema.Literals([
      "invalid",
      "native",
      "timeout",
      "empty",
      "limit",
      "concurrent",
      "closed",
    ]),
    exitCode: Schema.optionalKey(Schema.Int),
  },
) {}

/** FFmpeg is a host-installed executable, never an automatically installed dependency. */
export const Options = Schema.Struct({
  outputPath: Schema.String.check(
    Schema.isMinLength(1),
    Schema.isMaxLength(8192),
    Schema.isPattern(/^[^\0]+$/),
  ),
  executable: Schema.optionalKey(
    Schema.String.check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8192),
      Schema.isPattern(/^[^\0]+$/),
    ),
  ),
  /** Constant output cadence; the browser still supplies images at its own variable cadence. */
  outputFramesPerSecond: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  ),
  /** Maximum admitted source timestamp span; output also includes quantization and a final tick. */
  maxDurationMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 21_600_000 })),
  ),
  maxFrameBytes: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 4, maximum: 64 * 1024 * 1024 })),
  ),
  writeTimeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  ),
  finalizeTimeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
  ),
});

export type Options = typeof Options.Type;

/** A finalized local output and its explicit source-to-output transformation, not a durable URL. */
export class Artifact extends Schema.Class<Artifact>("BrowserFfmpegArtifact")({
  outputPath: Schema.String,
  mediaType: Schema.Literal("video/mp4"),
  videoCodec: Schema.Literal("h264"),
  audio: Schema.Literal("absent"),
  width: Schema.Int,
  height: Schema.Int,
  bytes: Schema.BigInt,
  target: Target,
  firstSequence: Schema.Natural,
  lastSequence: Schema.Natural,
  /** Dimensions are supplied by the source; finalization does not independently probe JPEGs. */
  geometryEvidence: Schema.Literal("source-metadata"),
  sourceClock: Schema.Literal("presentation-unix-millis"),
  sourceFirstMillis: Schema.Finite,
  sourceLastMillis: Schema.Finite,
  outputFramesPerSecond: Schema.Int,
  outputFrames: Schema.Natural,
  repeatedFrames: Schema.Natural,
  supersededFrames: Schema.Natural,
  sourceFrames: Schema.Natural,
  /** Includes nearest-tick quantization, any pending final-image flush and that image's tick. */
  durationMillis: Schema.Finite,
}) {}

interface Packet {
  readonly bytes: Uint8Array;
  readonly accepted: Deferred.Deferred<void>;
}

/**
 * Stream JPEG frames into one host FFmpeg process and a progressively written fragmented MP4.
 * Images target the nearest output tick; gaps hold the latest image. An image targeting an
 * occupied tick stays pending until used or superseded. Finish emits a still-pending final image
 * at the next tick, so it may be up to one and a half ticks late. Only one
 * previous JPEG plus the current JPEG and one bounded pipe write are retained. These bytes
 * are additional to the capture subscription's reservation. A write accepts an image into this
 * bounded state or the pipe; the first write always reaches the pipe. Neither acknowledges pixel
 * decoding. Successful finalization requires encoder exit and a nonempty
 * file. Qualification can independently decode it. Existing output paths are never overwritten.
 *
 * The caller serializes write/finish. Cancellation leaves any partial file in place. The host's
 * ChildProcessSpawner owns termination; this does not issue a Chromium cleanup receipt or claim
 * crash recovery. Native stdout/stderr are ignored to avoid retaining unbounded diagnostics and
 * the pinned Node adapter's output-pipe teardown race.
 */
export const open = Effect.fn("RecordingFfmpeg.open")(function* (
  input: Options,
): Effect.fn.Return<
  FrameWriter<Artifact, EncoderError>,
  EncoderError,
  FileSystem.FileSystem | Path.Path | ChildProcessSpawner.ChildProcessSpawner | Scope.Scope
> {
  const options = yield* Schema.decodeEffect(Options)(input).pipe(
    Effect.mapError(() => new EncoderError({ operation: "configuration", reason: "invalid" })),
  );

  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const outputPath = path.resolve(options.outputPath);
  const fps = options.outputFramesPerSecond ?? 25;
  const maxDuration = options.maxDurationMillis ?? 60_000;
  const maxBytes = options.maxFrameBytes ?? 4 * 1024 * 1024;
  const writeTimeout = options.writeTimeoutMillis ?? 10_000;
  const finalizeTimeout = options.finalizeTimeoutMillis ?? 10_000;

  const processScope = yield* Effect.acquireRelease(Scope.make(), (scope, exit) =>
    Scope.close(scope, exit),
  );

  const handle = yield* spawner
    .spawn(
      ChildProcess.make(
        options.executable ?? "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-nostats",
          "-n",
          "-f",
          "image2pipe",
          "-vcodec",
          "mjpeg",
          "-framerate",
          String(fps),
          "-probesize",
          "32",
          "-analyzeduration",
          "0",
          "-i",
          "pipe:0",
          "-an",
          "-c:v",
          "libx264",
          "-preset",
          "ultrafast",
          "-tune",
          "zerolatency",
          "-pix_fmt",
          "yuv420p",
          "-vf",
          "pad=ceil(iw/2)*2:ceil(ih/2)*2",
          "-threads",
          "1",
          "-g",
          String(fps),
          "-movflags",
          "+frag_keyframe+empty_moov+default_base_moof",
          "-flush_packets",
          "1",
          "-f",
          "mp4",
          outputPath,
        ],
        {
          stdin: "pipe",
          stdout: "ignore",
          stderr: "ignore",
          forceKillAfter: 1_000,
        },
      ),
    )
    .pipe(
      Scope.provide(processScope),
      Effect.mapError(() => new EncoderError({ operation: "start", reason: "native" })),
    );

  const packets = yield* Queue.make<Packet, Cause.Done>({ capacity: 1 });
  const failed = yield* Deferred.make<never, EncoderError>();
  let acknowledged: Deferred.Deferred<void> | undefined;

  const pull = Effect.gen(function* () {
    if (acknowledged !== undefined) yield* Deferred.succeed(acknowledged, undefined);
    const packet = yield* Queue.take(packets);

    acknowledged = packet.accepted;

    return [packet.bytes] as const;
  });

  const inputWorker = yield* Stream.fromPull(Effect.succeed(pull)).pipe(
    Stream.run(handle.stdin),
    Effect.mapError(() => new EncoderError({ operation: "write", reason: "native" })),
    Effect.onExit((exit) =>
      Exit.isFailure(exit) ? Deferred.failCause(failed, exit.cause) : Effect.void,
    ),
    Effect.forkIn(processScope),
  );

  let phase: "open" | "finishing" | "finished" | "aborted" = "open";
  let busy = false;
  let previous: CapturedFrame | undefined;
  let previousEmitted = false;
  let firstMillis = 0;
  let firstSequence = 0;
  let outputFrames = 0;
  let repeatedFrames = 0;
  let supersededFrames = 0;
  let sourceFrames = 0;

  const abort = yield* Effect.cached(
    Effect.gen(function* () {
      if (phase === "finished") return;
      phase = "aborted";

      // Keep the stdin error observer alive while native termination is requested. The pinned
      // adapter's kill can finish its bounded wait while still alive, so check leader exit too.
      const running = yield* handle.isRunning.pipe(
        Effect.mapError(() => new EncoderError({ operation: "abort", reason: "native" })),
      );

      if (running)
        yield* handle
          .kill({ forceKillAfter: 1_000 })
          .pipe(Effect.mapError(() => new EncoderError({ operation: "abort", reason: "native" })));

      const stillRunning = yield* handle.isRunning.pipe(
        Effect.mapError(() => new EncoderError({ operation: "abort", reason: "native" })),
      );

      if (stillRunning) return yield* new EncoderError({ operation: "abort", reason: "timeout" });
    }).pipe(
      Effect.ensuring(
        Effect.gen(function* () {
          yield* Queue.shutdown(packets);
          yield* Scope.close(processScope, Exit.void);
          previous = undefined;
        }),
      ),
    ),
  );

  // The cached abort retains its typed result for explicit callers; finalizers have no E.
  yield* Effect.addFinalizer(() => Effect.exit(abort));

  const send = Effect.fnUntraced(function* (bytes: Uint8Array) {
    const accepted = yield* Deferred.make<void>();

    yield* Queue.offer(packets, { bytes, accepted });
    yield* Deferred.await(accepted);
    outputFrames++;
  });

  const write = Effect.fnUntraced(function* (frame: CapturedFrame) {
    if (phase !== "open") return yield* new EncoderError({ operation: "closed", reason: "closed" });
    if (busy) return yield* new EncoderError({ operation: "write", reason: "concurrent" });
    busy = true;
    yield* Effect.gen(function* () {
      const checked = yield* Schema.decodeEffect(CapturedFrame)(frame).pipe(
        Effect.mapError(() => new EncoderError({ operation: "frame", reason: "invalid" })),
      );

      if (checked.bytes.byteLength > maxBytes)
        return yield* new EncoderError({ operation: "frame", reason: "limit" });
      const retained = { ...checked, bytes: checked.bytes.slice() };
      let emitted = false;

      if (previous === undefined) {
        firstMillis = retained.sourceTimeMillis;
        firstSequence = retained.sequence;
        yield* send(retained.bytes);
        emitted = true;
      } else {
        if (
          retained.sourceTimeMillis <= previous.sourceTimeMillis ||
          retained.sequence <= previous.sequence ||
          retained.width !== previous.width ||
          retained.height !== previous.height ||
          retained.target.generation !== previous.target.generation ||
          retained.target.pageId !== previous.target.pageId ||
          retained.target.frameId !== previous.target.frameId
        ) {
          return yield* new EncoderError({ operation: "frame", reason: "invalid" });
        }
        const elapsed = retained.sourceTimeMillis - firstMillis;

        if (elapsed > maxDuration)
          return yield* new EncoderError({ operation: "frame", reason: "limit" });
        const tick = Math.round((elapsed * fps) / 1000);

        while (outputFrames < tick) {
          yield* send(previous.bytes);
          if (previousEmitted) repeatedFrames++;
          previousEmitted = true;
        }
        if (outputFrames === tick) {
          yield* send(retained.bytes);
          emitted = true;
        }
        if (!previousEmitted) supersededFrames++;
      }
      previous = retained;
      previousEmitted = emitted;
      sourceFrames++;
    }).pipe(
      Effect.raceFirst(Deferred.await(failed)),
      Effect.raceFirst(
        handle.exitCode.pipe(
          Effect.mapError(() => new EncoderError({ operation: "write", reason: "native" })),
          Effect.flatMap((exitCode) =>
            Effect.fail(new EncoderError({ operation: "write", reason: "native", exitCode })),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: writeTimeout,
        orElse: () => Effect.fail(new EncoderError({ operation: "write", reason: "timeout" })),
      }),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? abort : Effect.void)),
      Effect.ensuring(
        Effect.sync(() => {
          busy = false;
        }),
      ),
    );
  });

  const finish = yield* Effect.cached(
    Effect.gen(function* () {
      if (phase !== "open")
        return yield* new EncoderError({ operation: "closed", reason: "closed" });
      if (busy) return yield* new EncoderError({ operation: "finish", reason: "concurrent" });
      if (previous === undefined)
        return yield* new EncoderError({ operation: "finish", reason: "empty" });
      phase = "finishing";
      const last = previous;

      if (!previousEmitted) yield* send(last.bytes);
      yield* Queue.end(packets);
      yield* Fiber.join(inputWorker);

      const code = yield* handle.exitCode.pipe(
        Effect.mapError(() => new EncoderError({ operation: "finish", reason: "native" })),
      );

      if (code !== 0)
        return yield* new EncoderError({ operation: "finish", reason: "native", exitCode: code });

      const info = yield* fs
        .stat(outputPath)
        .pipe(Effect.mapError(() => new EncoderError({ operation: "finish", reason: "native" })));

      if (info.size <= 0n) return yield* new EncoderError({ operation: "finish", reason: "empty" });

      const artifact = new Artifact({
        outputPath,
        mediaType: "video/mp4",
        videoCodec: "h264",
        audio: "absent",
        width: Math.ceil(last.width / 2) * 2,
        height: Math.ceil(last.height / 2) * 2,
        bytes: info.size,
        target: last.target,
        firstSequence,
        lastSequence: last.sequence,
        geometryEvidence: "source-metadata",
        sourceClock: "presentation-unix-millis",
        sourceFirstMillis: firstMillis,
        sourceLastMillis: last.sourceTimeMillis,
        outputFramesPerSecond: fps,
        outputFrames,
        repeatedFrames,
        supersededFrames,
        sourceFrames,
        durationMillis: (outputFrames * 1000) / fps,
      });

      phase = "finished";
      previous = undefined;
      yield* Scope.close(processScope, Exit.void);

      return artifact;
    }).pipe(
      Effect.raceFirst(Deferred.await(failed)),
      Effect.raceFirst(
        handle.exitCode.pipe(
          Effect.mapError(() => new EncoderError({ operation: "finish", reason: "native" })),
          Effect.flatMap((exitCode) =>
            exitCode === 0
              ? Effect.never
              : Effect.fail(new EncoderError({ operation: "finish", reason: "native", exitCode })),
          ),
        ),
      ),
      Effect.timeoutOrElse({
        duration: finalizeTimeout,
        orElse: () => Effect.fail(new EncoderError({ operation: "finish", reason: "timeout" })),
      }),
      Effect.onExit((exit) => (Exit.isFailure(exit) ? abort : Effect.void)),
    ),
  );

  return { write, finish, abort };
});
