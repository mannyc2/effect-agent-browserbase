/** Re-run current graders on recorded fixture evidence; this command has no browser or model. */
import { Console, Effect, FileSystem, Schema } from "effect";
import { Argument, Command } from "effect/cli";

import { BenchError } from "./Budget.ts";
import { tasks } from "./Catalog.ts";
import { Recording } from "./Recording.ts";

export const grade = (recording: Recording) =>
  Effect.gen(function* () {
    const task = tasks.find(
      (candidate) =>
        candidate.name === recording.task.name &&
        candidate.kind === recording.task.kind &&
        candidate.prompt === recording.task.prompt,
    );

    if (task === undefined)
      return yield* new BenchError({
        message: "recording does not match the current task; re-record the scenario",
      });

    return yield* task.regrade(recording.outcome.answer, recording.truth);
  });

export const command = Command.make(
  "regrade",
  { file: Argument.String("recording.json") },
  Effect.fnUntraced(function* ({ file }) {
    const fs = yield* FileSystem.FileSystem;

    const recording = yield* fs
      .readFileString(file)
      .pipe(Effect.flatMap(Schema.decodeUnknownEffect(Schema.fromJsonString(Recording))));

    const result = yield* grade(recording);

    yield* Console.log(JSON.stringify(result));
  }),
).pipe(
  Command.withDescription("Grade a recording again without opening a browser or calling a model."),
);
