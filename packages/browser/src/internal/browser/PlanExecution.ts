import {
  Cause,
  Clock,
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
  AcknowledgementFact,
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
  RunTiming,
  Performed,
  PerformanceEvidence,
  Step,
  StepAttempt,
} from "../../PlanData.ts";
import type { Correlation, Payload } from "../../TimelineData.ts";
import type { DescriptorSample, ResolvedElement } from "./Descriptor.ts";
import { strongestOutcome, type Ticket } from "./Owner.ts";
import { prepare, type PerformancePlan } from "./Performance.ts";
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
  readonly performance?: PerformancePlan;
}

export interface ValidatedRunOptions extends RunOptions {
  readonly style?: "plain" | Performed;
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
  readonly newSeed?: Effect.Effect<number>;
  /** Captured at run execution and retained with its original domain, never an evidence owner. */
  readonly publish?: () => {
    readonly append: (correlation: Correlation, event: Payload) => void;
    readonly release: () => void;
  };
  /** Completes once the issuing Page or its owner can no longer run; a scheduled start ends then. */
  readonly retired?: Effect.Effect<void>;
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
  /** The strongest outcome the owner classified for any operation this attempt admitted. */
  reached: BrowserOutcome;
  capture?: DescriptorCapture;
  receipt?: RunReceipt;
  outcome?: BrowserOutcome;
  error?: BrowserError;
  cause?: Cause.Cause<BrowserError>;
  result?: AttemptResult;
  containment: Containment;
  performance?: PerformanceEvidence;
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
    ...(state.performance === undefined ? {} : { performance: state.performance }),
  });

