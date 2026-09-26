import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { cases, orderReference, plan, type Entry } from "./evaluation/Cases.ts";
import { type Evidence, Journal, manifest } from "./evaluation/Evidence.ts";
import { grade } from "./evaluation/Grading.ts";
import { replay } from "./evaluation/Replay.ts";
import { run } from "./evaluation/Tasks.ts";

const evaluate = (entry: Entry, bounds?: { events: number; bytes: number }) =>
  Effect.gen(function* () {
    const journal = new Journal(manifest(entry, "unavailable"), bounds);

    yield* run(journal);

    return journal.snapshot();
  });

const entry = (runId: string) => {
  const found = plan(1).find((candidate) => candidate.runId === runId);

  if (found === undefined) throw new Error(`No planned run ${runId}`);

  return found;
};

/** What the model was shown on its last turn, as retained. */
const lastRequest = (evidence: Evidence) =>
  JSON.stringify(evidence.events.findLast((event) => event.kind === "request")?.value);

// #93 asks for deterministic oracles that are calibrated before use: every scripted policy,
// known-bad ones included, must be graded exactly as its case declares.
for (const planned of plan(1).filter(
  (candidate) => cases[candidate.task].backend === "scripted-owner",
))
  it.effect(`evaluation grades ${planned.runId} as declared`, () =>
    Effect.gen(function* () {
      const report = grade(yield* evaluate(planned));

      expect(report.calibration).toEqual({ role: planned.role, agrees: true, mismatches: [] });
    }),
  );

it.effect("evaluation retains cancelled mutation and cleanup facts outside the agent waiter", () =>
  Effect.gen(function* () {
    const evidence = yield* evaluate(entry("cancelled-mutation-base-waiter-cancelled-0"));

    expect(evidence.facts.owner).toMatchObject({
      phase: "uncertain",
      unresolvedDispatch: true,
      dispatched: 1,
      settlement: "failed",
      hostRetry: "refused-undispatched",
    });
    expect(evidence.facts.applicationWrites).toBe(null);
    expect(evidence.facts.cleanup).toBe("confirmed");
    expect(evidence.facts.ownerClose).not.toBe("missing");
  }),
);

it.effect("evaluation requires a reference to be read from the page, not merely stated", () =>
  Effect.gen(function* () {
    const searched = yield* evaluate(entry("reading-base-searches-0"));
    const guessed = yield* evaluate(entry("reading-base-guesses-0"));

    expect(searched.facts.output).toEqual({ status: "done", answer: orderReference });
    expect(guessed.facts.output).toEqual(searched.facts.output);
    expect([grade(searched).task, grade(guessed).task]).toEqual(["pass", "fail"]);
  }),
);

it.effect("evaluation retains repeated checking and the final turn that exhausted it", () =>
  Effect.gen(function* () {
    const evidence = yield* evaluate(entry("reading-base-rechecks-0"));
    const report = grade(evidence);

    expect(report.repeatedCalls).toBeGreaterThan(0);
    expect(report.termination).toBe("agent-failure");
    expect(evidence.facts.failure?.category).toBe("agent");
    // The last request is retained with the runtime's own final-turn constraint on Tool use.
    expect(lastRequest(evidence)).toContain('"toolChoice":"none"');
  }),
);

it.effect("evaluation replays only identical actions and refuses a divergent one", () =>
  Effect.gen(function* () {
    const evidence = yield* evaluate(entry("reading-observed-searches-0"));

    expect((yield* replay(evidence)).output).toEqual({ status: "done", answer: orderReference });
    expect(
      yield* replay(evidence, {
        call: "search",
        params: { find: "total", scope: "document" },
      }).pipe(Effect.result),
    ).toMatchObject({ _tag: "Failure", failure: { _tag: "ReplayDivergence", reason: "action" } });
  }),
);

it.effect("evaluation refuses replay and success when retained inputs are lost or changed", () =>
  Effect.gen(function* () {
    const lost = yield* evaluate(entry("reading-base-searches-0"), {
      events: 1,
      bytes: 256 * 1024,
    });

    expect(lost.loss.events).toBeGreaterThan(0);
    expect(grade(lost)).toMatchObject({ task: "inconclusive", exactness: "incomplete" });
    expect(yield* replay(lost).pipe(Effect.result)).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "ReplayDivergence", reason: "incomplete" },
    });

    const intact = yield* evaluate(entry("reading-base-searches-0"));

    const changed: Evidence = {
      ...intact,
      events: intact.events.map((event, index) =>
        index === 1 ? { ...event, value: { changed: true } } : event,
      ),
    };

    expect(grade(changed)).toMatchObject({ task: "inconclusive", exactness: "incomplete" });
  }),
);
