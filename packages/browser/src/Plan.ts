import { Data, type Duration, Effect, Schema, type Scope } from "effect";

import type { ElementAdmission, OperationOptions } from "./Browser.ts";
import type { CheckpointOptions } from "./BrowserData.ts";
import type { BrowserError } from "./Errors.ts";
import { guardedDecode } from "./internal/browser/PlanInput.ts";
import { checkedRunOptions } from "./internal/browser/PlanOptions.ts";
import { namedInputs } from "./internal/browser/Recording.ts";
import {
  type AttemptSnapshot,
  type InputBindings,
  LivePlan,
  type LivePlanEncoded,
  Plan,
  type PlanEncoded,
  type PerformedEncoded,
  type Ran,
  type RanStep,
  type StepAttempt,
} from "./PlanData.ts";

/** All execution stays on the issued Page/Frame and its original scoped owner. */
export interface RunOptions extends OperationOptions {
  readonly style?: "plain" | PerformedEncoded;
  /** Intended boundary in this owner's original monotonic runtime, measured when executed. */
  readonly startAt?: bigint;
  readonly within?: Duration.Input;
  readonly through?: string;
  readonly inputs?: InputBindings;
  readonly policy?: ElementAdmission;
  readonly checkpoint?: CheckpointOptions;
}

/** Normalize host options without exposing private deadline/queue accounting fields. */
export const validateOptions = (value: unknown): Effect.Effect<RunOptions, BrowserError> =>
  checkedRunOptions(value).pipe(
    Effect.map(({ withinMillis: _withinMillis, queueMillis: _queueMillis, ...options }) => options),
  );

interface StepFailure {
  readonly stage: "PreparationFailed" | "AttemptFailed";
  readonly stepId?: string;
  readonly completed: ReadonlyArray<RanStep>;
  readonly attempt?: StepAttempt;
  readonly error: BrowserError;
}

/**
 * Live host failure evidence is not a durable plan or a serialization schema. Its message names
 * only the stage, step and reason; the evidence fields can retain authored literal values, so
 * log the message rather than the whole value.
 */
export class StepFailed extends Data.TaggedError("StepFailed")<
  StepFailure & { readonly message: string }
> {
  constructor(failure: StepFailure) {
    const { operation, reason, outcome } = failure.error;

    const where =
      failure.stage === "PreparationFailed"
        ? "Plan preparation failed"
        : `Step ${failure.stepId ?? "(unknown)"} failed`;

    super({ ...failure, message: `${where}: ${operation} ${reason._tag} (${outcome})` });
  }
}

export class RecordingIncomplete extends Data.TaggedError("RecordingIncomplete")<{
  readonly stepId?: string;
  readonly reason: "InvalidThrough" | "NoCompletedSteps" | "IncompleteCapture" | "Unacknowledged";
}> {}

/** A retained value keeps its evidence after interruption; joining never submits another walk. */
export interface RunOperation {
  readonly id: string;
  readonly attempts: Effect.Effect<AttemptSnapshot>;
  readonly completed: Effect.Effect<Ran, StepFailed>;
  readonly cancel: Effect.Effect<void>;
}

export interface PlanOperations {
  readonly start: (
    plan: LivePlanEncoded | PlanEncoded,
    options?: RunOptions,
  ) => Effect.Effect<RunOperation, StepFailed, Scope.Scope>;
  readonly run: (
    plan: LivePlanEncoded | PlanEncoded,
    options?: RunOptions,
  ) => Effect.Effect<Ran, StepFailed>;
}

/** Validate and normalize authored data, including explicit document/Strict defaults. */
export const make = (value: LivePlanEncoded) =>
  guardedDecode(LivePlan)(value, { onExcessProperty: "error" });

/** Descriptor-only ingress for stored intent; it never decodes a live Ref. */
export const decode = (value: unknown) => guardedDecode(Plan)(value, { onExcessProperty: "error" });

/** The normalized scope and guards are always included in encoded durable intent. */
export const encode = (value: Plan) =>
  guardedDecode(Plan)(value, { onExcessProperty: "error" }).pipe(
    Effect.flatMap(Schema.encodeEffect(Plan)),
  );

/** A named input a plan reads: the step and action path that read it, and how it is used. */
export interface InputSlot {
  readonly name: string;
  readonly stepId: string;
  readonly path: ReadonlyArray<string>;
  /** `text` is typed key by key into focus; `value` replaces a field's whole contents. */
  readonly kind: "text" | "value";
}

/**
 * The named inputs a stored or live plan reads, in step order. A recorded plan's literal fill and
 * type values are such slots; bind each `name` in `inputs` to replay it.
 */
export const inputSlots = (plan: Plan | LivePlan): ReadonlyArray<InputSlot> =>
  namedInputs(plan.steps);

/**
 * Project only acknowledged, faithfully captured intent. An explicitly chosen completed prefix
 * can be retained after a later failure by passing the operation's host snapshot and `through`.
 * Literal input values are replaced during capture with deterministic named input slots.
 */
export const recorded = (
  value: Ran | AttemptSnapshot,
  options?: { readonly through?: string },
): Effect.Effect<Plan, RecordingIncomplete> =>
  Effect.gen(function* () {
    const steps = "steps" in value ? value.steps : value.completed;
    const through = options?.through;

    const last =
      through === undefined ? steps.length - 1 : steps.findIndex((step) => step.id === through);

    if (through !== undefined && last < 0)
      return yield* new RecordingIncomplete({ stepId: through, reason: "InvalidThrough" });
    if (steps.length === 0) return yield* new RecordingIncomplete({ reason: "NoCompletedSteps" });
    if (!("steps" in value) && through === undefined)
      return yield* new RecordingIncomplete({ reason: "Unacknowledged" });
    const selected = steps.slice(0, last + 1);

    for (const step of selected) {
      if (
        !step.attempt.completed ||
        step.attempt.outcome === "unknown" ||
        step.attempt.outcome === "rejected" ||
        (step.receipt !== undefined &&
          typeof step.receipt === "object" &&
          "stopped" in step.receipt &&
          step.receipt.stopped !== undefined)
      )
        return yield* new RecordingIncomplete({ stepId: step.id, reason: "Unacknowledged" });
      if (step.recorded._tag === "Incomplete")
        return yield* new RecordingIncomplete({ stepId: step.id, reason: "IncompleteCapture" });
    }

    const projected = {
      version: 1,
      steps: selected.map((step) => ({
        id: step.id,
        action: step.recorded._tag === "Complete" ? step.recorded.action : undefined,
        ...(step.sourceStep.expect === undefined ? {} : { expect: step.sourceStep.expect }),
        resolution: step.sourceStep.resolution,
      })),
    };

    return yield* guardedDecode(Plan)(projected, { onExcessProperty: "error" }).pipe(
      Effect.mapError(() => new RecordingIncomplete({ reason: "IncompleteCapture" })),
    );
  });
