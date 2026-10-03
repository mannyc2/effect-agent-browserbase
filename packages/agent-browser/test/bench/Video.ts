import { join, resolve } from "node:path";

import { ByteSize, Effect, FileSystem, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

/** Bench artifacts only: neither pixels nor captions are sent back to the agent. */
export const Frame = Schema.Struct({
  bytes: Schema.Uint8Array.check(Schema.isMinLength(4), Schema.isMaxLength(4 * 1024 * 1024)),
  sourceTimeMillis: Schema.Finite.check(Schema.isGreaterThan(0)),
  receivedAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  sequence: Schema.optionalKey(Schema.Natural),
  document: Schema.optionalKey(Schema.Natural),
  sourceClock: Schema.optionalKey(Schema.Literal("presentation-unix-millis")),
  receivedMonotonicNanos: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\d+$/))),
  width: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))),
  height: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 8192 }))),
  viewportWidth: Schema.optionalKey(Schema.Natural),
  viewportHeight: Schema.optionalKey(Schema.Natural),
});

export type Frame = typeof Frame.Type;

export const Commentary = Schema.Struct({
  at: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  label: Schema.String.check(Schema.isMaxLength(256)),
  caption: Schema.String.check(Schema.isMaxLength(1024)),
});

export type Commentary = typeof Commentary.Type;

const Input = Schema.Struct({
  outputDirectory: Schema.NonEmptyString,
  frames: Schema.Array(Frame).check(Schema.isMinLength(1), Schema.isMaxLength(36000)),
  commentary: Schema.Array(Commentary).check(Schema.isMaxLength(64)),
  startedAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  endedAt: Schema.Finite.check(Schema.isGreaterThanOrEqualTo(0)),
  maxDurationMillis: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 900_000 })),
  maxFrames: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 36000 })),
  maxBytes: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 512 * 1024 * 1024 })),
  label: Schema.String.check(Schema.isMaxLength(256)),
});

export type Input = typeof Input.Type;

export class VideoError extends Schema.TaggedError<VideoError>()("BenchVideoError", {
  operation: Schema.String,
  message: Schema.String,
  cause: Schema.optionalKey(Schema.Defect()),
}) {}

export interface Artifacts {
  readonly raw: string;
  readonly commented: string;
  readonly subtitles: string;
  readonly timing: string;
  readonly durationMillis: number;
  readonly frames: number;
  readonly captions: number;
}

const refuse = (operation: string, message: string) => new VideoError({ operation, message });

/** Drain both pipes concurrently, with a byte cap and a scoped, force-killable child. */
const processResult = Effect.fnUntraced(
  function* (command: string, args: ReadonlyArray<string>, cwd: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

    const handle = yield* spawner
      .spawn(
        ChildProcess.make(command, args, {
          cwd,
          stdin: "ignore",
          stdout: "pipe",
          stderr: "pipe",
          extendEnv: true,
          forceKillAfter: "2 seconds",
        }),
      )
      .pipe(
        Effect.mapError(
          (cause) =>
            new VideoError({ operation: command, message: "Could not start encoder.", cause }),
        ),
      );

    const collect = (stream: typeof handle.stdout) => {
      let bytes = 0;

      return stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;

          return bytes <= 2 * 1024 * 1024
            ? Effect.succeed(chunk)
            : Effect.fail(refuse(command, "Encoder output exceeded its byte bound."));
        }),
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (text, chunk) => text + chunk,
        ),
        Effect.mapError((cause) =>
          cause instanceof VideoError
            ? cause
            : new VideoError({
                operation: command,
                message: "Could not read encoder output.",
                cause,
              }),
        ),
      );
    };

    const [stdout, stderr, code] = yield* Effect.all(
      [
        collect(handle.stdout),
        collect(handle.stderr),
        handle.exitCode.pipe(
          Effect.mapError(
            (cause) =>
              new VideoError({ operation: command, message: "Could not await encoder.", cause }),
          ),
        ),
      ],
      { concurrency: "unbounded" },
    );

    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* refuse(command, `Encoder exited ${code}: ${stderr.slice(0, 1024)}`);

    return stdout;
  },
  Effect.scoped,
  Effect.timeoutOrElse({
    duration: "90 seconds",
    orElse: () => Effect.fail(refuse("encoder", "Encoder exceeded its time bound.")),
  }),
);

