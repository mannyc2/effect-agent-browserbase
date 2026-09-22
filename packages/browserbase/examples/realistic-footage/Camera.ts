import { Clock, Deferred, Effect, Fiber, Schema, Stream } from "effect";
import type { BrowserSession } from "effect-browser/browser";
import * as Capture from "effect-browser/capture";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { Broadcast } from "./Broadcast.ts";
import { FootageError } from "./FootageError.ts";
import * as Reel from "./Reel.ts";
import { type Metrics, Telemetry } from "./Telemetry.ts";

/**
 * Films a performance: live capture in, one constant-frame-rate H.264 file out.
 *
 * Frames are piped to the caller's FFmpeg as they arrive, so nothing is held
 * beyond the capture's own bounded buffer and nothing is written but the
 * result. FFmpeg and ffprobe are host tools, as in `record-video.ts`; the
 * package does not depend on an encoder.
 */

export interface FilmOptions {
  readonly framesPerSecond?: number;
  /**
   * The largest frame to accept. Without it the screencast is fitted inside
   * 800×800, which softens every glyph; a viewport within this box is filmed
   * at its own size.
   */
  readonly size?: Capture.CaptureSize;
  /** JPEG quality of captured frames. The encode cannot recover what this discards. */
  readonly quality?: number;
  /** x264 constant rate factor; 18 is visually lossless for screen content. */
  readonly constantRateFactor?: number;
  /** Rest on the final picture so the last action is seen to land. */
  readonly closingHoldMillis?: number;
}

const Defaults = {
  framesPerSecond: 30,
  size: { width: 1920, height: 1080 },
  quality: 92,
  constantRateFactor: 18,
  closingHoldMillis: 1_200,
} satisfies Required<FilmOptions>;

const Probe = Schema.fromJsonString(
  Schema.Struct({
    streams: Schema.Tuple([
      Schema.Struct({
        codec_name: Schema.Literal("h264"),
        pix_fmt: Schema.Literal("yuv420p"),
        width: Schema.Int,
        height: Schema.Int,
        nb_read_frames: Schema.FiniteFromString,
        duration: Schema.FiniteFromString,
      }),
    ]),
  }),
);

export interface Footage<A> {
  readonly result: A;
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly frames: number;
  readonly seconds: number;
  /** Everything this layer is answerable for, including how long each navigation held the picture. */
  readonly metrics: Metrics;
}

type Rush =
  | { readonly _tag: "Frame"; readonly frame: Capture.CapturedFrame }
  | { readonly _tag: "Cut"; readonly atNanos: bigint };

const encoderFailure = (detail: string) => (cause: unknown) =>
  FootageError.make({ reason: "encoder", detail, cause });

interface Signals {
  readonly rolling: Deferred.Deferred<void>;
  readonly cut: Deferred.Deferred<bigint>;
}

/**
 * One capture interval for the whole film. It follows its page across
 * documents, so a navigation is filmed as it loads instead of ending the
 * interval, and the library says where each document began. The interval is
 * bounded at ten minutes. If it ends before the film is cut, the film fails
 * rather than silently holding its last picture to the end.
 */
const footage = (
  session: BrowserSession,
  options: Required<FilmOptions>,
  telemetry: Telemetry["Service"],
) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const attemptedAt = yield* telemetry.now;

      const interval = yield* Capture.start(session, {
        lifetime: "page",
        quality: options.quality,
        size: options.size,
        maxFrames: 64,
        maxFrameBytes: 8 * 1024 * 1024,
        maxBufferedBytes: 64 * 1024 * 1024,
        maxDurationMillis: 600_000,
      });

      yield* telemetry.captureStarted(attemptedAt);

      return interval.frames.pipe(
        Stream.concat(
          Stream.fail(
            FootageError.make({ reason: "capture-ended", detail: "before the film was cut" }),
          ),
        ),
        Stream.ensuring(Effect.flatMap(interval.stop, telemetry.captureEnded)),
      );
    }),
  );

/**
 * Each frame goes to the live view as it arrives, and onto one constant-rate
 * reel of JPEG bytes for the encoder, until the cut.
 */
const reel = (
  session: BrowserSession,
  options: Required<FilmOptions>,
  signals: Signals,
  telemetry: Telemetry["Service"],
  broadcast: Broadcast["Service"],
) =>
  footage(session, options, telemetry).pipe(
    Stream.tap((frame) =>
      Effect.all([
        telemetry.frame(frame),
        broadcast.publish(frame),
        Deferred.succeed(signals.rolling, undefined),
      ]),
    ),
    Stream.map((frame): Rush => ({ _tag: "Frame", frame })),
    Stream.interruptWhen(Deferred.await(signals.cut)),
    Stream.concat(
      Stream.fromEffect(Deferred.await(signals.cut)).pipe(
        Stream.map((atNanos): Rush => ({ _tag: "Cut", atNanos })),
      ),
    ),
    Stream.mapAccum(
      () => ({ reel: undefined as Reel.Reel | undefined, receivedNanos: 0n }),
      (state, rush) => {
        if (rush._tag === "Cut") {
          // Receipt times share the host's monotonic clock with the cut; source times do not.
          const stillMillis = Number(rush.atNanos - state.receivedNanos) / 1_000_000;

          return [state, Reel.cut(state.reel, stillMillis)];
        }

        const [next, settled] = Reel.expose(state.reel, rush.frame, options.framesPerSecond);

        return [{ reel: next, receivedNanos: rush.frame.receivedMonotonicNanos }, settled];
      },
    ),
    // The reel repeats a picture by reference, so identity is what marks a held frame.
    Stream.mapAccum(
      () => undefined as Uint8Array | undefined,
      (previous, bytes) => [bytes, [{ bytes, held: bytes === previous }]],
    ),
    Stream.tap((picture) => telemetry.output(picture.held)),
    Stream.map((picture) => picture.bytes),
  );

