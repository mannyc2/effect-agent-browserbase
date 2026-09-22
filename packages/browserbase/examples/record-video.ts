import { spawn } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect, Schema, Stream } from "effect";
import type { AnySession } from "effect-browser/browser";
import * as Capture from "effect-browser/capture";

import { CaptureEvidence, captureEvidence } from "./capture-evidence.ts";

class RecordVideoError extends Schema.TaggedError<RecordVideoError>()("RecordVideoError", {
  operation: Schema.String,
  evidence: Schema.optionalKey(CaptureEvidence),
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
  frames: Schema.Array(DecodedFrame).check(Schema.isMinLength(2)),
});

const processResult = (command: string, args: ReadonlyArray<string>, cwd?: string) =>
  Effect.tryPromise({
    try: (signal) =>
      new Promise<{ readonly stdout: string; readonly stderr: string }>((resolve, reject) => {
        const child = spawn(command, args, { cwd, signal, stdio: ["ignore", "pipe", "pipe"] });
        let stdout = "";
        let stderr = "";

        child.stdout.on("data", (chunk: Buffer) => {
          stdout += chunk.toString();
        });
        child.stderr.on("data", (chunk: Buffer) => {
          stderr += chunk.toString();
        });
        child.once("error", reject);
        child.once("close", (code) =>
          code === 0
            ? resolve({ stdout, stderr })
            : reject(
                RecordVideoError.make({
                  operation: `${command} exited ${String(code)}: ${stderr.slice(-2000)}`,
                }),
              ),
        );
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
      const directory = yield* Effect.acquireRelease(
        Effect.tryPromise({
          try: () => mkdtemp(join(tmpdir(), "browserbase-capture-")),
          catch: (cause) => RecordVideoError.make({ operation: "capture-directory", cause }),
        }),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );

      const captureStarted = yield* Effect.sync(() => process.hrtime.bigint());

      const interval = yield* Capture.start(session, {
        maxFrames: 64,
        maxBufferedBytes: 32 * 1024 * 1024,
        maxFrameBytes: 4 * 1024 * 1024,
        maxDurationMillis: durationMillis,
        quality: 80,
      });

      const frames = Array.from(yield* interval.frames.pipe(Stream.runCollect));
      const summary = yield* interval.completed;

      if (frames.length < 2) {
        const captureCompleted = yield* Effect.sync(() => process.hrtime.bigint());

        return yield* RecordVideoError.make({
          operation: "insufficient-frames",
          evidence: captureEvidence(
            frames,
            summary,
            durationMillis,
            captureStarted,
            captureCompleted,
          ),
        });
      }

      const lines: string[] = [];

      for (let index = 0; index < frames.length; index++) {
        const frame = frames[index]!;
        const name = `frame-${String(index).padStart(6, "0")}.jpg`;

        yield* Effect.tryPromise({
          try: () => writeFile(join(directory, name), frame.bytes),
          catch: (cause) => RecordVideoError.make({ operation: "write-frame", cause }),
        });
        lines.push(`file '${name}'`);
        if (index + 1 < frames.length) {
          const next = frames[index + 1]!;
          const seconds = Math.max(0.001, (next.sourceTimeMillis - frame.sourceTimeMillis) / 1000);

          lines.push(`duration ${seconds.toFixed(6)}`);
        }
      }
      // concat requires the final file again so its duration is represented.
      lines.push(`file 'frame-${String(frames.length - 1).padStart(6, "0")}.jpg'`);
      yield* Effect.tryPromise({
        try: () =>
          writeFile(
            join(directory, "frames.ffconcat"),
            "ffconcat version 1.0\n" + lines.join("\n") + "\n",
          ),
        catch: (cause) => RecordVideoError.make({ operation: "write-manifest", cause }),
      });
      yield* processResult(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-f",
          "concat",
          "-safe",
          "0",
          "-i",
          "frames.ffconcat",
          "-vsync",
          "vfr",
          "-pix_fmt",
          "yuv420p",
          outputPath,
        ],
        directory,
      );

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

      return { summary, decoded, decodedFrames };
    }),
  );
