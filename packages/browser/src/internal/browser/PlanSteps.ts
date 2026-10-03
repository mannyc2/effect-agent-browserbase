import { Effect, Schema } from "effect";

import {
  ActionResult,
  Checkpoint,
  FillFormResult,
  InputReceipt,
  type KeyModifier,
  type PointerClickRequest,
  NavigationResult,
  type WaitForElementRequest,
} from "../../BrowserData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type {
  ActionTarget,
  InputBindings,
  Precondition,
  RunPhase,
  RunReceipt,
  SettledEvidence,
  SettledOptions,
  Step,
  ValueSource,
} from "../../PlanData.ts";
import type { ResolvedElement } from "./Descriptor.ts";
import type { DriverTarget } from "./Driver.ts";
import type { AdmissionPolicy } from "./Observation.ts";
import type { Ticket } from "./Owner.ts";
import type { StepExecution, StepSuccess } from "./PlanExecution.ts";
import type { NativePoint } from "./Pointer.ts";
import type { ExecutionOptions, FormOutcome, FormSettings, FormSteps, Reading } from "./Session.ts";
import { makeStepPreparation } from "./StepPreparation.ts";

type Resolved = () => ResolvedElement;

/**
 * What one plan step may do on its issued page: the page's own operations, each admitted under its
 * operation's policy, plus the few a step needs on targets it resolved itself. Step semantics live
 * here; admission, readiness and containment stay with the session that implements this port.
 */
