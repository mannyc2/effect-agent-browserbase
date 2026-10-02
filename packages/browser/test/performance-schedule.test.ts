import { expect, it } from "@effect/vitest";
import { Effect, Result } from "effect";

import { keys, prepare } from "../src/internal/browser/Performance.ts";
import { DefaultMotionProfile } from "../src/PlanData.ts";

it.effect(
  "performed text schedules within its documented bounds and measures what exceeds them",
  () =>
    Effect.gen(function* () {
      // Every lowercase character slips: a wrong key, its Backspace and the key itself.
      const plan = yield* prepare(
        { motion: DefaultMotionProfile, slips: { probability: 1 } },
        7,
        "text",
      );

      const longest = keys(plan, "a".repeat(256));

      expect(Result.isSuccess(longest) ? longest.success.strokes.length : longest.failure).toBe(
        768,
      );

      const longer = keys(plan, "a".repeat(300));

      expect(Result.isFailure(longer) ? longer.failure.reason : longer.success).toEqual({
        _tag: "Limit",
        dimension: "code-points",
        maximum: 256,
        observed: 300,
      });
    }),
);
