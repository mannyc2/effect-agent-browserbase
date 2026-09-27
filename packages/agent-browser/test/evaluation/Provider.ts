import { AnthropicClient, AnthropicLanguageModel } from "@effect/ai-anthropic";
import { OpenAiClient, OpenAiLanguageModel } from "@effect/ai-openai";
import { Effect, Layer, type Redacted, Schema, Stream } from "effect";
import * as InMemory from "effect-agent/in-memory";
import { type LanguageModel, Prompt, Telemetry } from "effect/unstable/ai";
import { HttpClient } from "effect/unstable/http";

import type { Subject } from "./Campaign.ts";
import { type Journal, json, requestData } from "./Evidence.ts";
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
 * Stored conversations, referenced items, files and images, hosted tools and non-standard tiers
 * bill tokens the request's bytes do not bound, or at other rates.
 */
const openAiPriced = (payload: OpenAiPayload, subject: Subject) =>
  payload.model === subject.model &&
  payload.store === false &&
  payload.service_tier === subject.settings.serviceTier &&
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

/**
 * Betas can change the price, so only these are sent: the provider package adds strict tool
 * schemas for every Tool.
 */
const betas: ReadonlySet<string> = new Set(["structured-outputs-2025-11-13"]);

/** Thinking, hosted tools, containers, faster or regional inference and documents are refused. */
const anthropicPriced = ({ payload, params }: AnthropicRequest, subject: Subject) =>
  payload.model === subject.model &&
  payload.max_tokens === subject.settings.maxOutputTokens &&
  payload.service_tier === subject.settings.serviceTier &&
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
interface Gate {
  armed: boolean;
}

const guarded = (gate: Gate) => (client: HttpClient.HttpClient) =>
  HttpClient.transform(client, (effect) =>
    Effect.suspend(() => {
      if (!gate.armed) return Effect.die("A provider request was not admitted");
      gate.armed = false;

      return effect;
    }),
  );

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
      }),
    ),
  );

export const admitOpenAi = (
  native: OpenAiClient.Service,
  allowance: Allowance,
  subject: Subject,
  gate: Gate = { armed: false },
): OpenAiClient.Service => ({
  ...native,
  createResponse: () => Effect.suspend(() => Effect.fail(allowance.refuse("contract"))),
  createEmbedding: () => Effect.suspend(() => Effect.fail(allowance.refuse("contract"))),
  createResponseStream: (payload) =>
    Effect.suspend(() =>
      openAiPriced(payload, subject)
        ? admitted(allowance, gate, bytes(payload), native.createResponseStream(payload))
        : Effect.fail(allowance.refuse("contract")),
    ),
});

export const admitAnthropic = (
  native: AnthropicClient.Service,
  allowance: Allowance,
  subject: Subject,
  gate: Gate = { armed: false },
): AnthropicClient.Service => ({
  ...native,
  streamRequest: () => () => Stream.die("Only admitted message streams are sent"),
  createMessage: () => Effect.suspend(() => Effect.fail(allowance.refuse("contract"))),
  createMessageStream: (request) =>
    Effect.suspend(() =>
      anthropicPriced(request, subject)
        ? admitted(allowance, gate, bytes(request.payload), native.createMessageStream(request))
        : Effect.fail(allowance.refuse("contract")),
    ),
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
  const gate: Gate = { armed: false };
  const aliases = new Aliases();
  const { maxOutputTokens, reasoningEffort, serviceTier } = subject.settings;

  const model =
    subject.provider === "openai"
      ? OpenAiLanguageModel.model(subject.model, {
          store: false,
          service_tier: "default",
          max_output_tokens: maxOutputTokens,
          ...(reasoningEffort === null ? {} : { reasoning: { effort: reasoningEffort } }),
        }).pipe(
          Layer.provide(
            Layer.effect(
              OpenAiClient.OpenAiClient,
              OpenAiClient.make({ apiKey, transformClient: guarded(gate) }).pipe(
                Effect.map((native) => admitOpenAi(native, allowance, subject, gate)),
              ),
            ),
          ),
        )
      : AnthropicLanguageModel.model(subject.model, {
          max_tokens: maxOutputTokens,
          service_tier: serviceTier === "standard_only" ? "standard_only" : "auto",
        }).pipe(
          Layer.provide(
            Layer.effect(
              AnthropicClient.AnthropicClient,
              AnthropicClient.make({ apiKey, transformClient: guarded(gate) }).pipe(
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
