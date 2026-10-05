/**
 * Bench-only native Responses adapter. The transport owner admits and prices every request before
 * returning a reply; this module owns no HTTP client, provider credentials, connection or retry.
 */
import { Context, Effect, Schema } from "effect";
import type * as Agent from "effect-browser/Agent";
import { Browser } from "effect-browser/Browser";
import type { BrowserError } from "effect-browser/BrowserError";
import type { Page } from "effect-browser/Page";

import type { OperateInput, Prediction, Strategy, UnderstandInput } from "./Arms.ts";

export const limits = {
  turns: 20,
  actionsPerReply: 64,
  waitsPerTrial: 20,
  waitMillis: 1000,
  textCharacters: 10_000,
  imageBytes: 5 * 1024 * 1024,
  historyBytes: 32 * 1024 * 1024,
} as const;

export const Code = Schema.Literals([
  "AdmissionStopped",
  "RequestUncertain",
  "UnpricedResponse",
  "NativeRouteRejected",
  "InvalidUsage",
  "InvalidOptions",
  "UnsupportedSchema",
  "ResponseEnvelopeInvalid",
  "NativeIncomplete",
  "NativeRefused",
  "ComputerCallInvalid",
  "UnsupportedAction",
  "InvalidAction",
  "InvalidCoordinates",
  "InvalidKeys",
  "InvalidBatch",
  "SafetyCheckRequired",
  "RepeatedCall",
  "UnexpectedOutputKind",
  "FirstComputerCallMissing",
  "FinalMessageInvalid",
  "FinalJsonInvalid",
  "FinalAnswerInvalid",
  "ImageSize",
  "OutsideFixture",
  "PageChanged",
  "HistoryLimit",
  "WaitLimit",
  "MaxTurns",
  "HistoricalActionRequested",
]);

export type Code = typeof Code.Type;

export class NativeError extends Schema.TaggedError<NativeError>()("NativeError", {
  code: Code,
}) {}

const Options = Schema.Struct({
  model: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(200)),
  reasoning: Schema.Literals(["none", "minimal", "low", "medium", "high", "xhigh", "max"]),
  maxOutputTokens: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 32_768 })),
});

export type Options = typeof Options.Type;

export const defaults: Options = {
  model: "openai/gpt-6-luna",
  reasoning: "medium",
  maxOutputTokens: 4096,
};

type ObjectValue = Readonly<Record<string, unknown>>;

export interface Request {
  readonly model: string;
  readonly store: false;
  readonly include: readonly ["reasoning.encrypted_content"];
  readonly instructions: string;
  readonly input: ReadonlyArray<ObjectValue>;
  readonly tools: readonly [{ readonly type: "computer" }];
  readonly reasoning: { readonly effort: Options["reasoning"] };
  readonly max_output_tokens: number;
  readonly service_tier: "default";
}

export const RequestSchema = Schema.Struct({
  model: Options.fields.model,
  store: Schema.Literal(false),
  include: Schema.Tuple([Schema.Literal("reasoning.encrypted_content")]),
  instructions: Schema.String.check(Schema.isMaxLength(128 * 1024)),
  input: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)).check(Schema.isMaxLength(4096)),
  tools: Schema.Tuple([Schema.Struct({ type: Schema.Literal("computer") })]),
  reasoning: Schema.Struct({ effort: Options.fields.reasoning }),
  max_output_tokens: Options.fields.maxOutputTokens,
  service_tier: Schema.Literal("default"),
});

export interface Reply {
  readonly status: number;
  readonly body: unknown;
  /** The parent's already-settled receipt; unknown cost must fail before this reply is returned. */
  readonly usage: Agent.Usage;
}

export class NativeTransport extends Context.Service<
  NativeTransport,
  {
    readonly request: (request: Request) => Effect.Effect<Reply, NativeError>;
  }
>()("bench/NativeTransport") {}

const fail = (code: Code) => new NativeError({ code });

