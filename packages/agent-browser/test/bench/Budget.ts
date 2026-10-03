import { Effect } from "effect";
import { AiError, type Response } from "effect/unstable/ai";

import type { Usage } from "./Records.ts";

/** Integer micro-dollars per million tokens from the run's dated specification. */
export interface Prices {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

type Refusal = NonNullable<Usage["refused"]>;

export const refusal = (reason: Refusal) =>
  AiError.make({
    module: "BenchBudget",
    method: "admit",
    reason: new AiError.InvalidRequestError({
      description: `Bench model call refused: ${reason}.`,
    }),
  });

/** Stops new calls at the reported-spend cap. The final bounded request can overshoot it. */
export class Ledger {
  spentMicrousd = 0;
  halted = false;
  constructor(readonly limitMicrousd: number) {}
  allowance(options: {
    readonly limitMicrousd: number;
    readonly rates: Prices;
    readonly maxOutputTokens: number;
  }): Allowance {
    return new Allowance(this, options);
  }
}

export class Allowance {
  #inFlight = false;
  #admitted = 0;
  #settled = 0;
  #refused: Refusal | null = null;
  #cost = 0;
  #unknown = false;
  #tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  constructor(
    readonly ledger: Ledger,
    readonly options: {
      readonly limitMicrousd: number;
      readonly rates: Prices;
      readonly maxOutputTokens: number;
    },
  ) {}
  admit(): Effect.Effect<void, AiError.AiError> {
    return Effect.suspend(() => {
      const reason: Refusal | null = this.#inFlight
        ? "concurrent"
        : this.ledger.halted
          ? "missing-usage"
          : this.#cost >= this.options.limitMicrousd
            ? "run-budget"
            : this.ledger.spentMicrousd >= this.ledger.limitMicrousd
              ? "invocation-budget"
              : null;

      if (reason !== null) {
        this.#refused ??= reason;

        return Effect.fail(refusal(reason));
      }
      this.#inFlight = true;
      this.#admitted++;

      return Effect.void;
    });
  }
  release(): void {
    if (this.#inFlight) {
      this.#unknown = true;
      this.ledger.halted = true;
    }
    this.#inFlight = false;
  }
  settle(usage: Pick<Response.Usage, "inputTokens" | "outputTokens">): number {
    this.#inFlight = false;

    const input =
      usage.inputTokens.total ??
      (usage.inputTokens.uncached === undefined
        ? undefined
        : usage.inputTokens.uncached +
          (usage.inputTokens.cacheRead ?? 0) +
          (usage.inputTokens.cacheWrite ?? 0));

    const output =
      usage.outputTokens.total ??
      (usage.outputTokens.text === undefined
        ? undefined
        : usage.outputTokens.text + (usage.outputTokens.reasoning ?? 0));

    if (input === undefined || output === undefined) {
      this.#unknown = true;
      this.ledger.halted = true;

      return 0;
    }
    const read = usage.inputTokens.cacheRead ?? 0;
    const write = usage.inputTokens.cacheWrite ?? 0;
    const rates = this.options.rates;

    const cost = Math.ceil(
      (Math.max(0, input - read - write) * rates.input +
        read * rates.cacheRead +
        write * rates.cacheWrite +
        output * rates.output) /
        1_000_000,
    );

    this.#settled++;
    this.#cost += cost;
    this.ledger.spentMicrousd += cost;
    this.#tokens.input += input;
    this.#tokens.cacheRead += read;
    this.#tokens.cacheWrite += write;
    this.#tokens.output += output;
    this.#tokens.reasoning += usage.outputTokens.reasoning ?? 0;

    return cost;
  }
  finish(): Usage {
    this.release();

    return this.usage();
  }
  usage(): Usage {
    return {
      admitted: this.#admitted,
      settled: this.#settled,
      refused: this.#refused,
      inputTokens: this.#tokens.input,
      cacheReadInputTokens: this.#tokens.cacheRead,
      cacheWriteInputTokens: this.#tokens.cacheWrite,
      outputTokens: this.#tokens.output,
      reasoningTokens: this.#tokens.reasoning,
      costMicrousd: this.#cost,
      limitMicrousd: this.options.limitMicrousd,
      overshootMicrousd: Math.max(0, this.#cost - this.options.limitMicrousd),
      status: this.#unknown
        ? "usage-unavailable"
        : this.#admitted === 0
          ? "no-calls"
          : "estimated-from-reported-usage",
    };
  }
}

/** One fresh session per run; unconfirmed cleanup stops further allocation. */
export class Sessions {
  used = 0;
  halted = false;
  constructor(readonly maximum: number) {}
  admit(): boolean {
    if (this.halted || this.used >= this.maximum) return false;
    this.used++;

    return true;
  }
  settle(cleanup: "missing" | "confirmed" | "unconfirmed"): void {
    if (cleanup !== "confirmed") this.halted = true;
  }
}
