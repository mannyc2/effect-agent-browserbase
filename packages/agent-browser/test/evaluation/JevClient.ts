import { Effect, Redacted, Schema, Stream } from "effect";
import { type AiError } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest, type HttpClientResponse } from "effect/unstable/http";

import type { Allowance } from "./Spend.ts";

/** The version and limits qualified by https://docs.typesafe.ai/models. */
export const modelName = "jev-1.13.0";

const maxBytes = 65_536;
const maxDecisionBytes = 32_768;
const probability = Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 }));
const tokens = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER }));
const Model = Schema.Struct({ model: Schema.String });
const Usage = Schema.Struct({ input_tokens: tokens, output_tokens: tokens });

const State = Schema.Json.check(
  Schema.makeFilter(
    (value) => typeof value === "string" || (value !== null && typeof value === "object"),
  ),
);

const Question = Schema.Struct({
  type: Schema.Literal("choice"),
  instructions: Schema.String,
  criteria: Schema.Record(Schema.NonEmptyString, Schema.NullOr(Schema.String)).check(
    Schema.makeFilter((value) => {
      const size = Object.keys(value).length;

      return size >= 1 && size <= 255;
    }),
  ),
});

const Request = Schema.Struct({
  model: Schema.Literal(modelName),
  state: State,
  questions: Schema.Struct({ next: Question }),
});

const DecisionInput = Schema.Struct({ state: State, question: Question });

const Response = Schema.Struct({
  model: Schema.Literal(modelName),
  answers: Schema.Struct({
    next: Schema.Struct({
      type: Schema.Literal("choice"),
      choice: Schema.String,
      probabilities: Schema.Record(Schema.String, probability),
      confidence: probability,
    }),
  }),
  usage: Usage,
});

/** Fixed error facts only: provider bodies, request state and credentials are never retained. */
export class JevError extends Schema.TaggedError<JevError>()("JevError", {
  reason: Schema.Literals(["payload", "provider", "response", "usage"]),
  status: Schema.NullOr(Schema.Int),
}) {}

