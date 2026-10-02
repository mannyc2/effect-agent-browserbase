import { Duration, Option, Schema } from "effect";

const FiniteDurationValue = Schema.Union([
  Schema.TaggedStruct("Millis", { millis: Schema.Finite }),
  Schema.TaggedStruct("Nanos", { nanos: Schema.BigInt }),
]);

// Duration.fromInput intentionally normalizes raw NaN to zero. Validate raw components first
// so an invalid queue allowance cannot silently become fail-fast admission.
export const FiniteDurationInput = Schema.Union([
  // The built-in declaration checks only the Duration marker. Validate its representation
  // before arithmetic so a malformed host value is a typed refusal rather than a defect.
  Schema.Duration.check(
    Schema.makeFilter((duration) => Schema.is(FiniteDurationValue)(duration.value)),
  ),
  Schema.Finite,
  Schema.BigInt,
  Schema.TemplateLiteral([
    Schema.Finite,
    " ",
    Schema.Literals([
      "nano",
      "nanos",
      "micro",
      "micros",
      "milli",
      "millis",
      "second",
      "seconds",
      "minute",
      "minutes",
      "hour",
      "hours",
      "day",
      "days",
      "week",
      "weeks",
    ]),
  ]),
  Schema.Literals(["Infinity", "-Infinity"]),
  Schema.Tuple([Schema.Finite, Schema.Finite]),
  Schema.Struct({
    weeks: Schema.optionalKey(Schema.Finite),
    days: Schema.optionalKey(Schema.Finite),
    hours: Schema.optionalKey(Schema.Finite),
    minutes: Schema.optionalKey(Schema.Finite),
    seconds: Schema.optionalKey(Schema.Finite),
    milliseconds: Schema.optionalKey(Schema.Finite),
    microseconds: Schema.optionalKey(Schema.Finite),
    nanoseconds: Schema.optionalKey(Schema.Finite),
  }),
]).check(
  Schema.makeFilter(
    (input) =>
      Option.exists(
        Duration.fromInput(input),
        (duration) =>
          Duration.isFinite(duration) &&
          !Duration.isNegative(duration) &&
          Number.isFinite(Duration.toMillis(duration)),
      ),
    { message: "Queue duration must be finite and nonnegative" },
  ),
);

/** Host configuration only; never part of model-facing request schemas. */
export const AdmissionOptionsSchema = Schema.Struct({
  queue: Schema.optionalKey(FiniteDurationInput),
});

export const OperationOptionsSchema = Schema.Struct({
  timeoutMillis: Schema.optionalKey(
    Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 60000 })),
  ),
  admission: Schema.optionalKey(AdmissionOptionsSchema),
});