const decode = <A, I>(schema: Schema.Codec<A, I>, value: unknown, code: Code) =>
  Schema.decodeUnknownEffect(schema)(value).pipe(Effect.mapError(() => fail(code)));

const JsonObject = Schema.Record(Schema.String, Schema.Unknown);
const Point = Schema.Struct({ x: Schema.Finite, y: Schema.Finite });
const Identifier = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(256));

const ActionKind = Schema.Literals([
  "click",
  "double_click",
  "move",
  "scroll",
  "type",
  "keypress",
  "wait",
  "screenshot",
  "drag",
]);

const Action = Schema.Union([
  Schema.Struct({
    type: Schema.Literal("click"),
    ...Point.fields,
    button: Schema.optional(Schema.Literals(["left", "right", "middle"])),
  }),
  Schema.Struct({ type: Schema.Literal("double_click"), ...Point.fields }),
  Schema.Struct({ type: Schema.Literal("move"), ...Point.fields }),
  Schema.Struct({
    type: Schema.Literal("scroll"),
    ...Point.fields,
    scroll_x: Schema.Finite,
    scroll_y: Schema.Finite,
  }),
  Schema.Struct({
    type: Schema.Literal("type"),
    text: Schema.String.check(Schema.isMaxLength(limits.textCharacters)),
  }),
  Schema.Struct({ type: Schema.Literal("keypress"), keys: Schema.Array(Schema.String) }),
  Schema.Struct({ type: Schema.Literal("wait") }),
  Schema.Struct({ type: Schema.Literal("screenshot") }),
  Schema.Struct({ type: Schema.Literal("drag"), path: Schema.Array(Point) }),
]);

type Action = typeof Action.Type;

const Call = Schema.Struct({
  type: Schema.Literal("computer_call"),
  id: Identifier,
  call_id: Identifier,
  actions: Schema.Array(Schema.Unknown),
  pending_safety_checks: Schema.optional(Schema.Array(Schema.Unknown)),
});

interface CheckedCall {
  readonly id: string;
  readonly call_id: string;
  readonly actions: ReadonlyArray<Action>;
}

const Envelope = Schema.Struct({
  status: Schema.String.check(Schema.isMaxLength(64)),
  output: Schema.Array(JsonObject).check(Schema.isMaxLength(128)),
});

const Message = Schema.Struct({
  type: Schema.Literal("message"),
  role: Schema.Literal("assistant"),
  content: Schema.Array(JsonObject).check(Schema.isMaxLength(128)),
});

const TextPart = Schema.Struct({
  type: Schema.Literal("output_text"),
  text: Schema.String.check(Schema.isMaxLength(128 * 1024)),
});

const Count = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Usage = Schema.Struct({ inputTokens: Count, outputTokens: Count, cachedInputTokens: Count });

export const ReplySchema = Schema.Struct({
  status: Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 })),
  body: Schema.Unknown,
  usage: Usage,
});

const Key = Schema.Union([
  Schema.String.check(
    Schema.isPattern(
      /^(?:ctrl|control|cmd|command|meta|win|super|mod|alt|option|shift|enter|return|esc|escape|tab|space|spacebar|backspace|delete|del|insert|home|end|pageup|pagedown|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright)$/i,
    ),
  ),
  Schema.String.check(
    Schema.isPattern(/^(?:[ -~]|F(?:[1-9]|1[0-2])|Key[A-Z]|Digit[0-9]|Numpad[0-9])$/),
  ),
]);

const Chord = Schema.Array(Key).check(Schema.isMinLength(1), Schema.isMaxLength(4));

const ViewportPoint = Schema.Struct({
  x: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 1279 })),
  y: Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 719 })),
});

