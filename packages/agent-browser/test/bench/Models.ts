import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import * as InMemory from "@yielded/agent/in-memory";
import { Effect, Layer, Redacted, Schema, Stream, type Tracer } from "effect";
import { type LanguageModel, Prompt, Telemetry } from "effect/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/http";

import type { Allowance } from "./Budget.ts";
import { latencies, type Driver } from "./Drivers.ts";
import { type Subject, type Journal, json, requestData } from "./Records.ts";

const isRecord = Schema.is(Schema.Record(Schema.String, Schema.Unknown));

/** OpenRouter rejects null cache controls; schema and tool input payloads remain untouched. */
export const withoutNullCacheControl = (value: unknown): unknown =>
  Array.isArray(value)
    ? value.map(withoutNullCacheControl)
    : isRecord(value)
      ? Object.fromEntries(
          Object.entries(value)
            .filter(([key, field]) => !(key === "cache_control" && field === null))
            .map(([key, field]) => [
              key,
              key === "input_schema" || key === "input" ? field : withoutNullCacheControl(field),
            ]),
        )
      : value;

/** Run-local names for provider-issued identifiers, in order of first appearance. */
class Aliases {
  readonly #names = new Map<string, string>();
  of(id: string): string {
    const known = this.#names.get(id);

    if (known !== undefined) return known;
    const alias = `id-${this.#names.size + 1}`;

    this.#names.set(id, alias);

    return alias;
  }
}

/** Provider options emptied and call identifiers aliased; message content is untouched. */
const part = (value: unknown, aliases: Aliases): unknown => {
  if (!isRecord(value)) return value;
  const copy: Record<string, unknown> = { ...value };

  if ("options" in copy) copy.options = {};
  if ((copy.type === "tool-call" || copy.type === "tool-result") && typeof copy.id === "string")
    copy.id = aliases.of(copy.id);

  return copy;
};

const prompt = (value: unknown, aliases: Aliases): unknown =>
  isRecord(value) && Array.isArray(value.content)
    ? {
        ...value,
        content: value.content.map((message: unknown) =>
          isRecord(message)
            ? {
                ...message,
                ...("options" in message ? { options: {} } : {}),
                content: Array.isArray(message.content)
                  ? message.content.map((item: unknown) => part(item, aliases))
                  : message.content,
              }
            : message,
        ),
      }
    : value;

const request = (options: LanguageModel.ProviderOptions, aliases: Aliases): Schema.Json => {
  const data = Schema.decodeUnknownSync(Schema.Record(Schema.String, Schema.Unknown))(
    requestData(options),
  );

  return json({
    ...data,
    prompt: prompt(data.prompt, aliases),
    incrementalPrompt:
      data.incrementalPrompt === null ? null : prompt(data.incrementalPrompt, aliases),
    previousResponseId:
      typeof data.previousResponseId === "string" ? aliases.of(data.previousResponseId) : null,
  });
};

const plain = (value: unknown) => json(JSON.parse(JSON.stringify(value ?? null)));

type Part = Parameters<Telemetry.SpanTransformer>[0]["response"][number];

/** The parts a replay needs, in their encoded form; metadata and provider events are dropped. */
const response = (value: Part, aliases: Aliases): Schema.Json | undefined => {
  switch (value.type) {
    case "text-start":
    case "text-end":
    case "reasoning-start":
    case "reasoning-end":
      return { type: value.type, id: aliases.of(value.id) };
    case "text-delta":
    case "reasoning-delta":
      return { type: value.type, id: aliases.of(value.id), delta: value.delta };
    case "tool-call":
      return {
        type: "tool-call",
        id: aliases.of(value.id),
        name: value.name,
        params: plain(value.params),
        ...(value.providerExecuted === true ? { providerExecuted: true } : {}),
      };
    case "finish":
      return {
        type: "finish",
        reason: value.reason,
        usage: {
          inputTokens: plain(value.usage.inputTokens),
          outputTokens: plain(value.usage.outputTokens),
        },
      };
    case "text":
    case "reasoning":
    case "tool-params-start":
    case "tool-params-delta":
    case "tool-params-end":
    case "tool-result":
    case "tool-approval-request":
    case "response-metadata":
    case "source":
    case "file":
    case "error":
      return undefined;
  }
};

type Delta = {
  readonly type: "text-delta" | "reasoning-delta";
  readonly id: string;
  readonly delta: string;
};

const isDelta = (value: unknown): value is Delta =>
  isRecord(value) &&
  (value.type === "text-delta" || value.type === "reasoning-delta") &&
  typeof value.id === "string" &&
  typeof value.delta === "string";

/**
 * Each request and what came back, recorded as the stream ends, on failure too. A part's
 * streamed deltas are joined into one, so a long reply cannot exhaust the journal's events.
 */
const recorder = (
  journal: Journal,
  aliases: Aliases,
  spans: Tracer.Span[],
): Telemetry.SpanTransformer => {
  let turn = 0;

  return (options) => {
    if (spans.length < 2000) spans.push(options.span);
    const index = turn++;
    const parts: Array<Schema.Json> = [];

    for (const item of options.response) {
      const value = response(item, aliases);
      const last = parts.at(-1);

      if (isDelta(value) && isDelta(last) && last.type === value.type && last.id === value.id)
        parts[parts.length - 1] = { ...last, delta: last.delta + value.delta };
      else if (value !== undefined) parts.push(value);
    }
    journal.append({ kind: "request", turn: index, value: request(options, aliases) });
    for (const value of parts) journal.append({ kind: "response", turn: index, value });
  };
};

/** Where each request format is served, directly and through OpenRouter. */
const endpoints = {
  direct: { openai: "https://api.openai.com/v1", anthropic: "https://api.anthropic.com" },
  openrouter: { openai: "https://openrouter.ai/api/v1", anthropic: "https://openrouter.ai/api" },
} as const;