/** One classifier: the owner's, per admitted operation, never weakened by a later failure. */
const outcome = (state: AttemptState, error?: BrowserError): BrowserOutcome =>
  strongestOutcome(state.reached, error?.outcome ?? "undispatched");

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
        const requestedMonotonicNanos = configuration.clock.monotonicTimeNanosUnsafe();
        const intendedMonotonicNanos = options.startAt ?? requestedMonotonicNanos;
        const began = Number(intendedMonotonicNanos) / 1_000_000;

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
        if (!Number.isFinite(began) || !Number.isFinite(runDeadline))
          return yield* preparationFailure(
            BrowserError.make({
              operation: "run",
              reason: Reasons.Configuration.make({ path: "startAt" }),
              outcome: "undispatched",
            }),
          );
        if (began >= runDeadline || now() >= runDeadline)
          return yield* preparationFailure(
            BrowserError.make({
              operation: "run",
              reason: Reasons.ScheduleMissed.make({}),
              outcome: "undispatched",
            }),
          );

        const style =
          options.style === undefined || options.style === "plain" ? undefined : options.style;

        const seed =
          style === undefined
            ? undefined
            : (style.seed ??
              (configuration.newSeed === undefined
                ? yield* preparationFailure(
                    BrowserError.make({
                      operation: "run",
                      reason: Reasons.Configuration.make({ path: "style.seed" }),
                      outcome: "undispatched",
                    }),
                  )
                : yield* restore(configuration.newSeed)));

        const runId = yield* restore(configuration.newId);
        const ids = yield* restore(Effect.forEach(plan.steps, () => configuration.newId));
        const release = yield* configuration.reserve.pipe(Effect.mapError(preparationFailure));
        // Evidence publication is taken when the walk starts, so a scheduled start retains no
        // journal while it waits and never holds back its domain's terminal.
        let publication: ReturnType<NonNullable<typeof configuration.publish>> | undefined;
        let publish: ((correlation: Correlation, event: Payload) => void) | undefined;
        let released = false;

        const releaseAll = () => {
          if (released) return;
          released = true;
          release();
          publication?.release();
        };

        const releaseOnce = Effect.sync(releaseAll);

        yield* Effect.addFinalizer(() => releaseOnce);
        freezeData(plan);
        const slots = inputSlots(plan);
        const completed: Array<RanStep> = [];
        const attempts: Array<AttemptState> = [];
        const completion = yield* Deferred.make<Ran, StepFailed>();
        let terminal = false;

        let timing: RunTiming = Object.freeze({
          requestedMonotonicNanos,
          intendedMonotonicNanos,
          startedMonotonicNanos: null,
          deadlineMonotonicNanos: BigInt(Math.floor(runDeadline * 1_000_000)),
          latenessNanos: null,
          ...(seed === undefined ? {} : { seed }),
        });

        const snapshot = (): AttemptSnapshot =>
          Object.freeze({
            runId,
            attempts: Object.freeze(attempts.map(attemptSnapshot)),
            completed: Object.freeze([...completed]),
            terminal,
            timing,
          });

        const worker = Effect.gen(function* () {
          let waited = false;

          // Timers have millisecond resolution and can wake before a fractional instant, so the
          // wait repeats until the owner's own monotonic clock has reached the intended start.
          while (configuration.clock.monotonicTimeNanosUnsafe() < intendedMonotonicNanos) {
            waited = true;

            const remainingNanos =
              intendedMonotonicNanos - configuration.clock.monotonicTimeNanosUnsafe();

            const retired = yield* (configuration.retired ?? Effect.never).pipe(
              Effect.timeoutOption(Duration.millis(Math.ceil(Number(remainingNanos) / 1_000_000))),
            );

            // The issuing Page or owner ended before the start: refuse with its current reason.
            if (Option.isSome(retired))
              return yield* configuration.validate.pipe(
                Effect.andThen(
                  Effect.fail(
                    BrowserError.make({
                      operation: "run",
                      reason: Reasons.Closed.make({}),
                      outcome: "undispatched",
                    }),
                  ),
                ),
                Effect.mapError(preparationFailure),
              );
          }
          if (waited) yield* configuration.validate.pipe(Effect.mapError(preparationFailure));
          if (!released) {
            publication = configuration.publish?.();
            publish = publication?.append;
          }
          const startedMonotonicNanos = configuration.clock.monotonicTimeNanosUnsafe();

          timing = Object.freeze({
            ...timing,
            startedMonotonicNanos,
            latenessNanos:
              startedMonotonicNanos > intendedMonotonicNanos
                ? startedMonotonicNanos - intendedMonotonicNanos
                : 0n,
          });
          if (now() >= runDeadline)
            return yield* preparationFailure(
              BrowserError.make({
                operation: "run",
                reason: Reasons.ScheduleMissed.make({}),
                outcome: "undispatched",
              }),
            );
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
              reached: "undispatched",
              containment: { _tag: "NotRequired" },
            };

            attempts.push(state);

            const correlation = (): Correlation => ({
              runId,
              stepId: step.id,
              attemptId,
              ...(state.fieldIndex === undefined ? {} : { fieldIndex: state.fieldIndex }),
            });

            publish?.(correlation(), { _tag: "Planned", action: step.action._tag });

            const performance =
              style === undefined || seed === undefined
                ? undefined
                : yield* prepare(style, seed, step.id);

            if (performance !== undefined)
              state.performance = Object.freeze({
                seed: performance.seed,
                profile: performance.profile,
              });
            const finishedTickets = new WeakSet<Ticket>();

            const targetBindings = new Map<
              ObservedElement | ResolvedElement | string,
              Array<ReadonlyArray<string>>
            >();

            const retainedInputs = new WeakSet<InputReceipt>();
            const checkedSamples = new Set<string>();
            let lastDispatchTicket: Ticket | undefined;
            let lastBurstTicket: Ticket | undefined;

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

            const appendPhase = (evidence: PhaseEvidence, ticket: Ticket): void => {
              if (evidence.phase === "Dispatched") lastDispatchTicket = ticket;
              const fact = evidence.acknowledgement;

              if (
                evidence.phase !== "Acknowledged" ||
                fact === undefined ||
                fact.logicalComplete ||
                (fact.subphase !== "key-burst" && fact.subphase !== "scroll-burst") ||
                lastDispatchTicket !== ticket
              ) {
                if (evidence.phase !== "Dispatched") lastBurstTicket = undefined;
                append(evidence);

                return;
              }
              let start = state.phases.length;

              while (start > 0) {
                const previous = state.phases[start - 1];

                if (
                  previous?.phase !== "Dispatched" ||
                  previous.operation !== evidence.operation ||
                  previous.fieldIndex !== evidence.fieldIndex ||
                  previous.late !== evidence.late
                )
                  break;
                start--;
              }
              const dispatched = state.phases[start];

              if (dispatched === undefined) {
                lastBurstTicket = undefined;
                append(evidence);

                return;
              }
              const dispatches = state.phases.length - start;
              const previous = state.phases[start - 1];

              const combine =
                lastBurstTicket === ticket &&
                previous?.phase === "Acknowledged" &&
                previous.burst?.subphase === fact.subphase &&
                previous.operation === evidence.operation &&
                previous.fieldIndex === evidence.fieldIndex &&
                previous.late === evidence.late;

              state.phases.splice(start);

              const burst = Object.freeze({
                subphase: fact.subphase,
                dispatches: dispatches + (combine ? (previous.burst?.dispatches ?? 0) : 0),
                acknowledgements: 1 + (combine ? (previous.burst?.acknowledgements ?? 0) : 0),
                firstDispatchedMonotonicNanos: combine
                  ? (previous.burst?.firstDispatchedMonotonicNanos ?? dispatched.atMonotonicNanos)
                  : dispatched.atMonotonicNanos,
                lastAcknowledgedMonotonicNanos: evidence.atMonotonicNanos,
              });

              if (combine) {
                state.phases[start - 1] = Object.freeze({ ...previous, ...evidence, burst });
              } else append({ ...evidence, burst });
              lastBurstTicket = ticket;
            };

            const retainScroll = (
              facts: Parameters<
                NonNullable<NonNullable<ExecutionOptions["evidence"]>["scroll"]>
              >[0],
              ticket: Ticket,
            ): void => {
              const late =
                state.completed ||
                finishedTickets.has(ticket) ||
                ticket.signal.aborted ||
                now() >= ticket.deadline;

              const scroll: NonNullable<PhaseEvidence["scroll"]> = Object.freeze({
                target: Object.freeze({
                  generation: ticket.generation,
                  pageId: facts.target.pageId,
                  frameId: facts.target.frameId,
                }),
                startedMonotonicNanos: facts.startedMonotonicNanos,
                completedMonotonicNanos: facts.completedMonotonicNanos,
                qualification: facts.qualification ?? "native-call-interval",
                ...(facts.x === undefined || facts.y === undefined
                  ? {}
                  : { delta: Object.freeze({ x: facts.x, y: facts.y }) }),
              });

              const index = state.phases.length - 1;
              const previous = state.phases[index];

              if (
                !late &&
                previous?.phase === "Acknowledged" &&
                !previous.late &&
                previous.operation === state.phase &&
                previous.fieldIndex === state.fieldIndex
              ) {
                const original = previous.scroll;

                const delta =
                  original?.delta !== undefined && scroll.delta !== undefined
                    ? Object.freeze({
                        x: original.delta.x + scroll.delta.x,
                        y: original.delta.y + scroll.delta.y,
                      })
                    : scroll.delta;

                state.phases[index] = Object.freeze({
                  ...previous,
                  scroll:
                    original === undefined
                      ? scroll
                      : Object.freeze({
                          ...scroll,
                          startedMonotonicNanos: original.startedMonotonicNanos,
                          ...(delta === undefined ? {} : { delta }),
                        }),
                });

                return;
              }
              lastBurstTicket = undefined;
              append({
                phase: "SubphaseReceipt",
                operation: state.phase,
                atMonotonicNanos: facts.completedMonotonicNanos,
                late,
                scroll,
                ...(state.fieldIndex === undefined ? {} : { fieldIndex: state.fieldIndex }),
              });
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
              ...(performance === undefined ? {} : { performance }),
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
                  correlation,
                  phase: (
                    phase: NonNullable<Ticket["phase"]>,
                    ticket: Ticket,
                    acknowledgement?: AcknowledgementFact,
                  ) => {
                    const late =
                      state.completed ||
                      finishedTickets.has(ticket) ||
                      ticket.signal.aborted ||
                      now() >= ticket.deadline;

                    appendPhase(
                      {
                        phase,
                        operation: state.phase,
                        atMonotonicNanos: configuration.clock.monotonicTimeNanosUnsafe(),
                        late,
                        ...(state.fieldIndex === undefined ? {} : { fieldIndex: state.fieldIndex }),
                        ...(acknowledgement === undefined
                          ? {}
                          : { acknowledgement: Object.freeze({ ...acknowledgement }) }),
                      },
                      ticket,
                    );
                    if (phase === "Terminal") {
                      finishedTickets.add(ticket);
                      if (!state.completed)
                        state.reached = strongestOutcome(
                          state.reached,
                          ticket.outcome ?? "undispatched",
                        );
                      if (
                        ticket.containment !== undefined &&
                        ticket.containment._tag !== "NotRequired"
                      )
                        state.containment = Object.freeze({ ...ticket.containment });
                    }
                  },
                  scroll: retainScroll,
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
                    if (Exit.isFailure(exit))
                      publish?.(
                        correlation(),
                        Cause.hasInterrupts(exit.cause)
                          ? { _tag: "Cancelled", outcome: state.outcome }
                          : {
                              _tag: "Failed",
                              operation: "run",
                              reason: state.error?.reason._tag ?? "Failed",
                              outcome: state.outcome,
                            },
                      );
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
            timing,
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
        });

        const fiber = yield* worker.pipe(
          Effect.forkScoped({ startImmediately: false, uninterruptible: false }),
        );

        // Fiber observers cover interruption before the deferred worker evaluates any onExit.
        // Capacity and publication are released before a joined caller can resume.
        yield* Effect.sync(() => {
          fiber.addObserver((exit) => {
            releaseAll();
            terminal = true;
            Deferred.doneUnsafe(completion, exit);
          });
        });

        return Object.freeze({
          id: runId,
          attempts: Effect.sync(snapshot),
          completed: Deferred.await(completion),
          cancel: Fiber.interrupt(fiber),
        });
      }),
    ).pipe(Effect.provideService(Clock.Clock, configuration.clock));

  return {
    start,
    run: (plan: LivePlan, options?: ValidatedRunOptions): Effect.Effect<Ran, StepFailed> =>
      Effect.scoped(start(plan, options).pipe(Effect.flatMap((operation) => operation.completed))),
  };
};