const checkedAction = Effect.fnUntraced(function* (raw: unknown) {
  const object = yield* decode(JsonObject, raw, "InvalidAction");

  if (!Schema.is(ActionKind)(object.type)) return yield* fail("UnsupportedAction");

  const action = yield* Schema.decodeUnknownEffect(Action, { onExcessProperty: "error" })(
    object,
  ).pipe(Effect.mapError(() => fail("InvalidAction")));

  switch (action.type) {
    case "click":
    case "double_click":
    case "move":
      yield* decode(ViewportPoint, action, "InvalidCoordinates");
      break;
    case "scroll":
      yield* decode(ViewportPoint, action, "InvalidCoordinates");
      if (Math.abs(action.scroll_x) > 8192 || Math.abs(action.scroll_y) > 8192)
        return yield* fail("InvalidAction");
      break;
    case "keypress":
      yield* decode(Chord, action.keys, "InvalidKeys");
      if (action.keys.some((key, index) => key === "+" && index !== action.keys.length - 1))
        return yield* fail("InvalidKeys");
      break;
    case "drag":
      // Public Page.drag has endpoints, not a polyline. Reject before dispatching any sibling action.
      if (action.path.length !== 2) return yield* fail("UnsupportedAction");
      for (const point of action.path) yield* decode(ViewportPoint, point, "InvalidCoordinates");
      break;
    case "type":
    case "wait":
    case "screenshot":
      break;
  }

  return action;
});

interface Parsed {
  readonly output: ReadonlyArray<ObjectValue>;
  readonly calls: ReadonlyArray<CheckedCall>;
  readonly texts: ReadonlyArray<string>;
}

const parse = Effect.fnUntraced(function* (
  body: unknown,
  itemIds: ReadonlySet<string>,
  callIds: ReadonlySet<string>,
): Effect.fn.Return<Parsed, NativeError> {
  const response = yield* decode(Envelope, body, "ResponseEnvelopeInvalid");

  if (response.status !== "completed") return yield* fail("NativeIncomplete");
  const calls: Array<CheckedCall> = [];
  const texts: Array<string> = [];
  const newItems = new Set<string>();
  const newCalls = new Set<string>();
  let actions = 0;

  // Validate every item and every coordinate before executing even the first action.
  for (const item of response.output) {
    switch (item.type) {
      case "computer_call": {
        const call = yield* decode(Call, item, "ComputerCallInvalid");

        if (call.actions.length === 0 || call.actions.length > limits.actionsPerReply)
          return yield* fail("InvalidBatch");
        actions += call.actions.length;
        if (actions > limits.actionsPerReply) return yield* fail("InvalidBatch");
        if ((call.pending_safety_checks?.length ?? 0) > 0)
          return yield* fail("SafetyCheckRequired");
        if (
          itemIds.has(call.id) ||
          callIds.has(call.call_id) ||
          newItems.has(call.id) ||
          newCalls.has(call.call_id)
        )
          return yield* fail("RepeatedCall");
        newItems.add(call.id);
        newCalls.add(call.call_id);
        const checked: Array<Action> = [];

        for (const action of call.actions) checked.push(yield* checkedAction(action));
        calls.push({ id: call.id, call_id: call.call_id, actions: checked });
        break;
      }
      case "message": {
        const message = yield* decode(Message, item, "FinalMessageInvalid");
        const parts: Array<string> = [];

        for (const part of message.content) {
          if (part.type === "refusal") return yield* fail("NativeRefused");
          parts.push((yield* decode(TextPart, part, "FinalMessageInvalid")).text);
        }
        texts.push(parts.join(""));
        break;
      }
      case "reasoning":
        break;
      case "refusal":
        return yield* fail("NativeRefused");
      default:
        return yield* fail("UnexpectedOutputKind");
    }
  }

  return { output: response.output, calls, texts };
});

const fixtureOrigin = "https://bench.test";

const samePage = Effect.fnUntraced(function* (page: Page) {
  const browser = yield* Browser;
  const pages = yield* browser.pages;

  if (pages.length !== 1 || pages[0]?.id !== page.id) return yield* fail("PageChanged");
  const url = yield* page.url;

  const origin = yield* Effect.try({
    try: () => new URL(url).origin,
    catch: () => fail("OutsideFixture"),
  });

  if (origin !== fixtureOrigin) return yield* fail("OutsideFixture");
});

