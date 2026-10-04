import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import * as Agent from "@yielded/agent/agent";
import * as AgentRuntime from "@yielded/agent/agent-runtime";
import { Effect, Layer, Redacted, Schema } from "effect";
import { AiError, Prompt, Toolkit } from "effect/ai";
import { HttpClient, HttpClientResponse } from "effect/http";

import { Ledger, ModelRequestAdmission } from "./bench/Budget.ts";
import { measured } from "./bench/Models.ts";
import { Journal, type Subject } from "./bench/Records.ts";

// The real provider decoder and AgentRuntime consume this local, unpaid HTTP fixture.
const response = () =>
  [
    {
      type: "message_start",
      message: {
        id: "fixture-message",
        type: "message",
        role: "assistant",
        content: [],
        model: "fixture-budget",
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 0,
          cache_creation: null,
          cache_creation_input_tokens: 0,
          cache_read_input_tokens: 0,
          service_tier: null,
        },
      },
    },
    {
      type: "content_block_start",
      index: 0,
      content_block: { type: "text", text: "", citations: null },
    },
    {
      type: "content_block_delta",
      index: 0,
      delta: {
        type: "text_delta",
        text: JSON.stringify({ caption: "Fixture response.", facts: {} }),
      },
    },
    { type: "content_block_stop", index: 0 },
    {
      type: "message_delta",
      delta: { stop_reason: "end_turn", stop_sequence: null },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    { type: "message_stop" },
  ]
    .map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`)
    .join("");

for (const source of ["fixture prices", "https://prices.test/" + "version/".repeat(50)])
  it.live(
    `actual measured driver settles successive narration calls and enforces the cap (${source.length})`,
    () =>
      Effect.gen(function* () {
        const subject: Subject = {
          provider: "anthropic",
          model: "fixture-budget",
          settings: {
            gateway: "direct",
            maxOutputTokens: 100,
            reasoningEffort: null,
            serviceTier: null,
          },
          rates: {
            input: 1000000,
            cacheRead: 500000,
            cacheWrite: 1000000,
            output: 2000000,
            source,
            retrieved: "2026-10-03",
          },
        };

        const journal = new Journal({
          version: 1,
          runId: `model-budget-${source.length}`,
          scene: "read-table",
          backend: "chromium",
          driver: "fixture-http",
          sourceRevision: "native-test",
          sourceDirty: false,
          trial: 0,
          seed: 0,
          viewport: { width: 1280, height: 720 },
          settings: { subject },
          capture: {
            maxFrames: 300,
            maxBytes: 16 * 1024 * 1024,
            quality: 30,
            maxDurationMillis: 15000,
          },
        });

        const ledger = new Ledger(400);

        const allowance = ledger.allowance({
          limitMicrousd: 400,
          rates: subject.rates,
          maxOutputTokens: 100,
        });

        let sent = 0;

        const driver = measured({
          subject,
          journal,
          allowance,
          apiKey: Redacted.make("fixture-only"),
          transport: Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) => {
              sent++;

              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  new Response(response(), {
                    headers: { "content-type": "text/event-stream" },
                  }),
                ),
              );
            }),
          ),
        });

        const narrator = Agent.make("fixture-budget", {
          input: Schema.String,
          output: Schema.Struct({ caption: Schema.String, facts: Schema.Json }),
          toolkit: Toolkit.empty,
          instructions: "Return the fixture response as the final output.",
          policy: { maxTurns: 1, maxToolCalls: 1 },
        });

        const invoke = () =>
          driver.provide(
            AgentRuntime.run(narrator, "Return the fixture response.", {
              estimateCostMicrousd: driver.estimate,
            }),
          );

        let preparationFinished = false;

        const closedDuringPreparation = yield* driver
          .provide(
            AgentRuntime.run(narrator, "Prepare context before admitting the native request.", {
              beforeTurn: () => Effect.void,
              transientContext: {
                load: () =>
                  Effect.sync(() => {
                    preparationFinished = true;

                    return Prompt.fromMessages([]);
                  }),
              },
              estimateCostMicrousd: driver.estimate,
            }),
          )
          .pipe(
            Effect.provideService(
              ModelRequestAdmission,
              Effect.suspend(() =>
                preparationFinished
                  ? Effect.fail(
                      AiError.make({
                        module: "fixture-window",
                        method: "admit",
                        reason: new AiError.InvalidRequestError({
                          description: "Measurement ended during context preparation.",
                        }),
                      }),
                    )
                  : Effect.void,
              ),
            ),
            Effect.exit,
          );

        expect(closedDuringPreparation._tag).toBe("Failure");
        expect(preparationFinished).toBe(true);
        expect(sent).toBe(0);
        expect(allowance.usage()).toMatchObject({ admitted: 0, settled: 0, status: "no-calls" });
        expect(ledger.halted).toBe(false);

        for (let index = 0; index < 2; index++) {
          const result = yield* invoke();

          expect(result.output).toEqual({ caption: "Fixture response.", facts: {} });
          expect(allowance.usage()).toMatchObject({
            admitted: index + 1,
            settled: index + 1,
            costMicrousd: (index + 1) * 200,
            refused: null,
            status: "estimated-from-reported-usage",
          });
        }
        expect((yield* invoke().pipe(Effect.exit))._tag).toBe("Failure");
        expect(sent).toBe(2);
        expect(driver.finish()).toMatchObject({
          admitted: 2,
          settled: 2,
          inputTokens: 200,
          outputTokens: 100,
          costMicrousd: 400,
          refused: "run-budget",
          status: "estimated-from-reported-usage",
        });
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
