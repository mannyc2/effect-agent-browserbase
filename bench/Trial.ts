// What both runners share about one scheduled unit of work: its seed, its own browser, and how its
// exit becomes a durable status. A wrong answer is a result; a broken capture, provider or browser
// is not, and a refused or unstarted unit is neither.
import {
  Cause,
  Clock,
  Duration,
  Effect,
  Exit,
  type Layer,
  Option,
  Ref,
  Schema,
  Stream,
} from "effect";
import * as Agent from "effect-browser/Agent";
import type { Browser } from "effect-browser/Browser";
import { BrowserError } from "effect-browser/BrowserError";
import { BrowserbaseError } from "effect-browserbase/BrowserbaseError";
import { AiError } from "effect/ai";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

import { type Account, type Calls, Endpoint, type Halt, noCalls, noTiming } from "./Budget.ts";
import { FixtureUnreadable } from "./Sites.ts";

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
export const Revision = Schema.Struct({
  commit: Schema.NullOr(Schema.String),
  /** Uncommitted changes make a result unreproducible from `commit` alone. */
  dirty: Schema.NullOr(Schema.Boolean),
});

export type Revision = typeof Revision.Type;

// What git prints, or nothing where it fails, such as outside a checkout.
const git = Effect.fnUntraced(function* (args: ReadonlyArray<string>) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const handle = yield* spawner.spawn(
    ChildProcess.make("git", args, { cwd: import.meta.dirname, stderr: "ignore" }),
  );

  const [output, code] = yield* Effect.all(
    [Stream.mkString(Stream.decodeText(handle.stdout)), handle.exitCode],
    { concurrency: 2 },
  );

  return code === 0 ? Option.some(output.trim()) : Option.none();
}, Effect.scoped);

export const revision: Effect.Effect<Revision, never, ChildProcessSpawner.ChildProcessSpawner> =
  Effect.all([git(["rev-parse", "HEAD"]), git(["status", "--porcelain"])]).pipe(
    Effect.map(([commit, status]) => ({
      commit: Option.getOrNull(commit),
      dirty: Option.getOrNull(Option.map(status, (changes) => changes.length > 0)),
    })),
    Effect.orElseSucceed(() => ({ commit: null, dirty: null })),
  );

/**
 * Two families of seeds: `dev` for working on prompts and tools against the pages, and `eval`,
 * held out for comparing arms. Each eval seed hashes the split in, so it is drawn independently of
 * the dev seed of the same trial.
 */
export const Split = Schema.Literals(["dev", "eval"]);

export type Split = typeof Split.Type;

/** The configuration a result depends on, recorded with it. */
export const RunInfo = Schema.Struct({
  revision: Revision,
  model: Schema.NullOr(Schema.String),
  /** The pinned OpenRouter endpoint and its per-call reservation; null without a model. */
  endpoint: Schema.NullOr(Endpoint),
  browser: Schema.Literals(["chromium", "browserbase"]),
  /** Added round-trip milliseconds on a local browser's DevTools connection; null for none. */
  latencyMillis: Schema.NullOr(Schema.Finite),
  humanize: Schema.Boolean,
  maxOutputTokens: Schema.Int,
  maxUsd: Schema.Finite,
  concurrency: Schema.Int,
  /**
   * Recording and narration each run a screencast, which lets an observation reuse a frame
   * instead of capturing one, and narration adds model calls: their trials time differently.
   */
  record: Schema.Boolean,
  narrateSeconds: Schema.NullOr(Schema.Finite),
  /** Which family of seeds the trials drew from; see `Split`. */
  split: Split,
});

export type RunInfo = typeof RunInfo.Type;

