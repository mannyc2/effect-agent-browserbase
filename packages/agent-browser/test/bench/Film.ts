import { join, resolve } from "node:path";

import { Effect, FileSystem, Schema } from "effect";

import { BenchError, load, type Event } from "./Records.ts";
import { encode, Frame, type Commentary } from "./Video.ts";

const Published = Schema.Struct({
  output: Schema.Struct({ caption: Schema.String.check(Schema.isMaxLength(1024)) }),
});

const Segment = Schema.Struct({
  caption: Schema.Struct({ atMillis: Schema.Finite, kind: Schema.String, ...Published.fields }),
});

/** Use publication times; captions do not reach backward to their narrated result. */
export const commentary = (events: ReadonlyArray<Event>): ReadonlyArray<Commentary> =>
  events.flatMap((event) => {
    if (event.kind !== "host") return [];
    const segment = Schema.decodeUnknownExit(Segment)(event.value);

    if (segment._tag === "Success")
      return [
        {
          at: segment.value.caption.atMillis,
          label: segment.value.caption.kind,
          caption: segment.value.caption.output.caption,
        },
      ];
    const sample = Schema.decodeUnknownExit(Published)(event.value);

    return sample._tag === "Success"
      ? [{ at: event.at, label: "narration", caption: sample.value.output.caption }]
      : [];
  });

const Metadata = Schema.Struct({
  path: Schema.String.check(Schema.isPattern(/^frames\/frame-\d{6}\.jpg$/)),
  sourceTimeMillis: Frame.fields.sourceTimeMillis,
  receivedAt: Frame.fields.receivedAt,
  receivedMonotonicNanos: Frame.fields.receivedMonotonicNanos,
  sequence: Frame.fields.sequence,
  document: Frame.fields.document,
  sourceClock: Frame.fields.sourceClock,
  width: Frame.fields.width,
  height: Frame.fields.height,
  viewportWidth: Frame.fields.viewportWidth,
  viewportHeight: Frame.fields.viewportHeight,
});

const Capture = Schema.Struct({
  startedAt: Schema.Finite,
  endedAt: Schema.Finite,
  captureEndedAt: Schema.optionalKey(Schema.Finite),
  measurementEndedAt: Schema.optionalKey(Schema.Finite),
  limitReached: Schema.optionalKey(Schema.NullOr(Schema.Literals(["frames", "bytes"]))),
  frames: Schema.Array(Metadata).check(Schema.isMaxLength(54000)),
});

export const retainedEnd = (capture: {
  readonly startedAt: number;
  readonly endedAt: number;
  readonly captureEndedAt?: number;
  readonly measurementEndedAt?: number;
  readonly limitReached?: "frames" | "bytes" | null;
  readonly frames: ReadonlyArray<{ readonly receivedAt: number }>;
}) =>
  Math.max(
    capture.startedAt,
    Math.min(
      capture.endedAt,
      capture.measurementEndedAt ?? capture.endedAt,
      capture.limitReached === "frames" || capture.limitReached === "bytes"
        ? (capture.frames.at(-1)?.receivedAt ?? capture.startedAt)
        : (capture.captureEndedAt ?? capture.endedAt),
    ),
  );

/** Render only the retained interval after its session has closed. Never reacquire a browser. */
export const film = Effect.fn("Bench.film")(function* (directory: string) {
  const record = yield* load(directory);
  const capture = yield* Schema.decodeUnknownEffect(Capture)(record.capture);
  const fs = yield* FileSystem.FileSystem;
  const frames = [];
  let totalBytes = 0;
  const endedAt = retainedEnd(capture);

  for (const frame of capture.frames) {
    const bytes = yield* fs.readFile(join(directory, frame.path));

    totalBytes += bytes.byteLength;
    if (totalBytes > record.manifest.capture.maxBytes)
      return yield* new BenchError({
        operation: "film",
        message: "Retained frames exceed their run's byte bound.",
      });
    const { path: _path, ...metadata } = frame;

    if (frame.receivedAt >= capture.startedAt && frame.receivedAt <= endedAt)
      frames.push({ ...metadata, bytes });
  }

  return yield* encode({
    ...capture,
    endedAt,
    frames,
    commentary: commentary(record.events).filter(
      (entry) => entry.at >= capture.startedAt && entry.at < endedAt && entry.caption.length > 0,
    ),
    outputDirectory: resolve(directory, "film"),
    ...record.manifest.capture,
    label: `${record.manifest.scene} · ${record.manifest.backend} · retained capture`,
  });
});
