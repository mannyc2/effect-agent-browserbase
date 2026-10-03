import { Effect, Layer, Schema } from "effect";
import { HttpClient, HttpClientResponse, HttpServerResponse } from "effect/http";

/**
 * Provider HTTP replaced by a finite script: the pinned provider packages still serialize each
 * request and decode each streamed reply. Identifiers carry `SECRET`, so a test can show that no
 * provider-issued value reaches a retained record.
 */

export type WireTurn =
  | { readonly call: string; readonly params: unknown; readonly usage: WireUsage }
  | { readonly text: string; readonly usage: WireUsage }
  /** The provider refuses the request with this HTTP status and a message naming a secret. */
  | { readonly refuse: number };

export interface WireUsage {
  readonly input: number;
  readonly cacheRead?: number;
  readonly cacheWrite?: number;
  readonly output: number;
  readonly reasoning?: number;
}

const Body = Schema.fromJsonString(Schema.Record(Schema.String, Schema.Json));

/** Response headers carry request and account identifiers, as a provider's do. */
const headers = {
  "x-request-id": "req_SECRET",
  "request-id": "req_SECRET",
  "openai-organization": "org-SECRET",
  "openai-project": "proj_SECRET",
  "anthropic-organization-id": "org-SECRET",
};

const events = (request: Parameters<typeof HttpClientResponse.fromWeb>[0], lines: string) =>
  HttpClientResponse.fromWeb(
    request,
    HttpServerResponse.toWeb(
      HttpServerResponse.text(lines, { contentType: "text/event-stream", headers }),
    ),
  );

type Reply = Exclude<WireTurn, { readonly refuse: number }>;

const wire = (turns: ReadonlyArray<WireTurn>, reply: (turn: Reply, index: number) => string) => {
  const bodies: Array<Readonly<Record<string, Schema.Json>>> = [];
  /** Where each request went, and which credential headers it carried (never their values). */
  const sent: Array<{ readonly url: string; readonly credentials: ReadonlyArray<string> }> = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((request) =>
      Effect.gen(function* () {
        if (request.body._tag !== "Uint8Array") return yield* Effect.die("Expected a JSON body");
        bodies.push(yield* Schema.decodeEffect(Body)(new TextDecoder().decode(request.body.body)));
        sent.push({
          url: request.url,
          credentials: ["authorization", "x-api-key"].filter(
            (name) => request.headers[name] !== undefined,
          ),
        });
        const index = bodies.length - 1;
        const turn = turns[index];

        if (turn === undefined) return yield* Effect.die("Provider script exhausted");
        if ("refuse" in turn)
          return HttpClientResponse.fromWeb(
            request,
            HttpServerResponse.toWeb(
              HttpServerResponse.jsonUnsafe(
                {
                  type: "error",
                  error: { type: "invalid_request_error", message: "Rejected field SECRET" },
                },
                { status: turn.refuse, headers },
              ),
            ),
          );

        return events(request, reply(turn, index));
      }).pipe(Effect.orDie),
    ),
  );

  return { layer, bodies, sent };
};

const sse = (items: ReadonlyArray<Readonly<Record<string, unknown>>>, sequence: boolean) =>
  items
    .map(
      (item, index) =>
        `event: ${String(item.type)}\ndata: ${JSON.stringify(sequence ? { ...item, sequence_number: index } : item)}\n\n`,
    )
    .join("");

/**
 * OpenAI Responses: a reasoning item precedes each reply, as a reasoning model's would. OpenRouter
 * closes the stream with `data: [DONE]`, in the same chunk as the last event.
 */
export const openAiWire = (
  turns: ReadonlyArray<WireTurn>,
  options: { readonly done?: boolean } = {},
) =>
  wire(turns, (turn, index) => {
    const reasoning = {
      type: "reasoning",
      id: `rs_SECRET_${index}`,
      summary: [],
      encrypted_content: `ENCRYPTED_SECRET_${index}`,
    };

    const item =
      "call" in turn
        ? {
            type: "function_call",
            id: `fc_SECRET_${index}`,
            call_id: `call_SECRET_${index}`,
            name: turn.call,
            arguments: JSON.stringify(turn.params),
            status: "completed",
          }
        : {
            type: "message",
            id: `msg_SECRET_${index}`,
            role: "assistant",
            status: "completed",
            content: [{ type: "output_text", text: turn.text, annotations: [] }],
          };

    const response = {
      id: `resp_SECRET_${index}`,
      object: "response",
      model: "gpt-test",
      created_at: 0,
      service_tier: "default",
      output: [reasoning, item],
      usage: {
        input_tokens: turn.usage.input,
        output_tokens: turn.usage.output,
        total_tokens: turn.usage.input + turn.usage.output,
        input_tokens_details: { cached_tokens: turn.usage.cacheRead ?? 0 },
        output_tokens_details: { reasoning_tokens: turn.usage.reasoning ?? 0 },
      },
    };

    return (
      sse(
        [
          { type: "response.created", response: { ...response, output: [], usage: null } },
          { type: "response.output_item.added", output_index: 0, item: reasoning },
          { type: "response.output_item.done", output_index: 0, item: reasoning },
          {
            type: "response.output_item.added",
            output_index: 1,
            item:
              "call" in turn
                ? { ...item, arguments: "", status: "in_progress" }
                : { ...item, status: "in_progress", content: [] },
          },
          // Text streams in small deltas, as a provider's does.
          ...("text" in turn
            ? (turn.text.match(/.{1,8}/gs) ?? []).map((delta) => ({
                type: "response.output_text.delta",
                item_id: item.id,
                output_index: 1,
                content_index: 0,
                delta,
              }))
            : []),
          { type: "response.output_item.done", output_index: 1, item },
          { type: "response.completed", response },
        ],
        true,
      ) + (options.done === true ? "data: [DONE]\n\n" : "")
    );
  });

/** Anthropic Messages: usage arrives at the start and is completed by the closing delta. */
export const anthropicWire = (turns: ReadonlyArray<WireTurn>) =>
  wire(turns, (turn, index) => {
    const usage = {
      input_tokens: turn.usage.input,
      cache_creation_input_tokens: turn.usage.cacheWrite ?? 0,
      cache_read_input_tokens: turn.usage.cacheRead ?? 0,
    };

    const block =
      "call" in turn
        ? [
            {
              type: "content_block_start",
              index: 0,
              content_block: {
                type: "tool_use",
                id: `toolu_SECRET_${index}`,
                name: turn.call,
                input: {},
              },
            },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "input_json_delta", partial_json: JSON.stringify(turn.params) },
            },
          ]
        : [
            { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
            {
              type: "content_block_delta",
              index: 0,
              delta: { type: "text_delta", text: turn.text },
            },
          ];

    return sse(
      [
        {
          type: "message_start",
          message: {
            id: `msg_SECRET_${index}`,
            type: "message",
            role: "assistant",
            model: "claude-test",
            content: [],
            stop_reason: null,
            stop_sequence: null,
            usage: {
              ...usage,
              output_tokens: 0,
              cache_creation: null,
              inference_geo: null,
              server_tool_use: null,
              service_tier: null,
            },
          },
        },
        ...block,
        { type: "content_block_stop", index: 0 },
        {
          type: "message_delta",
          delta: { stop_reason: "call" in turn ? "tool_use" : "end_turn", stop_sequence: null },
          usage: { ...usage, output_tokens: turn.usage.output, server_tool_use: null },
        },
        { type: "message_stop" },
      ],
      false,
    );
  });
