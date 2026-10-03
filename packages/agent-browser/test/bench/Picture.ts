import { Effect, Schema, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { BenchError, type RecordingFrame } from "./Records.ts";

export interface Interval {
  readonly start: number;
  readonly end: number;
}

/** Native capture can end before the scene; the unobserved tail is not a page freeze. */
export const measurement = (program: Interval, cutoff = program.end) => {
  const window = {
    start: program.start,
    end: Math.max(program.start, Math.min(program.end, cutoff)),
  };

  return {
    window,
    status:
      window.end < program.end
        ? window.end === window.start
          ? "unmeasured"
          : "partial"
        : "complete",
    programDurationMillis: program.end - program.start,
    measuredDurationMillis: window.end - window.start,
    unmeasuredMillis: program.end - window.end,
  };
};

export const quantiles = (values: ReadonlyArray<number>) => {
  const sorted = [...values].sort((a, b) => a - b);
  const rank = (p: number) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)] ?? 0;

  return { p50: rank(0.5), p95: rank(0.95), max: rank(1) };
};

const within = (frames: ReadonlyArray<RecordingFrame>, window: Interval) =>
  frames.filter((frame) => frame.receivedAt >= window.start && frame.receivedAt <= window.end);

/** Change-driven capture cadence is a delivery metric, not the document's rendering rate. */
export const cadence = (frames: ReadonlyArray<RecordingFrame>, window: Interval) => {
  const selected = within(frames, window);

  const gaps = selected
    .slice(1)
    .map(
      (frame, index) =>
        Number(
          BigInt(frame.receivedMonotonicNanos) -
            BigInt(selected[index]?.receivedMonotonicNanos ?? frame.receivedMonotonicNanos),
        ) / 1e6,
    );

  const durationMillis = Math.max(0, window.end - window.start);

  return {
    frames: selected.length,
    durationMillis,
    fps: durationMillis === 0 ? 0 : (selected.length * 1000) / durationMillis,
    gapMillis: quantiles(gaps),
    gapsOver250Millis: gaps.filter((gap) => gap > 250).length,
    gapsOver1000Millis: gaps.filter((gap) => gap > 1000).length,
    firstDeliveryMillis: selected[0] === undefined ? null : selected[0].receivedAt - window.start,
    tailWithoutDeliveryMillis: window.end - (selected.at(-1)?.receivedAt ?? window.start),
  };
};

/** Include initial and trailing silence; only caller-proven changing intervals count. */
export const freezes = (
  frames: ReadonlyArray<RecordingFrame>,
  changing: ReadonlyArray<Interval>,
  window: Interval,
  thresholdMillis = 250,
) => {
  const points = [
    window.start,
    ...within(frames, window).map((frame) => frame.receivedAt),
    window.end,
  ];

  const intervals: Interval[] = [];

  for (let index = 1; index < points.length; index++) {
    const start = points[index - 1] ?? window.start;
    const end = points[index] ?? start;

    for (const expected of changing) {
      const overlap = { start: Math.max(start, expected.start), end: Math.min(end, expected.end) };

      if (overlap.end - overlap.start > thresholdMillis) intervals.push(overlap);
    }
  }

  return {
    intervals,
    count: intervals.length,
    seconds: intervals.reduce(
      (total, interval) => total + (interval.end - interval.start) / 1000,
      0,
    ),
    longestMillis: Math.max(0, ...intervals.map((interval) => interval.end - interval.start)),
  };
};

export const Boundary = Schema.Struct({
  document: Schema.Natural,
  sameDocument: Schema.Boolean,
  observedMonotonicNanos: Schema.String.check(Schema.isPattern(/^\d+$/)),
});

/** Receipt attribution after navigation commit does not prove that these are the new pixels. */
export const firstFrame = (
  frames: ReadonlyArray<RecordingFrame>,
  boundaries: ReadonlyArray<typeof Boundary.Type>,
) =>
  boundaries
    .filter((boundary) => !boundary.sameDocument)
    .map((boundary) => {
      const first = frames.find(
        (frame) =>
          frame.document === boundary.document &&
          BigInt(frame.receivedMonotonicNanos) >= BigInt(boundary.observedMonotonicNanos),
      );

      return {
        document: boundary.document,
        millis:
          first === undefined
            ? null
            : Number(
                BigInt(first.receivedMonotonicNanos) - BigInt(boundary.observedMonotonicNanos),
              ) / 1e6,
        basis: "navigation-commit-to-received-frame",
      };
    });

