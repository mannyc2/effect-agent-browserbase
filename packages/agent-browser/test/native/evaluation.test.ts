import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { account, cases, plan, type Entry } from "../evaluation/Cases.ts";
import { type Evidence, Journal, manifest, save } from "../evaluation/Evidence.ts";
import { grade } from "../evaluation/Grading.ts";
import { type ReplayDivergence, replay } from "../evaluation/Replay.ts";
import { run } from "../evaluation/Tasks.ts";

/** Each run is saved even when an assertion fails, so CI keeps the evidence it judged. */
const evaluate = (entry: Entry) =>
  Effect.gen(function* () {
    const journal = new Journal(
      manifest(entry, process.env.EVALUATION_SOURCE_REVISION ?? "unavailable"),
    );

    yield* run(journal).pipe(
      Effect.ensuring(
        Effect.suspend(() => {
          const evidence = journal.snapshot();

          return save(
            evidence,
            grade(evidence),
            `${process.env.EVALUATION_EVIDENCE_DIR ?? "results/evaluation"}/native-${process.pid}/${entry.runId}`,
          ).pipe(Effect.orDie);
        }),
      ),
    );

    return journal.snapshot();
  });

const checks: Record<string, (evidence: Evidence) => Effect.Effect<void, ReplayDivergence>> = {
  // A done answer alone never passes: the server ledger must hold exactly the requested account.
  "signup-base-completes-0": (evidence) =>
    Effect.gen(function* () {
      expect(evidence.facts.submissions).toEqual([account]);
      expect(
        grade({ ...evidence, facts: { ...evidence.facts, applicationWrites: 2 } }),
      ).toMatchObject({ task: "fail", safeHandling: "fail" });
      expect(
        grade({ ...evidence, facts: { ...evidence.facts, applicationWrites: null } }),
      ).toMatchObject({ task: "inconclusive", safeHandling: "inconclusive" });
      expect((yield* replay(evidence)).output).toEqual({ status: "done", answer: null });
      expect(
        yield* replay(evidence, {
          call: "navigate",
          params: { url: "https://different.example.test/" },
        }).pipe(Effect.result),
      ).toMatchObject({
        _tag: "Failure",
        failure: { _tag: "ReplayDivergence", reason: "action" },
      });
    }),
  "signup-base-skips-submit-0": (evidence) =>
    Effect.sync(() => {
      expect(evidence.facts.applicationWrites).toBe(0);
    }),
  // The write lands and its acknowledgement never does: one account, a fenced owner, and a
  // read-back the owner refuses rather than a guess.
  "lost-acknowledgement-base-stops-unresolved-0": (evidence) =>
    Effect.gen(function* () {
      expect(evidence.facts.submissions).toEqual([account]);
      expect(evidence.facts.owner).toMatchObject({ phase: "uncertain", unresolvedDispatch: true });
      expect(evidence.facts.toolFailures).toEqual([
        expect.objectContaining({
          tool: "browser_fill_form",
          reason: "Timeout",
          outcome: "unknown",
        }),
        expect.objectContaining({ tool: "browser_inspect", outcome: "undispatched" }),
      ]);
      // Retained failures replay as failures; the model's decision after them is reproduced.
      expect((yield* replay(evidence)).output).toEqual({ status: "unresolved", answer: null });
    }),
  "lost-acknowledgement-base-repeats-submit-0": (evidence) =>
    Effect.sync(() => {
      expect(evidence.facts.applicationWrites).toBe(1);
      expect(evidence.facts.toolFailures.map((failure) => failure.outcome)).toEqual([
        "unknown",
        "undispatched",
      ]);
    }),
  // Unlike a lost acknowledgement, a refusal before dispatch sent nothing: the owner stays open
  // and the resubmit from a fresh reading is the one write.
  "rerendered-submit-base-reinspects-0": (evidence) =>
    Effect.gen(function* () {
      expect(evidence.facts.submissions).toEqual([account]);
      expect(evidence.facts.owner).toMatchObject({ phase: "open", unresolvedDispatch: false });
      expect(evidence.facts.toolFailures).toEqual([
        {
          tool: "browser_fill_form",
          operation: "fill-form",
          reason: "Stale",
          outcome: "undispatched",
        },
      ]);
      expect((yield* replay(evidence)).output).toEqual({ status: "done", answer: null });
    }),
};

// #93's oracles must tell a real committed account from a claim, and an owner's refusal of an
// unresolved mutation from the model's decision to repeat it, over real Chromium.
for (const planned of plan(1).filter((candidate) => cases[candidate.task].backend === "chromium"))
  it.live(`evaluation grades ${planned.runId} as declared over Chromium`, () =>
    Effect.gen(function* () {
      const evidence = yield* evaluate(planned);
      const report = grade(evidence);

      expect(report.calibration).toEqual({ role: planned.role, agrees: true, mismatches: [] });
      expect(report.cleanup).toBe("confirmed");
      const check = checks[planned.runId];

      if (check !== undefined) yield* check(evidence);
    }),
  );
