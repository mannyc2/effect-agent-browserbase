import { join, resolve } from "node:path";

import { Effect, FileSystem, Schema } from "effect";

import { BenchError, load } from "./Records.ts";
import { encode, Frame } from "./Video.ts";

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
  frames: Schema.Array(Metadata).check(Schema.isMaxLength(36000)),
});

/** Render only the retained interval after its session has closed. Never reacquire a browser. */
export const film = Effect.fn("Bench.film")(function* (directory: string) {
  const record = yield* load(directory);
  const capture = yield* Schema.decodeUnknownEffect(Capture)(record.capture);
  const fs = yield* FileSystem.FileSystem;
  const frames = [];
  let totalBytes = 0;

  for (const frame of capture.frames) {
    const bytes = yield* fs.readFile(join(directory, frame.path));

    totalBytes += bytes.byteLength;
    if (totalBytes > record.manifest.capture.maxBytes)
      return yield* new BenchError({
        operation: "film",
        message: "Retained frames exceed their run's byte bound.",
      });
    const { path: _path, ...metadata } = frame;

    frames.push({ ...metadata, bytes });
  }

  return yield* encode({
    ...capture,
    frames,
    commentary: [],
    outputDirectory: resolve(directory, "film"),
    ...record.manifest.capture,
    label: `${record.manifest.scene} · ${record.manifest.backend} · retained capture`,
  });
});
