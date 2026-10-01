import { Schema } from "effect";

import { ControlFacts } from "../../BrowserData.ts";
import type { ActionTarget, Descriptor, FrameDescriptor } from "../../PlanData.ts";
import type { DriverTarget } from "./Driver.ts";
import type { Ticket } from "./Owner.ts";

const Presence = Schema.Literals(["absent", "complete", "omitted"]);

/** Native completeness belongs to the host; it is never an observed control field. */
export const FactsCompleteness = Schema.Struct({
  label: Schema.Literals(["complete", "omitted"]),
  inputType: Presence,
  autocomplete: Presence,
  destination: Presence,
  formMethod: Presence,
});

export type FactsCompleteness = typeof FactsCompleteness.Type;

/** Missing metadata cannot establish complete recording evidence. */
export const NativeControlFacts = Schema.Struct({
  ...ControlFacts.fields,
  completeness: Schema.optionalKey(FactsCompleteness),
});

export type NativeControlFacts = typeof NativeControlFacts.Type;

export interface DescriptorSample {
  readonly facts: ControlFacts;
  readonly scope: "document" | "viewport";
  readonly completeness?: FactsCompleteness;
  readonly frame?: FrameDescriptor;
  readonly frameComplete: boolean;
  readonly ordinal?: { readonly index: number; readonly of: number };
}

/** The producing observation authenticates this value in its private WeakMap. */
export interface ResolvedElement {
  readonly _tag: "ResolvedElement";
  readonly target: DriverTarget;
}

export interface ResolvedGroup {
  readonly elements: ReadonlyArray<ResolvedElement>;
  readonly samples?: ReadonlyArray<DescriptorSample | undefined>;
  readonly activate: (ticket: Ticket) => void;
  readonly release: () => Promise<void>;
}

export interface ResolveRequest {
  readonly target: ActionTarget;
  /** An earlier request naming this option's exact native parent select. */
  readonly parent?: number;
  /** A passive exact-node wait has no later input facts read to supply capture. */
  readonly captureInitial?: boolean;
}

export interface DescriptorQuery {
  readonly descriptor: Descriptor;
  readonly parent?: Element;
  readonly contextual: boolean;
}

export const MaximumGroupNodes = 32 * 65 + 1;

export const DescriptorReadResult = Schema.Struct({
  exhausted: Schema.Boolean,
  visited: Schema.Natural,
  results: Schema.Array(
    Schema.Struct({
      status: Schema.Literals(["matched", "missing", "ambiguous", "incomplete"]),
      count: Schema.Natural,
      documentCount: Schema.Natural,
      facts: Schema.optionalKey(NativeControlFacts),
      value: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(65536))),
    }),
  ).check(Schema.isMaxLength(MaximumGroupNodes)),
});

export type DescriptorReadResult = typeof DescriptorReadResult.Type;
