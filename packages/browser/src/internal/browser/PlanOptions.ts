import { Duration, Effect, Schema } from "effect";

import type {
  CoordinateAdmission,
  ElementAdmission,
  OperationOptions,
  ResolveOptions,
  SettledRequest,
} from "../../Browser.ts";
import { CheckpointOptions, Identifier } from "../../BrowserData.ts";
import { BrowserError, Reasons, type BrowserOperation } from "../../Errors.ts";
import type { RunOptions } from "../../Plan.ts";
import {
  Descriptor,
  InputBindings,
  Limits,
  LivePlan,
  Performed,
  ResolveGuard,
  SettledOptions,
} from "../../PlanData.ts";
import { FiniteDurationInput, OperationOptionsSchema } from "./OperationOptions.ts";
import { guardedDecode } from "./PlanInput.ts";
import { schemaPath } from "./SchemaPath.ts";

/** Frozen host durations, never model-facing inputs or native authority. */
export interface PlanExecutionOptions extends RunOptions {
  readonly style?: "plain" | Performed;
  readonly withinMillis?: number;
  readonly queueMillis?: number;
}

const durationPrototype: unknown = Object.getPrototypeOf(Duration.zero);

/** Inspect data descriptors, rather than evaluating caller-supplied getters. */
const ownFields = (value: unknown, keys: ReadonlyArray<string>): Record<string, unknown> => {
  if (value === null || typeof value !== "object" || Array.isArray(value))
    throw new Error("Expected host option data");
  const prototype: unknown = Object.getPrototypeOf(value);

  if (prototype !== Object.prototype && prototype !== null)
    throw new Error("Expected plain host option data");
  const fields: Record<string, unknown> = {};
  const names = Reflect.ownKeys(value);

  if (names.length > keys.length) throw new Error("Unexpected host option");
  for (const name of names) {
    const descriptor = Object.getOwnPropertyDescriptor(value, name);

    if (
      typeof name !== "string" ||
      !keys.includes(name) ||
      descriptor === undefined ||
      !descriptor.enumerable ||
      !("value" in descriptor)
    )
      throw new Error("Expected declared host option data");
    fields[name] = descriptor.value;
  }

  return fields;
};

const configuration = (operation: BrowserOperation) =>
  BrowserError.make({
    operation,
    reason: Reasons.Configuration.make({}),
    outcome: "undispatched",
  });

const hostFields = (value: unknown, keys: ReadonlyArray<string>, operation: BrowserOperation) =>
  Effect.try({
    try: () => ownFields(value === undefined ? {} : value, keys),
    catch: () => configuration(operation),
  });

const checkedData = <S extends Schema.Constraint>(
  schema: S,
  value: unknown,
  operation: BrowserOperation,
) =>
  guardedDecode(schema)(value, { onExcessProperty: "error" }).pipe(
    Effect.mapError((error) =>
      BrowserError.make({
        operation,
        reason: Reasons.Configuration.make(schemaPath(error)),
        outcome: "undispatched",
      }),
    ),
  );

const durationData = (value: unknown, depth = 0): void => {
  if (typeof value === "string" && value.length > Limits.encodedBytes)
    throw new Error("Duration input is too large");
  if (value === null || typeof value !== "object") return;
  if (depth > 2) throw new Error("Duration input is too deep");
  const prototype: unknown = Object.getPrototypeOf(value);

  if (
    prototype !== Object.prototype &&
    prototype !== null &&
    prototype !== Array.prototype &&
    prototype !== durationPrototype
  )
    throw new Error("Expected duration data");
  const keys = Reflect.ownKeys(value);

  if (keys.length > 10) throw new Error("Duration input has too many fields");
  for (const key of keys) {
    const descriptor = Object.getOwnPropertyDescriptor(value, key);

    if (descriptor === undefined || !("value" in descriptor))
      throw new Error("Expected duration data");
    durationData(descriptor.value, depth + 1);
  }
};

const millis = (value: unknown, positive: boolean, operation: BrowserOperation) =>
  Effect.try({
    try: () => {
      durationData(value);

      return value;
    },
    catch: () => configuration(operation),
  }).pipe(
    Effect.flatMap((value) =>
      Schema.decodeUnknownEffect(FiniteDurationInput)(value, {
        onExcessProperty: "error",
      }).pipe(Effect.mapError(() => configuration(operation))),
    ),
    Effect.map((value) => Duration.toMillis(Duration.fromInputUnsafe(value))),
    Effect.filterOrFail(
      (value) => !positive || value > 0,
      () => configuration(operation),
    ),
  );

const operationData = (fields: Record<string, unknown>, operation: BrowserOperation) =>
  Effect.gen(function* () {
    const admission =
      fields.admission === undefined
        ? undefined
        : yield* hostFields(fields.admission, ["queue"], operation);

    const queue =
      admission?.queue === undefined ? undefined : yield* millis(admission.queue, false, operation);

    return yield* checkedData(
      OperationOptionsSchema,
      {
        ...(fields.timeoutMillis === undefined ? {} : { timeoutMillis: fields.timeoutMillis }),
        ...(admission === undefined ? {} : { admission: queue === undefined ? {} : { queue } }),
      },
      operation,
    );
  });

const RunData = Schema.Struct({
  style: Schema.optionalKey(Schema.Union([Schema.Literal("plain"), Performed])),
  through: Schema.optionalKey(Identifier),
  inputs: Schema.optionalKey(InputBindings),
  checkpoint: Schema.optionalKey(CheckpointOptions),
});

const CoordinateFunction = Schema.declare<CoordinateAdmission["admit"]>(
  (value): value is CoordinateAdmission["admit"] => typeof value === "function",
);

