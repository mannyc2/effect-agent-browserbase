// What trial records say: the lines a run ends with, which the `report` command prints for any
// results files. Passes count over graded trials only; infrastructure failures, denials and unrun
// trials are counted apart.
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { type Arm, armNames } from "./Arms.ts";
import * as Results from "./Results.ts";
import { tasks } from "./Tasks.ts";
import { tally } from "./Trial.ts";

type TrialRecord = Results.TrialRecord;

/** The middle value, or the mean of the middle two; 0 for none. */
export const median = (values: ReadonlyArray<number>): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);

  if (sorted.length === 0) return 0;

  return sorted.length % 2 === 1
    ? (sorted[middle] ?? 0)
    : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
};

/**
 * Two arms' outcomes on the same task and trial, over the pairs graded in both: the discordant
 * counts are what McNemar's test reads. A pair with an ungraded side says nothing about accuracy.
 */
export const pairs = (
  records: ReadonlyArray<{
    readonly task: string;
    readonly trial: number;
    readonly arm: Arm | null;
    readonly status: string;
    readonly pass: boolean | null;
  }>,
  first: Arm,
  second: Arm,
) => {
  const passed = (arm: Arm) =>
    new Map(
      records
        .filter((record) => record.arm === arm && record.status === "graded")
        .map((record) => [`${record.task}#${record.trial}`, record.pass === true]),
    );

  const left = passed(first);
  const right = passed(second);
  const counts = { pairs: 0, both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 };

  for (const [key, a] of left) {
    const b = right.get(key);

    if (b === undefined) continue;
    counts.pairs += 1;
    if (a && b) counts.both += 1;
    else if (a) counts.onlyFirst += 1;
    else if (b) counts.onlySecond += 1;
    else counts.neither += 1;
  }

  return counts;
};

const mean = (values: ReadonlyArray<number>) =>
  values.reduce((sum, value) => sum + value, 0) / values.length;

/** Where graded trials' time went, as means, so the parts add up to the whole. */
const breakdown = (graded: ReadonlyArray<TrialRecord>) => {
  const total = mean(graded.map((record) => record.seconds));

  const parts = {
    "model requests": mean(graded.map((record) => record.timing.requestSeconds)),
    "budget queue": mean(graded.map((record) => record.timing.queueSeconds)),
    "opening the browser": mean(graded.map((record) => record.phases.setupSeconds)),
    "tool calls": mean(graded.map((record) => record.phases.toolSeconds)),
    "looking at the page": mean(graded.map((record) => record.phases.observeSeconds)),
  };

  const rest = Object.values(parts).reduce((left, part) => left - part, total);

  return `mean ${total.toFixed(1)}s per graded trial: ${Object.entries(parts)
    .map(([part, seconds]) => `${part} ${seconds.toFixed(1)}s`)
    .join(", ")}, the rest ${rest.toFixed(1)}s`;
};

/**
 * Where a latency run's round trips went, as means per graded trial, by the innermost span open
 * when each command was sent, busiest first.
 */
const roundTrips = (graded: ReadonlyArray<TrialRecord>) => {
  const bySpan = new Map<string, { readonly roundTrips: number; readonly spans: number }>();

  for (const record of graded)
    for (const [name, waited] of Object.entries(record.protocol?.bySpan ?? {})) {
      const sum = bySpan.get(name) ?? { roundTrips: 0, spans: 0 };

      bySpan.set(name, {
        roundTrips: sum.roundTrips + waited.roundTrips,
        spans: sum.spans + waited.spans,
      });
    }

  const busiest = [...bySpan]
    .toSorted(([, left], [, right]) => right.roundTrips - left.roundTrips)
    .slice(0, 8)
    .map(
      ([name, sum]) =>
        `${name} ${(sum.roundTrips / graded.length).toFixed(1)} in ${(sum.spans / graded.length).toFixed(1)} calls`,
    );

  return `mean ${mean(graded.map((record) => record.protocol?.roundTrips ?? 0)).toFixed(1)} per graded trial: ${busiest.join(", ")}`;
};

const tallied = (label: string, subset: ReadonlyArray<TrialRecord>) => {
  const counts = tally(subset);

  return `${label} ${counts.passed} of ${counts.graded} graded passed; ${counts.infrastructureFailed} infrastructure-failed, ${counts.denied} denied, ${counts.unrun} unrun`;
};

