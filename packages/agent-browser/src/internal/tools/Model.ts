import { Option, Predicate, Schema, SchemaGetter } from "effect";
import { BrowserActionResult, BrowserNavigationResult } from "effect-agent/interactive-browser";
import {
  FillRequest,
  Identifier,
  KeyStroke,
  Observation,
  TypeRequest,
  WaitForElementRequest,
  WheelRequest,
} from "effect-browser/browser-data";
import type { BrowserError } from "effect-browser/errors";

/** A declared Tool failure, not a successful payload with an embedded error. */
export class BrowserToolFailure extends Schema.TaggedError<BrowserToolFailure>()(
  "BrowserToolFailure",
  {
    reason: Schema.Literals([
      "stale",
      "busy",
      "denied",
      "not-found",
      "ambiguous",
      "not-visible",
      "not-focused",
      "disabled",
      "unsupported",
      "limit",
      "timeout",
      "closed",
      "failed",
    ]),
    outcome: Schema.Literals(["undispatched", "rejected", "unknown"]),
  },
) {}

const toolReasons = {
  Stale: "stale",
  TargetChanged: "stale",
  Resized: "stale",
  Interrupted: "stale",
  Busy: "busy",
  Active: "busy",
  RateLimited: "busy",
  Denied: "denied",
  Authorization: "denied",
  UnsafeUrl: "denied",
  NotFound: "not-found",
  Ambiguous: "ambiguous",
  NotVisible: "not-visible",
  NotFocused: "not-focused",
  Disabled: "disabled",
  Unsupported: "unsupported",
  Limit: "limit",
  Timeout: "timeout",
  Closed: "closed",
  Expired: "closed",
  Disconnected: "closed",
  UnregisteredSession: "closed",
  Configuration: "failed",
  Malformed: "failed",
  Transport: "failed",
  Provider: "failed",
  Failed: "failed",
  ContentType: "failed",
  Timestamp: "failed",
  ContextLease: "failed",
} as const satisfies Record<BrowserError["reason"]["_tag"], BrowserToolFailure["reason"]>;

/** The compact projection a model sees. Provider facts, paths and measurements stay on the host. */
export const projectFailure = (error: BrowserError): BrowserToolFailure =>
  BrowserToolFailure.make({ reason: toolReasons[error.reason._tag], outcome: error.outcome });

const ObservationIdParameter = Identifier.annotate({
  description: "observationId of the latest observation, from browser_inspect or an action result",
});

const ElementIdParameter = Identifier.annotate({
  description: "elementId of a control in that same observation",
});

/** One control of one observation. Only issued IDs identify a control; never construct one. */
export const ElementReference = Schema.Struct({
  observationId: ObservationIdParameter,
  elementId: ElementIdParameter,
});

export type ElementReference = typeof ElementReference.Type;

// A description attaches to a schema's last check, and a custom filter has no JSON Schema form.
// Parameters are therefore described before their custom filters, or a provider never sees it.

/**
 * An optional parameter a model may also send as null. Effect's OpenAI and Anthropic
 * structured-output codecs make every key required and nullable, so a model sends null for each
 * parameter it leaves out. Null decodes as the absent key, so the host, an approval predicate
 * and the recorded call all see the request the model meant. The description sits on the
 * nullable value the provider shows, and says what null does.
 */
const optionalParameter = <S extends Schema.Constraint>(schema: S, description: string) =>
  Schema.optionalKey(Schema.NullOr(schema).annotate({ description })).pipe(
    Schema.decodeTo(Schema.optionalKey(Schema.toType(schema)), {
      decode: SchemaGetter.transformOptional(Option.filter(Predicate.isNotNull)),
      encode: SchemaGetter.passthroughSubtype(),
    }),
  );

/** `ReadingMatch`; the browser checks it again when it reads. */
const FindParameter = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(256),
  Schema.makeFilter((value) => value.trim().length > 0, { title: "not only whitespace" }),
);

