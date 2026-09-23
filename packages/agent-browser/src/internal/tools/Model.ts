import { Schema } from "effect";
import { BrowserActionResult, BrowserNavigationResult } from "effect-agent/interactive-browser";
import {
  FillRequest,
  Identifier,
  KeyStroke,
  Observation,
  TypeRequest,
  WaitForElementRequest,
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

/** `ReadingMatch`, described; the browser checks it again when it reads. */
const FindParameter = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256))
  .annotate({
    description:
      "Case-insensitive text to look for. Only controls whose label contains it, and text lines containing it, are returned; matches are kept even when earlier content would fill the reading",
  })
  .check(Schema.makeFilter((value) => value.trim().length > 0, { title: "not only whitespace" }));

/** `SelectOptions`, described. */
const optionsParameter = (description: string) =>
  Schema.Array(Identifier)
    .check(Schema.isMinLength(1), Schema.isMaxLength(64))
    .annotate({ description })
    .check(
      Schema.makeFilter((ids) => new Set(ids).size === ids.length, { title: "each at most once" }),
    );

/** What a model may ask of one reading; the host decides the bounds and the default scope. */
export const InspectRequest = Schema.Struct({
  find: Schema.optionalKey(FindParameter),
  scope: Schema.optionalKey(
    Schema.Literals(["viewport", "document"]).annotate({
      description:
        "viewport reads what is on screen now; scroll to see more. document reads the whole page in document order; combine it with find to search the page",
    }),
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
  ...KeyStroke.fields,
});

export const TypeParameters = Schema.Struct({
  reference: ElementReference,
  text: TypeRequest.fields.text,
});

export const WaitForParameters = Schema.Struct({
  reference: ElementReference,
  state: WaitForElementRequest.fields.state,
  timeoutMillis: WaitForElementRequest.fields.timeoutMillis,
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
  value: Schema.optionalKey(
    FillRequest.fields.value.annotate({
      description: "Text that replaces the contents of an input or textarea",
    }),
  ),
  checked: Schema.optionalKey(
    Schema.Boolean.annotate({
      description:
        "The state a checkbox, radio or switch should end in; it is clicked only when it differs",
    }),
  ),
  options: Schema.optionalKey(
    optionsParameter("elementIds of the options to select in a native select"),
  ),
})
  .annotate({ description: "One control and exactly one of value, checked or options for it" })
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
  submit: Schema.optionalKey(
    Identifier.annotate({
      description:
        "elementId of the control to click once every field is set, such as the form's submit button. Omit it to leave the form unsent",
    }),
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
