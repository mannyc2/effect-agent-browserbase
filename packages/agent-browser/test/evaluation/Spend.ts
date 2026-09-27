import { Effect } from "effect";
import { AiError, type Response } from "effect/unstable/ai";

import type { Usage } from "./Evidence.ts";

/**
 * Model spend, admitted before each request is sent. A request's reservation bounds its input by
 * its serialized bytes, since a byte-level tokenizer never needs more than one token per byte,
 * plus a margin for the provider's own framing and tool preamble, all at the dearest input rate;
 * and its output by the request's whole output allowance. Reported usage settles it. Usage
 * beyond what was reserved breaks that assumption, so it closes the whole campaign.
 */

/** Integer micro-dollars per million tokens. */
export interface Prices {
  readonly input: number;
  readonly cacheRead: number;
  readonly cacheWrite: number;
  readonly output: number;
}

/** Tokens a request may bill beyond its bytes: message framing and tool-use preambles. */
export const inputMargin = 1024;

type Refusal = NonNullable<Usage["refused"]>;

const descriptions: Record<Refusal, string> = {
  "run-budget": "The request's reservation would pass the run's spend limit.",
  "campaign-budget": "The request's reservation would pass the campaign's spend limit.",
  closed: "An earlier request broke its price contract, so the campaign admits nothing more.",
  contract: "The request is outside the contract it was priced under.",
  concurrent: "A run sends one request at a time, and its last is still in flight.",
};

/** Fixed descriptions only: never provider text, request content or credentials. */
export const refusal = (reason: Refusal) =>
  AiError.make({
    module: "EvaluationSpend",
    method: "admit",
    reason: new AiError.InvalidRequestError({ description: descriptions[reason] }),
  });

