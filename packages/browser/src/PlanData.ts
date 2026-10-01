import { type Cause, Effect, Schema } from "effect";

import {
  type ActionResult,
  type Checkpoint,
  ControlFacts,
  FillFormOptions,
  type FillFormResult,
  FillRequest,
  Identifier,
  type InputReceipt,
  KeyStroke,
  NavigateRequest,
  type NavigationResult,
  ObservedElement,
  PointerMoveRequest,
  ScrollRequest,
  TargetUrl,
  TypeRequest,
  Viewport,
  ViewportRect,
  WaitForElementRequest,
  WheelRequest,
} from "./BrowserData.ts";
import type { BrowserError, BrowserOutcome, Containment, InitializationError } from "./Errors.ts";

/** These bounds limit one authored walk, independently of the owner's remaining allowance. */
export const Limits = {
  steps: 128,
  identifierLength: 128,
  encodedBytes: 1024 * 1024,
  inputBytes: 65536,
  frameDepth: 8,
  conditions: 16,
  fields: 32,
  options: 64,
} as const;

const utf8 = new TextEncoder();
const closed = { parseOptions: { onExcessProperty: "error" } } as const;

const motionRange = (maximum: number, minimum = 0) =>
  Schema.Struct({
    minMillis: Schema.Finite.check(Schema.isBetween({ minimum, maximum })),
    maxMillis: Schema.Finite.check(Schema.isBetween({ minimum, maximum })),
  })
    .check(
      Schema.makeFilter((value) => value.minMillis <= value.maxMillis, {
        title: "ordered finite duration bounds",
      }),
    )
    .annotate(closed);

/** Chosen bounded presentation policy; these constants are not scientific calibration. */
export const MotionProfile = Schema.Struct({
  name: Schema.Literal("default"),
  pointer: Schema.Struct({
    duration: motionRange(5000),
    aimInset: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.49 })),
    curvature: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 0.25 })),
  }).annotate(closed),
  keys: Schema.Struct({
    interval: motionRange(1000),
    hold: motionRange(500),
  }).annotate(closed),
  scroll: Schema.Struct({
    duration: motionRange(5000),
    intervalMillis: Schema.Finite.check(Schema.isBetween({ minimum: 8, maximum: 250 })),
  }).annotate(closed),
}).annotate(closed);

export type MotionProfile = typeof MotionProfile.Type;

export const DefaultMotionProfile: MotionProfile = Object.freeze({
  name: "default",
  pointer: Object.freeze({
    duration: Object.freeze({ minMillis: 120, maxMillis: 1500 }),
    aimInset: 0.15,
    curvature: 0.08,
  }),
  keys: Object.freeze({
    interval: Object.freeze({ minMillis: 30, maxMillis: 70 }),
    hold: Object.freeze({ minMillis: 10, maxMillis: 30 }),
  }),
  scroll: Object.freeze({
    duration: Object.freeze({ minMillis: 120, maxMillis: 800 }),
    intervalMillis: 20,
  }),
});

/** Serialized style contains policy data, never callbacks, random services or native authority. */
export const Performed = Schema.Struct({
  motion: MotionProfile.pipe(Schema.withDecodingDefaultKey(Effect.succeed(DefaultMotionProfile))),
  seed: Schema.optionalKey(Schema.Int),
  slips: Schema.Struct({
    probability: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  })
    .annotate(closed)
    .pipe(Schema.withDecodingDefaultKey(Effect.succeed({ probability: 0 }))),
}).annotate(closed);

export type Performed = typeof Performed.Type;
export type PerformedEncoded = typeof Performed.Encoded;

export const StepId = Identifier.check(Schema.isMaxLength(Limits.identifierLength));

export type StepId = typeof StepId.Type;

export const InputName = Identifier.check(Schema.isMaxLength(256));

export type InputName = typeof InputName.Type;

export const InputValue = FillRequest.fields.value.check(
  Schema.makeFilter((value) => utf8.encode(value).byteLength <= Limits.inputBytes, {
    title: "at most 65,536 UTF-8 input bytes",
  }),
);

export type InputValue = typeof InputValue.Type;

