import { Effect, Fiber, FileSystem, Path, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { FootageError } from "./FootageError.ts";
import type { Graphics } from "./Presentation.ts";

const stamp = (seconds: number) => {
  const ticks = Math.max(0, Math.round(seconds * 100));
  const hours = Math.floor(ticks / 360000);
  const minutes = Math.floor(ticks / 6000) % 60;
  const whole = Math.floor(ticks / 100) % 60;

  return `${hours}:${String(minutes).padStart(2, "0")}:${String(whole).padStart(2, "0")}.${String(ticks % 100).padStart(2, "0")}`;
};

/** ASS controls cannot be supplied through a caption; glyph replacement keeps text literal. */
const text = (value: string) =>
  value
    .replaceAll("\\", "＼")
    .replaceAll("{", "｛")
    .replaceAll("}", "｝")
    .replace(/[\r\n]/gu, " ");

const artwork = (graphics: Graphics, seconds: number) => {
  const { width, height } = graphics.viewport;

  const at = (nanos: bigint) =>
    Math.max(0, Math.min(seconds, Number(nanos - graphics.firstFrameNanos) / 1_000_000_000));

  const drawings = [...graphics.drawings].sort((left, right) =>
    left.atNanos < right.atNanos ? -1 : left.atNanos > right.atNanos ? 1 : 0,
  );

  const cursors = drawings.filter((drawing) => drawing.kind === "cursor");
  const captions = drawings.filter((drawing) => drawing.kind === "caption");
  const rows: Array<string> = [];

  const row = (start: number, end: number, content: string) => {
    if (end > start)
      rows.push(`Dialogue: 0,${stamp(start)},${stamp(end)},Artwork,,0,0,0,,${content}`);
  };

  for (const [index, drawing] of cursors.entries()) {
    if (!("point" in drawing)) continue;
    const point = drawing.point;
    const next = cursors[index + 1];

    row(
      at(drawing.atNanos),
      next === undefined ? seconds : at(next.atNanos),
      `{\\an7\\pos(${point.x.toFixed(2)},${point.y.toFixed(2)})\\p1\\bord1.5\\shad1}m 0 0 l 0 25 7 18 13 28 17 26 11 16 21 16 0 0`,
    );
  }
  for (const drawing of drawings) {
    if (drawing.kind !== "pulse") continue;
    const start = at(drawing.atNanos);

    row(
      start,
      Math.min(seconds, start + 0.35),
      `{\\an7\\pos(${(drawing.point.x - 15).toFixed(2)},${(drawing.point.y - 15).toFixed(2)})\\p1\\bord1\\shad0\\1c&H005AFF&\\fad(0,350)}m 15 0 b 35 0 35 30 15 30 b -5 30 -5 0 15 0`,
    );
  }
  for (const [index, drawing] of captions.entries()) {
    if (drawing.kind !== "caption" || drawing.text === "") continue;
    const next = captions[index + 1];

    row(
      at(drawing.atNanos),
      next === undefined ? seconds : at(next.atNanos),
      `{\\an2\\pos(${Math.round(width / 2)},${height - 36})\\bord2\\shad1}${text(drawing.text)}`,
    );
  }
  const ass = `[Script Info]\nScriptType: v4.00+\nPlayResX: ${width}\nPlayResY: ${height}\n\n[V4+ Styles]\nFormat: Name,Fontname,Fontsize,PrimaryColour,SecondaryColour,OutlineColour,BackColour,Bold,Italic,Underline,StrikeOut,ScaleX,ScaleY,Spacing,Angle,BorderStyle,Outline,Shadow,Alignment,MarginL,MarginR,MarginV,Encoding\nStyle: Artwork,DejaVu Sans,26,&H00FFFFFF,&H00FFFFFF,&H00111111,&H80000000,0,0,0,0,100,100,0,0,1,2,1,2,20,20,20,1\n\n[Events]\nFormat: Layer,Start,End,Style,Name,MarginL,MarginR,MarginV,Effect,Text\n${rows.join("\n")}\n`;

  if (new TextEncoder().encode(ass).byteLength > 8 * 1024 * 1024)
    throw FootageError.make({ reason: "presentation-limit", detail: "8MiB artwork" });

  return ass;
};

/** The existing encoder boundary owns graphics; the website receives no presentation DOM. */
export const compose = Effect.fnUntraced(
  function* (
    rawPath: string,
    outputPath: string,
    graphics: Graphics,
    seconds: number,
    constantRateFactor: number,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const paths = yield* Path.Path;
    const directory = yield* fs.makeTempDirectoryScoped({ prefix: "browser-footage-artwork-" });

    const ass = yield* Effect.try({
      try: () => artwork(graphics, seconds),
      catch: (cause) => FootageError.make({ reason: "presentation-limit", cause }),
    });

    yield* fs.writeFileString(`${directory}/artwork.ass`, ass);

    const encoder = yield* spawner.spawn(
      ChildProcess.make(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-y",
          "-i",
          paths.resolve(rawPath),
          "-vf",
          "ass=artwork.ass",
          "-c:v",
          "libx264",
          "-preset",
          "veryfast",
          "-crf",
          String(constantRateFactor),
          "-pix_fmt",
          "yuv420p",
          "-movflags",
          "+faststart",
          paths.resolve(outputPath),
        ],
        { cwd: directory, forceKillAfter: "5 seconds" },
      ),
    );

    const complaints = yield* encoder.stderr.pipe(
      Stream.decodeText(),
      Stream.runFold(
        () => "",
        (tail, chunk) => (tail + chunk).slice(-2000),
      ),
      Effect.forkScoped,
    );

    const code = yield* encoder.exitCode;

    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* FootageError.make({
        reason: "encoder",
        detail: `artwork encoder exited ${String(code)} ${(yield* Fiber.join(complaints)).slice(-2000)}`,
      });
  },
  Effect.timeoutOrElse({
    duration: "2 minutes",
    orElse: () =>
      Effect.fail(FootageError.make({ reason: "encoder", detail: "composition deadline" })),
  }),
  Effect.mapError((cause) =>
    cause instanceof FootageError
      ? cause
      : FootageError.make({ reason: "encoder", detail: "artwork composition", cause }),
  ),
);
