// A take's defaults, apart from the take itself so the dev server's runner can report them
// without loading the browser and the bench.
import { Duration } from "effect";

export const defaults = {
  id: "polymarket",
  model: "openai/gpt-6-luna",
  reasoning: "medium",
  maxUsd: 0.5,
  every: Duration.seconds(4),
  maxSteps: 24,
  headed: false,
} as const;
