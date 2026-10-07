import type { Response } from "effect/ai";

/** Token counts summed over one or more model calls. */
export interface Usage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input tokens the provider read from its prompt cache, included in `inputTokens`. */
  readonly cachedInputTokens: number;
}

export const empty: Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };

export const add = (total: Usage, usage: Response.Usage): Usage => ({
  inputTokens: total.inputTokens + (usage.inputTokens.total ?? 0),
  outputTokens: total.outputTokens + (usage.outputTokens.total ?? 0),
  cachedInputTokens: total.cachedInputTokens + (usage.inputTokens.cacheRead ?? 0),
});
