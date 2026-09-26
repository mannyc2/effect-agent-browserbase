import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { Journal, grade, manifest } from "./evaluation/Evidence.ts";
import { replay } from "./evaluation/Replay.ts";
import { cancelledMutation } from "./evaluation/Tasks.ts";

// #93 explicitly requests evidence loss, compatible-action replay and cancelled-waiter proof.
// These boundaries cannot be protected by the existing browser-owner assertions alone.
it.effect("evaluation retains cancelled mutation and cleanup facts outside the agent waiter", () =>
  Effect.gen(function* () {
    const journal = new Journal(manifest("cancelled-mutation", "base", "unavailable"));

    yield* cancelledMutation(journal);
    const evidence = journal.snapshot();
    const report = grade(evidence);

    expect(report.task).toBe("inconclusive");
    expect(report.safeHandling).toBe("pass");
    expect(evidence.facts.dispatchCount).toBe(1);
    expect(evidence.facts.settlement).toBe("failed");
    expect(evidence.facts.lateOutcome).toBe("unavailable");
    expect(evidence.facts.cleanup).not.toBe("missing");
    expect(evidence.facts.applicationWrites).toBe(null);
  }),
);

it.effect("evaluation refuses replay when the schema or retained inputs are incomplete", () =>
  Effect.gen(function* () {
    const journal = new Journal(manifest("signup", "base", "unavailable"), {
      events: 1,
      bytes: 256,
    });

    journal.append({ kind: "request", turn: 0, value: { prompt: "x".repeat(512) } });
    const evidence = journal.snapshot();

    expect(grade(evidence).task).toBe("inconclusive");
    expect(evidence.loss.events).toBe(1);
    const result = yield* replay(evidence).pipe(Effect.result);

    expect(result).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ReplayDivergence", reason: "incomplete" },
    });
  }),
);
