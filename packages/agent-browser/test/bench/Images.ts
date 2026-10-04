import { Effect, FileSystem, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BenchError } from "./Records.ts";

/** Scale the captured PNG locally; preserve CSS-coordinate mapping in the model's context. */
export const resize = Effect.fn("Bench.image.resize")(
  function* (bytes: Uint8Array, scale: 0.5 | 1) {
    if (scale === 1) return bytes;
    if (bytes.byteLength > 4 * 1024 * 1024)
      return yield* new BenchError({
        operation: "image",
        message: "Captured PNG exceeds its input bound.",
      });
    const fs = yield* FileSystem.FileSystem;

    // FFmpeg closes before its input is removed when the resize scope is interrupted.
    const input = yield* fs.makeTempFileScoped({ prefix: "bench-image-", suffix: ".png" });

    yield* fs.writeFile(input, bytes);
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-f",
          "image2pipe",
          "-i",
          input,
          "-frames:v",
          "1",
          "-vf",
          "scale=iw/2:ih/2",
          "-f",
          "image2pipe",
          "-c:v",
          "png",
          "pipe:1",
        ],
        {
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        },
      ),
    );

    const collect = (stream: typeof handle.stdout) => {
      let count = 0;

      return stream.pipe(
        Stream.mapEffect((chunk) => {
          count += chunk.byteLength;

          return count <= 4 * 1024 * 1024
            ? Effect.succeed(chunk)
            : Effect.fail(
                new BenchError({
                  operation: "image",
                  message: "Image process output exceeds its bound.",
                }),
              );
        }),
        Stream.runFold(
          () => new Uint8Array(),
          (all, chunk) => {
            const next = new Uint8Array(all.byteLength + chunk.byteLength);

            next.set(all);
            next.set(chunk, all.byteLength);

            return next;
          },
        ),
      );
    };

    const [output, , code] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );

    if (code !== ChildProcessSpawner.ExitCode(0) || output.byteLength === 0)
      return yield* new BenchError({
        operation: "image",
        message: "Could not scale captured PNG.",
      });

    return output;
  },
  Effect.scoped,
  Effect.timeout("10 seconds"),
);
