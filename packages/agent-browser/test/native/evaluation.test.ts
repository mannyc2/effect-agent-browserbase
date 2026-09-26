import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Journal, grade, manifest, save } from "../evaluation/Evidence.ts";
import { replay } from "../evaluation/Replay.ts";
import { signup } from "../evaluation/Tasks.ts";

// #93's independent oracle must detect an agent claiming success without committing a form.
it.live(
  "evaluation captures a real agent form, independently grades it and replays compatible calls",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const journal = new Journal(
          manifest("signup", "base", process.env.EVALUATION_SOURCE_REVISION ?? "unavailable"),
        );

        yield* Effect.addFinalizer(() =>
          save(
            journal.snapshot(),
            `${process.env.EVALUATION_EVIDENCE_DIR ?? "results/evaluation"}/native-${process.pid}`,
          ).pipe(Effect.orDie),
        );
        yield* signup(journal);
        const evidence = journal.snapshot();
        const report = grade(evidence);

        expect(report.task).toBe("pass");
        expect(report.output).toBe("valid");
        expect(report.safeHandling).toBe("pass");
        expect(evidence.facts.applicationWrites).toBe(1);
        expect(evidence.facts.submission).toEqual({
          email: "ada@example.test",
          plan: "pro",
          terms: true,
        });
        expect(
          grade({ ...evidence, facts: { ...evidence.facts, applicationWrites: 0 } }).task,
        ).toBe("fail");
        expect(yield* replay(evidence)).toMatchObject({ output: { done: true } });
        expect(
          yield* replay(evidence, "https://different.example.test/").pipe(Effect.result),
        ).toMatchObject({
          _tag: "Failure",
          failure: { _tag: "ReplayDivergence", reason: "action" },
        });
      }),
    ),
);
