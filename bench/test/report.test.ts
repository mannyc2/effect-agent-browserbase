// Results files and what `report` makes of them: a run's records read back as written, and the
// summary is the same whatever order its trials ended in.
import { NodeServices } from "@effect/platform-node";
import { assert, describe, it } from "@effect/vitest";
import { Arbitrary, Effect, FileSystem, Path, Result, Schema } from "effect";

import type { Arm } from "../Arms.ts";
import { emptyAccounting, noTiming } from "../Budget.ts";
import { pairs, summary } from "../Report.ts";
import * as Results from "../Results.ts";
import { noPhases } from "../Trace.ts";
import type { Reason, Status } from "../Trial.ts";

const record = (fields: {
  readonly task: string;
  readonly trial: number;
  readonly arm?: Arm | null;
  readonly status?: Status;
  readonly reason?: Reason;
  readonly pass?: boolean | null;
  readonly answer?: unknown;
}) =>
  new Results.TrialRecord({
    version: 1,
    task: fields.task,
    kind: "operate",
    arm: fields.arm ?? null,
    trial: fields.trial,
    baseSeed: 1,
    seed: 3704062687,
    startedAt: "2026-10-07T14:22:14.381Z",
    run: {
      revision: { commit: "d1c390abc31a214a54f6ca33bddf291b2e65e803", dirty: false },
      model: fields.arm === undefined || fields.arm === null ? null : "openai/gpt-6-luna",
      endpoint: null,
      browser: "chromium",
      latencyMillis: null,
      humanize: false,
      maxOutputTokens: 4096,
      maxUsd: 2,
      concurrency: 4,
      record: false,
      narrateSeconds: null,
    },
    reasoning: null,
    status: fields.status ?? "graded",
    reason: fields.reason ?? "answered",
    pass: fields.pass === undefined ? true : fields.pass,
    detail: "The shop issued CONF-48213; the answer reported CONF-48213.",
    error: null,
    diagnostic: null,
    lastResponse: null,
    answer: fields.answer ?? null,
    steps: 4,
    actions: 6,
    accounting: emptyAccounting,
    timing: noTiming,
    phases: noPhases,
    protocol: null,
    roundTripMillis: null,
    region: null,
    traceId: null,
    seconds: 1.5,
  });

// Two tasks, two arms and three trials, with every kind of status.
const run = ["checkout", "chart-trade"].flatMap((task) =>
  ([1, 5] as const).flatMap((arm) =>
    [1, 2, 3].map((trial) =>
      trial === 3 && arm === 1
        ? record({
            task,
            trial,
            arm,
            status: "infrastructure-failed",
            reason: "timed-out",
            pass: null,
          })
        : record({ task, trial, arm, pass: (trial + arm) % 2 === 0 }),
    ),
  ),
);

describe("results", () => {
  it.effect("read back exactly the records a run wrote, in order", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped(), "run.jsonl");

      const written = [
        record({ task: "checkout", trial: 1, answer: { order: "CONF-48213", items: [1, 2] } }),
        record({
          task: "quote-table",
          trial: 2,
          arm: 2,
          status: "unrun",
          reason: "interrupted",
          pass: null,
        }),
        record({ task: "chart-read", trial: 1, answer: "ü — 0.05%" }),
      ];

      for (const item of written) yield* Results.append(file, item);

      assert.deepStrictEqual(yield* Results.read(file), written);
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );

  it.effect("name the line that is not a record", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const file = (yield* Path.Path).join(yield* fs.makeTempDirectoryScoped(), "run.jsonl");

      yield* Results.append(file, record({ task: "checkout", trial: 1 }));
      yield* fs.writeFileString(file, '{"version":1,"task":"checkout"}\n', { flag: "a" });

      const read = yield* Effect.result(Results.read(file));

      assert.isTrue(Result.isFailure(read) && read.failure.message.includes("line 2"));
    }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
});

describe("summary", () => {
  it.prop(
    "is the same whatever order a run's trials end in",
    {
      keys: Arbitrary.array(Arbitrary.schema(Schema.Finite), {
        minLength: run.length,
        maxLength: run.length,
      }),
    },
    ({ keys }) => {
      const ended = run
        .map((item, index) => ({ item, key: keys[index] ?? 0 }))
        .toSorted((left, right) => left.key - right.key)
        .map(({ item }) => item);

      assert.deepStrictEqual(summary(ended), summary(run));
    },
  );
});

describe("pairs", () => {
  it("counts only pairs graded in both arms", () => {
    const counts = pairs(
      [
        record({ task: "a", trial: 1, arm: 1, pass: true }),
        record({ task: "a", trial: 1, arm: 5, pass: true }),
        record({ task: "a", trial: 2, arm: 1, pass: false }),
        record({ task: "a", trial: 2, arm: 5, pass: true }),
        record({ task: "b", trial: 1, arm: 1, pass: true }),
        record({ task: "b", trial: 1, arm: 5, pass: false }),
        record({ task: "b", trial: 2, arm: 1, pass: false }),
        record({ task: "b", trial: 2, arm: 5, pass: false }),
        record({ task: "c", trial: 1, arm: 1, pass: true }),
        record({ task: "c", trial: 1, arm: 5, status: "infrastructure-failed", pass: null }),
        record({ task: "c", trial: 2, arm: 1, status: "unrun", reason: "interrupted", pass: null }),
      ],
      5,
      1,
    );

    assert.deepStrictEqual(counts, { pairs: 4, both: 1, onlyFirst: 1, onlySecond: 1, neither: 1 });
  });
});
