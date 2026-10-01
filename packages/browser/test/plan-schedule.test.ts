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

// Completes without the test clock advancing, so a run's timing is only its scheduling.
const visit = {
  version: 1,
  steps: [{ id: "visit", action: { _tag: "Navigate", url: `${origin}/` } }],
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

it.effect("a future start begins at its boundary and reports its timing", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      const startAt = (yield* browser.monotonicTimeNanos) + 5_000_000_000n;
      const operation = yield* page.start(visit, { startAt, within: "30 seconds" });

      yield* TestClock.adjust("4900 millis");
      expect((yield* operation.attempts).attempts).toEqual([]);
      yield* TestClock.adjust("100 millis");
      const ran = yield* operation.completed;

      expect(ran.timing.intendedMonotonicNanos).toBe(startAt);
      expect(ran.timing.startedMonotonicNanos).not.toBeNull();
      if (ran.timing.startedMonotonicNanos === null) return;
      expect(ran.timing.startedMonotonicNanos).toBeGreaterThanOrEqual(startAt);
      expect(ran.timing.latenessNanos).toBe(ran.timing.startedMonotonicNanos - startAt);
    }),
  ),
);

it.effect("a late start inside its budget runs and reports how late it began", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      const startAt = (yield* browser.monotonicTimeNanos) - 500_000_000n;
      const ran = yield* page.run(visit, { startAt, within: "5 seconds" });

      expect(ran.steps).toHaveLength(1);
      expect(ran.timing.latenessNanos).toBe(500_000_000n);
    }),
  ),
);

it.effect("a start already past its budget is missed before any attempt or input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      const before = (yield* browser.control.calls).length;
      const startAt = (yield* browser.monotonicTimeNanos) - 2_000_000_000n;
      const failure = yield* page.run(visit, { startAt, within: "1 second" }).pipe(Effect.flip);

      expect(failure).toMatchObject({
        stage: "PreparationFailed",
        completed: [],
        error: { reason: { _tag: "ScheduleMissed" }, outcome: "undispatched" },
      });
      expect(failure.attempt).toBeUndefined();
      expect((yield* browser.control.calls).slice(before)).toEqual([]);
    }),
  ),
);

it.live("a scheduled start never begins before its instant on the owner's real clock", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* Testing.open(script);
      const page = browser.initialPage;

      yield* page.navigate({ url: `${origin}/` });
      // Fractional-millisecond offsets are where a millisecond timer can wake early.
      for (let attempt = 0; attempt < 20; attempt++) {
        const startAt = (yield* browser.monotonicTimeNanos) + 3_000_000n + BigInt(attempt * 37_123);
        const ran = yield* page.run(visit, { startAt, within: "10 seconds" });

        expect(ran.timing.startedMonotonicNanos).not.toBeNull();
        if (ran.timing.startedMonotonicNanos === null) return;
        expect(ran.timing.startedMonotonicNanos).toBeGreaterThanOrEqual(startAt);
        expect(ran.timing.latenessNanos).toBe(ran.timing.startedMonotonicNanos - startAt);
      }
    }),
  ),
);
