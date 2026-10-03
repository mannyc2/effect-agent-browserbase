import { resolve } from "node:path";

import { ByteSize, Effect, FileSystem, Schema, Stream } from "effect";
import type { Event } from "effect-browser/timeline-data";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { type InputEvent, Point } from "./InputLog.ts";

export const CursorSample = Schema.Struct({
  atMillis: Schema.Finite,
  kind: Schema.Literals(["cursor", "press"]),
  point: Point,
  qualification: Schema.Literals([
    "native-input",
    "commanded-point",
    "checked-intended-aim",
    "intended-schedule",
  ]),
});

export type CursorSample = typeof CursorSample.Type;

export class ClipError extends Schema.TaggedError<ClipError>()("BenchClipError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export const cursorFromInput = (
  events: ReadonlyArray<InputEvent>,
  startSourceMillis: number,
): ReadonlyArray<CursorSample> =>
  events.flatMap((event) =>
    event.trusted && event.point !== null && event.coordinateSpace === "main-viewport"
      ? [
          {
            atMillis: event.sourceTimeMillis - startSourceMillis,
            kind: event.kind === "pointerdown" ? ("press" as const) : ("cursor" as const),
            point: event.point,
            qualification: "native-input" as const,
          },
        ]
      : [],
  );

/** The clock bridge is measured by the caller; intended glides remain labelled as intentions. */
export const cursorFromTimeline = (
  events: ReadonlyArray<Event>,
  anchor: {
    readonly clockId: string;
    readonly offsetNanos: bigint;
    readonly sourceTimeMillis: number;
    readonly clipStartSourceMillis: number;
  },
): ReadonlyArray<CursorSample> => {
  const samples: CursorSample[] = [];

  const time = (stamp: { readonly clockId: string; readonly offsetNanos: bigint }) =>
    stamp.clockId === anchor.clockId
      ? anchor.sourceTimeMillis -
        anchor.clipStartSourceMillis +
        Number(stamp.offsetNanos - anchor.offsetNanos) / 1e6
      : null;

  for (const envelope of events) {
    const event = envelope.event;

    if (event._tag === "Glide") {
      for (const sample of event.schedule) {
        const atMillis = time(sample.at);

        if (atMillis !== null)
          samples.push({
            atMillis,
            kind: "cursor",
            point: sample.position,
            qualification: "intended-schedule",
          });
      }
    } else if (event._tag === "Pointer" || event._tag === "Press") {
      const atMillis = time(event.interval.end);

      const point =
        event.position ?? (event._tag === "Press" ? event.intended?.position : undefined);

      if (atMillis !== null && point !== undefined && point !== null)
        samples.push({
          atMillis,
          kind: event._tag === "Press" ? "press" : "cursor",
          point,
          qualification: event.position === null ? "checked-intended-aim" : "commanded-point",
        });
    }
  }

  return samples;
};

const stamp = (millis: number) => {
  const ticks = Math.max(0, Math.round(millis / 10));

  return `${Math.floor(ticks / 360000)}:${String(Math.floor(ticks / 6000) % 60).padStart(2, "0")}:${String(Math.floor(ticks / 100) % 60).padStart(2, "0")}.${String(ticks % 100).padStart(2, "0")}`;
};

/** Identical vector cursor and press pulse for every source arm; no labels or captions. */
export const cursorArtwork = (
  input: ReadonlyArray<CursorSample>,
  viewport: { readonly width: number; readonly height: number },
  durationMillis = 15000,
) => {
  const samples = [
    ...Schema.decodeSync(Schema.Array(CursorSample).check(Schema.isMaxLength(65536)))(input),
  ].sort((a, b) => a.atMillis - b.atMillis);

  const cursors = samples;
  const rows: string[] = [];

  const row = (start: number, end: number, text: string) => {
    if (end > start && start < durationMillis && end > 0)
      rows.push(
        `Dialogue: 0,${stamp(Math.max(0, start))},${stamp(Math.min(durationMillis, end))},Artwork,,0,0,0,,${text}`,
      );
  };

  for (const [index, sample] of cursors.entries()) {
    const next = cursors[index + 1];

    row(
      sample.atMillis,
      next?.atMillis ?? durationMillis,
      `{\\an7\\pos(${sample.point.x.toFixed(2)},${sample.point.y.toFixed(2)})\\p1\\bord1.5\\shad1}m 0 0 l 0 25 7 18 13 28 17 26 11 16 21 16 0 0`,
    );
    if (sample.kind === "press")
      row(
        sample.atMillis,
        sample.atMillis + 350,
        `{\\an7\\pos(${(sample.point.x - 15).toFixed(2)},${(sample.point.y - 15).toFixed(2)})\\p1\\bord1\\shad0\\1c&H005AFF&\\fad(0,350)}m 15 0 b 35 0 35 30 15 30 b -5 30 -5 0 15 0`,
      );
  }

  return `[Script Info]\nScriptType: v4.00+\nPlayResX: ${viewport.width}\nPlayResY: ${viewport.height}\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Artwork,DejaVu Sans,26,&H00FFFFFF,&H00FFFFFF,&H00111111,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${rows.join("\n")}\n`;
};