export interface ShownEvent {
  readonly at: number;
  readonly kind: string;
  readonly shown: boolean;
}

export const shownIntervals = (events: ReadonlyArray<ShownEvent>, window: Interval) => {
  const open = new Map<string, number>();
  const intervals: Array<Interval & { kind: string }> = [];

  for (const event of [...events].sort((a, b) => a.at - b.at)) {
    if (event.at > window.end) break;
    if (event.shown) {
      if (!open.has(event.kind)) open.set(event.kind, Math.max(window.start, event.at));
    } else {
      const start = open.get(event.kind);

      if (start !== undefined && event.at >= window.start)
        intervals.push({ kind: event.kind, start, end: event.at });
      open.delete(event.kind);
    }
  }
  for (const [kind, start] of open) intervals.push({ kind, start, end: window.end });

  return intervals;
};

/** Duration-weighted luma heuristic. The last delivered image remains on screen until the end. */
export const blank = (
  frames: ReadonlyArray<RecordingFrame>,
  spreads: ReadonlyArray<number>,
  window: Interval,
  threshold = 4,
) => {
  let millis = 0;
  let blankFrames = 0;

  for (let index = 0; index < frames.length; index++) {
    const frame = frames[index];
    const spread = spreads[index];

    if (frame === undefined || spread === undefined || spread >= threshold) continue;
    const start = Math.max(window.start, frame.receivedAt);
    const end = Math.min(window.end, frames[index + 1]?.receivedAt ?? window.end);

    if (end > start) {
      millis += end - start;
      blankFrames++;
    }
  }

  return {
    seconds: millis / 1000,
    frames: blankFrames,
    threshold,
    basis: "signalstats-luma-spread",
  };
};

/** One bounded ffmpeg process reads actual JPEG pixels; fixture truth is graded separately. */
export const lumaSpreads = Effect.fn("Bench.picture.luma")(
  function* (frames: ReadonlyArray<RecordingFrame>) {
    if (frames.length === 0) return [];
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
          "pipe:0",
          "-vf",
          "signalstats,metadata=print:file=-",
          "-f",
          "null",
          "-",
        ],
        {
          stdin: Stream.fromIterable(frames).pipe(Stream.map((frame) => frame.bytes)),
          stdout: "pipe",
          stderr: "pipe",
          forceKillAfter: "2 seconds",
        },
      ),
    );

    const collect = (stream: typeof handle.stdout) => {
      let bytes = 0;

      return stream.pipe(
        Stream.mapEffect((chunk) => {
          bytes += chunk.byteLength;

          return bytes <= 16 * 1024 * 1024
            ? Effect.succeed(chunk)
            : Effect.fail(
                new BenchError({
                  operation: "luma",
                  message: "Pixel metric output exceeded its bound.",
                }),
              );
        }),
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (all, chunk) => all + chunk,
        ),
      );
    };

    const [output, , code] = yield* Effect.all(
      [collect(handle.stdout), collect(handle.stderr), handle.exitCode],
      { concurrency: "unbounded" },
    );

    if (code !== ChildProcessSpawner.ExitCode(0))
      return yield* new BenchError({
        operation: "luma",
        message: "Could not decode captured frames.",
      });

    const minima = Array.from(
      output.matchAll(/lavfi\.signalstats\.YMIN=(\d+(?:\.\d+)?)/g),
      (match) => Number(match[1]),
    );

    const maxima = Array.from(
      output.matchAll(/lavfi\.signalstats\.YMAX=(\d+(?:\.\d+)?)/g),
      (match) => Number(match[1]),
    );

    if (minima.length !== frames.length || maxima.length !== frames.length)
      return yield* new BenchError({
        operation: "luma",
        message: "Pixel metric frame count disagrees with capture.",
      });

    return maxima.map((maximum, index) => maximum - (minima[index] ?? maximum));
  },
  Effect.scoped,
  Effect.timeout("60 seconds"),
);
