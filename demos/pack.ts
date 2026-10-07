// Packs one bench recording (`bun run bench run --record`) for the player: its shown frames become
// one H.264 video at their recorded times, and replay.json keeps everything else.
//
//   bun run pack -- <recording directory> <replay id>
//
// Output goes to public/replays/<replay id>/, which is ignored by git and published with the site.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Recording } from "bench/Recording.ts";
import { Cause, Console, Effect, Exit, Schema } from "effect";

import { Replay, shownFrames } from "./src/Replay.ts";

class PackError extends Schema.TaggedError<PackError>()("PackError", {
  message: Schema.String,
}) {}

const attempt = <A>(message: string, operation: () => A) =>
  Effect.try({
    try: operation,
    catch: (error) =>
      new PackError({
        message: `${message}: ${error instanceof Error ? error.message : String(error)}`,
      }),
  });

/** The last frame stays up until the recording ended, and at least this long. */
const minimumLastFrameMillis = 100;

const pack = Effect.fn("pack")(function* (source: string, id: string) {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id))
    return yield* new PackError({ message: "the replay id must be lowercase words and hyphens" });

  const recording = yield* Schema.decodeUnknownEffect(Recording)(
    yield* attempt("could not read recording.json", () =>
      JSON.parse(readFileSync(join(source, "recording.json"), "utf8")),
    ),
  ).pipe(Effect.mapError((error) => new PackError({ message: error.message })));

  const frames = shownFrames(recording.frames, recording.events);
  const first = frames[0];

  if (first === undefined) return yield* new PackError({ message: "the recording has no frames" });
  const output = fileURLToPath(new URL(`public/replays/${id}/`, import.meta.url));

  yield* attempt("could not prepare the output", () => {
    rmSync(output, { recursive: true, force: true });
    mkdirSync(join(output, "moments"), { recursive: true });
  });

  // Each frame lasts until the next; the concat demuxer turns these durations into timestamps,
  // read at millisecond precision rather than the image demuxer's default 25 frames a second,
  // which would merge frames painted within one slot.
  const entry = (file: string) => [`file '${resolve(source, file)}'`, "option framerate 1000"];

  const list = frames.flatMap((frame, index) => {
    const until = frames[index + 1]?.hostTime ?? Math.max(recording.endedAt, frame.hostTime);

    const millis =
      index === frames.length - 1
        ? Math.max(until - frame.hostTime, minimumLastFrameMillis)
        : until - frame.hostTime;

    return [...entry(frame.file), `duration ${(millis / 1000).toFixed(6)}`];
  });

  const last = frames.at(-1) ?? first;
  const listFile = join(output, "frames.ffconcat");

  yield* attempt("could not write the frame list", () =>
    writeFileSync(
      listFile,
      // The last frame is listed again so its duration counts.
      ["ffconcat version 1.0", ...list, ...entry(last.file), ""].join("\n"),
    ),
  );

  const width = first.width - (first.width % 2);
  const height = first.height - (first.height % 2);

  const encoded = spawnSync(
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
      listFile,
      "-vf",
      `scale=${width}:${height}:force_original_aspect_ratio=decrease,pad=${width}:${height}:(ow-iw)/2:(oh-ih)/2`,
      "-fps_mode",
      "vfr",
      "-enc_time_base",
      "1/1000",
      "-video_track_timescale",
      "1000",
      "-c:v",
      "libx264",
      "-preset",
      "slow",
      "-crf",
      "23",
      "-force_key_frames",
      "expr:gte(t,n_forced*1)",
      "-pix_fmt",
      "yuv420p",
      "-movflags",
      "+faststart",
      join(output, "video.mp4"),
    ],
    { stdio: ["ignore", "inherit", "inherit"] },
  );

  yield* attempt("could not remove the frame list", () => rmSync(listFile));
  if (encoded.status !== 0)
    return yield* new PackError({
      message: `ffmpeg failed (${encoded.error?.message ?? `exit ${encoded.status}`})`,
    });

  for (const moment of recording.moments)
    for (const frame of moment.frames)
      yield* attempt("could not copy a moment's picture", () =>
        copyFileSync(join(source, frame.file), join(output, frame.file)),
      );

  const replay = new Replay({
    ...recording,
    video: {
      file: "video.mp4",
      startsAt: first.hostTime,
      durationMillis:
        Math.max(recording.endedAt, last.hostTime + minimumLastFrameMillis) - first.hostTime,
      width,
      height,
      frames: frames.length,
    },
  });

  const json = yield* Schema.encodeEffect(Replay)(replay).pipe(
    Effect.mapError((error) => new PackError({ message: error.message })),
  );

  yield* attempt("could not write replay.json", () =>
    writeFileSync(join(output, "replay.json"), `${JSON.stringify(json)}\n`),
  );
  yield* Console.log(
    `${id}: ${frames.length} of ${recording.frames.length} frames, ${(replay.video.durationMillis / 1000).toFixed(1)}s, in ${output}`,
  );
});

if (import.meta.main) {
  const [source, id] = process.argv.slice(2);

  const exit = await Effect.runPromiseExit(
    source === undefined || id === undefined
      ? Effect.fail(
          new PackError({ message: "usage: bun run pack -- <recording directory> <replay id>" }),
        )
      : pack(source, id),
  );

  if (Exit.isFailure(exit)) {
    const error = Cause.squash(exit.cause);

    console.error(error instanceof Error ? error.message : "pack failed");
    process.exitCode = 1;
  }
}
