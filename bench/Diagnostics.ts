// Closed projections keep provider failures useful without persisting provider text or identifiers.
import type { OpenRouterClient } from "@effect/ai-openrouter";
import { Cause, type Effect, Option, Schema } from "effect";
import { AiError } from "effect/ai";

const Origin = Schema.Literals([
  "OpenRouterClient/createChatCompletion",
  "OpenRouterLanguageModel/makeResponse",
  "OpenRouterLanguageModel/getResponseFormat",
  "LanguageModel/generateObject",
  "bench/createChatCompletion",
  "Other",
]);

const Reason = Schema.Literals([
  "RateLimitError",
  "QuotaExhaustedError",
  "AuthenticationError",
  "ContentPolicyError",
  "InvalidRequestError",
  "InternalProviderError",
  "NetworkError",
  "InvalidOutputError",
  "StructuredOutputError",
  "UnsupportedSchemaError",
  "UnknownError",
  "ToolNotFoundError",
  "ToolParameterValidationError",
  "InvalidToolResultError",
  "ToolResultEncodingError",
  "ToolConfigurationError",
  "ToolkitRequiredError",
  "InvalidUserInputError",
]);

const HttpStatus = Schema.Int.check(Schema.isBetween({ minimum: 100, maximum: 599 }));
const Count = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const FinishReason = Schema.NullOr(
  Schema.Literals(["stop", "length", "tool_calls", "content_filter", "error", "Other"]),
);

export const Failure = Schema.Struct({
  kind: Schema.Literals(["AiError", "Interrupted", "Defect", "Other"]),
  origin: Origin,
  reason: Schema.NullOr(Reason),
  objectDecode: Schema.NullOr(Schema.Literals(["NoText", "JsonSyntax", "SchemaMismatch"])),
  httpStatus: Schema.NullOr(HttpStatus),
});

export type Failure = typeof Failure.Type;

export const Receipt = Schema.Struct({
  httpStatus: Schema.NullOr(HttpStatus),
  choiceCount: Count,
  finishReason: FinishReason,
  contentKind: Schema.Literals(["missing", "null", "empty", "text", "parts"]),
  reasoningPresent: Schema.Boolean,
  toolCallCount: Count,
});

export type Receipt = typeof Receipt.Type;

export const LastResponse = Schema.Struct({
  call: Count,
  ...Receipt.fields,
});

export type LastResponse = typeof LastResponse.Type;

const decodeJson = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown));

const status = (value: unknown): number | null =>
  Option.getOrNull(Schema.decodeUnknownOption(HttpStatus)(value));

/** Only fixed categories survive; schema descriptions can contain the rejected provider values. */
export const failure = (cause: Cause.Cause<unknown>): Failure => {
  const candidate = Cause.findErrorOption(cause);
  const error = Option.isSome(candidate) ? candidate.value : undefined;

  if (!AiError.isAiError(error)) {
    return {
      kind: Cause.hasInterruptsOnly(cause)
        ? "Interrupted"
        : Cause.hasDies(cause)
          ? "Defect"
          : "Other",
      origin: "Other",
      reason: null,
      objectDecode: null,
      httpStatus: null,
    };
  }

  const reason = error.reason;

  return {
    kind: "AiError",
    origin: Option.getOrElse(
      Schema.decodeUnknownOption(Origin)(error.module + "/" + error.method),
      () => "Other" as const,
    ),
    reason: Option.getOrNull(Schema.decodeOption(Reason)(reason._tag)),
    objectDecode:
      reason._tag !== "StructuredOutputError"
        ? null
        : reason.responseText.length === 0
          ? "NoText"
          : Option.isNone(decodeJson(reason.responseText))
            ? "JsonSyntax"
            : "SchemaMismatch",
    httpStatus: "http" in reason ? status(reason.http?.response?.status) : null,
  };
};

type DecodedResponse = Effect.Success<ReturnType<OpenRouterClient.Service["createChatCompletion"]>>;

/** Called only after the real SDK decoded the receipt and the ledger settled its usage. */
export const receipt = ([response, http]: DecodedResponse): Receipt => {
  const choice = response.choices[0];
  const message = choice?.message;
  const content = message?.content;

  return {
    httpStatus: status(http.status),
    choiceCount: response.choices.length,
    finishReason: Option.getOrElse(
      Schema.decodeOption(FinishReason)(choice?.finish_reason ?? null),
      () => "Other" as const,
    ),
    contentKind:
      content === undefined
        ? "missing"
        : content === null
          ? "null"
          : typeof content !== "string"
            ? "parts"
            : content.length === 0
              ? "empty"
              : "text",
    reasoningPresent:
      (message?.reasoning?.length ?? 0) > 0 || (message?.reasoning_details?.length ?? 0) > 0,
    toolCallCount: message?.tool_calls?.length ?? 0,
  };
};
