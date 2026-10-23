/**
 * Prompt caching for OpenRouter chat completions whose turns end in a picture. `BrowserTools` shows
 * the screenshot before a turn as context the next call drops. A provider that caches at
 * breakpoints, as OpenAI's models do on OpenRouter, sets its own at the end of the prompt, inside
 * that picture, so no later call matches it and every call writes the whole conversation again.
 * `layer` marks the end of each request's history instead, with OpenRouter's `cache_control`: its
 * last tool result or, before there is one, its system message. Yielded builds the prompt and sets
 * no cache options, and `@effect/ai-openrouter` before 4.0.6 drops them on tool results, so the
 * mark is made on the request's JSON, in the HTTP client beneath the OpenRouter client:
 *
 * ```ts
 * OpenRouterClient.layerConfig({ apiKey }).pipe(
 *   Layer.provide(PromptCache.layer),
 *   Layer.provide(FetchHttpClient.layer),
 * )
 * ```
 *
 * @since 0.3.0
 */
import { Effect, Layer, Option, Predicate, Schema } from "effect";
import { HttpBody, HttpClient, HttpClientRequest } from "effect/http";

const ephemeral = { type: "ephemeral" } as const;

// The content with a breakpoint after its last text, or undefined where it does not end in text.
const marked = (content: unknown) => {
  if (typeof content === "string")
    return [{ type: "text", text: content, cache_control: ephemeral }];
  if (!Array.isArray(content)) return undefined;

  const last: unknown = content.at(-1);

  return Predicate.hasProperty(last, "type") && last.type === "text"
    ? content.with(-1, { ...last, cache_control: ephemeral })
    : undefined;
};

const markHistory = (messages: ReadonlyArray<unknown>) => {
  const at = messages.findLastIndex(
    (message) =>
      Predicate.hasProperty(message, "role") &&
      (message.role === "tool" || message.role === "system"),
  );

  const message = messages[at];

  if (!Predicate.hasProperty(message, "content")) return messages;

  const content = marked(message.content);

  return content === undefined ? messages : messages.with(at, { ...message, content });
};

const Completion = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown));

/** Marks the chat completions sent through the `HttpClient` it is given; other requests pass. */
export const layer: Layer.Layer<HttpClient.HttpClient, never, HttpClient.HttpClient> = Layer.effect(
  HttpClient.HttpClient,
  Effect.map(HttpClient.HttpClient, (http) =>
    HttpClient.mapRequest(http, (request) => {
      const { body } = request;

      if (body._tag !== "Uint8Array" || !request.url.endsWith("/chat/completions")) return request;

      return Option.match(Schema.decodeOption(Completion)(new TextDecoder().decode(body.body)), {
        onNone: () => request,
        onSome: (completion) =>
          Array.isArray(completion["messages"])
            ? HttpClientRequest.setBody(
                request,
                HttpBody.jsonUnsafe({
                  ...completion,
                  messages: markHistory(completion["messages"]),
                }),
              )
            : request,
      });
    }),
  ),
);
