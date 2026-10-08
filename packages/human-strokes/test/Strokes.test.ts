import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { brotliCompressSync, brotliDecompressSync } from "node:zlib";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Random, Result, Schema } from "effect";
import * as Motion from "effect-browser/Motion";

import * as HumanStrokes from "../src/index.ts";
import * as Strokes from "../src/internal/strokes.ts";

const compressed = readFileSync(new URL("../data/strokes.bin.br", import.meta.url));
const bytes = brotliDecompressSync(compressed);
const indexed = Strokes.index(bytes);

assert.ok(Result.isSuccess(indexed));
const data = indexed.success;

describe("bundled human strokes", () => {
  it("has the complete known payload and bounded structural metadata", () => {
    assert.strictEqual(compressed.length, 3_152_464);
    assert.strictEqual(
      createHash("sha256").update(compressed).digest("hex"),
      "323b68bdb39413a61d266dc9ade9bc105c98e288eb3347ac6716ba51eadedc15",
    );
    assert.strictEqual(bytes.length, 10_411_952);
    assert.strictEqual(
      createHash("sha256").update(bytes).digest("hex"),
      "bf5d5a126363acba787256fe35b225c1f2231ef55ed0802f6765b4d87a16b7c2",
    );
    assert.strictEqual(data.records.length, 32_130);
    assert.strictEqual(data.points, 2_604_684);
    assert.strictEqual(
      data.records.reduce((sum, record) => sum + record.length, 0),
      data.points,
    );
    assert.strictEqual(Math.max(...data.records.map((record) => record.length)), 1604);
    assert.strictEqual(
      Math.max(...data.records.map((record) => record.duration)),
      4997.999755859375,
    );
    assert.isTrue(
      data.records.every(
        (record) =>
          record.length <= Motion.maximumSamples &&
          record.duration <= Motion.maximumDurationMillis &&
          record.distance >= 30,
      ),
    );
  });

  it("decodes a real fractional-time stroke exactly and retains equal-time samples", () => {
    const record = data.records[18_479];

    assert.ok(record !== undefined);
    assert.deepStrictEqual(Strokes.decode(data, record), [
      { afterMillis: 0, x: 0, y: 0 },
      { afterMillis: 30.000244140625, x: 27, y: 3 },
      { afterMillis: 66.000244140625, x: 90, y: 7 },
      { afterMillis: 100, x: 135, y: 9 },
      { afterMillis: 140, x: 156, y: 12 },
    ]);
    const first = Strokes.decode(data, data.first);

    assert.strictEqual(first.length, 327);
    assert.isTrue(
      first.some(
        (sample, index) => index > 0 && sample.afterMillis === first[index - 1]?.afterMillis,
      ),
    );
    assert.isTrue(first.every((sample) => Number.isInteger(sample.afterMillis * 4096)));
  });

  it("rejects malformed extents, headers, precision and record bounds with DataError", () => {
    const header = Uint8Array.from(bytes);

    header[4] = 2;
    const precision = Uint8Array.from(bytes);

    precision[5] = 1;
    const count = Uint8Array.from(bytes);

    count[7] = 0;
    const record = Uint8Array.from(bytes);

    record.fill(255, 10, 15);
    for (const invalid of [bytes.subarray(1), header, precision, count, record]) {
      const result = Strokes.index(invalid);

      assert.ok(Result.isFailure(result));
      assert.isTrue(Schema.is(HumanStrokes.DataError)(result.failure));
      assert.strictEqual(result.failure.reason, "Format");
    }
  });

  it("uses the measured distance selection rule, including nearest strokes outside the range", () => {
    const candidates = data.records.filter(
      (record) => Math.abs(Math.log(record.distance / 200)) < 0.15,
    );

    assert.strictEqual(Strokes.select(data, 200, 0), candidates[0]);
    assert.strictEqual(
      Strokes.select(data, 200, 0.5),
      candidates[Math.floor(candidates.length / 2)],
    );
    assert.strictEqual(Strokes.select(data, 200, 0.999999), candidates.at(-1));
    assert.strictEqual(
      Strokes.select(data, 2, 0.2).distance,
      Math.min(...data.records.map((record) => record.distance)),
    );
    assert.strictEqual(
      Strokes.select(data, Number.MAX_VALUE, 0.8).distance,
      Math.max(...data.records.map((record) => record.distance)),
    );
  });

  it("rotates and mirrors real geometry without changing sampled times or endpoints", () => {
    const record = data.records[18_479];

    assert.ok(record !== undefined);
    const source = Strokes.decode(data, record);
    const from = { x: 100, y: 200 };
    const to = { x: 88, y: 356 };
    const rotated = Strokes.retarget(data, record, from, to, false);
    const mirrored = Strokes.retarget(data, record, from, to, true);

    assert.deepStrictEqual(
      rotated,
      source.map((sample) => ({
        x: 100 - sample.y,
        y: 200 + sample.x,
        afterMillis: sample.afterMillis,
      })),
    );
    assert.deepStrictEqual(
      mirrored.map((sample) => sample.afterMillis),
      source.map((sample) => sample.afterMillis),
    );
    assert.deepStrictEqual(mirrored[0], { ...from, afterMillis: 0 });
    assert.deepStrictEqual(mirrored.at(-1), { ...to, afterMillis: 140 });
    assert.notDeepEqual(mirrored, rotated);
    assert.isTrue(mirrored.every((sample) => Schema.is(Motion.Sample)(sample)));

    const extreme = Strokes.retarget(
      data,
      record,
      { x: -Number.MAX_VALUE, y: Number.MAX_VALUE },
      { x: Number.MAX_VALUE, y: -Number.MAX_VALUE },
      true,
    );

    assert.isTrue(extreme.every((sample) => Schema.is(Motion.Sample)(sample)));
    assert.deepStrictEqual(extreme.at(-1), {
      x: Number.MAX_VALUE,
      y: -Number.MAX_VALUE,
      afterMillis: 140,
    });
  });

  it.effect("loads a ready seeded planner and keeps tiny moves immediate", () =>
    Effect.gen(function* () {
      const planner = yield* HumanStrokes.motion;
      const from = { x: 640, y: 360 };
      const to = { x: 796, y: 372 };
      const first = yield* planner.plan(from, to).pipe(Random.withSeed("retarget-seed"));
      const second = yield* planner.plan(from, to).pipe(Random.withSeed("retarget-seed"));

      assert.deepStrictEqual(first, second);
      assert.deepStrictEqual(first.at(-1), { ...to, afterMillis: first.at(-1)?.afterMillis });
      assert.isTrue(first.length > 1 && first.length <= Motion.maximumSamples);
      assert.isTrue(
        first.every(
          (sample, index) =>
            Schema.is(Motion.Sample)(sample) &&
            (index === 0 || sample.afterMillis >= (first[index - 1]?.afterMillis ?? 0)),
        ),
      );
      assert.deepStrictEqual(yield* planner.plan(from, { x: 641, y: 360 }), [
        { x: 641, y: 360, afterMillis: 0 },
      ]);
    }),
  );

  it.effect("fails with a typed DataError for a corrupt or oversized compressed asset", () =>
    Effect.gen(function* () {
      const oversized = brotliCompressSync(new Uint8Array(Strokes.rawBytes + 1));

      for (const asset of [compressed.subarray(0, 4096), Uint8Array.of(255, 255, 255), oversized]) {
        const failure = yield* Effect.flip(Strokes.inflate(asset));

        assert.isTrue(Schema.is(HumanStrokes.DataError)(failure));
        assert.strictEqual(failure.reason, "Compression");
      }
    }),
  );
});
