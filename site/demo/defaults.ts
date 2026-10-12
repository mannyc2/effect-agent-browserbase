// A take's defaults, apart from the take itself so the dev server's runner can report them
// without loading the browser and the bench.

/** The demos a take can record, each named for its replay. */
export const demoNames = ["polymarket", "casino"] as const;

export type DemoName = (typeof demoNames)[number];

/** Turns each demo's agent gets by default: six spins take more than a browse. */
export const stepsFor: { readonly [D in DemoName]: number } = { polymarket: 24, casino: 40 };

export const defaults = {
  demo: "polymarket",
  model: "openai/gpt-6-luna",
  reasoning: "medium",
  maxUsd: 0.5,
  headed: false,
} as const;
