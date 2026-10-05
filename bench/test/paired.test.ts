import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";

import { manifest, options } from "../paired.ts";
import * as Pairing from "../Pairing.ts";

const closed = { live: false, hosted: false };

describe("paired experiment contract", () => {
  it.effect("free default manifest preserves primary and extension matrices", () =>
    Effect.gen(function* () {
      const configuration = yield* options([], closed);
      const value = manifest(configuration, "reviewed-commit", "fixed-time");
      const rows = value.pairs.flatMap((pair) => pair.order.map((arm) => ({ ...pair, arm })));

      assert.strictEqual(value.mode, "preview");
      assert.strictEqual(rows.length, 462);
      assert.strictEqual(
        rows.filter((row) => row.provider === "local" && row.stratum === "primary").length,
        210,
      );
      assert.strictEqual(
        rows.filter((row) => row.provider === "local" && row.stratum === "extension").length,
        120,
      );
      assert.strictEqual(
        rows.filter((row) => row.provider === "browserbase" && row.stratum === "primary").length,
        84,
      );
      assert.strictEqual(
        rows.filter((row) => row.provider === "browserbase" && row.stratum === "extension").length,
        48,
      );
      assert.isFalse(rows.some((row) => row.task === "quote-dense"));
      assert.deepStrictEqual(Pairing.pairs(configuration), value.pairs);
      for (const hosted of value.pairs.filter((pair) => pair.provider === "browserbase")) {
        const local = value.pairs.find(
          (pair) =>
            pair.provider === "local" && pair.task === hosted.task && pair.trial === hosted.trial,
        );

        assert.strictEqual(local?.seed, hosted.seed);
        assert.deepStrictEqual(
          hosted.order.toSorted((a, b) => a - b),
          [1, 2, 5, 6],
        );
      }
    }),
  );
  it.effect("requires each paid gate before consulting services or outputs", () =>
    Effect.gen(function* () {
      assert.strictEqual(
        (yield* options(["--model", "openai/test"], closed).pipe(Effect.flip)).code,
        "LiveRequired",
      );
      assert.strictEqual(
        (yield* options(["--model", "openai/test"], { live: true, hosted: false }).pipe(
          Effect.flip,
        )).code,
        "HostedRequired",
      );
      assert.strictEqual(
        (yield* options(["--model", "openai/test"], { live: true, hosted: true }).pipe(Effect.flip))
          .code,
        "Options",
      );
      yield* options(["--model", "openai/test", "--provider", "local"], {
        live: true,
        hosted: false,
      });
      yield* options(
        ["--model", "openai/test", "--hosted-concurrency", "2", "--browser-hourly-usd", "0.12"],
        { live: true, hosted: true },
      );
    }),
  );
  it.effect("rejects underfunded browser lifetimes and ambiguous subsets", () =>
    Effect.gen(function* () {
      const cases = [
        ["--scripted"],
        ["--arms", "1,1"],
        ["--arms", "7"],
        ["--provider", "browserbase", "--arms", "3,4"],
        ["--tasks", "quote-dense"],
        ["--local-trials", "0", "--hosted-trials", "0"],
        ["--model", "openai/test", "--hosted-concurrency", "2", "--browser-hourly-usd", "100"],
      ];

      for (const args of cases)
        yield* options(args, { live: true, hosted: true }).pipe(Effect.flip);
    }),
  );
  it.effect("records explicit subset and omits runtime service origins", () =>
    Effect.gen(function* () {
      const configuration = yield* options(
        [
          "--scripted",
          "--provider",
          "local",
          "--local-trials",
          "1",
          "--arms",
          "5",
          "--tasks",
          "chart-read",
          "--parse-origin",
          "http://127.0.0.1:9999",
        ],
        closed,
      );

      const value = manifest(configuration, "commit", "time");

      assert.strictEqual(value.pairs.length, 1);
      assert.deepStrictEqual(value.pairs[0]?.order, [5]);
      assert.strictEqual(value.mode, "scripted");
      assert.isFalse(JSON.stringify(value).includes("9999"));
    }),
  );
  it("keeps failed and unrun rows in denominators and incomplete pairs visible", () => {
    const base: Pairing.Observation = {
      provider: "local",
      stratum: "primary",
      kind: "operate",
      task: "checkout",
      trial: 1,
      seed: 1,
      arm: 1,
      status: "completed",
      pass: true,
      millis: 1000,
      knownUsd: 0.01,
      reservedUsd: 0,
    };

    const rows: ReadonlyArray<Pairing.Observation> = [
      base,
      { ...base, arm: 5, millis: 700 },
      { ...base, trial: 2, seed: 2, status: "failed", pass: null, millis: null, reservedUsd: 0.1 },
      {
        ...base,
        trial: 2,
        seed: 2,
        arm: 5,
        status: "unrun",
        pass: null,
        millis: null,
        knownUsd: 0,
      },
    ];

    const summary = Pairing.summarize(rows);

    assert.strictEqual(summary.arms[0]?.passPerPlanned, 0.5);
    assert.strictEqual(summary.arms[0]?.passPerGraded, 1);
    assert.strictEqual(summary.paired.length, 1);
    assert.strictEqual(summary.paired[0]?.complete, 1);
    assert.strictEqual(summary.paired[0]?.incomplete, 1);
    assert.strictEqual(summary.paired[0]?.medianTimeRatio, 0.7);
  });
});