const coordinatePolicy = Effect.fnUntraced(function* (value: unknown, operation: BrowserOperation) {
  if (value === undefined) return undefined;
  const fields = yield* hostFields(value, ["admit"], operation);

  const admit = yield* Schema.decodeUnknownEffect(CoordinateFunction)(fields.admit).pipe(
    Effect.mapError(() => configuration(operation)),
  );

  return Object.freeze({ admit });
});

export const checkedPointerClickOptions = Effect.fnUntraced(function* (value: unknown) {
  const fields = yield* hostFields(
    value,
    ["timeoutMillis", "admission", "coordinatePolicy"],
    "pointer-click",
  );

  const operation = yield* operationData(fields, "pointer-click");
  const policy = yield* coordinatePolicy(fields.coordinatePolicy, "pointer-click");

  return { ...operation, ...(policy === undefined ? {} : { coordinatePolicy: policy }) };
});

const AdmissionFunction = Schema.declare<ElementAdmission["admit"]>(
  (value): value is ElementAdmission["admit"] => typeof value === "function",
);

export const checkedRunOptions = (
  value: unknown,
): Effect.Effect<PlanExecutionOptions, BrowserError> =>
  Effect.gen(function* () {
    const fields = yield* hostFields(
      value,
      [
        "style",
        "startAt",
        "within",
        "through",
        "inputs",
        "policy",
        "coordinatePolicy",
        "checkpoint",
        "timeoutMillis",
        "admission",
      ],
      "run",
    );

    const operation = yield* operationData(fields, "run");

    const withinMillis =
      fields.within === undefined ? undefined : yield* millis(fields.within, true, "run");

    const startAt =
      fields.startAt === undefined
        ? undefined
        : yield* Schema.decodeUnknownEffect(
            Schema.BigInt.check(
              Schema.makeFilter(
                (value) =>
                  Number.isFinite(Number(value)) &&
                  Math.abs(Number(value) / 1_000_000) <= Number.MAX_SAFE_INTEGER,
                { title: "finite runtime monotonic instant" },
              ),
            ),
          )(fields.startAt).pipe(Effect.mapError(() => configuration("run")));

    const coordinate = yield* coordinatePolicy(fields.coordinatePolicy, "run");

    let policy: ElementAdmission | undefined;

    if (fields.policy !== undefined) {
      const fieldsOfPolicy = yield* hostFields(fields.policy, ["admit"], "run");

      const admit = yield* Schema.decodeUnknownEffect(AdmissionFunction)(fieldsOfPolicy.admit).pipe(
        Effect.mapError(() => configuration("run")),
      );

      policy = Object.freeze({ admit });
    }

    const data = yield* checkedData(
      RunData,
      {
        ...(fields.style === undefined ? {} : { style: fields.style }),
        ...(fields.through === undefined ? {} : { through: fields.through }),
        ...(fields.inputs === undefined ? {} : { inputs: fields.inputs }),
        ...(fields.checkpoint === undefined ? {} : { checkpoint: fields.checkpoint }),
      },
      "run",
    );

    return Object.freeze({
      ...operation,
      ...(withinMillis === undefined ? {} : { within: withinMillis, withinMillis }),
      ...(data.style === undefined
        ? {}
        : {
            style:
              data.style === "plain"
                ? "plain"
                : Object.freeze({
                    ...data.style,
                    motion: Object.freeze({
                      ...data.style.motion,
                      pointer: Object.freeze({
                        ...data.style.motion.pointer,
                        duration: Object.freeze({ ...data.style.motion.pointer.duration }),
                      }),
                      keys: Object.freeze({
                        interval: Object.freeze({ ...data.style.motion.keys.interval }),
                        hold: Object.freeze({ ...data.style.motion.keys.hold }),
                      }),
                      scroll: Object.freeze({
                        ...data.style.motion.scroll,
                        duration: Object.freeze({ ...data.style.motion.scroll.duration }),
                      }),
                    }),
                    slips: Object.freeze({ ...data.style.slips }),
                  }),
          }),
      ...(startAt === undefined ? {} : { startAt }),
      ...(operation.admission?.queue === undefined
        ? {}
        : { queueMillis: Duration.toMillis(Duration.fromInputUnsafe(operation.admission.queue)) }),
      ...(data.through === undefined ? {} : { through: data.through }),
      ...(data.inputs === undefined ? {} : { inputs: Object.freeze({ ...data.inputs }) }),
      ...(data.checkpoint === undefined
        ? {}
        : { checkpoint: Object.freeze({ ...data.checkpoint }) }),
      ...(policy === undefined ? {} : { policy }),
      ...(coordinate === undefined ? {} : { coordinatePolicy: coordinate }),
    });
  });

export const checkedLivePlan = (value: unknown) => checkedData(LivePlan, value, "run");
export const checkedDescriptor = (value: unknown) => checkedData(Descriptor, value, "resolve");

export const checkedResolveOptions = (value: ResolveOptions | undefined) =>
  Effect.gen(function* () {
    const fields = yield* hostFields(value, ["guard", "timeoutMillis", "admission"], "resolve");
    const operationOptions: OperationOptions = yield* operationData(fields, "resolve");

    const guard = yield* checkedData(
      ResolveGuard,
      fields.guard === undefined ? { _tag: "Strict" } : fields.guard,
      "resolve",
    );

    return { operationOptions, guard };
  });

export const checkedSettled = (value: SettledRequest) =>
  Effect.gen(function* () {
    const fields = yield* hostFields(value, ["quiet", "within"], "settled");
    const quietMillis = yield* millis(fields.quiet, true, "settled");
    const withinMillis = yield* millis(fields.within, true, "settled");

    return yield* checkedData(SettledOptions, { quietMillis, withinMillis }, "settled");
  });
