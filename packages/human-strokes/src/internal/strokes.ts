import { promisify } from "node:util";
import { brotliDecompress } from "node:zlib";

import { Effect, Result, Schema } from "effect";
import * as Motion from "effect-browser/Motion";

/** The fixed bundled recording could not be read or validated. */
export class DataError extends Schema.TaggedError<DataError>()("HumanStrokesDataError", {
  reason: Schema.Literals(["Read", "Compression", "Format"]),
  detail: Schema.String,
}) {}

export const rawBytes = 10_411_952;
export const strokeCount = 32_130;
export const pointCount = 2_604_684;
const ticks = 4096;
const decompress = promisify(brotliDecompress);

/** Inflate on the thread pool, bounded to the payload size, without blocking the event loop. */
export const inflate = (compressed: Uint8Array) =>
  Effect.tryPromise({
    try: () => decompress(compressed, { maxOutputLength: rawBytes }),
    catch: () =>
      new DataError({
        reason: "Compression",
        detail: "The bundled human-stroke asset could not be decompressed.",
      }),
  });

export interface Record {
  readonly offset: number;
  readonly length: number;
  readonly dx: number;
  readonly dy: number;
  readonly distance: number;
  readonly duration: number;
}

export interface Index {
  readonly bytes: Uint8Array;
  readonly records: ReadonlyArray<Record>;
  readonly first: Record;
  readonly points: number;
}

// The private binary codec keeps original fractional milliseconds. Rounding them to integer
// milliseconds would change 880,905 sample times, despite saving less than a megabyte on disk.
class Reader {
  offset: number;
  invalid = false;
  readonly bytes: Uint8Array;

  constructor(bytes: Uint8Array, offset = 0) {
    this.bytes = bytes;
    this.offset = offset;
  }

  unsigned(): number {
    let value = 0;
    let multiplier = 1;

    for (let byteIndex = 0; byteIndex < 5; byteIndex++) {
      const byte = this.bytes[this.offset++];

      if (byte === undefined) {
        this.invalid = true;

        return 0;
      }
      value += (byte & 127) * multiplier;
      if (byte < 128) {
        if (value > 0xffffffff || (byteIndex > 0 && byte === 0)) this.invalid = true;

        return value;
      }
      multiplier *= 128;
    }
    this.invalid = true;

    return 0;
  }

  signed(): number {
    const value = this.unsigned();

    return value % 2 === 0 ? value / 2 : -(value + 1) / 2;
  }
}

const bad = (detail: string) => Result.fail(new DataError({ reason: "Format", detail }));

/** Validate each bounded record once, retaining only offsets and selection metadata. */
export const index = (bytes: Uint8Array): Result.Result<Index, DataError> => {
  if (
    bytes.length !== rawBytes ||
    bytes[0] !== 66 ||
    bytes[1] !== 79 ||
    bytes[2] !== 85 ||
    bytes[3] !== 78 ||
    bytes[4] !== 1
  )
    return bad("The bundled stroke header or byte count is invalid.");

  const reader = new Reader(bytes, 5);

  if (reader.unsigned() !== ticks || reader.unsigned() !== strokeCount)
    return bad("The bundled stroke precision or record count is invalid.");
  const records: Array<Record> = [];
  let points = 0;

  for (let ordinal = 0; ordinal < strokeCount; ordinal++) {
    const intervals = reader.unsigned();
    const length = intervals + 1;

    if (reader.invalid || length < 4 || length > Motion.maximumSamples)
      return bad("A stroke exceeds the supported sample count.");
    points += length;
    if (points > pointCount) return bad("The bundled point count is invalid.");
    const offset = reader.offset;
    const times = new Float64Array(length);
    let whole = 0;

    for (let sample = 1; sample < length; sample++) {
      whole += reader.signed();
      times[sample] = whole;
    }
    let dx = 0;
    let dy = 0;

    for (let sample = 1; sample < length; sample++) dx += reader.signed();
    for (let sample = 1; sample < length; sample++) dy += reader.signed();
    let previous = 0;

    for (let sample = 1; sample < length; sample++) {
      const residual = reader.signed();
      const time = (times[sample] ?? 0) + residual / ticks;

      if (Math.abs(residual) > ticks / 2 || time < previous || time > Motion.maximumDurationMillis)
        return bad("A stroke has invalid or decreasing sample times.");
      previous = time;
    }
    const distance = Math.hypot(dx, dy);

    if (reader.invalid || distance < 30 || previous <= 0)
      return bad("A stroke has an invalid displacement or duration.");
    records.push({ offset, length, dx, dy, distance, duration: previous });
  }
  const first = records[0];

  if (
    reader.invalid ||
    reader.offset !== bytes.length ||
    points !== pointCount ||
    first === undefined
  )
    return bad("The bundled stroke payload has an invalid extent.");

  return Result.succeed({ bytes, records, first, points });
};