const image = (value: {
  readonly width: number;
  readonly height: number;
  readonly data: Uint8Array;
  readonly mediaType: string;
}) => {
  if (
    value.width !== 1280 ||
    value.height !== 720 ||
    value.data.length === 0 ||
    value.data.length > limits.imageBytes
  )
    return Effect.fail(fail("ImageSize"));

  return Effect.succeed({
    type: "computer_screenshot" as const,
    image_url: "data:" + value.mediaType + ";base64," + Buffer.from(value.data).toString("base64"),
    detail: "original" as const,
  });
};

const picture = Effect.fnUntraced(function* (page: Page) {
  yield* samePage(page);

  return yield* image(yield* page.screenshot({ fresh: true }));
});

const act = Effect.fnUntraced(function* (page: Page, action: Action) {
  yield* samePage(page);
  switch (action.type) {
    case "click":
      yield* page.click(action, { button: action.button ?? "left" });
      break;
    case "double_click":
      yield* page.click(action, { clickCount: 2 });
      break;
    case "move":
      yield* page.hover(action);
      break;
    case "scroll":
      yield* page.scroll({ at: action, dx: action.scroll_x, dy: action.scroll_y });
      break;
    case "type":
      yield* page.type(action.text);
      break;
    case "keypress":
      yield* page.press(action.keys.join("+"));
      break;
    case "wait":
      yield* Effect.sleep(limits.waitMillis);
      break;
    case "screenshot":
      break;
    case "drag": {
      const [from, to] = action.path;

      if (from === undefined || to === undefined) return yield* fail("InvalidAction");
      yield* page.drag(from, to);
      break;
    }
  }
  // A tab opened or a navigation left the fixture: stop before another action or model request.
  yield* samePage(page);
});

const instructions = <A, I>(schema: Schema.Codec<A, I>, historical: boolean) =>
  Effect.try({
    try: () =>
      [
        historical
          ? "Read the supplied historical frames, oldest first. Do not request computer actions: those frames are not the current page."
          : "Operate only the supplied local fixture through the native computer tool. Use viewport coordinates in the original 1280 by 720 screenshots. Stay at https://bench.test and in the supplied tab.",
        "When finished, return exactly one assistant message containing only JSON satisfying this schema document:",
        JSON.stringify(Schema.toJsonSchemaDocument(schema)),
      ].join("\n"),
    catch: () => fail("UnsupportedSchema"),
  });

const request = Effect.fnUntraced(function* (
  transport: NativeTransport["Service"],
  options: Options,
  guidance: string,
  history: ReadonlyArray<ObjectValue>,
) {
  const body: Request = {
    model: options.model,
    store: false,
    include: ["reasoning.encrypted_content"],
    instructions: guidance,
    input: [...history],
    tools: [{ type: "computer" }],
    reasoning: { effort: options.reasoning },
    max_output_tokens: options.maxOutputTokens,
    service_tier: "default",
  };

  const bytes = yield* Effect.try({
    try: () => Buffer.byteLength(JSON.stringify(body), "utf8"),
    catch: () => fail("HistoryLimit"),
  });

  if (bytes > limits.historyBytes) return yield* fail("HistoryLimit");
  const reply = yield* transport.request(body);
  const usage = yield* decode(Usage, reply.usage, "InvalidUsage");

  if (!Number.isSafeInteger(reply.status) || reply.status < 200 || reply.status >= 300)
    return yield* fail("NativeRouteRejected");

  return { body: reply.body, usage };
});

const final = Effect.fnUntraced(function* <A, I>(schema: Schema.Codec<A, I>, parsed: Parsed) {
  const [text] = parsed.texts;

  if (parsed.texts.length !== 1 || text === undefined) return yield* fail("FinalMessageInvalid");
  const json = yield* decode(Schema.fromJsonString(Schema.Unknown), text, "FinalJsonInvalid");

  return yield* decode(Schema.toCodecJson(schema), json, "FinalAnswerInvalid");
});

const add = (left: Agent.Usage, right: Agent.Usage): Agent.Usage => ({
  inputTokens: left.inputTokens + right.inputTokens,
  outputTokens: left.outputTokens + right.outputTokens,
  cachedInputTokens: left.cachedInputTokens + right.cachedInputTokens,
});