const processOutput = Effect.fnUntraced(
  function* (command: string, args: ReadonlyArray<string>, cwd: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
        extendEnv: true,
        forceKillAfter: "2 seconds",
      }),
    );

    const collect = (stream: typeof handle.stdout) => {
      let bytes = 0;

      return stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;

          return bytes <= 2 * 1024 * 1024
            ? Effect.succeed(chunk)
            : Effect.fail(
                new ClipError({ operation: command, message: "Encoder output bound exceeded." }),
              );
        }),
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
      );
    };

    const [stdout, stderr, exit] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );

    if (exit !== ChildProcessSpawner.ExitCode(0))
      return yield* new ClipError({
        operation: command,
        message: `Encoder exit ${exit}: ${stderr.slice(-1024)}`,
      });

    return stdout;
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: "60 seconds",
    orElse: () =>
      Effect.fail(
        new ClipError({ operation: "encoder", message: "Clip encoder deadline exceeded." }),
      ),
  }),
  Effect.mapError((cause) =>
    cause instanceof ClipError
      ? cause
      : new ClipError({ operation: "encoder", message: "Could not encode clip.", cause }),
  ),
);

const Render = Schema.Struct({
  inputVideo: Schema.NonEmptyString,
  outputDirectory: Schema.NonEmptyString,
  samples: Schema.Array(CursorSample).check(Schema.isMaxLength(65536)),
  viewport: Schema.Struct({
    width: Schema.Int.check(Schema.isBetween({ minimum: 32, maximum: 1920 })),
    height: Schema.Int.check(Schema.isBetween({ minimum: 32, maximum: 1080 })),
  }),
  startMillis: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  durationMillis: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 15000 })),
});

/** Encode and decode-verify a bounded blind clip from the caller's retained raw video. */
export const renderClip = Effect.fn("Bench.renderClip")(function* (input: {
  readonly inputVideo: string;
  readonly outputDirectory: string;
  readonly samples: ReadonlyArray<CursorSample>;
  readonly viewport: { readonly width: number; readonly height: number };
  readonly startMillis?: number;
  readonly durationMillis?: number;
}) {
  const options = yield* Schema.decodeEffect(Render)({
    ...input,
    startMillis: input.startMillis ?? 0,
    durationMillis: input.durationMillis ?? 15000,
  });

  const fs = yield* FileSystem.FileSystem;
  const directory = resolve(options.outputDirectory);

  yield* fs.makeDirectory(directory);
  yield* fs.writeFileString(
    `${directory}/cursor.ass`,
    cursorArtwork(options.samples, options.viewport, options.durationMillis),
    { flag: "wx" },
  );
  yield* processOutput(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-n",
      "-ss",
      String(options.startMillis / 1000),
      "-i",
      resolve(options.inputVideo),
      "-t",
      String(options.durationMillis / 1000),
      "-an",
      "-vf",
      "ass=cursor.ass,fps=25",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-map_metadata",
      "-1",
      "-movflags",
      "+faststart",
      "-fs",
      "134217728",
      "clip.mp4",
    ],
    directory,
  );

  const probe = yield* processOutput(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height:format=duration",
      "-of",
      "json",
      "clip.mp4",
    ],
    directory,
  );

  const facts = yield* Schema.decodeEffect(
    Schema.fromJsonString(
      Schema.Struct({
        streams: Schema.Array(
          Schema.Struct({ codec_type: Schema.String, width: Schema.Int, height: Schema.Int }),
        ),
        format: Schema.Struct({ duration: Schema.FiniteFromString }),
      }),
    ),
  )(probe);

  const size = yield* fs.stat(`${directory}/clip.mp4`);

  if (
    facts.streams.length !== 1 ||
    facts.streams[0]?.codec_type !== "video" ||
    facts.streams[0].width !== options.viewport.width ||
    facts.streams[0].height !== options.viewport.height ||
    Math.abs(facts.format.duration * 1000 - options.durationMillis) > 80 ||
    ByteSize.toBigInt(size.size) > 128n * 1024n * 1024n
  )
    return yield* new ClipError({
      operation: "verify",
      message: "Clip duration, geometry, audio or bytes disagree with the requested interval.",
    });
  yield* processOutput(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-xerror",
      "-i",
      "clip.mp4",
      "-map",
      "0:v:0",
      "-f",
      "null",
      "-",
    ],
    directory,
  );
  yield* fs.writeFileString(
    `${directory}/clip.json`,
    JSON.stringify(
      {
        version: 1,
        durationMillis: options.durationMillis,
        startMillis: options.startMillis,
        viewport: options.viewport,
        cursorArtwork: "identical-ass-v1",
        samples: options.samples,
        verified: "duration, geometry, no audio and full frame decode",
        sourceVideo: resolve(options.inputVideo),
      },
      null,
      2,
    ),
    { flag: "wx" },
  );

  return {
    video: `${directory}/clip.mp4`,
    metadata: `${directory}/clip.json`,
    artwork: `${directory}/cursor.ass`,
  };
});
