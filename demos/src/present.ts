// How the site puts a recording into words for a visitor: times, costs, an answer's fields, what
// an agent's tool call did and what the browser is doing at an instant. Element refs, parameter
// names and error tags are the model's and the library's handles, so none of them is shown.
import { Option, Schema } from "effect";

const twoDigits = (value: number) => String(value).padStart(2, "0");

/**
 * A video clock for a recording `length` long: 0:04.2 with tenths when the whole recording is
 * under a minute, 3:24 when it is longer, so both ends of the clock read alike.
 */
export const clock = (millis: number, length: number) => {
  const total = Math.max(0, millis) / 1000;
  const minutes = Math.floor(total / 60);
  const rest = total - minutes * 60;

  return length < 60_000
    ? `${minutes}:${rest.toFixed(1).padStart(4, "0")}`
    : `${minutes}:${twoDigits(Math.floor(rest))}`;
};

/** A run's length in words: 0.8 s, 16 s, 3 min 24 s. */
export const duration = (millis: number) => {
  const total = Math.max(0, millis) / 1000;

  if (total < 10) return `${total.toFixed(1)} s`;
  if (total < 60) return `${Math.round(total)} s`;
  const minutes = Math.floor(total / 60);
  const rest = Math.round(total - minutes * 60);

  return rest === 0 ? `${minutes} min` : `${minutes} min ${rest} s`;
};

const usd = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "USD",
  maximumSignificantDigits: 2,
});

/** What the models' calls cost: $0.025, or under a tenth of a cent. */
export const cost = (amount: number) => (amount < 0.001 ? "under $0.001" : usd.format(amount));

const decimal = new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 });

const money = new Intl.NumberFormat("en-US", {
  minimumFractionDigits: 2,
  maximumFractionDigits: 2,
});

const signed = (value: number) => `${value > 0 ? "+" : value < 0 ? "−" : ""}${Math.abs(value)}`;

const capitalized = (value: string) => value.charAt(0).toUpperCase() + value.slice(1);

/** A value as a visitor reads it: Yes and No, grouped digits, text as written. */
export const plain = (value: unknown): string => {
  if (typeof value === "boolean") return value ? "Yes" : "No";
  if (typeof value === "number") return decimal.format(value);
  if (typeof value === "string") return value;
  if (Array.isArray(value)) return value.map(plain).join(", ");

  return JSON.stringify(value);
};

interface FieldWords {
  readonly label: string;
  readonly format?: (value: unknown) => string;
}

const numeric = (format: (value: number) => string) => (value: unknown) =>
  typeof value === "number" ? format(value) : plain(value);

/** The bench's answer fields, named and formatted the way their pages show them. */
const fieldWords: Readonly<Record<string, FieldWords>> = {
  credits: { label: "Credits" },
  orderId: { label: "Order ID" },
  confirmation: { label: "Confirmation number" },
  movedSharply: { label: "Moved sharply" },
  direction: { label: "Direction", format: (value) => capitalized(plain(value)) },
  tumbles: { label: "Paying cascades" },
  multiplier: { label: "Final multiplier", format: numeric((value) => `×${value}`) },
  totalWin: { label: "Total win", format: numeric((value) => money.format(value)) },
  balance: { label: "Balance", format: numeric((value) => money.format(value)) },
  done: { label: "Spin finished" },
  ticker: { label: "Ticker" },
  price: { label: "Price", format: numeric((value) => `$${decimal.format(value)}`) },
  change1h: { label: "1-hour change", format: numeric((value) => `${signed(value)}%`) },
  change24h: { label: "24-hour change", format: numeric((value) => `${signed(value)}%`) },
  column: { label: "Column" },
  table: { label: "Table" },
};

export interface Field {
  readonly key: string;
  readonly label: string;
  readonly value: string;
}

/** An answer or the page's truth as labelled fields, in the order the task's schema gives them. */
export const fields = (value: unknown): ReadonlyArray<Field> => {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return value === null || value === undefined
      ? []
      : [{ key: "value", label: "Answer", value: plain(value) }];

  return Object.entries(value).map(([key, item]) => {
    const words = fieldWords[key];

    return {
      key,
      label: words?.label ?? capitalized(key.replace(/([a-z0-9])([A-Z])/g, "$1 $2").toLowerCase()),
      value: words?.format === undefined ? plain(item) : words.format(item),
    };
  });
};

/** Whether two answers agree on one field, compared as recorded. */
export const sameField = (left: unknown, right: unknown, key: string) => {
  const read = (value: unknown): unknown =>
    typeof value === "object" && value !== null
      ? Object.getOwnPropertyDescriptor(value, key)?.value
      : undefined;

  return JSON.stringify(read(left)) === JSON.stringify(read(right));
};

