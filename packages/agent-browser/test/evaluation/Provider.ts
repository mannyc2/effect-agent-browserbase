import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import * as InMemory from "effect-agent/in-memory";
import { type LanguageModel, Prompt, Telemetry } from "effect/unstable/ai";
import { HttpClient, HttpClientRequest, HttpClientResponse } from "effect/unstable/http";

import type { Subject } from "./Campaign.ts";
import { type Journal, json, requestData } from "./Evidence.ts";
import { measured as decisionMeasured } from "./Jev.ts";
import type { Driver } from "./Model.ts";
import type { Allowance } from "./Spend.ts";

/**
 * A real model behind the same AgentRuntime, Tools and owner as a script. Each provider request
 * is checked against the contract it is priced under and admitted by the run's allowance before
 * it is sent; the transport refuses anything that was not. Records keep the normalized model
 * boundary with provider identifiers aliased and provider metadata removed.
 */

/** The request body as the provider client sends it. */
const bytes = (payload: object) => Buffer.byteLength(JSON.stringify({ ...payload, stream: true }));

const absent = (value: unknown) => value === undefined || value === null;

const isRecord = (value: unknown): value is Readonly<Record<string, unknown>> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Every `type` among a request's items and their content parts; a bare message has none. */
const types = (items: unknown): ReadonlyArray<unknown> =>
  Array.isArray(items)
    ? items.flatMap((item) =>
        isRecord(item)
          ? [item.type, ...(Array.isArray(item.content) ? types(item.content) : [])]
          : [],
      )
    : [];

type OpenAiPayload = Parameters<OpenAiClient.Service["createResponseStream"]>[0];

/**
 * Through OpenRouter, only the vendor's own endpoint may serve a request, with no fallback, so
 * the vendor's listed rates are the ones charged. The field is part of the admitted bytes.
 */
const routing = (subject: Subject) =>
  subject.settings.gateway === "openrouter"
    ? { provider: { only: [subject.provider], allow_fallbacks: false } }
    : {};

/**
 * Stored conversations, referenced items, files and images, hosted tools and non-standard tiers
 * bill tokens the request's bytes do not bound, or at other rates.
 */
const openAiPriced = (payload: OpenAiPayload, subject: Subject) =>
  payload.model === subject.model &&
  payload.store === false &&
  payload.service_tier === (subject.settings.serviceTier ?? undefined) &&
  payload.max_output_tokens === subject.settings.maxOutputTokens &&
  (payload.reasoning?.effort ?? null) === subject.settings.reasoningEffort &&
  absent(payload.previous_response_id) &&
  absent(payload.conversation) &&
  payload.background !== true &&
  (payload.tools ?? []).every((tool) => tool.type === "function") &&
  types(payload.input).every(
    (type) => type !== "item_reference" && type !== "input_image" && type !== "input_file",
  );

type AnthropicRequest = Parameters<AnthropicClient.Service["createMessageStream"]>[0];

type MessageStream = Effect.Success<ReturnType<AnthropicClient.Service["createMessageStream"]>>;

/**
 * Betas can change the price, so only these are sent: the provider package adds strict tool
 * schemas for every Tool.
 */
const betas: ReadonlySet<string> = new Set(["structured-outputs-2025-11-13"]);

/** Thinking, hosted tools, containers, faster or regional inference and documents are refused. */
const anthropicPriced = ({ payload, params }: AnthropicRequest, subject: Subject) =>
  payload.model === subject.model &&
  payload.max_tokens === subject.settings.maxOutputTokens &&
  payload.service_tier === (subject.settings.serviceTier ?? undefined) &&
  (absent(payload.thinking) || payload.thinking?.type === "disabled") &&
  absent(payload.speed) &&
  absent(payload.inference_geo) &&
  absent(payload.container) &&
  absent(payload.context_management) &&
  absent(payload.mcp_servers) &&
  (payload.tools ?? []).every((tool) => !("type" in tool) || tool.type === "custom") &&
  (params?.["anthropic-beta"] ?? "").split(",").every((beta) => beta === "" || betas.has(beta)) &&
  types(payload.messages).every(
    (type) =>
      type === undefined || type === "text" || type === "tool_use" || type === "tool_result",
  );

/** One admission lets exactly one request through the transport. */
export interface Gate {
  armed: boolean;
}

/** The provider client's transport: it sends a request only when admission armed it. */
export const guarded = (gate: Gate) => (client: HttpClient.HttpClient) =>
  HttpClient.transform(client, (effect) =>
    Effect.suspend(() => {
      if (!gate.armed) return Effect.die("A provider request was not admitted");
      gate.armed = false;

      return effect;
    }),
  );

/**
 * Reserve, arm the transport for this one request and send it. The arm never outlives the send,
 * and a failed send ends the request's flight; a successful one ends with its stream.
 */
