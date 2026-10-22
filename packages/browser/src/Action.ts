/** Typed browser actions, shared by execution, policy, recordings and replay. */
import { Schema } from "effect";

import { Point } from "./Geometry.ts";
import * as Url from "./Url.ts";

const Ref = Schema.String.check(Schema.isPattern(/^e\d+$/));
const Target = Schema.Union([Ref, Point]);
const optionalNumber = Schema.optional(Schema.Finite);

export const ClickOptions = Schema.Struct({
  button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  clickCount: optionalNumber,
  holdMillis: optionalNumber,
});

export const TypeOptions = Schema.Struct({
  into: Schema.optional(Ref),
  replace: Schema.optional(Schema.Boolean),
  submit: Schema.optional(Schema.Boolean),
  secret: Schema.optional(Schema.Boolean),
});

export const PressOptions = Schema.Struct({
  on: Schema.optional(Ref),
  times: optionalNumber,
  holdMillis: optionalNumber,
});

export const ScrollOptions = Schema.Struct({
  at: Schema.optional(Target),
  dx: optionalNumber,
  dy: optionalNumber,
});

export const Action = Schema.TaggedUnion({
  Click: { target: Target, options: Schema.optional(ClickOptions) },
  Hover: { target: Target },
  Drag: { from: Target, to: Target },
  Type: { text: Schema.String, options: Schema.optional(TypeOptions) },
  Press: { keys: Schema.String, options: Schema.optional(PressOptions) },
  Scroll: { options: Schema.optional(ScrollOptions) },
  Select: { ref: Ref, values: Schema.Array(Schema.String) },
  Goto: { url: Schema.String },
  Back: {},
  Reload: {},
  /** A script's code and arguments are never retained. */
  Act: { document: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)) },
});

export type Action = typeof Action.Type;

export const Name = Schema.Literals([
  "click",
  "hover",
  "drag",
  "type",
  "press",
  "scroll",
  "select",
  "navigate",
  "back",
  "reload",
  "act",
]);

export type Name = typeof Name.Type;

/** Effective semantics suitable for policy and records; credentials never survive. */
export const recorded = (value: Action, revealed: boolean): Action => {
  if (value._tag === "Type") {
    const secret = !revealed || value.options?.secret === true;

    return {
      ...value,
      text: secret ? Url.withheld : value.text,
      options: {
        ...value.options,
        replace: value.options?.into === undefined ? false : (value.options.replace ?? true),
        secret: secret || value.options?.secret,
      },
    };
  }

  return value._tag === "Goto" ? { ...value, url: Url.redact(value.url) } : value;
};

/** The stable event vocabulary for an action. */
const names: Record<Action["_tag"], Name> = {
  Click: "click",
  Hover: "hover",
  Drag: "drag",
  Type: "type",
  Press: "press",
  Scroll: "scroll",
  Select: "select",
  Goto: "navigate",
  Back: "back",
  Reload: "reload",
  Act: "act",
};

export const nameOf = (action: Action): Name => names[action._tag];

/** The primary target, if this action addresses an element or point. */
export const targetOf = (action: Action) => {
  switch (action._tag) {
    case "Click":
    case "Hover":
      return action.target;
    case "Drag":
      return action.from;
    case "Type":
      return action.options?.into;
    case "Press":
      return action.options?.on;
    case "Scroll":
      return action.options?.at;
    case "Select":
      return action.ref;
    case "Goto":
    case "Back":
    case "Reload":
    case "Act":
      return undefined;
  }
};
