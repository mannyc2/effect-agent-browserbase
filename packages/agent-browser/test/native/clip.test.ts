import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { renderClip } from "../bench/Clip.ts";

it.live("FFmpeg renders shared cursor artwork into a verified silent bounded blind clip", () =>
  Effect.gen(function* () {
    const command = promisify(execFile);

    const directory = yield* Effect.acquireRelease(
      Effect.promise(() => mkdtemp(join(tmpdir(), "bench-clip-test-"))),
      (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
    );

    const source = join(directory, "source.mp4");

    yield* Effect.promise(() =>
      command("ffmpeg", [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-n",
        "-f",
        "lavfi",
        "-i",
        "color=blue:s=320x240:d=1",
        "-an",
        "-c:v",
        "libx264",
        source,
      ]),
    );

    const clip = yield* renderClip({
      inputVideo: source,
      outputDirectory: join(directory, "clip"),
      samples: [
        { kind: "cursor", atMillis: 0, point: { x: 20, y: 20 }, qualification: "native-input" },
      ],
      viewport: { width: 320, height: 240 },
      durationMillis: 1000,
    });

    const metadata = yield* Effect.promise(() => readFile(clip.metadata, "utf8"));

    expect(JSON.parse(metadata)).toMatchObject({
      durationMillis: 1000,
      cursorArtwork: "identical-ass-v1",
      viewport: { width: 320, height: 240 },
    });

    const result = yield* Effect.promise(() =>
      command(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-i",
          clip.video,
          "-frames:v",
          "1",
          "-vf",
          "crop=2:2:22:28,format=rgb24",
          "-f",
          "rawvideo",
          "pipe:1",
        ],
        { encoding: "buffer" },
      ),
    );

    expect([...result.stdout].every((byte) => byte > 160)).toBe(true);
  }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
);