export interface StepControls {
  readonly operations: {
    readonly navigate: (
      url: string,
      timeoutMillis: number | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<unknown, BrowserError>;
    readonly click: (
      target: Resolved,
      policy: AdmissionPolicy | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<unknown, BrowserError>;
    readonly hover: (
      target: Resolved,
      policy: AdmissionPolicy | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<object, BrowserError>;
    readonly fill: (
      target: Resolved,
      value: string,
      policy: AdmissionPolicy | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<unknown, BrowserError>;
    readonly type: (
      text: string,
      into: Resolved | undefined,
      policy: AdmissionPolicy | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<object, BrowserError>;
    readonly press: (
      key: string,
      modifiers: ReadonlyArray<KeyModifier>,
      into: Resolved | undefined,
      policy: AdmissionPolicy | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<object, BrowserError>;
    readonly scroll: (
      x: number,
      y: number,
      options: ExecutionOptions,
    ) => Effect.Effect<unknown, BrowserError>;
    readonly pointerClick: (
      request: PointerClickRequest,
      options: ExecutionOptions,
    ) => Effect.Effect<object, BrowserError>;
    readonly pointerMove: (
      to: NativePoint,
      options: ExecutionOptions,
    ) => Effect.Effect<object, BrowserError>;
    readonly wheel: (
      deltaX: number,
      deltaY: number,
      at: NativePoint | undefined,
      options: ExecutionOptions,
    ) => Effect.Effect<object, BrowserError>;
  };
  readonly selectOption: (
    target: Resolved,
    options: () => ReadonlyArray<ResolvedElement>,
    policy: AdmissionPolicy | undefined,
    operationOptions: ExecutionOptions,
  ) => Effect.Effect<unknown, BrowserError>;
  readonly settled: (
    settle: SettledOptions,
    options: ExecutionOptions,
  ) => Effect.Effect<SettledEvidence, BrowserError>;
  readonly fillForm: (
    form: FormSteps,
    policy: AdmissionPolicy | undefined,
    settings: FormSettings,
    options: ExecutionOptions,
  ) => Effect.Effect<FormOutcome, BrowserError>;
  readonly checkpoint: (
    reading: Omit<Reading, "scope"> & { readonly picture: boolean },
    options: ExecutionOptions,
  ) => Effect.Effect<unknown, BrowserError>;
  /** Scroll a resolved node into view. */
  readonly scrollTo: (
    target: Resolved,
    options: ExecutionOptions,
  ) => Effect.Effect<unknown, BrowserError>;
  /** A plain pause on the page, admitted like any wait so the page cannot change under it. */
  readonly pause: (
    milliseconds: number,
    options: ExecutionOptions,
  ) => Effect.Effect<void, BrowserError>;
  /** Wait for a resolved node to reach a state. */
  readonly waitFor: (
    target: Resolved,
    state: WaitForElementRequest["state"],
    timeoutMillis: number | undefined,
    options: ExecutionOptions,
  ) => Effect.Effect<void, BrowserError>;
  /** Check conditions on the page as one charged read. */
  readonly expectations: (
    conditions: ReadonlyArray<Precondition>,
    options: ExecutionOptions,
  ) => Effect.Effect<void, BrowserError>;
}

export interface StepDependencies {
  /** The issued page or frame every step resolves and acts through. */
  readonly target: DriverTarget;
  readonly controls: StepControls;
  /** Charges a step's own native reads (preconditions, resolution) to its admitted operation. */
  readonly chargeHostRead: (ticket: Ticket, operation: BrowserOperation) => void;
}

/**
 * Runs plan steps on one issued page or frame: preconditions and target resolution inside the
 * step's first admitted operation, then the action, then its postconditions and checkpoint.
 */
export const makePlanSteps = ({ target, controls, chargeHostRead }: StepDependencies) => {
  const decodeReceipt = <S extends Schema.Constraint>(schema: S, value: unknown) =>
    Schema.decodeUnknownEffect(schema)(value).pipe(
      Effect.mapError(() =>
        BrowserError.make({
          operation: "run",
          reason: Reasons.Malformed.make({}),
          outcome: "performed",
        }),
      ),
    );

  return (
    step: Step,
    inputs: InputBindings,
    context: StepExecution,
  ): Effect.Effect<StepSuccess, BrowserError> =>
    Effect.suspend(() => {
      let currentPhase: RunPhase =
        step.action._tag === "FillForm"
          ? "Field"
          : step.action._tag === "Wait" && step.action.mode._tag === "Settled"
            ? "Settled"
            : "Input";

      let currentField: number | undefined;

      const preparation = makeStepPreparation({
        step,
        target,
        context,
        chargeHostRead,
        current: () => [currentPhase, currentField],
      });

      const { requests, element: groupElement } = preparation;

      const planOptions: ExecutionOptions = {
        ...context.options,
        ...(context.coordinatePolicy === undefined
          ? {}
          : { coordinatePolicy: context.coordinatePolicy }),
        ...(context.performance === undefined
          ? {}
          : {
              performance: {
                plan: context.performance,
                get fieldIndex() {
                  return currentField;
                },
              },
            }),
        phase: (phase, fieldIndex) => {
          currentPhase = phase;
          currentField = fieldIndex;
          context.phase(phase, fieldIndex);
        },
        beforeNative: preparation.beforeNative,
      };

      const indexed = (value: ActionTarget): (() => ResolvedElement) => {
        const index = requests.findIndex((request) => request.target === value);

        return () => groupElement(index);
      };

      const inputValue = (value: ValueSource): Effect.Effect<string, BrowserError> =>
        value._tag === "Literal"
          ? Effect.succeed(value.value)
          : inputs[value.name] === undefined
            ? Effect.fail(
                BrowserError.make({
                  operation: "run",
                  reason: Reasons.Configuration.make({ path: `inputs.${value.name}` }),
                  outcome: "undispatched",
                }),
              )
            : Effect.succeed(inputs[value.name] ?? "");

      const policy: AdmissionPolicy | undefined = context.policy?.admit;
      const action = step.action;

      const perform: Effect.Effect<RunReceipt, BrowserError> = Effect.suspend(() => {
        switch (action._tag) {
          case "Navigate":
            return controls.operations
              .navigate(action.url, action.timeoutMillis, planOptions)
              .pipe(Effect.flatMap((url) => decodeReceipt(NavigationResult, { url })));
          case "Click":
            return controls.operations
              .click(indexed(action.target), policy, planOptions)
              .pipe(Effect.flatMap((value) => decodeReceipt(ActionResult, value)));
          case "Hover":
            return controls.operations
              .hover(indexed(action.target), policy, planOptions)
              .pipe(
                Effect.flatMap((value) => decodeReceipt(InputReceipt, { ...value, kind: "hover" })),
              );
          case "Fill":
            return inputValue(action.value).pipe(
              Effect.flatMap((value) =>
                controls.operations.fill(indexed(action.target), value, policy, planOptions),
              ),
              Effect.flatMap((url) => decodeReceipt(ActionResult, { url })),
            );
          case "Type":
            return inputValue(action.text).pipe(
              Effect.flatMap((value) =>
                controls.operations.type(
                  value,
                  action.target === undefined ? undefined : indexed(action.target),
                  policy,
                  planOptions,
                ),
              ),
              Effect.flatMap((value) => decodeReceipt(InputReceipt, { ...value, kind: "type" })),
            );
          case "Press":
            return controls.operations
              .press(
                action.key,
                action.modifiers ?? [],
                action.target === undefined ? undefined : indexed(action.target),
                policy,
                planOptions,
              )
              .pipe(
                Effect.flatMap((value) => decodeReceipt(InputReceipt, { ...value, kind: "press" })),
              );
          case "Select":
            return controls
              .selectOption(
                indexed(action.target),
                () => action.options.map((option) => indexed(option)()),
                policy,
                planOptions,
              )
              .pipe(Effect.flatMap((url) => decodeReceipt(ActionResult, { url })));
          case "Scroll": {
            const mode = action.mode;

            return (
              mode._tag === "By"
                ? controls.operations.scroll(mode.deltaX, mode.deltaY, planOptions)
                : controls.scrollTo(indexed(mode.target), planOptions)
            ).pipe(Effect.flatMap((url) => decodeReceipt(ActionResult, { url })));
          }
          case "PointerClick":
            // Exact-node admission cannot authorize an input with no exact node. A host that
            // supplies it must separately authorize coordinates before this plan can click them.
            if (context.policy !== undefined && context.coordinatePolicy === undefined)
              return Effect.fail(
                BrowserError.make({
                  operation: "pointer-click",
                  reason: Reasons.Denied.make({}),
                  outcome: "undispatched",
                }),
              );

            return controls.operations
              .pointerClick(
                {
                  ...action.at,
                  ...(action.button === undefined ? {} : { button: action.button }),
                  ...(action.clickCount === undefined ? {} : { clickCount: action.clickCount }),
                },
                planOptions,
              )
              .pipe(
                Effect.flatMap((value) => decodeReceipt(InputReceipt, { ...value, kind: "click" })),
              );
          case "PointerMove":
            return controls.operations
              .pointerMove(action.to, planOptions)
              .pipe(
                Effect.flatMap((value) =>
                  decodeReceipt(InputReceipt, { ...value, kind: "pointer-move" }),
                ),
              );
          case "Wheel":
            return controls.operations
              .wheel(action.deltaX, action.deltaY, action.at, planOptions)
              .pipe(
                Effect.flatMap((value) =>
                  decodeReceipt(InputReceipt, {
                    ...value,
                    kind: "wheel",
                    delta: { x: action.deltaX, y: action.deltaY },
                  }),
                ),
              );
          case "Wait": {
            const mode = action.mode;

            if (mode._tag === "Settled") return controls.settled(mode, planOptions);
            if (mode._tag === "Duration") return controls.pause(mode.milliseconds, planOptions);

            return controls.waitFor(
              indexed(mode.target),
              mode.state,
              mode.timeoutMillis,
              planOptions,
            );
          }
          case "FillForm":
            return Effect.gen(function* () {
              // Each control reports the ID its plan target named; a descriptor its position.
              const reported = (target: ActionTarget, fallback: string) =>
                target._tag === "Ref" ? target.reference.elementId : fallback;

              const fields = yield* Effect.forEach(
                action.fields,
                (field, index): Effect.Effect<FormSteps["fields"][number], BrowserError> => {
                  const reportedId = reported(field.target, `field_${index}`);
                  const reference = indexed(field.target);

                  return field._tag === "Value"
                    ? inputValue(field.value).pipe(
                        Effect.map((value) => ({
                          reportedId,
                          reference,
                          field: () => ({ elementId: reportedId, value }),
                        })),
                      )
                    : Effect.succeed({
                        reportedId,
                        reference,
                        field:
                          field._tag === "Checked"
                            ? () => ({ elementId: reportedId, checked: field.checked })
                            : () => ({
                                elementId: reportedId,
                                options: field.options.map((option) => indexed(option)()),
                              }),
                      });
                },
              );

              const submit = action.submit;

              const result = yield* controls.fillForm(
                {
                  fields,
                  ...(submit === undefined
                    ? {}
                    : {
                        submit: {
                          reportedId: reported(submit, "submit"),
                          reference: indexed(submit),
                        },
                      }),
                  retainObservation: false,
                },
                policy,
                {
                  verify: action.options?.verify ?? true,
                  settleMillis: action.options?.settleMillis ?? 50,
                },
                planOptions,
              );

              const receipt = yield* decodeReceipt(FillFormResult, result);

              context.retainReceipt(receipt);
              if (result.stopped !== undefined) return yield* result.stopped.error;

              return receipt;
            });
        }
      });

      return perform.pipe(
        Effect.tap((receipt) => Effect.sync(() => context.retainReceipt(receipt))),
        Effect.flatMap((receipt) => {
          const checkpointOptions = context.checkpoint;

          const after =
            step.expect?.after === undefined
              ? Effect.void
              : Effect.suspend(() => {
                  context.phase("Postcondition");

                  return controls.expectations(step.expect?.after ?? [], context.options);
                });

          return after.pipe(
            Effect.andThen(
              checkpointOptions === undefined
                ? Effect.succeed({ receipt })
                : Effect.suspend(() => {
                    context.phase("Checkpoint");

                    return controls
                      .checkpoint(
                        { ...checkpointOptions, picture: checkpointOptions.picture ?? false },
                        context.options,
                      )
                      .pipe(
                        Effect.flatMap((value) => decodeReceipt(Checkpoint, value)),
                        Effect.map((checkpoint) => ({ receipt, checkpoint })),
                      );
                  }),
            ),
          );
        }),
        Effect.ensuring(Effect.promise(preparation.release)),
      );
    });
};
