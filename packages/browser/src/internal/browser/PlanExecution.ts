import {
  Cause,
  type Clock,
  Deferred,
  Duration,
  Effect,
  Exit,
  Fiber,
  Option,
  Predicate,
  Schema,
  type Scope,
} from "effect";

import type { ElementAdmission } from "../../Browser.ts";
import {
  type Checkpoint,
  type CheckpointOptions,
  InputReceipt,
  type ObservedElement,
} from "../../BrowserData.ts";
import { BrowserError, Reasons, type BrowserOutcome, type Containment } from "../../Errors.ts";
import { type RunOperation, type RunOptions, StepFailed } from "../../Plan.ts";
import type {
  AttemptResult,
  AttemptSnapshot,
  DescriptorCapture,
  InputBindings,
  LivePlan,
  PhaseEvidence,
  Ran,
  RanStep,
  RunPhase,
  RunReceipt,
  Step,
  StepAttempt,
} from "../../PlanData.ts";
import type { DescriptorSample, ResolvedElement } from "./Descriptor.ts";
import type { Ticket } from "./Owner.ts";
import { capture, inputSlots, pathKey, type TargetSample, validateInputs } from "./Recording.ts";
import type { ExecutionOptions } from "./Session.ts";

export { actionTargets } from "./Recording.ts";

export interface TargetBinding {
  readonly value: ObservedElement | ResolvedElement | string;
  readonly path: ReadonlyArray<string>;
  readonly sample?: DescriptorSample;
}

export interface StepExecution {
  readonly options: ExecutionOptions;
  readonly policy?: ElementAdmission;
  readonly checkpoint?: CheckpointOptions;
  readonly phase: (phase: RunPhase, fieldIndex?: number) => void;
  readonly targets: (bindings: ReadonlyArray<TargetBinding>) => void;
  /** Partial form/input evidence survives a later failed verification, submit or postcondition. */
  readonly retainReceipt: (receipt: RunReceipt) => void;
}

export interface ValidatedRunOptions extends RunOptions {
  readonly withinMillis?: number;
  readonly queueMillis?: number;
}

export interface StepSuccess {
  readonly receipt: RunReceipt;
  readonly checkpoint?: Checkpoint;
}

export interface PlanExecutionOptions {
  readonly clock: Clock.Clock;
  readonly validate: Effect.Effect<void, BrowserError>;
  readonly lifetimeDeadline: number;
  readonly actionTimeoutMillis: number;
  readonly newId: Effect.Effect<string>;
  /** This bounds registrations, never takes a Page mutation permit for the whole walk. */
  readonly reserve: Effect.Effect<() => void, BrowserError>;
  readonly executeStep: (
    step: Step,
    inputs: InputBindings,
    context: StepExecution,
  ) => Effect.Effect<StepSuccess, BrowserError>;
}

const maximumPhases = 1024;

/** Only bounded decoded data is frozen. Original Effect Causes are retained without traversal. */
const freezeData = <A>(value: A): A => {
  const seen = new WeakSet<object>();

  const freeze = (input: unknown): void => {
    if (!Predicate.isObjectKeyword(input) || seen.has(input) || Object.isFrozen(input)) return;
    seen.add(input);
    for (const child of Object.values(input)) freeze(child);
    Object.freeze(input);
  };

  freeze(value);

  return value;
};

interface AttemptState {
  readonly id: string;
  readonly step: Step;
  readonly phases: Array<PhaseEvidence>;
  readonly samples: Map<string, TargetSample>;
  phase: RunPhase;
  fieldIndex?: number;
  overflow: boolean;
  completed: boolean;
  pending: number;
  acknowledged: boolean;
  capture?: DescriptorCapture;
  receipt?: RunReceipt;
  outcome?: BrowserOutcome;
  error?: BrowserError;
  cause?: Cause.Cause<BrowserError>;
  result?: AttemptResult;
  containment: Containment;
}

const attemptSnapshot = (state: AttemptState): StepAttempt =>
  Object.freeze({
    id: state.id,
    stepId: state.step.id,
    sourceStep: state.step,
    action: state.step.action._tag,
    phase: state.phase,
    phases: Object.freeze([...state.phases]),
    ...(state.capture === undefined ? {} : { capture: state.capture }),
    ...(state.receipt === undefined ? {} : { receipt: state.receipt }),
    ...(state.outcome === undefined ? {} : { outcome: state.outcome }),
    ...(state.error === undefined ? {} : { error: state.error }),
    ...(state.cause === undefined ? {} : { cause: state.cause }),
    ...(state.result === undefined ? {} : { result: state.result }),
    containment: state.containment,
    completed: state.completed,
  });