const timestamp = (milliseconds: number, separator: "," | ".") => {
  const value = Math.max(0, Math.round(milliseconds));
  const hours = Math.floor(value / 3_600_000);
  const minutes = Math.floor((value % 3_600_000) / 60_000);
  const seconds = Math.floor((value % 60_000) / 1000);
  const fraction = value % 1000;

  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}${separator}${String(fraction).padStart(3, "0")}`;
};

/** Presentation wraps whitespace; original caption strings survive in SRT and timing.json. */
const wrap = (text: string, columns = 68) => {
  const words = text.replaceAll(/\s+/g, " ").trim().split(" ");
  const lines: string[] = [];
  let line = "";

  for (const word of words) {
    if (line.length + word.length + 1 > columns && line.length > 0) {
      lines.push(line);
      line = "";
    }
    let rest = word;

    while (rest.length > columns) {
      if (line.length > 0) lines.push(line);
      lines.push(rest.slice(0, columns));
      rest = rest.slice(columns);
      line = "";
    }
    line = line.length === 0 ? rest : `${line} ${rest}`;
  }
  if (line.length > 0) lines.push(line);

  return lines;
};

/** ASS braces and backslashes are executable styling, so render them as literal lookalikes. */
const assText = (text: string, columns: number) =>
  wrap(text, columns)
    .map((line) => line.replaceAll("\\", "＼").replaceAll("{", "｛").replaceAll("}", "｝"))
    .join("\\N");

const Probe = Schema.Struct({
  streams: Schema.Array(
    Schema.Struct({ codec_type: Schema.String, width: Schema.Natural, height: Schema.Natural }),
  ),
  format: Schema.Struct({ duration: Schema.FiniteFromString }),
});

/**
 * Encode the complete retained interval, including failure and still periods. Chromium source
 * timestamps set frame intervals. The first host receipt anchors captions to that timeline;
 * host end sets the last-image hold. This bridge cannot measure capture transport latency.
 * The caller retains native capture loss/stop facts separately and checksums this directory.
 */
export const encode = Effect.fn("BenchVideo.encode")(function* (
  input: Input,
): Effect.fn.Return<
  Artifacts,
  VideoError,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const data = yield* Schema.decodeEffect(Input)(input).pipe(
    Effect.mapError(
      (cause) =>
        new VideoError({ operation: "input", message: "Invalid video artifact input.", cause }),
    ),
  );

  const first = data.frames[0];
  const last = data.frames.at(-1);

  if (first === undefined || last === undefined)
    return yield* refuse("input", "At least one captured frame is required.");
  const totalBytes = data.frames.reduce((total, frame) => total + frame.bytes.byteLength, 0);

  const durationMillis = Math.max(
    last.sourceTimeMillis - first.sourceTimeMillis,
    data.endedAt - first.receivedAt,
  );

  if (
    data.frames.length > data.maxFrames ||
    totalBytes > data.maxBytes ||
    data.endedAt < data.startedAt ||
    first.receivedAt < data.startedAt ||
    last.receivedAt > data.endedAt ||
    durationMillis < 1 ||
    durationMillis > data.maxDurationMillis ||
    data.frames.some((frame, index) => {
      const previous = data.frames[index - 1];

      return (
        previous !== undefined &&
        (frame.sourceTimeMillis <= previous.sourceTimeMillis ||
          frame.receivedAt < previous.receivedAt)
      );
    }) ||
    data.commentary.some((entry, index) => {
      const previous = data.commentary[index - 1];

      return (
        entry.at < data.startedAt ||
        entry.at > data.endedAt ||
        (previous !== undefined && entry.at <= previous.at)
      );
    })
  )
    return yield* refuse("input", "Capture timing, order or total bounds were exceeded.");

  const directory = resolve(data.outputDirectory);
  const fs = yield* FileSystem.FileSystem;
  const file = (name: string) => join(directory, name);

  const write = (name: string, text: string) =>
    fs
      .writeFileString(file(name), text, { flag: "wx" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new VideoError({ operation: "write", message: `Could not write ${name}.`, cause }),
        ),
      );

  yield* fs.makeDirectory(directory).pipe(
    Effect.andThen(fs.makeDirectory(file("frames"))),
    Effect.mapError(
      (cause) =>
        new VideoError({ operation: "directory", message: "Video directory must be new.", cause }),
    ),
  );
  const manifest: string[] = ["ffconcat version 1.0"];
  const anchors = [];

  for (const [index, frame] of data.frames.entries()) {
    const name = `frames/frame-${String(index).padStart(6, "0")}.jpg`;
    const { bytes, ...metadata } = frame;
    const next = data.frames[index + 1];
    const offsetMillis = frame.sourceTimeMillis - first.sourceTimeMillis;

    const heldMillis =
      next === undefined
        ? durationMillis - offsetMillis
        : next.sourceTimeMillis - frame.sourceTimeMillis;

    yield* fs
      .writeFile(file(name), bytes, { flag: "wx" })
      .pipe(
        Effect.mapError(
          (cause) =>
            new VideoError({ operation: "frame", message: "Could not retain JPEG.", cause }),
        ),
      );
    anchors.push({
      ...metadata,
      path: name,
      byteLength: bytes.byteLength,
      offsetMillis,
      heldMillis,
    });
    manifest.push(`file '${name}'`, `duration ${(Math.max(1, heldMillis) / 1000).toFixed(6)}`);
  }
  manifest.push(`file 'frames/frame-${String(data.frames.length - 1).padStart(6, "0")}.jpg'`);

  const cues = data.commentary.map((entry, index) => ({
    ...entry,
    startMillis: Math.max(0, entry.at - first.receivedAt),
    endMillis: Math.min(
      durationMillis,
      (data.commentary[index + 1]?.at ?? data.endedAt) - first.receivedAt,
    ),
  }));

  if (cues.some((cue) => cue.startMillis >= cue.endMillis || cue.endMillis > durationMillis))
    return yield* refuse("captions", "A caption has no visible interval within the capture.");

  const srt = cues
    .map(
      (cue, index) =>
        `${index + 1}\n${timestamp(cue.startMillis, ",")} --> ${timestamp(cue.endMillis, ",")}\n[${cue.label}] ${cue.caption}\n`,
    )
    .join("\n");

  yield* write("frames.ffconcat", `${manifest.join("\n")}\n`);
  yield* write("captions.srt", srt);
  yield* write(
    "timing.json",
    JSON.stringify(
      {
        version: 1,
        label: data.label,
        startedAt: data.startedAt,
        endedAt: data.endedAt,
        durationMillis,
        sourceFirstMillis: first.sourceTimeMillis,
        firstReceivedAt: first.receivedAt,
        hostClock: "host-performance-milliseconds",
        sourceClock: "presentation-unix-millis",
        alignment:
          "first host receipt anchors source intervals; final image held through host run end",
        transportLatency: "unknown",
        audio: "none",
        selection: "all retained frames and all delivered captions",
        rendering:
          "source intervals presented at 25 FPS with repeated still images; this is not native capture FPS",
        sourceBytes: totalBytes,
        maxFrames: data.maxFrames,
        maxBytes: data.maxBytes,
        maxDurationMillis: data.maxDurationMillis,
        frames: anchors,
        commentary: cues,
      },
      null,
      2,
    ),
  );
  yield* processResult(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-n",
      "-f",
      "concat",
      "-safe",
      "0",
      "-i",
      "frames.ffconcat",
      "-an",
      "-vf",
      "fps=25",
      "-fps_mode",
      "cfr",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-t",
      (durationMillis / 1000).toFixed(6),
      "-fs",
      "67108864",
      "raw.mp4",
    ],
    directory,
  );

  const probe = yield* processResult(
    "ffprobe",
    [
      "-v",
      "error",
      "-show_entries",
      "stream=codec_type,width,height:format=duration",
      "-of",
      "json",
      "raw.mp4",
    ],
    directory,
  ).pipe(
    Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(Probe))(text)),
    Effect.mapError(
      (cause) =>
        new VideoError({ operation: "probe", message: "Could not verify raw video.", cause }),
    ),
  );

  const video = probe.streams[0];

  if (
    probe.streams.length !== 1 ||
    video === undefined ||
    video.codec_type !== "video" ||
    video.width > 1920 ||
    video.height > 1080 ||
    Math.abs(probe.format.duration * 1000 - durationMillis) > 160
  )
    return yield* refuse("probe", "Raw video geometry, audio or duration did not match capture.");

  const captionColumns = Math.max(1, Math.floor((video.width - 32) / 18));
  const titleColumns = Math.max(1, Math.floor((video.width - 32) / 14));
  const titleHeight = Math.max(2, wrap(data.label, titleColumns).length) * 18;
  const captionY = titleHeight + 62;

  const panelHeight =
    Math.ceil(
      Math.max(
        176,
        captionY + 30,
        ...cues.map(
          (cue) =>
            wrap(`[${cue.label}] ${cue.caption}`, captionColumns).length * 22 + captionY + 10,
        ),
      ) / 2,
    ) * 2;

  const height = video.height + panelHeight;

  const header = [
    "[Script Info]",
    "ScriptType: v4.00+",
    `PlayResX: ${video.width}`,
    `PlayResY: ${height}`,
    "WrapStyle: 2",
    "[V4+ Styles]",
    "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
    "Style: Caption,DejaVu Sans,18,&H00FFFFFF,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,16,16,12,1",
    "Style: Title,DejaVu Sans,14,&H00A8B4C8,&H00FFFFFF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,0,0,7,16,16,12,1",
    "[Events]",
    "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
  ];

  const assTime = (millis: number) => timestamp(millis, ".").slice(1, -1);

  const dialogue = (start: number, end: number, style: string, y: number, text: string) =>
    `Dialogue: 0,${assTime(start)},${assTime(end)},${style},,0,0,0,,{\\pos(16,${y})}${assText(text, style === "Title" ? titleColumns : captionColumns)}`;

  const titles = [
    dialogue(0, durationMillis, "Title", video.height + 12, data.label),
    dialogue(
      0,
      durationMillis,
      "Title",
      video.height + titleHeight + 16,
      "Model text commentary · no audio",
    ),
    ...cues.map((cue) =>
      dialogue(
        cue.startMillis,
        cue.endMillis,
        "Caption",
        video.height + captionY,
        `[${cue.label}] ${cue.caption}`,
      ),
    ),
  ];

  yield* write("captions.ass", `${[...header, ...titles].join("\n")}\n`);
  yield* processResult(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-n",
      "-i",
      "raw.mp4",
      "-an",
      "-vf",
      `fps=25,pad=iw:${height}:0:0:color=0x101722,ass=captions.ass,drawtext=font='DejaVu Sans':fontsize=12:fontcolor=white:x=16:y=${video.height + titleHeight + 36}:text='Host receipt timing - elapsed %{pts\\:hms}'`,
      "-fps_mode",
      "cfr",
      "-c:v",
      "libx264",
      "-preset",
      "veryfast",
      "-pix_fmt",
      "yuv420p",
      "-fs",
      "67108864",
      "commentary.mp4",
    ],
    directory,
  );
  for (const name of ["raw.mp4", "commentary.mp4"]) {
    const size = yield* fs.stat(file(name)).pipe(
      Effect.mapError(
        (cause) =>
          new VideoError({
            operation: "stat",
            message: "Could not verify encoded bytes.",
            cause,
          }),
      ),
    );

    if (ByteSize.toBigInt(size.size) > 64n * 1024n * 1024n)
      return yield* refuse("bytes", "Encoded artifact exceeded its byte bound.");

    const verification = yield* processResult(
      "ffprobe",
      [
        "-v",
        "error",
        "-show_entries",
        "stream=codec_type,width,height:format=duration",
        "-of",
        "json",
        name,
      ],
      directory,
    ).pipe(
      Effect.flatMap((text) => Schema.decodeEffect(Schema.fromJsonString(Probe))(text)),
      Effect.mapError(
        (cause) =>
          new VideoError({
            operation: "verify",
            message: "Could not verify video timeline.",
            cause,
          }),
      ),
    );

    if (
      verification.streams.length !== 1 ||
      verification.streams[0]?.codec_type !== "video" ||
      Math.abs(verification.format.duration * 1000 - durationMillis) > 160
    )
      return yield* refuse(
        "verify",
        "Encoded timeline or audio did not match the retained interval.",
      );
    yield* processResult(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "error",
        "-nostdin",
        "-xerror",
        "-i",
        name,
        "-map",
        "0:v:0",
        "-f",
        "null",
        "-",
      ],
      directory,
    );
  }
  yield* write(
    "encoding.json",
    JSON.stringify(
      {
        version: 1,
        durationMillis,
        verified: "raw and commented copies probed and every frame decoded",
        audio: "none",
        width: video.width,
        imageHeight: video.height,
        panelHeight,
      },
      null,
      2,
    ),
  );

  return {
    raw: file("raw.mp4"),
    commented: file("commentary.mp4"),
    subtitles: file("captions.srt"),
    timing: file("timing.json"),
    durationMillis,
    frames: data.frames.length,
    captions: cues.length,
  };
});
