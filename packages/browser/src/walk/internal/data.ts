/** Serializable plan steps, expected effects, receipts and durable stopping evidence. */
import { Schema } from "effect";

import { Action } from "../../Action.ts";
import { BrowserError } from "../../BrowserError.ts";
import { Box, Subject } from "../../BrowserEvent.ts";
import { Ambiguous, Drifted, Missing } from "./choose.ts";

/** Reuse the execution variants; recorded code has no serializable replay capability. */
const ReplayAction = Action.pipe(
  Schema.refine(
    (value): value is Exclude<Action, { readonly _tag: "Act" }> => value._tag !== "Act",
  ),
);

const Query = Schema.Struct({
  role: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  text: Schema.optional(Schema.String),
});

/**
 * What a step leaves. `durable` asserts an author-chosen, lasting read-back of this operation,
 * such as its uniquely named saved receipt or exact operation URL. Only Appeared and an exact
 * Navigated URL allow it; a toast, absence or relative navigation cannot establish recovery.
 * Relative navigation measures observed change from dispatch, without asserting causality.
 */
export const Expected = Schema.Union([
  Schema.TaggedStruct("Checked", { checked: Schema.Boolean }),
  Schema.TaggedStruct("Appeared", {
    query: Query,
    durable: Schema.optional(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Gone", {
    query: Query,
    durable: Schema.optional(Schema.Never),
  }),
  Schema.TaggedStruct("Navigated", {
    url: Schema.String,
    durable: Schema.optional(Schema.Literal(true)),
  }),
  Schema.TaggedStruct("Navigated", {
    url: Schema.optional(Schema.Never),
    durable: Schema.optional(Schema.Never),
  }),
]);

export type Expected = typeof Expected.Type;

/** One recorded step: the action, what it acted on, and what else it was asked. */
export class Step extends Schema.Class<Step>("effect-browser/walk/Walk/Step")({
  action: ReplayAction,
  /** The address reached, including a delayed navigation before the next action began. */
  url: Schema.String,
  subject: Schema.optional(Subject),
  /** Where a drag ended. */
  to: Schema.optional(Subject),
  /** The recorded box keeps a point at the same relative position within its subject. */
  box: Schema.optional(Box),
  /** A slot replaces recorded typing text or a navigation address with withheld credentials. */
  input: Schema.optional(Schema.String),
  expect: Schema.optional(Expected),
}) {}

export class Walk extends Schema.Class<Walk>("effect-browser/walk/Walk")({
  version: Schema.Literal(3),
  steps: Schema.Array(Step),
}) {
  /** Version 3 carries canonical typed Actions; prior string-action encodings are rejected. */
  static new(steps: ReadonlyArray<Step>): Walk {
    return new Walk({ version: 3, steps });
  }

  /** The input slots its steps type, in order; replay needs text for each. */
  get inputs(): ReadonlyArray<string> {
    return this.steps.flatMap((step) => (step.input === undefined ? [] : [step.input]));
  }
}

/** One completed step, on the page's host clock. `verified` means its expected effect was seen. */
export class Receipt extends Schema.Class<Receipt>("effect-browser/walk/Walk/Receipt")({
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  outcome: Schema.Literals(["taken", "verified", "skipped"]),
  startedAt: Schema.Finite,
  at: Schema.Finite,
}) {}

/** Durable stopping data. A begun step without a receipt must be restored as `unknown`. */
export class Stopped extends Schema.Class<Stopped>("effect-browser/walk/Walk/Stopped")({
  step: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  input: Schema.Literals(["unsent", "unknown"]),
}) {}

/** Repeating this step could repeat an unresolved effect; the consumer must reconcile it. */
export class Uncertain extends Schema.TaggedError<Uncertain>("effect-browser/walk/Walk/Uncertain")(
  "Uncertain",
  {
    detail: Schema.String,
  },
) {
  override get message() {
    return this.detail;
  }
}

/** Why replay stopped, as `ReplayError`'s `reason`. */
export const ReplayErrorReason = Schema.Union([
  Missing,
  Ambiguous,
  Drifted,
  BrowserError,
  Uncertain,
]);

export type ReplayErrorReason = typeof ReplayErrorReason.Type;

/** Where replay stopped, counting steps from 0, why, and the steps that completed before it. */
export class ReplayError extends Schema.TaggedError<ReplayError>(
  "effect-browser/walk/Walk/ReplayError",
)("ReplayError", {
  step: Schema.Int,
  reason: ReplayErrorReason,
  input: Schema.Literals(["unsent", "unknown"]),
  receipts: Schema.Array(Receipt),
}) {
  get stopped(): Stopped {
    return new Stopped({ step: this.step, input: this.input });
  }

  override get message() {
    return `step ${this.step} failed: ${this.reason.message}`;
  }
}

/** Whether a value is a `ReplayError`. */
export const isReplayError: (u: unknown) => u is ReplayError = Schema.is(ReplayError);

/** Whether a value is one of `ReplayError`'s reasons. */
export const isReplayErrorReason: (u: unknown) => u is ReplayErrorReason =
  Schema.is(ReplayErrorReason);