export const InputBindings = Schema.Record(InputName, InputValue)
  .check(
    Schema.makeFilter((values) => Object.keys(values).length <= Limits.steps * Limits.fields, {
      title: "at most 4,096 named inputs",
    }),
    Schema.makeFilter(
      (values) => utf8.encode(JSON.stringify(values)).byteLength <= Limits.encodedBytes,
      {
        title: "at most 1 MiB of encoded input bindings",
      },
    ),
  )
  .annotate(closed);

export type InputBindings = typeof InputBindings.Type;

export const MatchScope = Schema.Literals(["document", "viewport"]);

export type MatchScope = typeof MatchScope.Type;

/** Zero-based index, accepted only after the complete filtered candidate count equals `of`. */
export const Ordinal = Schema.Struct({
  index: Schema.Natural,
  of: Schema.Int.check(Schema.isGreaterThan(0)),
})
  .check(Schema.makeFilter((value) => value.index < value.of, { title: "index less than of" }))
  .annotate(closed);

export type Ordinal = typeof Ordinal.Type;

/** Each segment is resolved among the exact parent's complete child-frame inventory. */
export const FrameDescriptor = Schema.Struct({
  path: Schema.Array(
    Schema.Struct({
      name: Schema.NonEmptyString.check(Schema.isMaxLength(256)),
      url: Schema.String.check(Schema.isMaxLength(8192)),
      ordinal: Schema.optionalKey(Ordinal),
    }).annotate(closed),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(Limits.frameDepth)),
}).annotate(closed);

export type FrameDescriptor = typeof FrameDescriptor.Type;

/** Full raw label equality; geometry is diagnostic and never chooses a candidate. */
export const Descriptor = Schema.Struct({
  kind: ControlFacts.fields.kind,
  label: ControlFacts.fields.label,
  matchScope: MatchScope.pipe(Schema.withDecodingDefaultKey(Effect.succeed("document"))),
  destination: Schema.optionalKey(ControlFacts.fields.destination.schema),
  identity: Schema.optionalKey(
    Schema.Struct({
      inputType: ControlFacts.fields.inputType,
      autocomplete: ControlFacts.fields.autocomplete,
      formMethod: ControlFacts.fields.formMethod,
    }).annotate(closed),
  ),
  ordinal: Schema.optionalKey(Ordinal),
  near: Schema.optionalKey(ViewportRect),
  frame: Schema.optionalKey(FrameDescriptor),
}).annotate(closed);

export type Descriptor = typeof Descriptor.Type;
export type DescriptorEncoded = typeof Descriptor.Encoded;

export const RecordedTarget = Schema.TaggedStruct("Descriptor", {
  descriptor: Descriptor,
}).annotate(closed);

export type RecordedTarget = typeof RecordedTarget.Type;

export const ActionTarget = Schema.Union([
  Schema.TaggedStruct("Ref", { reference: ObservedElement }).annotate(closed),
  RecordedTarget,
]);

export type ActionTarget = typeof ActionTarget.Type;

const valueSource = <S extends Schema.Constraint>(value: S) =>
  Schema.TaggedUnion({ Literal: { value }, Input: { name: InputName } }).annotate(closed);

export const ValueSource = valueSource(InputValue);

export type ValueSource = typeof ValueSource.Type;

const TypeValueSource = valueSource(TypeRequest.fields.text);
const Milliseconds = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 60000 }));
const PositiveMilliseconds = Milliseconds.check(Schema.isGreaterThan(0));

export const SettledOptions = Schema.Struct({
  quietMillis: PositiveMilliseconds,
  withinMillis: PositiveMilliseconds,
})
  .check(
    Schema.makeFilter((value) => value.quietMillis <= value.withinMillis, {
      title: "quiet interval fits within the original deadline",
    }),
  )
  .annotate(closed);

export type SettledOptions = typeof SettledOptions.Type;

const Origin = TargetUrl.check(
  Schema.makeFilter((value) => new URL(value).origin === value, {
    title: "an exact http(s) origin",
  }),
);

