// A recorded scripted trial in a real local Chromium decodes as a Recording whose frames are on
// disk, whose events include the trial's input, and whose moment names the frames a model sees.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { assert, describe, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import * as Chromium from "effect-browser/Chromium";

import * as Recorder from "../Recorder.ts";
import { plain, Recording } from "../Recording.ts";
import { frameHistory, tasks } from "../Tasks.ts";

const record = Effect.fnUntraced(function* (name: string, humanize: boolean) {
  const task = tasks.find((candidate) => candidate.name === name);

  if (task === undefined) return yield* Effect.die(`the bench has no ${name} task`);
  const directory = mkdtempSync(join(tmpdir(), "bench-recording-"));

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => rmSync(directory, { recursive: true, force: true })),
  );
  const recorder = Recorder.make(directory);

  const outcome = yield* recorder
    .around(task.scripted({ seed: 23, trace: recorder.trace }))
    .pipe(Effect.provide(Chromium.layer({ humanize, frameHistory }), { local: true }));

  yield* recorder.finish({
    task: { name: task.name, kind: task.kind, summary: task.summary, prompt: task.prompt },
    run: {
      trial: 1,
      seed: 23,
      model: null,
      reasoning: null,
      browser: "chromium",
      humanize,
      commit: null,
      dirty: null,
    },
    outcome: {
      status: "graded",
      reason: "answered",
      pass: outcome.pass,
      detail: outcome.detail,
      answer: outcome.answer,
      calls: 0,
      knownUsd: 0,
      seconds: 0,
    },
  });

  const recording = yield* Schema.decodeUnknownEffect(Recording)(
    JSON.parse(readFileSync(join(directory, "recording.json"), "utf8")),
  );

  return {
    recording,
    directory,
    filesExist: recording.frames.every((frame) => existsSync(join(directory, frame.file))),
  };
});

describe("recorder", () => {
  it.live("records a humanized operate trial's frames, glides and keys", () =>
    Effect.gen(function* () {
      const { recording, filesExist } = yield* record("checkout", true);
      const tags = new Set(recording.events.map((record) => record.event._tag));

      assert.deepStrictEqual(recording.problems, []);
      assert.isTrue(recording.outcome.pass);
      assert.isAbove(recording.frames.length, 0);
      assert.isTrue(filesExist);
      assert.deepStrictEqual(
        recording.viewports.map((viewport) => viewport.page),
        [...new Set(recording.frames.map((frame) => frame.page))],
      );
      for (const tag of ["PageOpened", "TrackPlanned", "PointerPressed", "KeyChanged"] as const)
        assert.isTrue(tags.has(tag), `no ${tag} event`);
      assert.isTrue(
        recording.frames.every(
          (frame) => frame.hostTime >= recording.startedAt && frame.hostTime <= recording.endedAt,
        ),
      );
    }).pipe(Effect.scoped),
  );

  it.live("records the frames an understand task shows a model", () =>
    Effect.gen(function* () {
      const { recording, directory } = yield* record("chart-spike", false);
      const [moment] = recording.moments;

      assert.strictEqual(recording.moments.length, 1);
      assert.strictEqual(moment?.frames.length, 3);
      assert.isTrue(moment?.frames.every((frame) => existsSync(join(directory, frame.file))));
      assert.deepStrictEqual(moment?.expected, recording.outcome.answer);
    }).pipe(Effect.scoped),
  );
});

describe("plain", () => {
  it("keeps the length of bytes and cuts long text", () => {
    const value = plain({ image: new Uint8Array(5), text: "x".repeat(9000), count: 1n });

    assert.deepStrictEqual(value, {
      image: { bytes: 5 },
      text: `${"x".repeat(8000)}… [1000 more characters]`,
      count: "1",
    });
  });
});
