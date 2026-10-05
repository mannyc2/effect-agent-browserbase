// What both runners share about one scheduled unit of work: its seed, its own browser, and how its
// exit becomes a durable status. A wrong answer is a result; a broken capture, provider or browser
// is not, and a refused or unstarted unit is neither.
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { Cause, Effect, Exit, type Layer, Option, Schema } from "effect";
import * as Agent from "effect-browser/Agent";
import type { Browser } from "effect-browser/Browser";
import { BrowserError } from "effect-browser/BrowserError";
import { BrowserbaseError } from "effect-browserbase/BrowserbaseError";
import { AiError } from "effect/ai";

import type { Calls, Endpoint } from "./Budget.ts";

/** The captured evidence cannot support a graded answer, so no model is asked about it. */
export class EvidenceIncomplete extends Schema.TaggedError<EvidenceIncomplete>()(
  "EvidenceIncomplete",
  { detail: Schema.String },
) {
  override get message() {
    return `capture incomplete: ${this.detail}`;
  }
}

/** The checkout a result came from; null where git cannot say. */
export interface Revision {
  readonly commit: string | null;
  /** Uncommitted changes make a result unreproducible from `commit` alone. */
  readonly dirty: boolean | null;
}

const git = (...args: ReadonlyArray<string>) =>
  execFileSync("git", args, {
    cwd: fileURLToPath(new URL(".", import.meta.url)),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  }).trim();

export const revision: Effect.Effect<Revision> = Effect.try(() => ({
  commit: git("rev-parse", "HEAD"),
  dirty: git("status", "--porcelain").length > 0,
})).pipe(Effect.orElseSucceed(() => ({ commit: null, dirty: null })));

/** The configuration a result depends on, recorded with it. */
export interface RunInfo {
  readonly revision: Revision;
  readonly model: string | null;
  /** The pinned OpenRouter endpoint and its per-call reservation; null without a model. */
  readonly endpoint: Endpoint | null;
  readonly browser: string;
  readonly humanize: boolean;
  readonly maxOutputTokens: number;
  readonly maxUsd: number;
  readonly concurrency: number;
}

/** Derivation depends on task identity, never dispatch order or provider random draws. */
export const trialSeed = (base: number, task: string, trial: number): number => {
  let seed = 2166136261;

  for (const character of `${base}:${task}:${trial}`) {
    seed = Math.imul(seed ^ character.charCodeAt(0), 16777619) >>> 0;
  }

  return seed;
};

/** A local memo map prevents parallel trials from sharing a scoped browser layer. */
export const isolatedTrial = <A, E, R, E2, R2>(
  trial: Effect.Effect<A, E, R | Browser>,
  browser: Layer.Layer<Browser, E2, R2>,
) => trial.pipe(Effect.provide(browser, { local: true }));

/**
 * `graded` units have a pass or fail; only they enter accuracy denominators. `denied` units were
 * stopped by the budget, `unrun` units never ran to an outcome, and `infrastructure-failed` units
 * failed for a reason other than the model's answer.
 */
export type Status = "graded" | "infrastructure-failed" | "denied" | "unrun";

export type Reason =
  | "answered"
  | "invalid-output"
  | "gave-up"
  | "step-limit"
  | "evidence-incomplete"
  | "preparation-failed"
  | "model-setup-failed"
  | "browser-failed"
  | "hosted-session-failed"
  | "provider-failed"
  | "charge-exceeded-bound"
  | "timed-out"
  | "defect"
  | "other"
  | "budget-exhausted"
  | "stopped-after-infrastructure"
  | "stopped-after-uncertain-charge"
  | "stopped-after-output-failure"
  | "interrupted";

export interface Classification {
  readonly status: Status;
  readonly reason: Reason;
  /** Only a graded unit passes or fails. */
  readonly pass: boolean | null;
}

const infrastructure = (reason: Reason): Classification => ({
  status: "infrastructure-failed",
  reason,
  pass: null,
});

const isAgentError = Schema.is(Agent.AgentError);
const isBrowserError = Schema.is(BrowserError);
const isBrowserbaseError = Schema.is(BrowserbaseError);
const isEvidenceIncomplete = Schema.is(EvidenceIncomplete);

/**
 * One policy for both runners. A model that gives up, runs out of steps, or returns output that
 * does not decode as the requested answer after its receipt was decoded and accounted has
 * answered wrongly. Budget refusals are denials. Everything else that prevents an answer is
 * infrastructure, never a wrong answer.
 */
export const classify = (
  exit: Exit.Exit<{ readonly pass: boolean }, unknown>,
  calls: Calls,
): Classification => {
  if (Exit.isSuccess(exit)) return { status: "graded", reason: "answered", pass: exit.value.pass };
  if (Cause.hasInterruptsOnly(exit.cause))
    return { status: "unrun", reason: "interrupted", pass: null };
  if (calls.refusal === "budget")
    return { status: "denied", reason: "budget-exhausted", pass: null };
  if (calls.refusal === "bound") return infrastructure("charge-exceeded-bound");

  const found = Cause.findErrorOption(exit.cause);

  if (Option.isNone(found)) return infrastructure("defect");
  const error = found.value;

  if (isAgentError(error))
    return {
      status: "graded",
      reason: error.reason._tag === "StepLimit" ? "step-limit" : "gave-up",
      pass: false,
    };
  if (
    AiError.isAiError(error) &&
    error.reason._tag === "StructuredOutputError" &&
    calls.lastResponse !== null &&
    calls.lastResponse.call === calls.accounting.calls
  )
    return { status: "graded", reason: "invalid-output", pass: false };
  if (isEvidenceIncomplete(error)) return infrastructure("evidence-incomplete");
  if (Cause.isTimeoutError(error)) return infrastructure("timed-out");
  if (isBrowserError(error)) return infrastructure("browser-failed");
  if (isBrowserbaseError(error)) return infrastructure("hosted-session-failed");
  if (AiError.isAiError(error)) return infrastructure("provider-failed");

  return infrastructure("other");
};

/** Counts that keep graded denominators apart from units that never produced an answer. */
export const tally = (
  records: ReadonlyArray<{ readonly status: Status; readonly pass: boolean | null }>,
) => {
  const graded = records.filter((record) => record.status === "graded");

  return {
    scheduled: records.length,
    graded: graded.length,
    passed: graded.filter((record) => record.pass === true).length,
    failed: graded.filter((record) => record.pass === false).length,
    infrastructureFailed: records.filter((record) => record.status === "infrastructure-failed")
      .length,
    denied: records.filter((record) => record.status === "denied").length,
    unrun: records.filter((record) => record.status === "unrun").length,
  };
};