export interface Decision {
  readonly choice: string;
  readonly confidence: number;
  readonly probabilities: Readonly<Record<string, number>>;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/** Bound bytes before decoding JSON; the web response's text accessor is unbounded. */
const read = Effect.fnUntraced(function* (response: HttpClientResponse.HttpClientResponse) {
  let bytes = 0;

  return yield* response.stream.pipe(
    Stream.mapEffect((chunk) => {
      bytes += chunk.byteLength;

      return bytes <= maxBytes
        ? Effect.succeed(chunk)
        : Effect.fail(new JevError({ reason: "response", status: response.status }));
    }),
    Stream.decodeText,
    Stream.runFold(
      () => "",
      (all, text) => all + text,
    ),
    Effect.mapError(() => new JevError({ reason: "response", status: response.status })),
  );
});

/**
 * One admitted direct System One request, with no retry. Jev selects only supplied candidates;
 * its returned confidence is a distribution statistic, not verification of browser success.
 * https://docs.typesafe.ai/api and https://docs.typesafe.ai/confidence own the wire contract.
 */
export const decide = Effect.fn("JevClient.decide")(function* (options: {
  readonly apiKey: Redacted.Redacted<string>;
  readonly state: Schema.Json;
  readonly criteria: Readonly<Record<string, string>>;
  readonly instructions: string;
  readonly allowance: Allowance;
}): Effect.fn.Return<Decision, JevError | AiError.AiError, HttpClient.HttpClient> {
  const data = yield* Schema.decodeEffect(Request)(
    {
      model: modelName,
      state: options.state,
      questions: {
        next: { type: "choice", instructions: options.instructions, criteria: options.criteria },
      },
    },
    { onExcessProperty: "error" },
  ).pipe(Effect.mapError(() => new JevError({ reason: "payload", status: null })));

  const payload = yield* Schema.encodeEffect(Schema.fromJsonString(Request))(data).pipe(
    Effect.mapError(() => new JevError({ reason: "payload", status: null })),
  );

  if (new TextEncoder().encode(payload).byteLength > maxBytes)
    return yield* new JevError({ reason: "payload", status: null });

  const decisionInput = yield* Schema.encodeEffect(Schema.fromJsonString(DecisionInput))({
    state: data.state,
    question: data.questions.next,
  }).pipe(Effect.mapError(() => new JevError({ reason: "payload", status: null })));

  // A single question has a smaller window than the whole request; bytes bound token count.
  if (new TextEncoder().encode(decisionInput).byteLength > maxDecisionBytes)
    return yield* new JevError({ reason: "payload", status: null });
  const client = yield* HttpClient.HttpClient;

  // Reserve the full documented request window, including framing, before dispatch.
  yield* options.allowance.admit(maxBytes);

  return yield* Effect.gen(function* () {
    const response = yield* client
      .execute(
        HttpClientRequest.post("https://api.typesafe.ai/v1/systemone").pipe(
          HttpClientRequest.bearerToken(Redacted.value(options.apiKey)),
          HttpClientRequest.bodyText(payload, "application/json"),
          HttpClientRequest.acceptJson,
        ),
      )
      .pipe(Effect.mapError(() => new JevError({ reason: "provider", status: null })));

    if (response.status < 200 || response.status >= 300)
      return yield* new JevError({ reason: "provider", status: response.status });
    const body = yield* read(response);

    const returned = yield* Schema.decodeEffect(Schema.fromJsonString(Model))(body).pipe(
      Effect.mapError(() => new JevError({ reason: "response", status: response.status })),
    );

    if (returned.model !== modelName) {
      options.allowance.breakContract();

      return yield* new JevError({ reason: "response", status: response.status });
    }

    const usage = yield* Schema.decodeEffect(
      Schema.fromJsonString(Schema.Struct({ usage: Usage })),
    )(body).pipe(
      Effect.mapError(() => {
        options.allowance.breakContract();

        return new JevError({ reason: "usage", status: response.status });
      }),
    );

    const { input_tokens: inputTokens, output_tokens: outputTokens } = usage.usage;

    if (inputTokens > maxBytes) {
      options.allowance.settle({
        inputTokens: { total: inputTokens },
        outputTokens: { total: outputTokens },
      });
      options.allowance.breakContract();

      return yield* new JevError({ reason: "usage", status: response.status });
    }

    const decoded = yield* Schema.decodeEffect(Schema.fromJsonString(Response))(body, {
      onExcessProperty: "error",
    }).pipe(Effect.mapError(() => new JevError({ reason: "response", status: response.status })));

    const answer = decoded.answers.next;

    const grounded = Response.check(
      Schema.makeFilter((value) => {
        const { choice, probabilities } = value.answers.next;
        const candidates = Object.keys(options.criteria);
        const scores = Object.values(probabilities);
        const selected = probabilities[choice];

        return (
          Object.hasOwn(options.criteria, choice) &&
          Object.keys(probabilities).length === candidates.length &&
          candidates.every((candidate) => Object.hasOwn(probabilities, candidate)) &&
          Math.abs(scores.reduce((sum, score) => sum + score, 0) - 1) <= 0.001 &&
          selected !== undefined &&
          scores.every((score) => score <= selected)
        );
      }),
    );

    yield* Schema.decodeEffect(grounded)(decoded).pipe(
      Effect.mapError(() => new JevError({ reason: "response", status: response.status })),
    );
    // Outputs are free, but the real output token count still belongs in the spend evidence.
    options.allowance.settle({
      inputTokens: { total: inputTokens },
      outputTokens: { total: outputTokens },
    });

    return {
      choice: answer.choice,
      confidence: answer.confidence,
      probabilities: answer.probabilities,
      inputTokens,
      outputTokens,
    };
  }).pipe(Effect.ensuring(Effect.sync(() => options.allowance.release())));
});
