/** Prompt-aware model scripts with per-layer request evidence and explicit exhaustion. */
import { Context, Effect, Layer, Predicate, Ref, Schema, Stream } from "effect";
import { AiError, LanguageModel, Model, type Prompt, type Response, type Tool } from "effect/ai";

export class ScriptError extends Schema.TaggedError<ScriptError>()("ScriptError", {
  detail: Schema.String,
}) {}

const normalized = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(normalized)
    : Predicate.isObject(value)
      ? Object.fromEntries(
          Object.keys(value)
            .toSorted()
            .map((key) => [key, normalized(Reflect.get(value, key))]),
        )
      : (value ?? null);

/** Canonical JSON for request identity; object key order never changes a match. */
export const canonical = (value: unknown): string => JSON.stringify(normalized(value));

export const fingerprint = (tools: ReadonlyArray<Tool.Any>): string =>
  canonical(
    tools
      .map((tool) => ({
        name: String(tool.name),
        description: tool.description,
        parameters: Schema.toJsonSchemaDocument(tool.parametersSchema),
      }))
      .toSorted((left, right) => left.name.localeCompare(right.name)),
  );

export interface Request {
  readonly turn: number;
  readonly options: LanguageModel.ProviderOptions;
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
  readonly toolsFingerprint: string;
}

export interface Reply {
  readonly parts: ReadonlyArray<Response.PartEncoded>;
  /** Override delivery to model pacing, stalls, or a broken-off stream without changing generation. */
  readonly stream?: Stream.Stream<Response.StreamPartEncoded, AiError.AiError> | undefined;
}

export type Turn = (request: Request) => Effect.Effect<Reply, ScriptError | AiError.AiError>;

export class TestModel extends Context.Service<
  TestModel,
  {
    readonly requests: Effect.Effect<ReadonlyArray<Request>>;
    readonly assertExhausted: Effect.Effect<void, ScriptError>;
  }
>()("effect-agent-browser/testing/TestModel") {}

const failed = (error: ScriptError) =>
  AiError.make({
    module: "TestModel",
    method: "request",
    reason: new AiError.InvalidRequestError({ description: error.detail }),
  });

/** Translate the finite response vocabulary at the streaming provider boundary. */
export const streamed = (
  parts: ReadonlyArray<Response.PartEncoded>,
): ReadonlyArray<Response.StreamPartEncoded> =>
  parts.flatMap((part, index): ReadonlyArray<Response.StreamPartEncoded> => {
    if (part.type === "text" || part.type === "reasoning") {
      const id = `${part.type}-${index}`;

      return part.type === "text"
        ? [
            { type: "text-start", id },
            { type: "text-delta", id, delta: part.text },
            { type: "text-end", id },
          ]
        : [
            { type: "reasoning-start", id },
            { type: "reasoning-delta", id, delta: part.text },
            { type: "reasoning-end", id },
          ];
    }

    return [part];
  });

export const finish = (reason: "stop" | "tool-calls" = "stop"): Response.PartEncoded => ({
  type: "finish",
  reason,
  usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
});

export const text = (value: string): ReadonlyArray<Response.PartEncoded> => [
  { type: "text", text: value },
  finish(),
];

export const reply = (
  parts: ReadonlyArray<Response.PartEncoded>,
  stream?: Reply["stream"],
): Reply => ({ parts, stream });

/** Call ids are explicit or local to a scripted turn; there is no process-global counter. */
export const call = (name: string, params: unknown, id = ""): Response.PartEncoded => ({
  type: "tool-call",
  id,
  name,
  params,
});

export const calling = (
  ...calls: ReadonlyArray<Response.PartEncoded>
): ReadonlyArray<Response.PartEncoded> => [...calls, finish("tool-calls")];

export const textOf = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text"
              ? [part.text]
              : part.type === "tool-result"
                ? [JSON.stringify(part.result)]
                : [],
          ),
    )
    .join("\n");

/** Ref allocation belongs to Layer construction, so rebuilding the layer starts the script afresh. */
export const layer = (
  turns: ReadonlyArray<Turn> | { readonly respond: Turn },
  options: {
    readonly onRequest?: ((request: Request) => Effect.Effect<void>) | undefined;
  } = {},
) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const requests = yield* Ref.make<ReadonlyArray<Request>>([]);

      const next = (options: LanguageModel.ProviderOptions) =>
        Effect.gen(function* () {
          const request = yield* Ref.modify(requests, (seen) => {
            const request: Request = {
              turn: seen.length + 1,
              options,
              prompt: options.prompt,
              tools: options.tools,
              toolsFingerprint: fingerprint(options.tools),
            };

            return [request, [...seen, request]];
          });

          yield* optionsOnRequest(request);
          const turn = "respond" in turns ? turns.respond : turns[request.turn - 1];

          return turn === undefined
            ? yield* new ScriptError({ detail: `script exhausted at request ${request.turn}` })
            : yield* Effect.map(turn(request), (reply) => ({
                ...reply,
                parts: reply.parts.map((part, index) =>
                  part.type === "tool-call" && part.id === ""
                    ? { ...part, id: `call-${request.turn}-${index}` }
                    : part,
                ),
              }));
        }).pipe(
          Effect.mapError((error) => (Schema.is(ScriptError)(error) ? failed(error) : error)),
        );

      const optionsOnRequest = options.onRequest ?? (() => Effect.void);

      const model = yield* LanguageModel.make({
        generateText: (request) => Effect.map(next(request), ({ parts }) => [...parts]),
        streamText: (request) =>
          Stream.unwrap(
            Effect.map(
              next(request),
              (reply) => reply.stream ?? Stream.fromIterable(streamed(reply.parts)),
            ),
          ),
      });

      return Layer.merge(
        Model.make("scripted", "test-model", Layer.succeed(LanguageModel.LanguageModel, model)),
        Layer.succeed(TestModel, {
          requests: Ref.get(requests),
          assertExhausted: Effect.flatMap(Ref.get(requests), (seen) =>
            "respond" in turns || seen.length === turns.length
              ? Effect.void
              : Effect.fail(
                  new ScriptError({
                    detail:
                      seen.length > turns.length
                        ? `${seen.length - turns.length} unexpected scripted requests`
                        : `${turns.length - seen.length} unused scripted turns`,
                  }),
                ),
          ),
        }),
      );
    }),
  );