const admitted = <A, E, R>(
  allowance: Allowance,
  gate: Gate,
  bytes: number,
  send: Effect.Effect<A, E, R>,
) =>
  allowance.admit(bytes).pipe(
    Effect.andThen(
      Effect.suspend(() => {
        gate.armed = true;

        return send;
      }).pipe(
        Effect.onError(() => Effect.sync(() => allowance.release())),
        Effect.ensuring(
          Effect.sync(() => {
            gate.armed = false;
          }),
        ),
      ),
    ),
  );

const landed = (allowance: Allowance) => Stream.ensuring(Effect.sync(() => allowance.release()));

export const admitOpenAi = (
  native: OpenAiClient.Service,
  allowance: Allowance,
  subject: Subject,
  gate: Gate = { armed: false },
): OpenAiClient.Service => ({
  ...native,
  createResponse: () => Effect.suspend(() => Effect.fail(allowance.refuse("contract"))),
  createEmbedding: () => Effect.suspend(() => Effect.fail(allowance.refuse("contract"))),
  createResponseStream: (original) =>
    Effect.suspend(() => {
      const payload = { ...original, ...routing(subject) };

      return openAiPriced(payload, subject)
        ? admitted(
            allowance,
            gate,
            bytes(payload),
            native
              .createResponseStream(payload)
              .pipe(
                Effect.map(
                  ([response, stream]) => [response, stream.pipe(landed(allowance))] as const,
                ),
              ),
          )
        : Effect.fail(allowance.refuse("contract"));
    }),
});

/**
 * A null `cache_control` means absent to Anthropic, but OpenRouter's validator refuses it, so it
 * is dropped. Tool schemas and a model's own tool input are left untouched.
 */
const withoutNullCacheControl = (value: unknown): unknown =>
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

const forGateway = (request: AnthropicRequest, subject: Subject): AnthropicRequest =>
  subject.settings.gateway === "openrouter"
    ? {
        ...request,
        payload: {
          ...request.payload,
          ...routing(subject),
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
        },
      }
    : request;

export const admitAnthropic = (
  native: AnthropicClient.Service,
  allowance: Allowance,
  subject: Subject,
  gate: Gate = { armed: false },
): AnthropicClient.Service => ({
  ...native,
  streamRequest: () => () => Stream.die("Only admitted message streams are sent"),
  createMessage: () => Effect.suspend(() => Effect.fail(allowance.refuse("contract"))),
  createMessageStream: (original) =>
    Effect.suspend(() => {
      const request = forGateway(original, subject);

      return anthropicPriced(request, subject)
        ? admitted(
            allowance,
            gate,
            bytes(request.payload),
            native
              .createMessageStream(request)
              .pipe(
                Effect.map(([response, stream]): MessageStream => [
                  response,
                  stream.pipe(landed(allowance)),
                ]),
              ),
          )
        : Effect.fail(allowance.refuse("contract"));
    }),
});

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
  const data = requestData(options);

  if (!isRecord(data)) return data;

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
const recorder = (journal: Journal, aliases: Aliases): Telemetry.SpanTransformer => {
  let turn = 0;

  return (options) => {
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
 * A measured run's model: the subject's provider with admission in front of every request, the
 * recorder, and the estimator that settles each reservation from reported usage.
 */
export const measured = (options: {
  readonly subject: Subject;
  readonly allowance: Allowance;
  readonly apiKey: Redacted.Redacted<string>;
  readonly journal: Journal;
  readonly transport: Layer.Layer<HttpClient.HttpClient>;
}): Driver => {
  const { subject, allowance, apiKey, journal, transport } = options;

  if (subject.provider === "typesafe") return decisionMeasured(options);

  const gate: Gate = { armed: false };
  const aliases = new Aliases();
  const { gateway, maxOutputTokens, reasoningEffort, serviceTier } = subject.settings;
  const apiUrl = endpoints[gateway][subject.provider];

  // OpenRouter reads a bearer token for either format; admission still wraps everything.
  const transformClient = (client: HttpClient.HttpClient) =>
    gateway === "openrouter"
      ? guarded(gate)(
          withoutDone(
            client.pipe(
              HttpClient.mapRequest(HttpClientRequest.bearerToken(Redacted.value(apiKey))),
            ),
          ),
        )
      : guarded(gate)(client);

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
                Effect.map((native) => admitOpenAi(native, allowance, subject, gate)),
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
                Effect.map((native) => admitAnthropic(native, allowance, subject, gate)),
              ),
            ),
          ),
        );

  // The language model takes its span transformer, the recorder, when it is built.
  const layer = Layer.mergeAll(
    InMemory.layer,
    model.pipe(
      Layer.provide(transport),
      Layer.provide(Layer.succeed(Telemetry.CurrentSpanTransformer, recorder(journal, aliases))),
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
      Effect.sync(() => ({
        costMicrousd: allowance.settle(usage),
        pricingVersion: `${subject.rates.source} ${subject.rates.retrieved}`,
        pricingStatus: "estimated" as const,
      })),
    finish: () => allowance.finish(),
  };
};
