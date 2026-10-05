/** Immutable pairing and conservative summaries; no browser or model is started here. */
import { Schema } from "effect";

import * as Arms from "./Arms.ts";
import { trialSeed } from "./run.ts";
import { tasks } from "./Tasks.ts";

export const Arm = Schema.Literals([1, 2, 3, 4, 5, 6]);
export type Arm = typeof Arm.Type;
export type Provider = "local" | "browserbase";

export const primary = [
  "casino-play",
  "casino-moment",
  "chart-read",
  "chart-spike",
  "chart-calm",
  "chart-trade",
  "checkout",
] as const;

export const extension = ["quote-table", "tumble-win", "order-filled", "navigated"] as const;

export interface Configuration {
  readonly localTrials: number;
  readonly hostedTrials: number;
  readonly seed: number;
  readonly provider: Provider | "both";
  readonly arms: ReadonlyArray<Arm>;
  readonly tasks: ReadonlyArray<string>;
}

export interface Pair {
  readonly provider: Provider;
  readonly stratum: "primary" | "extension";
  readonly kind: "operate" | "understand";
  readonly task: string;
  readonly trial: number;
  readonly seed: number;
  readonly order: ReadonlyArray<Arm>;
}

export const pairs = (configuration: Configuration): ReadonlyArray<Pair> =>
  (["local", "browserbase"] as const).flatMap((provider) =>
    configuration.provider !== "both" && configuration.provider !== provider
      ? []
      : [...primary, ...extension]
          .filter((task) => configuration.tasks.length === 0 || configuration.tasks.includes(task))
          .flatMap((task) =>
            Array.from(
              {
                length:
                  provider === "local" ? configuration.localTrials : configuration.hostedTrials,
              },
              (_, index): Pair => {
                const seed = trialSeed(configuration.seed, task, index + 1);

                return {
                  provider,
                  task,
                  trial: index + 1,
                  seed,
                  stratum: primary.some((value) => value === task) ? "primary" : "extension",
                  kind: tasks.find((value) => value.name === task)?.kind ?? "understand",
                  order: configuration.arms
                    .filter((arm) => provider === "local" || [1, 2, 5, 6].includes(arm))
                    .toSorted(
                      (left, right) =>
                        trialSeed(seed, String(left), 0) - trialSeed(seed, String(right), 0),
                    ),
                };
              },
            ),
          ),
  );

export const design = {
  arms: [
    ...Arms.metadata,
    {
      id: 6,
      name: "native-computer-use",
      requires: ["confirmed-native-route"],
      operate: "Native Responses computer_call.actions[] executor; no text-action fallback.",
      understand:
        "Original timed frame images and timeline; historical moments cannot accept new actions.",
      notes:
        "First approved probe returned no usable contract. Planned rows stay blocked until explicit route confirmation.",
    },
  ],
  sameRepresentationControls: [1, 4, 5],
  sameRepresentationAppliesTo: "understand",
  baseline: "Current public Tools per-action control; not a replay of d100c9f.",
  protocol:
    "Native Playwright logger exchanges and serialized JSON bytes; not transport bytes or awaited round trips. Known unlogged shutdown command is explicit.",
  thresholds: {
    fiveVsOneSpeedup: 0.2,
    fiveVsOnePassLoss: 0,
    twoVsOneHtmlPassLoss: 0.05,
    caveat:
      "Five trials per primary task detect only large differences; this cannot establish five-point noninferiority.",
  },
} as const;

export interface Observation {
  readonly provider: Provider;
  readonly stratum: Pair["stratum"];
  readonly kind: Pair["kind"];
  readonly task: string;
  readonly trial: number;
  readonly seed: number;
  readonly arm: Arm;
  readonly status: "completed" | "failed" | "unrun";
  readonly pass: boolean | null;
  readonly millis: number | null;
  readonly knownUsd: number;
  readonly reservedUsd: number;
}

const quantile = (values: ReadonlyArray<number>, proportion: number) => {
  const sorted = values.toSorted((a, b) => a - b);

  return sorted.length === 0
    ? null
    : (sorted[Math.max(0, Math.ceil(sorted.length * proportion) - 1)] ?? null);
};

const mean = (values: ReadonlyArray<number>) =>
  values.length === 0 ? null : values.reduce((sum, value) => sum + value, 0) / values.length;

/** All planned rows remain in denominators, with grading and infrastructure counts separate. */
export const summarize = (rows: ReadonlyArray<Observation>) => {
  const groups = new Map<string, Array<Observation>>();

  for (const row of rows) {
    const key = [row.provider, row.stratum, row.kind, row.arm].join("/");
    const group = groups.get(key) ?? [];

    group.push(row);
    groups.set(key, group);
  }

  const arms = [...groups].map(([group, values]) => {
    const graded = values.filter((value) => value.status === "completed");
    const passed = graded.filter((value) => value.pass).length;
    const times = graded.flatMap((value) => (value.millis === null ? [] : [value.millis]));

    return {
      group,
      planned: values.length,
      graded: graded.length,
      passed,
      failed: values.filter((value) => value.status === "failed").length,
      unrun: values.filter((value) => value.status === "unrun").length,
      passPerPlanned: passed / values.length,
      passPerGraded: graded.length === 0 ? null : passed / graded.length,
      meanMillis: mean(times),
      p50Millis: quantile(times, 0.5),
      p95Millis: quantile(times, 0.95),
      knownUsd: values.reduce((sum, value) => sum + value.knownUsd, 0),
      reservedUsd: values.reduce((sum, value) => sum + value.reservedUsd, 0),
    };
  });

  const paired = (["local", "browserbase"] as const)
    .flatMap((provider) =>
      (["primary", "extension"] as const).flatMap((stratum) =>
        (["operate", "understand"] as const).flatMap((kind) =>
          ([2, 3, 4, 5, 6] as const).map((arm) => {
            const baseline = rows.filter(
              (row) =>
                row.provider === provider &&
                row.stratum === stratum &&
                row.kind === kind &&
                row.arm === 1,
            );

            const comparisons = baseline.map((left) => ({
              left,
              right: rows.find(
                (right) =>
                  right.provider === provider &&
                  right.task === left.task &&
                  right.trial === left.trial &&
                  right.seed === left.seed &&
                  right.arm === arm,
              ),
            }));

            const complete = comparisons.filter(
              (pair) => pair.left.status === "completed" && pair.right?.status === "completed",
            );

            const ratios = complete.flatMap(({ left, right }) =>
              left.pass &&
              right?.pass &&
              left.millis !== null &&
              right.millis !== null &&
              left.millis > 0
                ? [right.millis / left.millis]
                : [],
            );

            return {
              provider,
              stratum,
              kind,
              arm,
              baseline: 1,
              planned: baseline.length,
              complete: complete.length,
              wins: complete.filter(({ left, right }) => !left.pass && right?.pass).length,
              losses: complete.filter(({ left, right }) => left.pass && !right?.pass).length,
              incomplete: baseline.length - complete.length,
              bothPassTimingPairs: ratios.length,
              medianTimeRatio: quantile(ratios, 0.5),
              interpretation:
                kind === "understand" && [4, 5].includes(arm)
                  ? "identical-representation control"
                  : "descriptive paired comparison",
            };
          }),
        ),
      ),
    )
    .filter(
      (row) =>
        row.planned > 0 &&
        rows.some(
          (value) =>
            value.provider === row.provider &&
            value.stratum === row.stratum &&
            value.kind === row.kind &&
            value.arm === row.arm,
        ),
    );

  return { arms, paired };
};