/**
 * OpenRouter ends a stream with `data: [DONE]`, which is not an event of either format and
 * arrives in the same chunk as the last one. Only that line is dropped.
 */
export const withoutDone = (client: HttpClient.HttpClient) =>
  client.pipe(
    HttpClient.transformResponse(
      Effect.map((response) => {
        let reader: ReadableStreamDefaultReader<Uint8Array> | undefined;

        // Nothing is read until the body is: an unread response keeps its own cleanup.
        const body = new ReadableStream<Uint8Array>(
          {
            pull: async (controller) => {
              reader ??= Stream.toReadableStream(
                response.stream.pipe(
                  Stream.decodeText,
                  Stream.splitLines,
                  Stream.filter((line) => line !== "data: [DONE]"),
                  Stream.map((line) => `${line}\n`),
                  Stream.encodeText,
                ),
              ).getReader();
              const next = await reader.read();

              if (next.done) controller.close();
              else controller.enqueue(next.value);
            },
            cancel: (reason) => reader?.cancel(reason),
          },
          { highWaterMark: 0 },
        );

        return HttpClientResponse.fromWeb(
          response.request,
          new Response(body, { status: response.status, headers: response.headers }),
        );
      }),
    ),
  );

/**
 * A measured run's model: the subject's provider with reported-spend checks in front of every request, the
 * recorder, and the estimator that records reported spend from reported usage.
 */
export const measured = (options: {
  readonly subject: Subject;
  readonly allowance: Allowance;
  readonly apiKey: Redacted.Redacted<string>;
  readonly journal: Journal;
  readonly transport: Layer.Layer<HttpClient.HttpClient>;
}): Driver => {
  const { subject, allowance, apiKey, journal, transport } = options;

  const aliases = new Aliases();
  const spans: Tracer.Span[] = [];
  const { gateway, maxOutputTokens, reasoningEffort, serviceTier } = subject.settings;
  const apiUrl = endpoints[gateway][subject.provider];

  const transformClient = (client: HttpClient.HttpClient) =>
    gateway === "openrouter"
      ? withoutDone(
          client.pipe(HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(apiKey)))),
        )
      : client;

  const send = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    allowance.admit().pipe(
      Effect.andThen(effect),
      Effect.onError(() => Effect.sync(() => allowance.release())),
    );

  const model =
    subject.provider === "openai"
      ? OpenAiLanguageModel.model(subject.model, {
          store: false,
          ...(serviceTier === null ? {} : { service_tier: "default" }),
          max_output_tokens: maxOutputTokens,
          ...(reasoningEffort === null ? {} : { reasoning: { effort: reasoningEffort } }),
        }).pipe(
          Layer.provide(
            Layer.effect(
              OpenAiClient.OpenAiClient,
              OpenAiClient.make({ apiKey, apiUrl, transformClient }).pipe(
                Effect.map((native) => ({
                  ...native,
                  createResponse: (payload) => send(native.createResponse(payload)),
                  createResponseStream: (payload) =>
                    send(
                      native.createResponseStream({
                        ...payload,
                        ...(gateway === "openrouter"
                          ? { provider: { only: [subject.provider], allow_fallbacks: false } }
                          : {}),
                      }),
                    ),
                })),
              ),
            ),
          ),
        )
      : AnthropicLanguageModel.model(subject.model, {
          max_tokens: maxOutputTokens,
          ...(serviceTier === null ? {} : { service_tier: "standard_only" }),
        }).pipe(
          Layer.provide(
            Layer.effect(
              AnthropicClient.AnthropicClient,
              AnthropicClient.make({ apiKey, apiUrl, transformClient }).pipe(
                Effect.map((native) => ({
                  ...native,
                  createMessage: (request) => send(native.createMessage(request)),
                  createMessageStream: (request) => {
                    const routed =
                      gateway === "openrouter"
                        ? {
                            ...request,
                            payload: {
                              ...request.payload,
                              messages: request.payload.messages.map(
                                (message) => withoutNullCacheControl(message) as typeof message,
                              ),
                              ...(request.payload.system === undefined
                                ? {}
                                : {
                                    system: withoutNullCacheControl(
                                      request.payload.system,
                                    ) as typeof request.payload.system,
                                  }),
                              provider: { only: [subject.provider], allow_fallbacks: false },
                            },
                          }
                        : request;

                    return send(native.createMessageStream(routed));
                  },
                })),
              ),
            ),
          ),
        );

  // The language model takes its span transformer, the recorder, when it is built.
  const layer = Layer.mergeAll(
    InMemory.layer,
    model.pipe(
      Layer.provide(transport),
      Layer.provide(
        Layer.succeed(Telemetry.CurrentSpanTransformer, recorder(journal, aliases, spans)),
      ),
    ),
  );

  return {
    provide: (effect) => Effect.provide(effect, layer),
    history: (history) =>
      Schema.encodeEffect(Prompt.Prompt)(history).pipe(
        Effect.tap((encoded) =>
          Effect.sync(() => {
            journal.append({ kind: "history", turn: null, value: json(prompt(encoded, aliases)) });
          }),
        ),
      ),
    estimate: (usage) =>
      Effect.sync(() => {
        const costMicrousd = allowance.settle(usage);

        return {
          costMicrousd,
          pricingVersion: `${subject.rates.source} ${subject.rates.retrieved}`,
          pricingStatus:
            allowance.usage().status === "usage-unavailable"
              ? ("unknown" as const)
              : ("estimated" as const),
        };
      }),
    finish: () => allowance.finish(),
    callLatencies: () => latencies(spans),
  };
};