/** `SelectOptions`, described when it stands alone. */
const optionsParameter = (description?: string) => {
  const bounded = Schema.Array(Identifier).check(Schema.isMinLength(1), Schema.isMaxLength(64));

  return (description === undefined ? bounded : bounded.annotate({ description })).check(
    Schema.makeFilter((ids) => new Set(ids).size === ids.length, { title: "each at most once" }),
  );
};

/** What a model may ask of one reading; the host decides the bounds and the default scope. */
export const InspectRequest = Schema.Struct({
  find: optionalParameter(
    FindParameter,
    "Case-insensitive text to look for. Only controls whose label contains it, and text lines containing it, are returned; matches are kept even when earlier content would fill the reading. null keeps everything in scope",
  ),
  scope: optionalParameter(
    Schema.Literals(["viewport", "document"]),
    "viewport reads what is on screen now; scroll to see more. document reads the whole page in document order; combine it with find to search the page. null reads the default scope",
  ),
});

export type InspectRequest = typeof InspectRequest.Type;

export const FillParameters = Schema.Struct({
  reference: ElementReference,
  value: FillRequest.fields.value.annotate({
    description: "The complete text for this input or textarea; it replaces what is there",
  }),
});

export const SelectOptionParameters = Schema.Struct({
  reference: ElementReference,
  options: optionsParameter(
    "elementIds of the options to select, from the same observation; their selectElementId names this select",
  ),
});

export const PressParameters = Schema.Struct({
  reference: ElementReference,
  key: KeyStroke.fields.key,
  modifiers: optionalParameter(
    KeyStroke.fields.modifiers.schema,
    "Modifier keys held down while the key is pressed, each at most once. null presses the key alone",
  ),
});

export const TypeParameters = Schema.Struct({
  reference: ElementReference,
  text: TypeRequest.fields.text,
});

/** `WheelRequest`, which the browser checks again when it sends the event. */
export const WheelParameters = Schema.Struct({
  deltaX: WheelRequest.fields.deltaX,
  deltaY: WheelRequest.fields.deltaY,
  at: optionalParameter(
    WheelRequest.fields.at.schema,
    "The main-frame viewport point to move the pointer to before the wheel event. null sends it where the pointer already is",
  ),
});

export const WaitForParameters = Schema.Struct({
  reference: ElementReference,
  state: WaitForElementRequest.fields.state,
  timeoutMillis: optionalParameter(
    WaitForElementRequest.fields.timeoutMillis.schema,
    "How long to wait, in milliseconds; it can shorten the host's deadline, never extend it. null waits until the host's deadline",
  ),
});

export const ReadMoreRequest = Schema.Struct({ observationId: ObservationIdParameter });

export type ReadMoreRequest = typeof ReadMoreRequest.Type;

/** The next part of one observation's text. It issues no references and reads nothing new. */
export const ReadMoreResult = Schema.Struct({
  observationId: Identifier,
  text: Schema.String,
  /** More of this observation's text remains; ask again for the next part. */
  remaining: Schema.Boolean,
  /** The page had more text than the host reads at once; scroll, or inspect with find. */
  textTruncated: Schema.Boolean,
});

export type ReadMoreResult = typeof ReadMoreResult.Type;

const FormFieldParameter = Schema.Struct({
  elementId: ElementIdParameter,
  value: optionalParameter(
    FillRequest.fields.value,
    "Text that replaces the contents of an input or textarea. null when this field sets checked or options",
  ),
  checked: optionalParameter(
    Schema.Boolean,
    "The state a checkbox, radio or switch should end in; it is clicked only when it differs. null when this field sets value or options",
  ),
  options: optionalParameter(
    optionsParameter(),
    "elementIds of the options to select in a native select. null when this field sets value or checked",
  ),
})
  .annotate({
    description:
      "One control and exactly one of value, checked or options for it; the other two are null",
  })
  .check(
    Schema.makeFilter(
      (field) =>
        Number(field.value !== undefined) +
          Number(field.checked !== undefined) +
          Number(field.options !== undefined) ===
        1,
      { title: "exactly one of value, checked or options" },
    ),
  );

