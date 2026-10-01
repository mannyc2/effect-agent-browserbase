import { Effect, Schema } from "effect";

import { TypeRequest } from "../../BrowserData.ts";
import { BrowserError, Reasons } from "../../Errors.ts";
import {
  type Action,
  type ActionTarget,
  type CaptureIncompleteReason,
  type Descriptor,
  type DescriptorCapture,
  type InputBindings,
  InputValue,
  type LivePlan,
  RecordedAction,
  type RecordedTarget,
  type Step,
  type ValueSource,
} from "../../PlanData.ts";
import type { DescriptorSample } from "./Descriptor.ts";

export interface ActionTargetPath {
  readonly target: ActionTarget;
  readonly path: ReadonlyArray<string>;
  readonly parent?: number;
  /** Passive Ref waits have no later input admission that could supply fresh recording facts. */
  readonly captureInitial?: boolean;
}

/** The same ordered inventory serves exact-node group resolution and capture correlation. */
export const actionTargets = (action: Action): ReadonlyArray<ActionTargetPath> => {
  switch (action._tag) {
    case "Click":
    case "Hover":
    case "Fill":
      return [{ target: action.target, path: ["target"] }];
    case "Type":
    case "Press":
      return action.target === undefined ? [] : [{ target: action.target, path: ["target"] }];
    case "Select":
      return [
        { target: action.target, path: ["target"] },
        ...action.options.map((target, index) => ({
          target,
          path: ["options", String(index)],
          parent: 0,
        })),
      ];
    case "FillForm": {
      const inventory: Array<ActionTargetPath> = [];

      action.fields.forEach((field, index) => {
        const parent = inventory.length;

        inventory.push({ target: field.target, path: ["fields", String(index), "target"] });
        if (field._tag === "Options")
          field.options.forEach((target, option) =>
            inventory.push({
              target,
              path: ["fields", String(index), "options", String(option)],
              parent,
            }),
          );
      });
      if (action.submit !== undefined) inventory.push({ target: action.submit, path: ["submit"] });

      return inventory;
    }
    case "Scroll":
      return action.mode._tag === "To"
        ? [{ target: action.mode.target, path: ["mode", "target"] }]
        : [];
    case "Wait":
      return action.mode._tag === "Element"
        ? [{ target: action.mode.target, path: ["mode", "target"], captureInitial: true }]
        : [];
    case "Navigate":
    case "PointerMove":
    case "Wheel":
      return [];
  }
};

interface InputPath {
  readonly value: ValueSource;
  readonly path: ReadonlyArray<string>;
  readonly typed: boolean;
}

const inputPaths = (action: Action): ReadonlyArray<InputPath> => {
  switch (action._tag) {
    case "Fill":
      return [{ value: action.value, path: ["value"], typed: false }];
    case "Type":
      return [{ value: action.text, path: ["text"], typed: true }];
    case "FillForm":
      return action.fields.flatMap((field, index) =>
        field._tag === "Value"
          ? [{ value: field.value, path: ["fields", String(index), "value"], typed: false }]
          : [],
      );
    case "Click":
    case "Hover":
    case "Navigate":
    case "PointerMove":
    case "Press":
    case "Scroll":
    case "Select":
    case "Wait":
    case "Wheel":
      return [];
  }
};

/** One named input use: the step and action path that read it, and how its value is used. */
export interface NamedInput {
  readonly name: string;
  readonly stepId: string;
  readonly path: ReadonlyArray<string>;
  readonly kind: "text" | "value";
}

/** Every named input the steps read, in step and action order; literal values are not inputs. */
export const namedInputs = (
  steps: ReadonlyArray<{ readonly id: string; readonly action: Action }>,
): ReadonlyArray<NamedInput> =>
  Object.freeze(
    steps.flatMap((step) =>
      inputPaths(step.action).flatMap((input) =>
        input.value._tag === "Input"
          ? [
              Object.freeze({
                name: input.value.name,
                stepId: step.id,
                path: Object.freeze([...input.path]),
                kind: input.typed ? ("text" as const) : ("value" as const),
              }),
            ]
          : [],
      ),
    ),
  );

/** Length-prefixed segments cannot alias another step/path, including nested form values. */
export const pathKey = (path: ReadonlyArray<string>): string =>
  path.map((part) => `${part.length}_${part}`).join("_");

export type InputSlots = ReadonlyMap<string, ReadonlyMap<string, string>>;

export const inputSlots = (plan: LivePlan): InputSlots => {
  const names = new Set<string>();
  const slots = new Map<string, ReadonlyMap<string, string>>();

  for (const step of plan.steps)
    for (const input of inputPaths(step.action))
      if (input.value._tag === "Input") names.add(input.value.name);
  for (const step of plan.steps) {
    const values = new Map<string, string>();

    for (const input of inputPaths(step.action)) {
      if (input.value._tag === "Input") continue;
      const base = `record_${pathKey([step.id, ...input.path])}`;
      let name = base;
      let collision = 0;

      while (names.has(name)) name = `${base}_${++collision}`;
      names.add(name);
      values.set(pathKey(input.path), name);
    }
    slots.set(step.id, values);
  }

  return slots;
};

/** Even a later step's missing or invalid binding refuses the walk before its first dispatch. */
export const validateInputs = (plan: LivePlan, inputs: InputBindings) =>
  Effect.forEach(
    plan.steps,
    (step) =>
      Effect.forEach(
        inputPaths(step.action),
        (input) => {
          const value =
            input.value._tag === "Literal" ? input.value.value : inputs[input.value.name];

          return Schema.decodeUnknownEffect(input.typed ? TypeRequest.fields.text : InputValue)(
            value,
          ).pipe(
            Effect.mapError(() =>
              BrowserError.make({
                operation: "run",
                reason: Reasons.Malformed.make({ path: `${step.id}/${input.path.join("/")}` }),
                outcome: "undispatched",
              }),
            ),
          );
        },
        { discard: true },
      ),
    { discard: true },
  );