const outcome = (state: AttemptState, error?: BrowserError): BrowserOutcome => {
  if (error?.outcome === "unknown" || (error === undefined && state.pending > 0)) return "unknown";
  if (error?.outcome === "performed" || state.acknowledged) return "performed";

  return error?.outcome ?? "undispatched";
};

const result = (value: BrowserOutcome, failed: boolean): AttemptResult => {
  switch (value) {
    case "unknown":
      return { _tag: "Unknown", outcome: value };
    case "performed":
      return {
        _tag: failed ? "AcknowledgedWithPostconditionFailure" : "Acknowledged",
        outcome: value,
      };
    case "undispatched":
      return { _tag: failed ? "Refused" : "Acknowledged", outcome: value };
    case "rejected":
      return { _tag: "Refused", outcome: value };
  }
};

const preparationFailure = (error: BrowserError): StepFailed =>
  new StepFailed({ stage: "PreparationFailed", completed: [], error });

/** The original scoped owner is supplied once; a RunOperation contains no reconnecting facade. */
export const makePlanExecution = (configuration: PlanExecutionOptions) => {
  const now = (): number => Number(configuration.clock.monotonicTimeNanosUnsafe()) / 1_000_000;

  const start = (
    plan: LivePlan,
    options: ValidatedRunOptions = {},
  ): Effect.Effect<RunOperation, StepFailed, Scope.Scope> =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const began = now();

        const runDeadline = Math.min(
          configuration.lifetimeDeadline,
          options.withinMillis === undefined
            ? Number.POSITIVE_INFINITY
            : began + options.withinMillis,
        );

        const last =
          options.through === undefined
            ? plan.steps.length - 1
            : plan.steps.findIndex((step) => step.id === options.through);

        if (last < 0)
          return yield* preparationFailure(
            BrowserError.make({
              operation: "run",
              reason: Reasons.Malformed.make({ path: "through" }),
              outcome: "undispatched",
            }),
          );
        const inputs = Object.freeze({ ...options.inputs });

        yield* restore(configuration.validate).pipe(Effect.mapError(preparationFailure));
        yield* restore(validateInputs(plan, inputs)).pipe(Effect.mapError(preparationFailure));
        const runId = yield* restore(configuration.newId);
        const ids = yield* restore(Effect.forEach(plan.steps, () => configuration.newId));
        const release = yield* configuration.reserve.pipe(Effect.mapError(preparationFailure));
        let released = false;

        const releaseOnce = Effect.sync(() => {
          if (released) return;
          released = true;
          release();
        });

        yield* Effect.addFinalizer(() => releaseOnce);
        freezeData(plan);
        const slots = inputSlots(plan);
        const completed: Array<RanStep> = [];
        const attempts: Array<AttemptState> = [];
        const completion = yield* Deferred.make<Ran, StepFailed>();
        let terminal = false;

        const snapshot = (): AttemptSnapshot =>
          Object.freeze({
            runId,
            attempts: Object.freeze(attempts.map(attemptSnapshot)),
            completed: Object.freeze([...completed]),
            terminal,
          });

        const worker = Effect.gen(function* () {
          for (let index = 0; index <= last; index++) {
            const step = plan.steps[index];
            const attemptId = ids[index];

            // Both arrays are bounded, nonempty and correlated by ingress/preparation.
            if (step === undefined || attemptId === undefined)
              return yield* Effect.die(
                new Error("Validated plan/attempt inventory lost alignment"),
              );
            const stepBegan = now();

            const stepDeadline = Math.min(
              runDeadline,
              stepBegan +
                Math.min(
                  options.timeoutMillis ?? configuration.actionTimeoutMillis,
                  configuration.actionTimeoutMillis,
                ),
            );

            const queueMillis =
              options.queueMillis ??
              (options.admission?.queue === undefined
                ? undefined
                : Duration.toMillis(Duration.fromInputUnsafe(options.admission.queue)));

            const queueDeadline =
              queueMillis === undefined
                ? undefined
                : Math.min(stepDeadline, stepBegan + queueMillis);

            const state: AttemptState = {
              id: attemptId,
              step,
              phase: "Preparation",
              phases: [],
              samples: new Map(),
              overflow: false,
              completed: false,
              pending: 0,
              acknowledged: false,
              containment: { _tag: "NotRequired" },
            };

            attempts.push(state);
            const finishedTickets = new WeakSet<Ticket>();
            const pendingTickets = new WeakMap<Ticket, boolean>();

            const targetBindings = new Map<
              ObservedElement | ResolvedElement | string,
              Array<ReadonlyArray<string>>
            >();

            const retainedInputs = new WeakSet<InputReceipt>();
            const checkedSamples = new Set<string>();

            const append = (evidence: PhaseEvidence): void => {
              if (state.phases.length >= maximumPhases) {
                state.overflow = true;
                if (state.completed)
                  state.capture = freezeData({
                    _tag: "Incomplete",
                    facts: { path: [] },
                    reason: "EvidenceLimit",
                  });

                return;
              }
              state.phases.push(Object.freeze(evidence));
            };

            const retainInput = (
              input: InputReceipt,
              operation: RunPhase,
              fieldIndex?: number,
            ): void => {
              if (retainedInputs.has(input)) return;
              retainedInputs.add(input);
              const receipt = freezeData(input);

              for (let index = state.phases.length - 1; index >= 0; index--) {
                const evidence = state.phases[index];

                if (
                  evidence?.phase === "Acknowledged" &&
                  !evidence.late &&
                  evidence.operation === operation &&
                  evidence.fieldIndex === fieldIndex &&
                  evidence.input === undefined &&
                  evidence.atMonotonicNanos >= receipt.startedMonotonicNanos &&
                  evidence.atMonotonicNanos <= receipt.completedMonotonicNanos
                ) {
                  state.phases[index] = Object.freeze({ ...evidence, input: receipt });

                  return;
                }
              }
              append({
                phase: "InputReceipt",
                operation,
                atMonotonicNanos: receipt.completedMonotonicNanos,
                late: state.completed,
                input: receipt,
                ...(fieldIndex === undefined ? {} : { fieldIndex }),
              });
            };

            const retainReceipt = (receipt: RunReceipt): void => {
              if (state.completed) return;
              state.receipt = freezeData(receipt);
              if (Schema.is(InputReceipt)(receipt)) retainInput(receipt, "Input");
              else if (receipt !== undefined) {
                if ("input" in receipt && receipt.input !== undefined)
                  retainInput(receipt.input, "Input");
                if ("fields" in receipt)
                  receipt.fields.forEach((field, index) => {
                    if (field.input !== undefined) retainInput(field.input, "Field", index);
                  });
                if ("submitInput" in receipt && receipt.submitInput !== undefined)
                  retainInput(receipt.submitInput, "Submit");
              }
            };

            const context: StepExecution = {
              ...(options.policy === undefined ? {} : { policy: options.policy }),
              ...(options.checkpoint === undefined
                ? {}
                : { checkpoint: freezeData({ ...options.checkpoint }) }),
              phase: (phase, fieldIndex) => {
                if (state.completed) return;
                state.phase = phase;
                state.fieldIndex = fieldIndex;
              },
              targets: (bindings) => {
                if (state.completed) return;
                for (const binding of bindings) {
                  const paths = targetBindings.get(binding.value) ?? [];

                  paths.push(binding.path);
                  targetBindings.set(binding.value, paths);
                  const key = pathKey(binding.path);

                  if (binding.sample !== undefined && !state.samples.has(key))
                    state.samples.set(key, { path: binding.path, sample: binding.sample });
                }
              },
              retainReceipt,
              options: {
                ...(options.timeoutMillis === undefined
                  ? {}
                  : { timeoutMillis: options.timeoutMillis }),
                ...(options.admission === undefined ? {} : { admission: options.admission }),
                operationDeadline: stepDeadline,
                ...(queueDeadline === undefined ? {} : { queueDeadline }),
                evidence: {
                  phase: (phase, ticket) => {
                    const late =
                      state.completed ||
                      finishedTickets.has(ticket) ||
                      ticket.signal.aborted ||
                      now() >= ticket.deadline;

                    if (phase === "Dispatched" && pendingTickets.get(ticket) !== true) {
                      state.pending++;
                      pendingTickets.set(ticket, true);
                    } else if (phase === "Acknowledged") {
                      const pending = pendingTickets.get(ticket) === true;

                      if (pending) state.pending--;
                      pendingTickets.set(ticket, false);
                      if (pending && !late) state.acknowledged = true;
                    }
                    append({
                      phase,
                      operation: state.phase,
                      atMonotonicNanos: configuration.clock.monotonicTimeNanosUnsafe(),
                      late,
                      ...(state.fieldIndex === undefined ? {} : { fieldIndex: state.fieldIndex }),
                    });
                    if (phase === "Terminal") {
                      finishedTickets.add(ticket);
                      if (
                        ticket.containment !== undefined &&
                        ticket.containment._tag !== "NotRequired"
                      )
                        state.containment = Object.freeze({ ...ticket.containment });
                    }
                  },
                  target: (target, sample) => {
                    if (state.completed) return;
                    for (const path of targetBindings.get(target) ?? []) {
                      if (
                        state.fieldIndex !== undefined &&
                        path[0] === "fields" &&
                        path[1] !== String(state.fieldIndex)
                      )
                        continue;
                      const key = pathKey(path);

                      if (!checkedSamples.has(key)) {
                        state.samples.set(key, {
                          path,
                          ...(sample === undefined ? {} : { sample }),
                        });
                        checkedSamples.add(key);
                      }
                    }
                  },
                },
              },
            };

            const effect =
              stepDeadline <= now()
                ? Effect.fail(
                    BrowserError.make({
                      operation: "run",
                      reason: Reasons.Timeout.make({}),
                      outcome: "undispatched",
                    }),
                  )
                : configuration.executeStep(step, inputs, context).pipe(
                    Effect.flatMap((success) => {
                      if (
                        success.receipt !== undefined &&
                        "stopped" in success.receipt &&
                        success.receipt.stopped !== undefined
                      ) {
                        retainReceipt(success.receipt);

                        return Effect.fail(success.receipt.stopped.error);
                      }

                      return Effect.succeed(success);
                    }),
                  );

            const success = yield* effect.pipe(
              Effect.onExit((exit) =>
                Effect.sync(() => {
                  if (Exit.isSuccess(exit)) retainReceipt(exit.value.receipt);
                  else {
                    state.cause = exit.cause;
                    const error = Cause.findErrorOption(exit.cause);

                    if (Option.isSome(error)) {
                      state.error = error.value;
                      state.containment = error.value.containment ?? state.containment;
                    }
                  }
                }).pipe(
                  Effect.andThen(
                    Effect.suspend(() => capture(step, state.samples, slots, state.overflow)),
                  ),
                  Effect.map((captured) => {
                    state.capture = freezeData(captured);
                    state.outcome = outcome(state, state.error);
                    state.result = result(state.outcome, Exit.isFailure(exit));
                    state.completed = true;
                  }),
                ),
              ),
              Effect.mapError(
                (error) =>
                  new StepFailed({
                    stage: "AttemptFailed",
                    stepId: step.id,
                    completed: Object.freeze([...completed]),
                    attempt: attemptSnapshot(state),
                    error,
                  }),
              ),
            );

            if (state.outcome === "unknown")
              return yield* new StepFailed({
                stage: "AttemptFailed",
                stepId: step.id,
                completed: Object.freeze([...completed]),
                attempt: attemptSnapshot(state),
                error: BrowserError.make({
                  operation: "run",
                  reason: Reasons.Interrupted.make({}),
                  outcome: "unknown",
                  containment: state.containment,
                }),
              });
            const captured = state.capture;

            if (captured === undefined)
              return yield* Effect.die(new Error("Terminal plan attempt lost capture evidence"));
            completed.push(
              Object.freeze({
                id: step.id,
                sourceStep: step,
                receipt: success.receipt,
                attempt: attemptSnapshot(state),
                recorded: captured,
                ...(step.expect === undefined ? {} : { expect: step.expect }),
                resolution: step.resolution,
                ...(success.checkpoint === undefined
                  ? {}
                  : { checkpoint: freezeData(success.checkpoint) }),
                ...(step.action._tag === "Wait" &&
                step.action.mode._tag === "Settled" &&
                success.receipt !== undefined &&
                "signals" in success.receipt
                  ? { settled: success.receipt }
                  : {}),
              }),
            );
          }

          const next = plan.steps[last + 1];

          return freezeData({
            runId,
            version: 1 as const,
            steps: Object.freeze([...completed]),
            completion:
              options.through === undefined
                ? { _tag: "Complete" as const }
                : {
                    _tag: "Through" as const,
                    through: options.through,
                    next: next === undefined ? null : { index: last + 1, stepId: next.id },
                  },
          });
        }).pipe(
          Effect.onExit((exit) =>
            Effect.sync(() => {
              terminal = true;
              Deferred.doneUnsafe(completion, exit);
            }).pipe(Effect.andThen(releaseOnce)),
          ),
        );

        const fiber = yield* worker.pipe(
          Effect.forkScoped({ startImmediately: false, uninterruptible: false }),
        );

        return Object.freeze({
          id: runId,
          attempts: Effect.sync(snapshot),
          completed: Deferred.await(completion),
          cancel: Fiber.interrupt(fiber),
        });
      }),
    );

  return {
    start,
    run: (plan: LivePlan, options?: ValidatedRunOptions): Effect.Effect<Ran, StepFailed> =>
      Effect.scoped(start(plan, options).pipe(Effect.flatMap((operation) => operation.completed))),
  };
};