/** Several controls of one observation, set in order, then at most one submit click. */
export const FillFormParameters = Schema.Struct({
  observationId: ObservationIdParameter,
  fields: Schema.Array(FormFieldParameter)
    .check(Schema.isMinLength(1), Schema.isMaxLength(32))
    .annotate({ description: "The controls to set, in the order to set them" })
    .check(
      Schema.makeFilter(
        (fields) => new Set(fields.map((field) => field.elementId)).size === fields.length,
        { title: "each elementId at most once" },
      ),
    ),
  submit: optionalParameter(
    Identifier,
    "elementId of the control to click once every field is set, such as the form's submit button. null leaves the form unsent",
  ),
}).check(
  Schema.makeFilter(
    (request) =>
      request.submit === undefined ||
      !request.fields.some((field) => field.elementId === request.submit),
    { title: "a submit control that is not also a field" },
  ),
);

export type FillFormParameters = typeof FillFormParameters.Type;

export const FormFieldStatus = Schema.Struct({
  elementId: Identifier,
  /** `unchanged`: a toggle already held the requested state, so nothing was sent. */
  status: Schema.Literals(["set", "unchanged"]),
});

export const FormFillResult = Schema.Struct({
  fields: Schema.Array(FormFieldStatus),
  submitted: Schema.Boolean,
  url: BrowserActionResult.fields.url,
});

export type FormFillResult = typeof FormFillResult.Type;

/**
 * A form that did not complete. `completed` were set before it stopped and stay set; `stage`
 * and `elementId` say where it stopped, and `outcome` whether that step itself was sent. No
 * submit was sent unless that stop is at `submit` with an `unknown` outcome.
 */
export class BrowserFormFailure extends Schema.TaggedError<BrowserFormFailure>()(
  "BrowserFormFailure",
  {
    reason: BrowserToolFailure.fields.reason,
    outcome: BrowserToolFailure.fields.outcome,
    stage: Schema.optionalKey(Schema.Literals(["field", "verify", "submit"])),
    elementId: Schema.optionalKey(Identifier),
    completed: Schema.Array(FormFieldStatus),
  },
) {}

/** Acknowledges input dispatch only, never completed scrolling or a website outcome. */
export const NativeInputResult = Schema.Struct({ dispatched: Schema.Literal(true) });

/** A condition was observed on the original node; it is not reserved for a later action. */
export const WaitResult = Schema.Struct({ satisfied: Schema.Literal(true) });

/** The action's result and the later read are independent pieces of evidence. */
export const FollowUpObservation = Schema.Union([
  Schema.TaggedStruct("Available", { observation: Observation }),
  Schema.TaggedStruct("Unavailable", {
    failure: Schema.Struct({
      reason: BrowserToolFailure.fields.reason,
      outcome: BrowserToolFailure.fields.outcome,
    }),
  }),
]);

export type FollowUpObservation = typeof FollowUpObservation.Type;

export const ObservedActionResult = Schema.Struct({
  action: BrowserActionResult,
  observation: FollowUpObservation,
});

export type ObservedActionResult = typeof ObservedActionResult.Type;

export const ObservedNavigationResult = Schema.Struct({
  action: BrowserNavigationResult,
  observation: FollowUpObservation,
});

export type ObservedNavigationResult = typeof ObservedNavigationResult.Type;

export const ObservedInputResult = Schema.Struct({
  action: NativeInputResult,
  observation: FollowUpObservation,
});

export type ObservedInputResult = typeof ObservedInputResult.Type;

export const ObservedFormResult = Schema.Struct({
  action: FormFillResult,
  observation: FollowUpObservation,
});

export type ObservedFormResult = typeof ObservedFormResult.Type;

/**
 * The host's bound on one encoded Tool result. The floor leaves room for any accepted action URL,
 * an observation's fixed fields and a failure envelope; the default stays under Effect Agent's
 * default 50 KiB `toolResultBounds`, so the engine never cuts a result in the middle.
 */
export const ResultMaxBytes = Schema.Int.check(
  Schema.isGreaterThanOrEqualTo(16 * 1024),
  Schema.isLessThanOrEqualTo(1024 * 1024),
);