/** Conditions are bounded data. No expression, selector, callback or regular expression is accepted. */
export const Precondition = Schema.TaggedUnion({
  Origin: { value: Origin },
  Path: { value: Schema.String.check(Schema.isMaxLength(8192), Schema.isPattern(/^\//)) },
  Text: {
    value: Schema.String.check(Schema.isMaxLength(131072)),
    match: Schema.Literals(["equals", "contains"]),
    scope: MatchScope.pipe(Schema.withDecodingDefaultKey(Effect.succeed("document"))),
  },
  Viewport: { ...Viewport.fields },
  Scroll: { x: Schema.Finite, y: Schema.Finite },
  Geometry: { target: Descriptor, box: ViewportRect },
}).annotate(closed);

export type Precondition = typeof Precondition.Type;

export const Condition = Precondition;

export type Condition = typeof Condition.Type;

export const Postcondition = Precondition;

export type Postcondition = typeof Postcondition.Type;

const Conditions = Schema.Array(Precondition).check(
  Schema.isMinLength(1),
  Schema.isMaxLength(Limits.conditions),
);

export const Expectation = Schema.Struct({
  before: Schema.optionalKey(Conditions),
  after: Schema.optionalKey(Conditions),
})
  .check(
    Schema.makeFilter((value) => value.before !== undefined || value.after !== undefined, {
      title: "at least one precondition or postcondition",
    }),
  )
  .annotate(closed);

export type Expectation = typeof Expectation.Type;

export const ResolveGuard = Schema.TaggedUnion({
  Strict: {},
  ViewportContext: { before: Conditions },
}).annotate(closed);

export type ResolveGuard = typeof ResolveGuard.Type;

/** One variant definition owns both live authority and descriptor-only durable projections. */
const actionSchema = <T extends Schema.Constraint>(target: T) => {
  const options = Schema.Array(target).check(
    Schema.isMinLength(1),
    Schema.isMaxLength(Limits.options),
    Schema.makeFilter(
      (values) => new Set(values.map((value) => JSON.stringify(value))).size === values.length,
      {
        title: "each option target at most once",
      },
    ),
  );

  const fields = Schema.Array(
    Schema.TaggedUnion({
      Value: { target, value: ValueSource },
      Checked: { target, checked: Schema.Boolean },
      Options: { target, options },
    }).annotate(closed),
  ).check(Schema.isMinLength(1), Schema.isMaxLength(Limits.fields));

  return Schema.TaggedUnion({
    Navigate: { ...NavigateRequest.fields },
    Click: { target },
    Hover: { target },
    Fill: { target, value: ValueSource },
    Type: { target: Schema.optionalKey(target), text: TypeValueSource },
    Press: { target: Schema.optionalKey(target), ...KeyStroke.fields },
    Select: { target, options },
    Scroll: {
      mode: Schema.TaggedUnion({
        By: { ...ScrollRequest.fields },
        To: { target },
      }).annotate(closed),
    },
    PointerMove: { ...PointerMoveRequest.fields },
    Wheel: { ...WheelRequest.fields },
    Wait: {
      mode: Schema.Union([
        Schema.TaggedStruct("Duration", { milliseconds: Milliseconds }).annotate(closed),
        Schema.TaggedStruct("Element", {
          target,
          state: WaitForElementRequest.fields.state,
          timeoutMillis: WaitForElementRequest.fields.timeoutMillis,
        }).annotate(closed),
        Schema.TaggedStruct("Settled", SettledOptions.fields)
          .check(Schema.makeFilter((value) => value.quietMillis <= value.withinMillis))
          .annotate(closed),
      ]),
    },
    FillForm: {
      fields,
      submit: Schema.optionalKey(target),
      options: Schema.optionalKey(FillFormOptions),
    },
  }).annotate(closed);
};

export const Action = actionSchema(ActionTarget);

export type Action = typeof Action.Type;

export const RecordedAction = actionSchema(RecordedTarget);

export type RecordedAction = typeof RecordedAction.Type;
export type RecordedActionEncoded = typeof RecordedAction.Encoded;

const stepSchema = <A extends Schema.Constraint>(action: A) =>
  Schema.Struct({
    id: StepId,
    action,
    expect: Schema.optionalKey(Expectation),
    resolution: ResolveGuard.pipe(
      Schema.withDecodingDefaultKey(Effect.succeed({ _tag: "Strict" })),
    ),
  }).annotate(closed);

export const Step = stepSchema(Action);

export type Step = typeof Step.Type;

export const RecordedStep = stepSchema(RecordedAction);

export type RecordedStep = typeof RecordedStep.Type;

export const PlanProvenance = Schema.Struct({
  library: Schema.Literal("effect-browser"),
  version: Schema.NonEmptyString.check(Schema.isMaxLength(64)),
}).annotate(closed);

export type PlanProvenance = typeof PlanProvenance.Type;

const planSchema = <S extends Schema.Constraint & { readonly Type: { readonly id: string } }>(
  step: S,
) =>
  Schema.Struct({
    version: Schema.Literal(1),
    provenance: Schema.optionalKey(PlanProvenance),
    steps: Schema.Array(step).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(Limits.steps),
      Schema.makeFilter((steps) => new Set(steps.map((step) => step.id)).size === steps.length, {
        title: "unique step identifiers",
      }),
    ),
  })
    .check(
      Schema.makeFilter(
        (value) => utf8.encode(JSON.stringify(value)).byteLength <= Limits.encodedBytes,
        {
          title: "at most 1 MiB of encoded plan data",
        },
      ),
    )
    .annotate(closed);

export const LivePlan = planSchema(Step);

export type LivePlan = typeof LivePlan.Type;
export type LivePlanEncoded = typeof LivePlan.Encoded;

export const Plan = planSchema(RecordedStep);

export type Plan = typeof Plan.Type;
export type PlanEncoded = typeof Plan.Encoded;

export const CaptureIncompleteReason = Schema.Literals([
  "FactsUnavailable",
  "LabelOmitted",
  "DestinationOmitted",
  "IdentityOmitted",
  "FrameUnavailable",
  "CardinalityUnavailable",
  "TargetUnavailable",
  "EvidenceLimit",
]);

export type CaptureIncompleteReason = typeof CaptureIncompleteReason.Type;

export const BasicDescriptorEvidence = Schema.Struct({
  path: Schema.Array(Schema.String.check(Schema.isMaxLength(128))).check(Schema.isMaxLength(8)),
  matchScope: Schema.optionalKey(MatchScope),
  facts: Schema.optionalKey(ControlFacts),
}).annotate(closed);

export type BasicDescriptorEvidence = typeof BasicDescriptorEvidence.Type;

/** Incomplete contains no executable action member; faithful intent is not a uniqueness promise. */
export const DescriptorCapture = Schema.TaggedUnion({
  Complete: { action: RecordedAction },
  Incomplete: { facts: BasicDescriptorEvidence, reason: CaptureIncompleteReason },
}).annotate(closed);

export type DescriptorCapture = typeof DescriptorCapture.Type;

export type RunPhase =
  | "Preparation"
  | "Resolution"
  | "Precondition"
  | "Input"
  | "Field"
  | "Verification"
  | "Submit"
  | "Postcondition"
  | "Checkpoint"
  | "Settled"
  | "Terminal";

export type NativePhase = "Prepared" | "Dispatched" | "Acknowledged" | "FollowUp" | "Terminal";

/** A preparatory native acknowledgement does not imply completed logical input. */
export interface AcknowledgementFact {
  readonly subphase: "scroll-into-view" | "focus" | "key-burst" | "scroll-burst";
  readonly logicalComplete: boolean;
}

/** Host-only evidence retains the exact acknowledgement separately from an optional input receipt. */
export interface PhaseEvidence {
  readonly phase: NativePhase | "InputReceipt" | "SubphaseReceipt";
  readonly operation?: RunPhase;
  readonly atMonotonicNanos: bigint;
  /** A late native reply never repairs an already decided unknown outcome. */
  readonly late: boolean;
  readonly input?: InputReceipt;
  readonly fieldIndex?: number;
  readonly acknowledgement?: AcknowledgementFact;
  /** Completed adjacent bursts are summarized; an unresolved dispatch is never folded. */
  readonly burst?: {
    readonly subphase: "key-burst" | "scroll-burst";
    readonly dispatches: number;
    readonly acknowledgements: number;
    readonly firstDispatchedMonotonicNanos: bigint;
    readonly lastAcknowledgedMonotonicNanos: bigint;
  };
  readonly scroll?: {
    readonly target: {
      readonly generation: number;
      readonly pageId: string;
      readonly frameId: string;
    };
    readonly startedMonotonicNanos: bigint;
    readonly completedMonotonicNanos: bigint;
    readonly qualification: "native-call-interval" | "exact-node-scroll-into-view";
    /** Commanded deltas, when exposed by the original native scroll capability. */
    readonly delta?: { readonly x: number; readonly y: number };
  };
}

export interface SettledEvidence extends SettledOptions {
  readonly signals: ReadonlyArray<"dom-mutation" | "scroll" | "root-geometry" | "viewport">;
  readonly observedMillis: number;
  readonly samples: number;
  readonly mutations: number;
  readonly scrollChanges: number;
  readonly geometryChanges: number;
  readonly viewportChanges: number;
  readonly visibility: "visible" | "hidden";
}

export type AttemptResult =
  | { readonly _tag: "Refused"; readonly outcome: "undispatched" | "rejected" }
  | { readonly _tag: "Acknowledged"; readonly outcome: "performed" | "undispatched" }
  | { readonly _tag: "Unknown"; readonly outcome: "unknown" }
  | { readonly _tag: "AcknowledgedWithPostconditionFailure"; readonly outcome: "performed" };

/** Causes stay typed on the host; this value is deliberately not a serialization schema. */
export interface StepAttempt<Id extends string = string, E = BrowserError | InitializationError> {
  readonly id: string;
  readonly stepId: Id;
  readonly sourceStep: Step & { readonly id: Id };
  readonly action: Action["_tag"];
  readonly phase: RunPhase;
  readonly phases: ReadonlyArray<PhaseEvidence>;
  readonly capture?: DescriptorCapture;
  readonly outcome?: BrowserOutcome;
  readonly error?: BrowserError | InitializationError;
  readonly result?: AttemptResult;
  readonly containment: Containment;
  readonly completed: boolean;
  readonly cause?: Cause.Cause<E>;
  readonly receipt?: RunReceipt;
  readonly performance?: PerformanceEvidence;
}

/** Host timing is measured in the original owner's monotonic domain, never a remote clock. */
export interface RunTiming {
  readonly requestedMonotonicNanos: bigint;
  readonly intendedMonotonicNanos: bigint;
  readonly startedMonotonicNanos: bigint | null;
  readonly deadlineMonotonicNanos: bigint;
  readonly latenessNanos: bigint | null;
  readonly seed?: number;
}

export interface PerformanceEvidence {
  readonly seed: number;
  readonly profile: MotionProfile;
}

export type RunReceipt =
  | NavigationResult
  | ActionResult
  | InputReceipt
  | FillFormResult
  | SettledEvidence
  | void;

export interface RanStep<Id extends string = string> {
  readonly id: Id;
  readonly sourceStep: Step & { readonly id: Id };
  readonly receipt: RunReceipt;
  readonly attempt: StepAttempt<Id>;
  readonly recorded: DescriptorCapture;
  readonly expect?: Expectation;
  readonly resolution: ResolveGuard;
  readonly checkpoint?: Checkpoint;
  readonly settled?: SettledEvidence;
}

export interface AttemptSnapshot<E = BrowserError | InitializationError> {
  readonly runId: string;
  readonly attempts: ReadonlyArray<StepAttempt<string, E>>;
  readonly completed: ReadonlyArray<RanStep>;
  readonly terminal: boolean;
  readonly timing: RunTiming;
}

export interface Ran<P extends LivePlan = LivePlan> {
  readonly runId: string;
  readonly version: 1;
  readonly timing: RunTiming;
  readonly steps: ReadonlyArray<RanStep<P["steps"][number]["id"]>>;
  readonly completion:
    | { readonly _tag: "Complete" }
    | {
        readonly _tag: "Through";
        readonly through: string;
        readonly next: { readonly index: number; readonly stepId: string } | null;
      };
}
