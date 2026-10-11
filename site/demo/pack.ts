// Packs one recording (`bun run demo`, or the bench's `--record`) for the player: its shown frames
// become one H.264 video at their recorded times, the narrator's lines are spoken into its audio
// track and written as WebVTT captions, and replay.json keeps everything else.
//
// Output goes to public/replays/<replay id>/, which is ignored by git and published with the site.
import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { Recording } from "bench/Recording.ts";
import { Console, Effect, Schema } from "effect";

import { NarrationLine, Replay, shownFrames } from "../src/replay.ts";
import { captions, mixdown, schedule } from "./narration.ts";
import { sampleRate, type Voice } from "./voice.ts";

export class PackError extends Schema.TaggedError<PackError>()("PackError", {
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

/** After the last line, the video holds its last frame this long, so the voice ends unclipped. */
const afterLastLineMillis = 600;

const ffmpeg = (args: ReadonlyArray<string>) =>
  Effect.suspend(() => {
    const run = spawnSync("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", ...args], {
      stdio: ["ignore", "inherit", "inherit"],
    });

    return run.status === 0
      ? Effect.void
      : Effect.fail(
          new PackError({
            message: `ffmpeg failed (${run.error?.message ?? `exit ${run.status}`})`,
          }),
        );
  });

/**
 * Packs the recording in `source` as replay `id`. With a voice, the narrator's captions are
 * spoken; without one, or with no captions, the video is silent and has no narration.
 */
export const pack = Effect.fn("pack")(function* (source: string, id: string, voice?: Voice) {
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
  const output = fileURLToPath(new URL(`../public/replays/${id}/`, import.meta.url));

  yield* attempt("could not prepare the output", () => {
    rmSync(output, { recursive: true, force: true });
    mkdirSync(join(output, "moments"), { recursive: true });
  });

  const spoken =
    voice === undefined
      ? []
      : yield* schedule(
          recording.moments.flatMap((moment) =>
            moment.caption === undefined
              ? []
              : [
                  {
                    text: moment.caption,
                    from: moment.from,
                    // A window that closed before the first frame is heard from the first frame.
                    until: Math.max(moment.at, first.hostTime),
                    readyAt: moment.readyAt,
                  },
                ],
          ),
          (caption) =>
            voice.speak(caption.text).pipe(
              Effect.tap(() => Console.log(`  said: ${caption.text}`)),
              Effect.catchTag("VoiceError", (error) =>
                Console.error(`  unsaid (${error.message}): ${caption.text}`).pipe(
                  Effect.as(undefined),
                ),
              ),
            ),
        );

  const endsAt = Math.max(
    recording.endedAt,
    (spoken.at(-1)?.end ?? Number.NEGATIVE_INFINITY) + afterLastLineMillis,
  );

  // Each frame lasts until the next; the concat demuxer turns these durations into timestamps,
  // read at millisecond precision rather than the image demuxer's default 25 frames a second,
  // which would merge frames painted within one slot.
  const entry = (file: string) => [`file '${resolve(source, file)}'`, "option framerate 1000"];

  const list = frames.flatMap((frame, index) => {
    const until = frames[index + 1]?.hostTime ?? Math.max(endsAt, frame.hostTime);

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

  const silent = join(output, spoken.length === 0 ? "video.mp4" : "silent.mp4");

  yield* ffmpeg([
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
    silent,
  ]).pipe(
    Effect.ensuring(
      attempt("could not remove the frame list", () => rmSync(listFile)).pipe(Effect.ignore),
    ),
  );

  const durationMillis = Math.max(endsAt, last.hostTime + minimumLastFrameMillis) - first.hostTime;

  if (spoken.length > 0) {
    const track = join(output, "narration.pcm");

    yield* attempt("could not write the narration", () =>
      writeFileSync(
        track,
        mixdown(
          spoken.map((line) => ({ at: line.at, pcm: line.speech.pcm })),
          first.hostTime,
          durationMillis,
        ),
      ),
    );
    yield* ffmpeg([
      "-i",
      silent,
      "-f",
      "s16le",
      "-ar",
      String(sampleRate),
      "-ac",
      "1",
      "-i",
      track,
      "-map",
      "0:v",
      "-map",
      "1:a",
      "-c:v",
      "copy",
      "-c:a",
      "aac",
      "-b:a",
      "96k",
      "-movflags",
      "+faststart",
      join(output, "video.mp4"),
    ]);
    yield* attempt("could not remove the intermediate files", () => {
      rmSync(track);
      rmSync(silent);
    });
    yield* attempt("could not write the captions", () =>
      writeFileSync(join(output, "captions.vtt"), captions(spoken, first.hostTime)),
    );
  }

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
      durationMillis,
      width,
      height,
      frames: frames.length,
    },
    narration:
      voice === undefined || spoken.length === 0
        ? undefined
        : {
            voice: voice.credit,
            captions: "captions.vtt",
            lines: spoken.map(
              ({ text, from, until, readyAt, at, end }) =>
                new NarrationLine({ text, from, until, readyAt, at, end }),
            ),
          },
  });

  const json = yield* Schema.encodeEffect(Replay)(replay).pipe(
    Effect.mapError((error) => new PackError({ message: error.message })),
  );

  yield* attempt("could not write replay.json", () =>
    writeFileSync(join(output, "replay.json"), `${JSON.stringify(json)}\n`),
  );
  yield* Console.log(
    `${id}: ${frames.length} of ${recording.frames.length} frames, ${(durationMillis / 1000).toFixed(1)}s, ${spoken.length} of ${recording.moments.filter((moment) => moment.caption !== undefined).length} lines spoken, in ${output}`,
  );

  return { output, lines: spoken.length };
});
