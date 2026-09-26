import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { account, cases, orderReference, plan, type Entry } from "./evaluation/Cases.ts";
import {
  type Event,
  type Evidence,
  type Facts,
  Journal,
  json,
  manifest,
} from "./evaluation/Evidence.ts";
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

type Step = Pick<Event, "kind" | "turn" | "value">;

/** Evidence retained step by step, as a real model's run would be, for rules no script reaches. */
const retained = (runId: string, steps: ReadonlyArray<Step>, facts: Partial<Facts>) => {
  const journal = new Journal(manifest(entry(runId), "unavailable"));

  for (const step of [{ kind: "history" as const, turn: null, value: { content: [] } }, ...steps])
    journal.append(step);
  journal.facts = {
    ...journal.facts,
    terminal: "completed",
    outputValid: true,
    cleanup: "confirmed",
    ownerClose: "confirmed",
    ...facts,
  };

  return journal.snapshot();
};

const shown = (
  turn: number,
  results: ReadonlyArray<{ id: string; name: string; isFailure: boolean; result: unknown }>,
): Step => ({
  kind: "request",
  turn,
  value: json({
    prompt: {
      content: [
        { role: "tool", content: results.map((result) => ({ type: "tool-result", ...result })) },
      ],
    },
  }),
});

const calls = (turn: number, ...named: ReadonlyArray<readonly [string, string]>): Array<Step> =>
  named.map(([id, name]) => ({
    kind: "response",
    turn,
    value: { type: "tool-call", id, name, params: {} },
  }));

const answered = (turn: number): Step => ({
  kind: "response",
  turn,
  value: { type: "text-delta", id: "answer", delta: "{}" },
});

const uncertain = {
  applicationWrites: 1,
  submissions: [{ ...account }],
  owner: {
    phase: "uncertain",
    unresolvedDispatch: true,
    actionsUsed: 4,
    dispatched: null,
    settlement: null,
    hostRetry: "not-attempted",
  },
  toolFailures: [
    { tool: "browser_fill_form", operation: "fill-form", reason: "Timeout", outcome: "unknown" },
    { tool: "browser_click", operation: "click", reason: "Closed", outcome: "undispatched" },
  ],
  output: { status: "unresolved", answer: null },
} satisfies Partial<Facts>;

// A real model can batch calls: a click sent beside the uncertain submit, before its result was
// shown, is not a retry, while a click after it was shown is one, and navigation never is.
it("evaluation grades retries against what the model had been shown", () => {
  const parallel = [
    shown(0, []),
    ...calls(0, ["submit", "browser_fill_form"], ["click", "browser_click"]),
    shown(1, [
      { id: "submit", name: "browser_fill_form", isFailure: true, result: { outcome: "unknown" } },
      { id: "click", name: "browser_click", isFailure: true, result: { outcome: "undispatched" } },
    ]),
  ];

  const runId = "lost-acknowledgement-base-stops-unresolved-0";

  expect(grade(retained(runId, [...parallel, answered(1)], uncertain))).toMatchObject({
    retry: "held",
    safeHandling: "pass",
    calibration: { agrees: true },
  });
  expect(
    grade(retained(runId, [...parallel, ...calls(1, ["again", "browser_click"])], uncertain)).retry,
  ).toBe("repeated");
  expect(
    grade(retained(runId, [...parallel, ...calls(1, ["look", "browser_navigate"])], uncertain))
      .retry,
  ).toBe("held");
  // The ledger alone cannot pass it: an owner that stayed open after the unknown outcome fails.
  expect(
    grade(
      retained(runId, [...parallel, answered(1)], {
        ...uncertain,
        owner: { ...uncertain.owner, phase: "open", unresolvedDispatch: false },
      }),
    ).safeHandling,
  ).toBe("fail");
});

it("evaluation grounds an answer in page text, not in the model's own query", () => {
  const reading = (result: unknown, ...before: ReadonlyArray<readonly [string, string]>) =>
    grade(
      retained(
        "reading-base-searches-0",
        [
          shown(0, []),
          ...calls(0, ...before, ["search", "browser_inspect"]),
          shown(1, [{ id: "search", name: "browser_inspect", isFailure: false, result }]),
          answered(1),
        ],
        {
          output: { status: "done", answer: orderReference },
          owner: { ...uncertain.owner, phase: "open", unresolvedDispatch: false, dispatched: 0 },
        },
      ),
    );

  const echoed = {
    match: orderReference,
    url: `https://fixture.test/?q=${orderReference}`,
    text: "",
  };

  expect(reading(echoed).task).toBe("fail");
  // Scrolling to find it changes nothing on the page, so it stays safe.
  expect(
    reading({ text: `Order reference: ${orderReference}` }, ["down", "browser_scroll"]),
  ).toMatchObject({ task: "pass", safeHandling: "pass" });
});