// Records arrive in the order trials end; summaries list tasks as the bench does, then arms.
const order = (name: string) => {
  const index = tasks.findIndex((task) => task.name === name);

  return index === -1 ? tasks.length : index;
};

/** Tallies by task and arm, where graded trials' time went, and how arms compare on paired trials. */
export const summary = (records: ReadonlyArray<TrialRecord>): ReadonlyArray<string> => {
  const names = [...new Set(records.map((record) => record.task))].toSorted(
    (left, right) => order(left) - order(right),
  );

  const armsRun = [...new Set(records.map((record) => record.arm))].toSorted(
    (left, right) => (left ?? 0) - (right ?? 0),
  );

  const lines = names.flatMap((name) =>
    armsRun.map((arm) =>
      tallied(
        `${name.padEnd(14)}${arm === null ? "" : ` arm ${arm}`}`,
        records.filter((record) => record.task === name && record.arm === arm),
      ),
    ),
  );

  for (const arm of armsRun) {
    const graded = records.filter((record) => record.arm === arm && record.status === "graded");

    if (graded.length > 0)
      lines.push(`${arm === null ? "Time" : `Arm ${arm} time`}: ${breakdown(graded)}`);
    const read = graded.filter((record) => record.protocol !== null);
    const measured = read.flatMap((record) => record.roundTripMillis ?? []);

    if (read.length > 0)
      lines.push(
        `${arm === null ? "Round trips" : `Arm ${arm} round trips`}${measured.length === 0 ? "" : `, about ${median(measured).toFixed(0)}ms each`}: ${roundTrips(read)}`,
      );
  }

  if (records.every((record) => record.run.model === null)) return lines;

  lines.push("");
  for (const arm of armsRun) {
    const subset = records.filter((record) => record.arm === arm);
    const graded = subset.filter((record) => record.status === "graded");
    const spent = subset.reduce((total, record) => total + record.accounting.knownUsd, 0);

    lines.push(
      `${tallied(`arm ${arm} (${arm === null ? "" : armNames[arm]}):`, subset)}; median ${median(graded.map((record) => record.seconds)).toFixed(1)}s, ${median(graded.map((record) => record.steps ?? 0))} turns and ${median(graded.map((record) => record.actions ?? 0))} tool calls per graded trial; $${spent.toFixed(4)} known`,
    );
  }

  for (const [index, arm] of armsRun.entries())
    for (const other of armsRun.slice(index + 1)) {
      if (arm === null || other === null) continue;
      const paired = pairs(records, arm, other);

      lines.push(
        `arm ${arm} vs arm ${other}: ${paired.pairs} pairs graded in both; both passed ${paired.both}, only arm ${arm} ${paired.onlyFirst}, only arm ${other} ${paired.onlySecond}, neither ${paired.neither}`,
      );
    }

  return lines;
};

/** Every trial's status, in all; `spent` says what the money line reports. */
export const totals = (records: ReadonlyArray<TrialRecord>, spent: string) => {
  const counts = tally(records);

  return `${counts.passed} of ${counts.graded} graded trials passed; ${counts.infrastructureFailed} infrastructure-failed, ${counts.denied} denied and ${counts.unrun} unrun of ${counts.scheduled} scheduled; ${spent}`;
};

export const command = Command.make(
  "report",
  {
    files: Argument.String("results").pipe(
      Argument.atLeast(1),
      Argument.withDescription(
        "A run's .jsonl results file; give several to report them together.",
      ),
    ),
  },
  Effect.fnUntraced(function* ({ files }) {
    const records = (yield* Effect.forEach(files, Results.read)).flat();
    const known = records.reduce((total, record) => total + record.accounting.knownUsd, 0);

    const reserved = records.reduce((total, record) => total + record.accounting.reservedUsd, 0);

    for (const line of summary(records)) yield* Console.log(line);
    yield* Console.log(
      `\n${totals(records, `$${known.toFixed(4)} known + $${reserved.toFixed(4)} unresolved in these records`)}`,
    );
  }),
).pipe(Command.withDescription("Summarize the trials in results files, as a run ends."));
