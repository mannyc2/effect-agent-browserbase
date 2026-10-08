import { Schema } from "effect";
import type { Response } from "effect/ai";

/** Token counts summed over one or more model calls. */
export const Usage = Schema.Struct({
  inputTokens: Schema.Finite,
  outputTokens: Schema.Finite,
  /** Input tokens the provider read from its prompt cache, included in `inputTokens`. */
  cachedInputTokens: Schema.Finite,
});

export type Usage = typeof Usage.Type;

export const empty: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export const add = (total: Usage, usage: Response.Usage): Usage => ({
  inputTokens: total.inputTokens + (usage.inputTokens.total ?? 0),
  outputTokens: total.outputTokens + (usage.outputTokens.total ?? 0),
  cachedInputTokens: total.cachedInputTokens + (usage.inputTokens.cacheRead ?? 0),
});