/** Derivation depends on task identity, never dispatch order or provider random draws. */
export const trialSeed = (base: number, task: string, trial: number, split: Split = "dev") => {
  let seed = 2166136261;

  for (const character of `${split === "dev" ? "" : `${split}:`}${base}:${task}:${trial}`) {
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
export const Status = Schema.Literals(["graded", "infrastructure-failed", "denied", "unrun"]);

export type Status = typeof Status.Type;

export const Reason = Schema.Literals([
  "answered",
  "invalid-output",
  "gave-up",
  "step-limit",
  "evidence-incomplete",
  "fixture-unreadable",
  "preparation-failed",
  "model-setup-failed",
  "browser-failed",
  "hosted-session-failed",
  "provider-failed",
  "charge-exceeded-bound",
  "timed-out",
  "defect",
  "other",
  "budget-exhausted",
  "stopped-after-charge-bound",
  "stopped-after-infrastructure",
  "stopped-after-uncertain-charge",
  "stopped-after-output-failure",
  "stopped-after-uncertain-session",
  "interrupted",
]);

export type Reason = typeof Reason.Type;

export interface Classification {
  readonly status: Status;
  readonly reason: Reason;
  /** Only a graded unit passes or fails. */
  readonly pass: boolean | null;
}

const stopReasons: { readonly [Cause in Halt]: Reason } = {
  "charge-exceeded-bound": "stopped-after-charge-bound",
  infrastructure: "stopped-after-infrastructure",
  "uncertain-charge": "stopped-after-uncertain-charge",
  "output-failed": "stopped-after-output-failure",
};

/**
 * A unit the ledger did not admit: denied when the budget had no room, unrun with the run's own
 * stop reason when the ledger had halted. Both runners label it the same way.
 */
export const notAdmitted = (halt: Halt | null): Classification =>
  halt === null
    ? { status: "denied", reason: "budget-exhausted", pass: null }
    : { status: "unrun", reason: stopReasons[halt], pass: null };

const infrastructure = (reason: Reason): Classification => ({
  status: "infrastructure-failed",
  reason,
  pass: null,
});

const isAgentError = Schema.is(Agent.AgentError);

// Reasons the model's own decoded output caused: an answer or tool arguments that do not parse
// or fit their schema, or a tool that does not exist. A provider envelope that does not decode
// is not among them.
const modelOutput: ReadonlySet<string> = new Set([
  "StructuredOutputError",
  "ToolParameterValidationError",
  "ToolNotFoundError",
]);

const isBrowserError = Schema.is(BrowserError);
const isBrowserbaseError = Schema.is(BrowserbaseError);
const isEvidenceIncomplete = Schema.is(EvidenceIncomplete);
const isFixtureUnreadable = Schema.is(FixtureUnreadable);

/**
 * One policy for both runners. A model that gives up, runs out of steps, or returns output that
 * does not decode as the requested answer or tool call after its receipt was decoded and
 * accounted has answered wrongly. Budget refusals are denials. A request without a decoded
 * response, and everything else that prevents an answer, is infrastructure, never a wrong answer.
 */
export const classify = (
  exit: Exit.Exit<{ readonly pass: boolean }, unknown>,
  calls: Calls,
): Classification => {
  if (Exit.isSuccess(exit)) return { status: "graded", reason: "answered", pass: exit.value.pass };
  if (Cause.hasInterruptsOnly(exit.cause))
    return { status: "unrun", reason: "interrupted", pass: null };
  if (calls.refusal === "budget") return notAdmitted(calls.halt);
  if (calls.refusal === "bound") return infrastructure("charge-exceeded-bound");
  if (calls.refusal === "unresolved") return infrastructure("provider-failed");

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
    modelOutput.has(error.reason._tag) &&
    calls.lastResponse !== null &&
    calls.lastResponse.call === calls.accounting.calls
  )
    return { status: "graded", reason: "invalid-output", pass: false };
  if (isEvidenceIncomplete(error)) return infrastructure("evidence-incomplete");
  // Operate graders turn an unreadable fixture into a failed grade; elsewhere the fixture is ours.
  if (isFixtureUnreadable(error)) return infrastructure("fixture-unreadable");
  if (Cause.isTimeoutError(error)) return infrastructure("timed-out");
  if (isBrowserError(error)) return infrastructure("browser-failed");
  if (isBrowserbaseError(error)) return infrastructure("hosted-session-failed");
  if (AiError.isAiError(error)) return infrastructure("provider-failed");

  return infrastructure("other");
};

/**
 * Whether a failed session create may have left a hosted browser that nobody can release: no
 * answer arrived (Transport), the server failed or timed out after accepting it (5xx, 408), or
 * its success answer did not decode and the session was not released. A refusal (429 or another
 * 4xx) allocated nothing, and a session the client released after a bad answer is gone.
 */
const uncertainCreate = (error: BrowserbaseError): boolean => {
  if (error.operation !== "createSession") return false;
  const reason = error.reason;

  switch (reason._tag) {
    case "Transport":
      return true;
    case "Status":
      return reason.status >= 500 || reason.status === 408;
    case "Decode":
      return reason.released !== true;
    case "RateLimited":
    case "Unauthorized":
    case "NotFound":
    case "InvalidRequest":
      return false;
  }
};

export const uncertainAllocation = (cause: Cause.Cause<unknown>): boolean =>
  cause.reasons.some(
    (reason) =>
      Cause.isFailReason(reason) &&
      isBrowserbaseError(reason.error) &&
      uncertainCreate(reason.error),
  );

/**
 * Fails with a `TimeoutError` once a unit has worked for `limit`. Time it spent queued for budget
 * admission depends on the budget and on other units, so it does not count: a deadline hit is
 * then the unit's own slowness, still infrastructure, never a budget artefact.
 */
export const workDeadline = (limit: Duration.Input, queued: Effect.Effect<number>) =>
  Effect.gen(function* () {
    const allowed = Duration.toMillis(Duration.fromInputUnsafe(limit));
    const started = yield* Clock.monotonicTimeNanos;

    while (true) {
      const elapsed = Number((yield* Clock.monotonicTimeNanos) - started) / 1e6;
      const worked = elapsed - (yield* queued) * 1000;

      if (worked >= allowed)
        return yield* new Cause.TimeoutError(`no outcome within ${allowed}ms of work`);
      yield* Effect.sleep(Duration.millis(allowed - worked));
    }
  });

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

/**
 * The units of a run that have no saved record yet, with the account each one's calls use. Each
 * unit is claimed exactly once: by its own record, or by `drain` when the run is interrupted,
 * which keeps what its calls already spent or reserved.
 */
export const journal = <Key>(keys: ReadonlyArray<Key>) =>
  Effect.gen(function* () {
    const pending = yield* Ref.make<ReadonlyMap<Key, Account | undefined>>(
      new Map(keys.map((key) => [key, undefined])),
    );

    const claim = (key: Key) =>
      Ref.modify(pending, (units) => {
        const next = new Map(units);

        return [next.delete(key), next];
      });

    return {
      begin: (key: Key, account: Account) =>
        Ref.update(pending, (units) => (units.has(key) ? new Map(units).set(key, account) : units)),
      /** Save a unit's record unless an interruption already recorded it. */
      settle: <E, R>(key: Key, save: Effect.Effect<void, E, R>) =>
        Effect.uninterruptible(
          claim(key).pipe(Effect.flatMap((claimed) => (claimed ? save : Effect.void))),
        ),
      /** Claim every unit still pending, with its calls and timing so far. */
      drain: Ref.getAndSet(pending, new Map()).pipe(
        Effect.flatMap((units) =>
          Effect.forEach([...units], ([key, account]) =>
            account === undefined
              ? Effect.succeed({ key, calls: noCalls, timing: noTiming })
              : Effect.all({ calls: account.calls, timing: account.timing }).pipe(
                  Effect.map(({ calls, timing }) => ({ key, calls, timing })),
                ),
          ),
        ),
      ),
    };
  });