interface Reservation {
  readonly microusd: number;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** The campaign's spend. Every run's allowance draws on it; a broken contract closes it. */
export class Ledger {
  readonly limitMicrousd: number;
  /** Settled estimates and retained reservations. */
  spentMicrousd = 0;
  /** Reservations admitted and not yet settled. */
  pendingMicrousd = 0;
  closed: "contract" | null = null;
  constructor(limitMicrousd: number) {
    this.limitMicrousd = limitMicrousd;
  }
  allowance(options: {
    readonly limitMicrousd: number;
    readonly rates: Prices;
    readonly maxOutputTokens: number;
  }): Allowance {
    return new Allowance(this, options);
  }
}

/**
 * One run's share of the campaign: one request at a time, each reserved before it is sent. A
 * request is in flight from admission until its stream ends or its usage settles it.
 */
export class Allowance {
  readonly #ledger: Ledger;
  readonly #limit: number;
  readonly #rates: Prices;
  readonly #maxOutputTokens: number;
  #pending: Reservation | null = null;
  #inFlight = false;
  #overrun = false;
  #admitted = 0;
  #settled = 0;
  #refused: Refusal | null = null;
  #settledMicrousd = 0;
  #retainedMicrousd = 0;
  #tokens = { input: 0, cacheRead: 0, cacheWrite: 0, output: 0, reasoning: 0 };
  constructor(
    ledger: Ledger,
    options: {
      readonly limitMicrousd: number;
      readonly rates: Prices;
      readonly maxOutputTokens: number;
    },
  ) {
    this.#ledger = ledger;
    this.#limit = options.limitMicrousd;
    this.#rates = options.rates;
    this.#maxOutputTokens = options.maxOutputTokens;
  }
  get refused(): Refusal | null {
    return this.#refused;
  }
  /** Reserve a request of `bytes` serialized bytes, or refuse it before it is sent. */
  admit(bytes: number): Effect.Effect<void, AiError.AiError> {
    return Effect.suspend(() => {
      const reason = this.#admit(bytes);

      return reason === null ? Effect.void : Effect.fail(refusal(reason));
    });
  }
  /** Refuse a request whose payload is outside the contract it would be priced under. */
  refuse(reason: Refusal): AiError.AiError {
    this.#refused ??= reason;

    return refusal(reason);
  }
  /** The admitted request's stream has ended; its reservation waits for settlement. */
  release(): void {
    this.#inFlight = false;
  }
  #admit(bytes: number): Refusal | null {
    if (this.#inFlight) return this.#refuse("concurrent");
    // A request that never settled is charged whole before the next is considered.
    this.#retain();
    if (this.#ledger.closed !== null) return this.#refuse("closed");
    const inputTokens = bytes + inputMargin;
    const outputTokens = this.#maxOutputTokens;

    const microusd = Math.ceil(
      (inputTokens * Math.max(this.#rates.input, this.#rates.cacheRead, this.#rates.cacheWrite) +
        outputTokens * this.#rates.output) /
        1_000_000,
    );

    if (this.#settledMicrousd + this.#retainedMicrousd + microusd > this.#limit)
      return this.#refuse("run-budget");
    if (
      this.#ledger.spentMicrousd + this.#ledger.pendingMicrousd + microusd >
      this.#ledger.limitMicrousd
    )
      return this.#refuse("campaign-budget");
    this.#pending = { microusd, inputTokens, outputTokens };
    this.#ledger.pendingMicrousd += microusd;
    this.#admitted++;
    this.#inFlight = true;

    return null;
  }
  #refuse(reason: Refusal): Refusal {
    this.#refused ??= reason;

    return reason;
  }
  #retain(): void {
    const pending = this.#pending;

    if (pending === null) return;
    this.#pending = null;
    this.#ledger.pendingMicrousd -= pending.microusd;
    this.#ledger.spentMicrousd += pending.microusd;
    this.#retainedMicrousd += pending.microusd;
  }
  /** Settle the pending reservation from reported usage; returns what it was charged. */
  settle(usage: Pick<Response.Usage, "inputTokens" | "outputTokens">): number {
    const pending = this.#pending;

    this.#inFlight = false;
    // Usage with nothing admitted means a request bypassed admission.
    if (pending === null) {
      this.#ledger.closed = "contract";
      this.#overrun = true;

      return 0;
    }
    const { inputTokens: reported, outputTokens: produced } = usage;

    const input =
      reported.total ??
      (reported.uncached === undefined
        ? undefined
        : reported.uncached + (reported.cacheRead ?? 0) + (reported.cacheWrite ?? 0));

    const output =
      produced.total ??
      (produced.text === undefined ? undefined : produced.text + (produced.reasoning ?? 0));

    if (input === undefined || output === undefined) {
      this.#retain();

      return pending.microusd;
    }
    this.#pending = null;
    this.#ledger.pendingMicrousd -= pending.microusd;
    const cacheRead = reported.cacheRead ?? 0;
    const cacheWrite = reported.cacheWrite ?? 0;

    const cost = Math.ceil(
      (Math.max(0, input - cacheRead - cacheWrite) * this.#rates.input +
        cacheRead * this.#rates.cacheRead +
        cacheWrite * this.#rates.cacheWrite +
        output * this.#rates.output) /
        1_000_000,
    );

    const broken = input > pending.inputTokens || output > pending.outputTokens;
    const charged = broken ? Math.max(cost, pending.microusd) : cost;

    this.#settled++;
    this.#tokens = {
      input: this.#tokens.input + input,
      cacheRead: this.#tokens.cacheRead + cacheRead,
      cacheWrite: this.#tokens.cacheWrite + cacheWrite,
      output: this.#tokens.output + output,
      reasoning: this.#tokens.reasoning + (produced.reasoning ?? 0),
    };
    this.#settledMicrousd += charged;
    this.#ledger.spentMicrousd += charged;
    if (broken) {
      this.#ledger.closed = "contract";
      this.#overrun = true;
    }

    return charged;
  }
  /** End the run: a reservation still pending is retained in full. */
  finish(): Usage {
    this.#inFlight = false;
    this.#retain();

    return this.usage();
  }
  usage(): Usage {
    const pending = this.#pending?.microusd ?? 0;
    const retained = this.#retainedMicrousd + pending;

    return {
      admitted: this.#admitted,
      settled: this.#settled,
      refused: this.#refused,
      overrun: this.#overrun,
      inputTokens: this.#tokens.input,
      cacheReadInputTokens: this.#tokens.cacheRead,
      cacheWriteInputTokens: this.#tokens.cacheWrite,
      outputTokens: this.#tokens.output,
      reasoningTokens: this.#tokens.reasoning,
      costMicrousd: this.#settledMicrousd + retained,
      retainedMicrousd: retained,
      limitMicrousd: this.#limit,
      status:
        this.#admitted === 0
          ? "no-calls"
          : retained > 0
            ? "includes-retained-reservations"
            : "estimated-from-reported-usage",
    };
  }
}