/** The index establishes these record boundaries; only the selected coordinates are expanded. */
export const decode = (data: Index, record: Record): ReadonlyArray<Motion.Sample> => {
  const reader = new Reader(data.bytes, record.offset);
  const times = new Float64Array(record.length);
  const xs = new Float64Array(record.length);
  const ys = new Float64Array(record.length);
  let value = 0;

  for (let sample = 1; sample < record.length; sample++) {
    value += reader.signed();
    times[sample] = value;
  }
  value = 0;
  for (let sample = 1; sample < record.length; sample++) {
    value += reader.signed();
    xs[sample] = value;
  }
  value = 0;
  for (let sample = 1; sample < record.length; sample++) {
    value += reader.signed();
    ys[sample] = value;
  }
  const samples: Array<Motion.Sample> = [{ x: 0, y: 0, afterMillis: 0 }];

  for (let sample = 1; sample < record.length; sample++)
    samples.push({
      x: xs[sample] ?? 0,
      y: ys[sample] ?? 0,
      afterMillis: (times[sample] ?? 0) + reader.signed() / ticks,
    });

  return samples;
};

/** Match the measured selection rule: random nearby distance, otherwise nearest absolute distance. */
export const select = (data: Index, distance: number, choice: number): Record => {
  const candidates: Array<Record> = [];
  let closest = data.first;

  for (const record of data.records) {
    if (Math.abs(Math.log(record.distance / distance)) < 0.15) candidates.push(record);

    const nearer =
      record.distance <= distance && closest.distance <= distance
        ? record.distance > closest.distance
        : record.distance >= distance && closest.distance >= distance
          ? record.distance < closest.distance
          : Math.abs(record.distance - distance) < Math.abs(closest.distance - distance);

    if (nearer) closest = record;
  }

  return candidates[Math.floor(choice * candidates.length)] ?? closest;
};

/** Rotate/scale the recorded geometry, optionally mirroring across its own movement axis. */
export const retarget = (
  data: Index,
  record: Record,
  from: Motion.Point,
  to: Motion.Point,
  mirror: boolean,
): ReadonlyArray<Motion.Sample> => {
  const source = decode(data, record);
  const sourceX = record.dx / record.distance;
  const sourceY = record.dy / record.distance;
  // Normalize before subtraction so large finite coordinates cannot overflow the displacement.
  const scale = Math.max(1, Math.abs(from.x), Math.abs(from.y), Math.abs(to.x), Math.abs(to.y));
  const startX = from.x / scale;
  const startY = from.y / scale;
  const deltaX = to.x / scale - startX;
  const deltaY = to.y / scale - startY;

  const coordinate = (value: number) =>
    Math.round(Math.max(-Number.MAX_VALUE, Math.min(Number.MAX_VALUE, value * scale)));

  return source.map((sample, ordinal) => {
    if (ordinal === 0) return { ...from, afterMillis: sample.afterMillis };
    if (ordinal === source.length - 1) return { ...to, afterMillis: sample.afterMillis };
    const along = (sample.x * sourceX + sample.y * sourceY) / record.distance;

    const lateral =
      ((-sample.x * sourceY + sample.y * sourceX) / record.distance) * (mirror ? -1 : 1);

    return {
      x: coordinate(startX + deltaX * along - deltaY * lateral),
      y: coordinate(startY + deltaY * along + deltaX * lateral),
      afterMillis: sample.afterMillis,
    };
  });
};