export interface TargetSample {
  readonly path: ReadonlyArray<string>;
  readonly sample?: DescriptorSample;
}

const incomplete = (
  path: ReadonlyArray<string>,
  sample: DescriptorSample | undefined,
  reason: CaptureIncompleteReason,
): DescriptorCapture => ({
  _tag: "Incomplete",
  facts: {
    path,
    ...(sample === undefined ? {} : { matchScope: sample.scope }),
    ...(sample === undefined ? {} : { facts: sample.facts }),
  },
  reason,
});

const descriptor = (sample: DescriptorSample): Descriptor | CaptureIncompleteReason => {
  const completeness = sample.completeness;
  const facts = sample.facts;

  if (completeness === undefined) return "FactsUnavailable";
  if (completeness.label !== "complete") return "LabelOmitted";
  if (completeness.destination === "omitted") return "DestinationOmitted";
  if (
    completeness.inputType === "omitted" ||
    completeness.autocomplete === "omitted" ||
    completeness.formMethod === "omitted"
  )
    return "IdentityOmitted";
  for (const field of ["destination", "inputType", "autocomplete", "formMethod"] as const)
    if ((completeness[field] === "complete") !== (facts[field] !== undefined))
      return "FactsUnavailable";
  if (!sample.frameComplete || (!facts.mainFrame && sample.frame === undefined))
    return "FrameUnavailable";

  const identity = {
    ...(facts.inputType === undefined ? {} : { inputType: facts.inputType }),
    ...(facts.autocomplete === undefined ? {} : { autocomplete: facts.autocomplete }),
    ...(facts.formMethod === undefined ? {} : { formMethod: facts.formMethod }),
  };

  return {
    kind: facts.kind,
    label: facts.label,
    matchScope: sample.scope,
    ...(facts.destination === undefined ? {} : { destination: facts.destination }),
    ...(Object.keys(identity).length === 0 ? {} : { identity }),
    ...(sample.ordinal === undefined ? {} : { ordinal: sample.ordinal }),
    ...(sample.frame === undefined ? {} : { frame: sample.frame }),
  };
};

/** No authored descriptor substitutes for the facts of the exact node this attempt checked. */
export const capture = (
  step: Step,
  samples: ReadonlyMap<string, TargetSample>,
  slots: InputSlots,
  overflow: boolean,
): Effect.Effect<DescriptorCapture> => {
  if (overflow) return Effect.succeed(incomplete([], undefined, "EvidenceLimit"));
  const targets = new Map<string, RecordedTarget>();

  for (const entry of actionTargets(step.action)) {
    const sampled = samples.get(pathKey(entry.path));
    const sample = sampled?.sample;

    if (sample === undefined)
      return Effect.succeed(incomplete(entry.path, sample, "TargetUnavailable"));
    const recorded = descriptor(sample);

    if (typeof recorded === "string")
      return Effect.succeed(incomplete(entry.path, sample, recorded));
    targets.set(pathKey(entry.path), { _tag: "Descriptor", descriptor: recorded });
  }

  const target = (path: ReadonlyArray<string>): RecordedTarget | undefined =>
    targets.get(pathKey(path));

  const value = (source: ValueSource, path: ReadonlyArray<string>) =>
    source._tag === "Input"
      ? source
      : { _tag: "Input", name: slots.get(step.id)?.get(pathKey(path)) };

  const action = step.action;

  const project = (): unknown => {
    switch (action._tag) {
      case "Click":
      case "Hover":
        return { ...action, target: target(["target"]) };
      case "Fill":
        return { ...action, target: target(["target"]), value: value(action.value, ["value"]) };
      case "Type":
        return {
          ...action,
          ...(action.target === undefined ? {} : { target: target(["target"]) }),
          text: value(action.text, ["text"]),
        };
      case "Press":
        return {
          ...action,
          ...(action.target === undefined ? {} : { target: target(["target"]) }),
        };
      case "Select":
        return {
          ...action,
          target: target(["target"]),
          options: action.options.map((_, index) => target(["options", String(index)])),
        };
      case "FillForm":
        return {
          ...action,
          fields: action.fields.map((field, index) => ({
            ...field,
            target: target(["fields", String(index), "target"]),
            ...(field._tag === "Value"
              ? { value: value(field.value, ["fields", String(index), "value"]) }
              : {}),
            ...(field._tag === "Options"
              ? {
                  options: field.options.map((_, option) =>
                    target(["fields", String(index), "options", String(option)]),
                  ),
                }
              : {}),
          })),
          ...(action.submit === undefined ? {} : { submit: target(["submit"]) }),
        };
      case "Scroll":
        return action.mode._tag === "To"
          ? { ...action, mode: { ...action.mode, target: target(["mode", "target"]) } }
          : action;
      case "Wait":
        return action.mode._tag === "Element"
          ? { ...action, mode: { ...action.mode, target: target(["mode", "target"]) } }
          : action;
      case "Navigate":
      case "PointerMove":
      case "Wheel":
        return action;
    }
  };

  return Schema.decodeUnknownEffect(RecordedAction)(project(), { onExcessProperty: "error" }).pipe(
    Effect.map((action): DescriptorCapture => ({ _tag: "Complete", action })),
    Effect.orElseSucceed(() => incomplete([], undefined, "FactsUnavailable")),
  );
};
