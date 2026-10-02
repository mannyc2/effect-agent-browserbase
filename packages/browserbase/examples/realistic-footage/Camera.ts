import { Deferred, Effect, Exit, Fiber, FileSystem, Schema, Stream } from "effect";
import { type AnySession, type Page, checkPage } from "effect-browser/browser";
import * as Capture from "effect-browser/capture";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { Broadcast } from "./Broadcast.ts";
import * as Compositor from "./Compositor.ts";
import { FootageError } from "./FootageError.ts";
import * as Presentation from "./Presentation.ts";
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

const Options = Schema.Struct({
  framesPerSecond: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60 })),
  size: Schema.Struct({
    width: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 })),
  }),
  quality: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 100 })),
  constantRateFactor: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 51 })),
  closingHoldMillis: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 30000 })),
});

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
const footage = (page: Page, options: Required<FilmOptions>, telemetry: Telemetry["Service"]) =>
  Stream.unwrap(
    Effect.gen(function* () {
      const attemptedAt = yield* telemetry.now;

      const interval = yield* Capture.start(page, {
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
  page: Page,
  options: Required<FilmOptions>,
  signals: Signals,
  telemetry: Telemetry["Service"],
  broadcast: Broadcast["Service"],
  presentation: Presentation.Presentation["Service"],
) =>
  footage(page, options, telemetry).pipe(
    Stream.tap((frame) =>
      Effect.all([
        telemetry.frame(frame),
        broadcast.publish(frame),
        presentation.frame(frame),
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
    Stream.mapAccumEffect(
      () => ({ reel: undefined as Reel.Reel | undefined, receivedNanos: 0n }),
      (state, rush) =>
        Effect.try({
          try: () => {
            if (rush._tag === "Cut") {
              // Receipt times share the host's monotonic clock with the cut; source times do not.
              const stillMillis = Number(rush.atNanos - state.receivedNanos) / 1_000_000;

              return [state, Reel.cut(state.reel, stillMillis)] as const;
            }

            const [next, settled] = Reel.expose(state.reel, rush.frame, options.framesPerSecond);

            return [
              { reel: next, receivedNanos: rush.frame.receivedMonotonicNanos },
              settled,
            ] as const;
          },
          catch: (cause) =>
            Schema.is(FootageError)(cause)
              ? cause
              : FootageError.make({ reason: "presentation-limit", cause }),
        }),
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
    .pipe(
      Effect.mapError(encoderFailure("ffprobe")),
      Effect.timeoutOrElse({
        duration: "1 minute",
        orElse: () =>
          Effect.fail(FootageError.make({ reason: "encoder", detail: "ffprobe deadline" })),
      }),
    );

  const decoded = yield* Schema.decodeEffect(Probe)(report).pipe(
    Effect.mapError(encoderFailure("ffprobe-report")),
  );

  return decoded.streams[0];
});

/**
 * Film `performance` from its issued Page into `outputPath`.
 *
 * The performance starts only once the first frame has arrived, and the reel is
 * cut a moment after it ends. A failed performance interrupts the encoder with
 * the scope, and its error is the one reported.
 */
export const film = Effect.fn("Camera.film")(function* <A, E, R>(
  session: AnySession,
  page: Page,
  outputPath: string,
  performance: Effect.Effect<A, E, R>,
  overrides: FilmOptions = {},
) {
  yield* checkPage(session, page).pipe(
    Effect.mapError((cause) =>
      FootageError.make({ reason: "presentation-limit", detail: "invalid Page owner", cause }),
    ),
  );

  const options = yield* Schema.decodeEffect(Options)({ ...Defaults, ...overrides }).pipe(
    Effect.mapError((cause) => FootageError.make({ reason: "presentation-limit", cause })),
  );

  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const telemetry = yield* Telemetry;

  yield* telemetry.bindOwner(session);
  const broadcast = yield* Broadcast;
  const fs = yield* FileSystem.FileSystem;
  const directory = yield* fs.makeTempDirectoryScoped({ prefix: "browser-footage-raw-" });
  const rawPath = `${directory}/raw.mp4`;
  const presentation = yield* Presentation.make(session, page, broadcast, telemetry);
  const graphicsReader = yield* presentation.read("graphics").pipe(Effect.forkScoped);
  const metricsReader = yield* presentation.read("metrics").pipe(Effect.forkScoped);
  const rolling = yield* Deferred.make<void>();
  const cut = yield* Deferred.make<bigint>();

  const encoder = yield* spawner
    // A wedged encoder must not hold the scope open: SIGTERM, then SIGKILL after five seconds.
    .spawn(
      ChildProcess.make("ffmpeg", encoderArguments(options, rawPath), {
        forceKillAfter: "5 seconds",
      }),
    )
    .pipe(Effect.mapError(encoderFailure("ffmpeg-start")));

  const complaints = yield* encoder.stderr.pipe(
    Stream.decodeText(),
    Stream.runFold(
      () => "",
      (tail, chunk) => (tail + chunk).slice(-2000),
    ),
    Effect.orElseSucceed(() => ""),
    Effect.forkScoped,
  );

  const encoding = yield* reel(
    page,
    options,
    { rolling, cut },
    telemetry,
    broadcast,
    presentation,
  ).pipe(Stream.run(encoder.stdin), Effect.forkScoped);

  yield* Effect.addFinalizer((exit) =>
    Exit.isFailure(exit)
      ? presentation.stop.pipe(
          Effect.andThen(Fiber.interrupt(encoding)),
          Effect.andThen(Fiber.interrupt(graphicsReader)),
          Effect.andThen(Fiber.interrupt(metricsReader)),
          Effect.andThen(presentation.abort),
        )
      : Effect.void,
  );

  yield* Deferred.await(rolling).pipe(
    Effect.raceFirst(Fiber.join(encoding)),
    Effect.timeoutOrElse({
      duration: "15 seconds",
      orElse: () => Effect.fail(FootageError.make({ reason: "no-frames" })),
    }),
  );

  const result = yield* performance.pipe(
    Effect.provideService(Presentation.Presentation, presentation),
    Effect.raceFirst(
      Fiber.join(encoding).pipe(
        Effect.andThen(
          Effect.fail(
            FootageError.make({ reason: "capture-ended", detail: "encoder ended before cut" }),
          ),
        ),
      ),
    ),
    Effect.raceFirst(
      Fiber.join(graphicsReader).pipe(
        Effect.andThen(
          Effect.fail(
            FootageError.make({ reason: "capture-ended", detail: "graphics reader ended" }),
          ),
        ),
      ),
    ),
    Effect.raceFirst(
      Fiber.join(metricsReader).pipe(
        Effect.andThen(
          Effect.fail(
            FootageError.make({ reason: "capture-ended", detail: "metrics reader ended" }),
          ),
        ),
      ),
    ),
  );

  yield* Effect.sleep(options.closingHoldMillis);
  yield* Deferred.succeed(cut, yield* session.monotonicTimeNanos);
  yield* Fiber.join(encoding).pipe(
    Effect.catchTag("PlatformError", (cause) => Effect.fail(encoderFailure("ffmpeg-input")(cause))),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(FootageError.make({ reason: "encoder", detail: "input drain deadline" })),
    }),
  );

  const exitCode = yield* encoder.exitCode.pipe(
    Effect.mapError(encoderFailure("ffmpeg-exit")),
    Effect.timeoutOrElse({
      duration: "2 minutes",
      orElse: () =>
        Effect.fail(FootageError.make({ reason: "encoder", detail: "ffmpeg exit deadline" })),
    }),
  );

  if (exitCode !== ChildProcessSpawner.ExitCode(0))
    return yield* FootageError.make({
      reason: "encoder",
      detail: `ffmpeg exited ${String(exitCode)}: ${(yield* Fiber.join(complaints)).slice(-2000)}`,
    });

  yield* presentation.stop;
  yield* Fiber.join(graphicsReader);
  yield* Fiber.join(metricsReader);
  const rawVideo = yield* probe(rawPath);
  const graphics = yield* presentation.graphics;
  const started = yield* session.monotonicTimeNanos;

  yield* Compositor.compose(
    rawPath,
    outputPath,
    graphics,
    rawVideo.duration,
    options.constantRateFactor,
  );
  yield* telemetry.composed(
    Number((yield* session.monotonicTimeNanos) - started) / 1_000_000,
    Number(graphics.clockUncertaintyNanos) / 1_000_000,
  );
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
