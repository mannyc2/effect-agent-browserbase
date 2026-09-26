import { spawn } from "node:child_process";

import { NodeServices } from "@effect/platform-node";
import { Effect, Schema } from "effect";
import type { AnySession } from "effect-browser/browser";
import * as Capture from "effect-browser/capture";
import * as Recording from "effect-browser/recording";
import * as RecordingFfmpeg from "effect-browser/recording-ffmpeg";

class RecordVideoError extends Schema.TaggedError<RecordVideoError>()("RecordVideoError", {
  operation: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

const DecodedFrame = Schema.Struct({
  stream: Schema.Literal(0),
  presentation: Schema.Int,
  checksum: Schema.String.check(Schema.isPattern(/^[a-f0-9]{32}$/)),
});

const DecodedFrames = Schema.Struct({
  numerator: Schema.Int.check(Schema.isGreaterThan(0)),
  denominator: Schema.Int.check(Schema.isGreaterThan(0)),
  frames: Schema.Array(DecodedFrame).check(Schema.isMinLength(2), Schema.isMaxLength(2000)),
});

const processResult = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stdoutBytes = 0;
        let stderr = "";
        let failure: RecordVideoError | undefined;
        let force: ReturnType<typeof setTimeout> | undefined;

        const terminate = (reason: string, cause?: unknown) => {
          if (failure !== undefined) return;
          failure = RecordVideoError.make({
            operation: reason,
            ...(cause === undefined ? {} : { cause }),
          });
          child.kill("SIGTERM");
          force = setTimeout(() => child.kill("SIGKILL"), 1000);
        };

        const interrupted = () => terminate("verification-interrupted");
        const deadline = setTimeout(() => terminate("verification-timeout"), 20_000);

        signal.addEventListener("abort", interrupted, { once: true });
        if (signal.aborted) interrupted();
        child.stdout.on("data", (chunk: Buffer) => {
          stdoutBytes += chunk.byteLength;
          if (stdoutBytes > 2 * 1024 * 1024) terminate("verification-output-limit");
          else stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-2000);
        });
        child.stdout.on("error", (cause) => terminate("verification-stdout", cause));
        child.stderr.on("error", (cause) => terminate("verification-stderr", cause));
        child.once("error", (cause) => terminate("verification-process", cause));
        child.once("close", (code) => {
          clearTimeout(deadline);
          clearTimeout(force);
          signal.removeEventListener("abort", interrupted);
          if (failure !== undefined) reject(failure);
          else if (code === 0) resolve({ stdout, stderr });
          else
            reject(
              RecordVideoError.make({ operation: `${command} exited ${String(code)}: ${stderr}` }),
            );
        });
      }),
    catch: (cause) => RecordVideoError.make({ operation: "media-process", cause }),
  });

/**
 * Record one bounded interval from the same live remote page.
 *
 * ffmpeg/ffprobe are caller-owned host tools; they are intentionally not package
 * dependencies. This seam is video-only because Playwright screencast supplies
 * rendered JPEG frames but no website-audio source.
 */
export const recordInterval = (session: AnySession, outputPath: string, durationMillis = 5_000) =>
  Effect.scoped(
    Effect.gen(function* () {
      const duration = yield* Schema.decodeEffect(
        Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60_000 })),
      )(durationMillis).pipe(
        Effect.mapError(() => new RecordVideoError({ operation: "duration" })),
      );

      const source = yield* Capture.openFrames(session, {
        capture: {
          maxFrames: 64,
          maxBufferedBytes: 16 * 1024 * 1024,
          maxFrameBytes: 4 * 1024 * 1024,
          maxDurationMillis: duration + 10_000,
          quality: 80,
        },
      });

      const job = yield* Recording.start(
        source,
        RecordingFfmpeg.open({ outputPath, maxDurationMillis: duration + 10_000 }),
        { maxFrames: 64, maxBufferedBytes: 16 * 1024 * 1024 },
      );

      // Measure this same recording after an actual first write, without warming and replacing it.
      yield* job.ready;
      yield* Effect.sleep(duration);
      const summary = (yield* source.stop).capture;
      const artifact = yield* job.artifact;
      const recording = yield* job.completed;

      const probe = yield* processResult("ffprobe", [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height,duration:format=duration",
        "-of",
        "json",
        outputPath,
      ]);

      const decoded: unknown = JSON.parse(probe.stdout);

      // ffprobe can read container headers without decoding pixels. Decode every
      // video frame independently and retain presentation times and pixel hashes.
      const verified = yield* processResult("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-xerror",
        "-i",
        outputPath,
        "-map",
        "0:v:0",
        "-vsync",
        "0",
        "-f",
        "framemd5",
        "-",
      ]);

      const timebase = /^#tb 0:\s*(\d+)\/(\d+)$/m.exec(verified.stdout);

      const verificationInput: unknown = {
        numerator: Number(timebase?.[1]),
        denominator: Number(timebase?.[2]),
        frames: verified.stdout
          .split("\n")
          .filter((line) => line.trim() !== "" && !line.startsWith("#"))
          .map((line) => {
            const columns = line.split(",").map((column) => column.trim());

            return {
              stream: Number(columns[0]),
              presentation: Number(columns[2]),
              checksum: columns[5],
            };
          }),
      };

      const verification = yield* Schema.decodeUnknownEffect(DecodedFrames)(verificationInput).pipe(
        Effect.mapError(() => RecordVideoError.make({ operation: "decode-verification" })),
      );

      const decodedFrames = verification.frames.map((frame) => ({
        presentationTimeMillis:
          (frame.presentation * verification.numerator * 1000) / verification.denominator,
        checksum: frame.checksum,
      }));

      return { summary, recording, artifact, decoded, decodedFrames };
    }),
  ).pipe(Effect.provide(NodeServices.layer));