const encoderArguments = (options: Required<FilmOptions>, outputPath: string) => [
  "-hide_banner",
  "-loglevel",
  "error",
  "-y",
  "-f",
  "image2pipe",
  "-framerate",
  String(options.framesPerSecond),
  "-c:v",
  "mjpeg",
  "-i",
  "pipe:0",
  // Convert JPEG's full-range samples as well as its pixel layout. FFmpeg 8.1 can
  // preserve full-range signaling after format=yuv420p alone, yielding yuvj420p.
  // https://ffmpeg.org/ffmpeg-filters.html#scale (out_range)
  "-vf",
  "scale=trunc(iw/2)*2:trunc(ih/2)*2:flags=lanczos:out_range=tv,format=yuv420p",
  "-c:v",
  "libx264",
  // Encoding keeps pace with capture; a slower preset would push back into the frame buffer.
  "-preset",
  "veryfast",
  "-crf",
  String(options.constantRateFactor),
  // The index goes first, so the file starts playing before it has finished downloading.
  "-movflags",
  "+faststart",
  outputPath,
];

const probe = Effect.fnUntraced(function* (outputPath: string) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  // Counting decoded frames reads every picture, not only the container's header.
  const report = yield* spawner
    .string(
      ChildProcess.make("ffprobe", [
        "-v",
        "error",
        "-count_frames",
        "-select_streams",
        "v",
        "-show_entries",
        "stream=codec_name,pix_fmt,width,height,nb_read_frames,duration",
        "-of",
        "json",
        outputPath,
      ]),
    )
    .pipe(Effect.mapError(encoderFailure("ffprobe")));

  const decoded = yield* Schema.decodeEffect(Probe)(report).pipe(
    Effect.mapError(encoderFailure("ffprobe-report")),
  );

  return decoded.streams[0];
});

/**
 * Film `performance` from the session's selected page into `outputPath`.
 *
 * The performance starts only once the first frame has arrived, and the reel is
 * cut a moment after it ends. A failed performance interrupts the encoder with
 * the scope, and its error is the one reported.
 */
export const film = Effect.fn("Camera.film")(function* <A, E, R>(
  session: BrowserSession,
  outputPath: string,
  performance: Effect.Effect<A, E, R>,
  overrides: FilmOptions = {},
) {
  const options = { ...Defaults, ...overrides };
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const telemetry = yield* Telemetry;
  const broadcast = yield* Broadcast;
  const rolling = yield* Deferred.make<void>();
  const cut = yield* Deferred.make<bigint>();

  const encoder = yield* spawner
    .spawn(ChildProcess.make("ffmpeg", encoderArguments(options, outputPath)))
    .pipe(Effect.mapError(encoderFailure("ffmpeg-start")));

  const complaints = yield* encoder.stderr.pipe(
    Stream.decodeText(),
    Stream.mkString,
    Effect.orElseSucceed(() => ""),
    Effect.forkScoped,
  );

  const encoding = yield* reel(session, options, { rolling, cut }, telemetry, broadcast).pipe(
    Stream.run(encoder.stdin),
    Effect.forkScoped,
  );

  yield* Deferred.await(rolling).pipe(
    Effect.raceFirst(Fiber.join(encoding)),
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(FootageError.make({ reason: "no-frames" })),
    }),
  );

  const result = yield* performance;

  yield* Effect.sleep(options.closingHoldMillis);
  yield* Deferred.succeed(cut, yield* Clock.clockWith((clock) => clock.monotonicTimeNanos));
  yield* Fiber.join(encoding).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(encoderFailure("ffmpeg-input")(cause))),
  );

  const exitCode = yield* encoder.exitCode.pipe(Effect.mapError(encoderFailure("ffmpeg-exit")));

  if (exitCode !== ChildProcessSpawner.ExitCode(0))
    return yield* FootageError.make({
      reason: "encoder",
      detail: `ffmpeg exited ${String(exitCode)}: ${(yield* Fiber.join(complaints)).slice(-2000)}`,
    });

  const video = yield* probe(outputPath);

  return {
    result,
    outputPath,
    width: video.width,
    height: video.height,
    frames: video.nb_read_frames,
    seconds: video.duration,
    metrics: yield* telemetry.metrics,
  } satisfies Footage<A>;
}, Effect.scoped);
