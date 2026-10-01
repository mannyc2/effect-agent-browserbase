import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { TestClock } from "effect/testing";

import type { StepFailed } from "../src/Plan.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://plans.test";

const script: Testing.Script = {
  documents: [{ url: `${origin}/`, title: "Plans", text: "Scheduled work." }],
};

const pause = {
  version: 1,
  steps: [{ id: "pause", action: { _tag: "Wait", mode: { _tag: "Duration", milliseconds: 10 } } }],
} as const;

it.effect("a run waiting for its start ends with its session and holds back no terminal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      const startAt = (yield* browser.monotonicTimeNanos) + 60_000_000_000n;
      const before = (yield* browser.control.calls).length;
      const operation = yield* page.start(pause, { startAt, within: "120 seconds" });

      yield* browser.closeChecked;
      // The session's journal ends with it; a scheduled run retains no publication meanwhile.
      expect((yield* browser.timeline.snapshot()).terminal).toMatchObject({ reason: "closed" });

      // Far short of the requested start: the run must already have ended without input.
      yield* TestClock.adjust("1 second");
      const failure: StepFailed = yield* operation.completed.pipe(Effect.flip);

      expect(failure).toMatchObject({
        stage: "PreparationFailed",
        completed: [],
        error: { outcome: "undispatched" },
      });
      expect((yield* operation.attempts).attempts).toEqual([]);
      expect((yield* browser.control.calls).slice(before)).toEqual([]);
    }),
  ),
);
