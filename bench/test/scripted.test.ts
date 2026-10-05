// Every task's scripted solution passes its own grading in a local Chromium: the pages, the grading
// and the library can do each task without a model.
import { assert, describe, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Chromium from "effect-browser/Chromium";

import { tasks } from "../Tasks.ts";

describe("scripted solutions", () => {
  for (const task of tasks) {
    it.live(task.name, () =>
      task.scripted.pipe(
        Effect.provide(Chromium.layer()),
        Effect.map((outcome) => assert.isTrue(outcome.pass, outcome.detail)),
      ),
    );
  }
});
