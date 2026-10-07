// What trial records say: the lines a run ends with, which the `report` command prints for any
// results files. Passes count over graded trials only; infrastructure failures, denials and unrun
// trials are counted apart.
import { Console, Effect } from "effect";
import { Argument, Command } from "effect/cli";

import { type Arm, armNames } from "./Arms.ts";
import { tasks } from "./Catalog.ts";
import * as Results from "./Results.ts";
import { holm, mcnemar, passHatK, wilson } from "./Stats.ts";
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

/** How two arms did on the pages both were graded on. */
export interface Paired {
  readonly pairs: number;
  readonly both: number;
  readonly onlyFirst: number;
  readonly onlySecond: number;
  readonly neither: number;
}

const noPairs: Paired = { pairs: 0, both: 0, onlyFirst: 0, onlySecond: 0, neither: 0 };

/**
 * Two arms' outcomes on the same pages, by task: a trial pairs with the other arm's trial of the
 * same task and seed, over pairs graded in both. The discordant counts are what McNemar's test
 * reads; a pair with an ungraded side says nothing about accuracy.
 */
export const pairs = (
  records: ReadonlyArray<{
    readonly task: string;
    readonly seed: number;
    readonly arm: Arm | null;
    readonly status: string;
    readonly pass: boolean | null;
  }>,
  first: Arm,
  second: Arm,
): ReadonlyMap<string, Paired> => {
  // A page an arm met twice, in two runs from one base seed, pairs in the order it was met.
  const passed = (arm: Arm) => {
    const met = new Map<string, number>();

    return new Map(
      records
        .filter((record) => record.arm === arm && record.status === "graded")
        .map((record) => {
          const page = `${record.task}#${record.seed}`;
          const times = met.get(page) ?? 0;

          met.set(page, times + 1);

          return [`${page}#${times}`, { task: record.task, pass: record.pass === true }];
        }),
    );
  };

  const right = passed(second);
  const byTask = new Map<string, Paired>();

  for (const [key, { task, pass: a }] of passed(first)) {
    const b = right.get(key)?.pass;

    if (b === undefined) continue;
    const counts = byTask.get(task) ?? noPairs;

    byTask.set(task, {
      pairs: counts.pairs + 1,
      both: counts.both + (a && b ? 1 : 0),
      onlyFirst: counts.onlyFirst + (a && !b ? 1 : 0),
      onlySecond: counts.onlySecond + (!a && b ? 1 : 0),
      neither: counts.neither + (!a && !b ? 1 : 0),
    });
  }

  return byTask;
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

const tasksOf = (records: ReadonlyArray<TrialRecord>) =>
  [...new Set(records.map((record) => record.task))].toSorted(
    (left, right) => order(left) - order(right),
  );

const armsOf = (records: ReadonlyArray<TrialRecord>) =>
  [...new Set(records.map((record) => record.arm))].toSorted(
    (left, right) => (left ?? 0) - (right ?? 0),
  );

/** How many trials pass^k asks to pass together. */
export const reliability = 3;

/** One task in one arm: its pass rate, how reliably it passes, and what a pass cost. */
export const table = (records: ReadonlyArray<TrialRecord>) =>
  tasksOf(records).flatMap((task) =>
    armsOf(records).flatMap((arm) => {
      const subset = records.filter((record) => record.task === task && record.arm === arm);
      const graded = subset.filter((record) => record.status === "graded");
      const passed = graded.filter((record) => record.pass === true).length;
      const operate = graded.filter((record) => record.onPage !== null);

      if (subset.length === 0) return [];

      return [
        {
          task,
          arm,
          graded: graded.length,
          passed,
          /** Graded operate trials whose page holds the work, whatever the answer; null for understand. */
          onPage:
            operate.length === 0 ? null : operate.filter((record) => record.onPage === true).length,
          interval: wilson(passed, graded.length),
          passHatK: passHatK(passed, graded.length, reliability),
          usdPerPass:
            graded.reduce((total, record) => total + record.accounting.knownUsd, 0) / passed,
          secondsPerPass: graded.reduce((total, record) => total + record.seconds, 0) / passed,
          infrastructureFailed: subset.filter((record) => record.status === "infrastructure-failed")
            .length,
        },
      ];
    }),
  );

/**
 * Each two arms, compared on the pages both were graded on: per task, McNemar's exact test, with
 * Holm's correction across the tasks; over all tasks, the test stratified by task, with Holm's
 * correction across the pairs of arms.
 */
export const compare = (records: ReadonlyArray<TrialRecord>) => {
  const armsRun = armsOf(records).filter((arm) => arm !== null);

  const raw = armsRun.flatMap((first, index) =>
    armsRun.slice(index + 1).map((second) => {
      const byTask = pairs(records, first, second);

      const tasksPaired = tasksOf(records).flatMap((task) => {
        const counts = byTask.get(task);

        return counts === undefined
          ? []
          : [{ task, ...counts, p: mcnemar(counts.onlyFirst, counts.onlySecond) }];
      });

      const adjusted = holm(tasksPaired.map((paired) => paired.p));

      const combined = tasksPaired.reduce(
        (total, paired) => ({
          pairs: total.pairs + paired.pairs,
          both: total.both + paired.both,
          onlyFirst: total.onlyFirst + paired.onlyFirst,
          onlySecond: total.onlySecond + paired.onlySecond,
          neither: total.neither + paired.neither,
        }),
        noPairs,
      );

      return {
        first,
        second,
        byTask: tasksPaired.map((paired, rank) => ({ ...paired, adjusted: adjusted[rank] ?? 1 })),
        combined: { ...combined, p: mcnemar(combined.onlyFirst, combined.onlySecond) },
      };
    }),
  );

  const adjusted = holm(raw.map((comparison) => comparison.combined.p));

  return raw.map((comparison, rank) => ({
    ...comparison,
    combined: { ...comparison.combined, adjusted: adjusted[rank] ?? 1 },
  }));
};

const backend = (record: TrialRecord) =>
  record.run.browser === "browserbase"
    ? "browserbase"
    : record.run.latencyMillis === null
      ? "chromium"
      : `chromium +${record.run.latencyMillis}ms`;

const fixed = (value: number, digits: number) =>
  Number.isFinite(value) ? value.toFixed(digits) : "-";

const comparisonLines = (records: ReadonlyArray<TrialRecord>) => [
  "Estimand: whether one arm passes more often than another on these tasks' pages, paired by task",
  "and seed. The tasks are fixed, not sampled, so a difference speaks to these pages only.",
  "",
  `${"task".padEnd(14)} arm  passed  rate  95% interval  pass^${reliability}  $/pass  s/pass  on page  infra`,
  ...table(records).map(
    (row) =>
      `${row.task.padEnd(14)} ${String(row.arm ?? "-").padStart(3)}  ${`${row.passed}/${row.graded}`.padStart(6)}  ${fixed(row.passed / row.graded, 2).padStart(4)}  ${`${fixed(row.interval.low, 2)}-${fixed(row.interval.high, 2)}`.padEnd(12)}  ${fixed(row.passHatK, 2).padStart(6)}  ${fixed(row.usdPerPass, 4).padStart(6)}  ${fixed(row.secondsPerPass, 1).padStart(6)}  ${(row.onPage === null ? "-" : `${row.onPage}/${row.graded}`).padStart(7)}  ${row.infrastructureFailed}`,
  ),
  ...compare(records).flatMap(({ first, second, byTask, combined }) => [
    "",
    `arm ${first} vs arm ${second}, paired by task and seed:`,
    ...byTask.map(
      (paired) =>
        `  ${paired.task.padEnd(14)} ${paired.pairs} pairs: only arm ${first} passed ${paired.onlyFirst}, only arm ${second} ${paired.onlySecond}; exact p ${fixed(paired.p, 3)}, Holm ${fixed(paired.adjusted, 3)}`,
    ),
    `  ${"all tasks".padEnd(14)} ${combined.pairs} pairs: only arm ${first} passed ${combined.onlyFirst}, only arm ${second} ${combined.onlySecond}; stratified exact p ${fixed(combined.p, 3)}, Holm across arm pairs ${fixed(combined.adjusted, 3)}`,
  ]),
  "",
  `Infrastructure failures: ${[...new Set(records.map(backend))]
    .map((name) => {
      const ran = records.filter((record) => backend(record) === name);
      const failed = ran.filter((record) => record.status === "infrastructure-failed").length;

      return `${name} ${failed} of ${ran.length} (${fixed((100 * failed) / ran.length, 1)}%)`;
    })
    .join("; ")}`,
];

/**
 * Tallies by task and arm and where graded trials' time went; with a model, each arm's pass rates,
 * reliability and cost, and how arms compare on paired trials.
 */
export const summary = (records: ReadonlyArray<TrialRecord>): ReadonlyArray<string> => {
  const names = tasksOf(records);
  const armsRun = armsOf(records);

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
    const operate = graded.filter((record) => record.onPage !== null);

    // A format-only failure is graded as one; on the page, the work counts whatever the answer said.
    const onPage =
      operate.length === 0
        ? ""
        : `; on the page, ${operate.filter((record) => record.onPage === true).length} of ${operate.length} graded operate trials`;

    lines.push(
      `${tallied(`arm ${arm} (${arm === null ? "" : armNames[arm]}):`, subset)}${onPage}; median ${median(graded.map((record) => record.seconds)).toFixed(1)}s, ${median(graded.map((record) => record.steps ?? 0))} turns and ${median(graded.map((record) => record.actions ?? 0))} tool calls per graded trial; $${spent.toFixed(4)} known`,
    );
  }

  lines.push("", ...comparisonLines(records));

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