export const operate = Effect.fnUntraced(function* <A, I, E>(
  rawOptions: Options,
  input: OperateInput<A, I, E>,
): Effect.fn.Return<Prediction<A>, NativeError | E | BrowserError, NativeTransport | Browser> {
  const options = yield* decode(Options, rawOptions, "InvalidOptions");

  if (!Number.isSafeInteger(input.maxSteps) || input.maxSteps < 1)
    return yield* fail("InvalidOptions");
  const transport = yield* NativeTransport;
  const guidance = yield* instructions(input.schema, false);
  const first = yield* picture(input.page);

  const history: Array<ObjectValue> = [
    {
      role: "user",
      content: [
        { type: "input_text", text: input.prompt },
        { type: "input_image", image_url: first.image_url, detail: "original" },
      ],
    },
  ];

  const itemIds = new Set<string>();
  const callIds = new Set<string>();
  let usage: Agent.Usage = { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0 };
  let waits = 0;

  for (let turn = 0; turn < Math.min(input.maxSteps, limits.turns); turn++) {
    const reply = yield* request(transport, options, guidance, history);

    usage = add(usage, reply.usage);
    yield* input.onUsage(reply.usage);
    const parsed = yield* parse(reply.body, itemIds, callIds);

    if (turn === 0 && parsed.calls.length === 0) return yield* fail("FirstComputerCallMissing");

    const newWaits = parsed.calls
      .flatMap((call) => call.actions)
      .filter((action) => action.type === "wait").length;

    if (waits + newWaits > limits.waitsPerTrial) return yield* fail("WaitLimit");
    waits += newWaits;
    // OpenRouter Responses is stateless. Preserve original output, including encrypted reasoning.
    history.push(...parsed.output);
    if (parsed.calls.length === 0)
      return { answer: yield* final(input.schema, parsed), steps: turn + 1, usage };
    for (const call of parsed.calls) {
      itemIds.add(call.id);
      callIds.add(call.call_id);
    }
    for (const call of parsed.calls) {
      for (const action of call.actions) yield* act(input.page, action);
      history.push({
        type: "computer_call_output",
        call_id: call.call_id,
        output: yield* picture(input.page),
      });
    }
  }

  return yield* fail("MaxTurns");
});

export const understand = Effect.fnUntraced(function* <A, I extends Record<string, unknown>, E>(
  rawOptions: Options,
  input: UnderstandInput<A, I, E>,
): Effect.fn.Return<Prediction<A>, NativeError | E, NativeTransport> {
  const options = yield* decode(Options, rawOptions, "InvalidOptions");
  const transport = yield* NativeTransport;
  const guidance = yield* instructions(input.schema, true);

  const content: Array<ObjectValue> = [
    {
      type: "input_text",
      text:
        input.instructions +
        "\nTimeline relative to the captured moment:\n" +
        input.moment.timeline,
    },
  ];

  if (input.moment.frames.length === 0 || input.moment.frames.length > 64)
    return yield* fail("ImageSize");
  for (const frame of input.moment.frames) {
    const screenshot = yield* image(frame.image);

    content.push(
      { type: "input_text", text: ((frame.hostTime - input.moment.at) / 1000).toFixed(3) + "s" },
      { type: "input_image", image_url: screenshot.image_url, detail: "original" },
    );
  }
  const reply = yield* request(transport, options, guidance, [{ role: "user", content }]);

  yield* input.onUsage(reply.usage);
  const parsed = yield* parse(reply.body, new Set(), new Set());

  if (parsed.calls.length > 0) return yield* fail("HistoricalActionRequested");

  return { answer: yield* final(input.schema, parsed), steps: 1, usage: reply.usage };
});

export const makeStrategy = (
  options: Options = defaults,
): Strategy<NativeError, NativeTransport> => ({
  operate: (input) => operate(options, input),
  understand: (input) => understand(options, input),
});