/** A call's parameters, read leniently: a model can leave any of them out or null. */
const Params = Schema.Struct({
  text: Schema.optional(Schema.NullOr(Schema.String)),
  keys: Schema.optional(Schema.NullOr(Schema.String)),
  times: Schema.optional(Schema.NullOr(Schema.Finite)),
  seconds: Schema.optional(Schema.NullOr(Schema.Finite)),
  still: Schema.optional(Schema.NullOr(Schema.Boolean)),
  url: Schema.optional(Schema.NullOr(Schema.String)),
  value: Schema.optional(Schema.NullOr(Schema.String)),
  answer: Schema.optional(Schema.Unknown),
});

const noParams: typeof Params.Type = {};

const readParams = (params: unknown) =>
  Option.getOrElse(Schema.decodeUnknownOption(Params)(params), () => noParams);

const Refusal = Schema.Struct({
  reason: Schema.Struct({ _tag: Schema.String, description: Schema.optional(Schema.String) }),
});

/** Why a tool refused a call, in words; the technical text stays available as a tooltip. */
const failure = (result: unknown): { readonly why: string; readonly technical: string } => {
  const refusal = Schema.decodeUnknownOption(Refusal)(result);

  if (Option.isSome(refusal)) {
    const { _tag, description } = refusal.value.reason;
    const technical = description === undefined ? _tag : `${_tag}: ${description}`;

    return _tag === "ToolParameterValidationError"
      ? { why: "rejected: the request was malformed", technical }
      : { why: "failed", technical };
  }
  const text = typeof result === "string" ? result : JSON.stringify(result);

  if (/not on the page any more/.test(text))
    return { why: "failed: the element it aimed for was gone", technical: text };

  return { why: "failed", technical: text };
};

const elementWords: Readonly<Record<string, string>> = {
  canvas: "the game canvas",
  input: "a text field",
  textarea: "a text field",
  button: "a button",
  a: "a link",
};

/** What a successful click reported hitting: its visible name, or the kind of element. */
const clicked = (result: unknown) => {
  if (typeof result !== "string") return "the page";
  const named = /"([^"]+)"/.exec(result)?.[1];

  if (named !== undefined) return `“${named}”`;
  const tag = /<([a-z]+)/.exec(result)?.[1];

  return (tag === undefined ? undefined : elementWords[tag]) ?? "the page";
};

export interface CallWords {
  /** What the call did, or tried to do. */
  readonly text: string;
  readonly failed: boolean;
  /** For a failed call: why, in words, and the tool's own message. */
  readonly why?: string | undefined;
  readonly technical?: string | undefined;
  /** The answer a finishing call reported. */
  readonly answer?: unknown;
}

const quoted = (text: string) => `“${text.length > 60 ? `${text.slice(0, 60)}…` : text}”`;

/** One of the agent's tool calls in words, from its parameters and what the tool returned. */
export const describeCall = (
  call: { readonly name: string; readonly params: unknown },
  outcome: { readonly result: unknown; readonly isFailure: boolean } | undefined,
): CallWords => {
  const params = readParams(call.params);
  const failed = outcome?.isFailure === true;
  const name = call.name.replace(/^browser_/, "");

  const text = ((): string => {
    switch (name) {
      case "click":
        return failed || outcome === undefined ? "Click" : `Clicked ${clicked(outcome.result)}`;
      case "type":
        return `${failed ? "Type" : "Typed"} ${quoted(params.text ?? "")}`;
      case "press": {
        const times = params.times ?? 1;

        return `${failed ? "Press" : "Pressed"} ${params.keys ?? "a key"}${times > 1 ? ` ×${times}` : ""}`;
      }
      case "wait":
        return params.text !== undefined && params.text !== null && params.text !== ""
          ? `Waited for ${quoted(params.text)} to appear`
          : `Waited ${params.seconds ?? 1} s for the screen to settle`;
      case "scroll":
      case "wheel":
        return failed ? "Scroll" : "Scrolled";
      case "select":
        return `${failed ? "Choose" : "Chose"} ${quoted(params.value ?? params.text ?? "")}`;
      case "navigate":
        return failed ? "Open a page" : "Opened a page";
      case "snapshot":
      case "observe":
      case "screenshot":
        return "Looked at the page";
      case "done":
        return "Finished and reported its answer";
      default:
        return capitalized(name.replace(/_/g, " "));
    }
  })();

  return failed
    ? { text, failed, ...failure(outcome?.result) }
    : { text, failed, ...(name === "done" ? { answer: params.answer } : {}) };
};

/** What the browser is doing during an action, as a status line over the video. */
export const doing = (action: {
  readonly name: string;
  readonly text?: string | undefined;
  readonly target?: string | undefined;
}) => {
  switch (action.name) {
    case "click":
      return "Clicking";
    case "type":
      return action.text === undefined ? "Typing" : `Typing ${quoted(action.text)}`;
    case "select":
      return action.text === undefined ? "Choosing an option" : `Choosing ${quoted(action.text)}`;
    case "press":
      return action.target === undefined ? "Pressing a key" : `Pressing ${action.target}`;
    case "navigate":
      return "Loading the page";
    case "scroll":
    case "wheel":
      return "Scrolling";
    default:
      return capitalized(action.name);
  }
};
