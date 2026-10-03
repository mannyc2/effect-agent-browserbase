import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { run } from "../bench/Backends.ts";
import { Ledger } from "../bench/Budget.ts";
import { measured } from "../bench/Models.ts";
import { Journal, type Subject } from "../bench/Records.ts";
import { understanding } from "../bench/Understanding.ts";

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

        yield* run(journal, (browser) =>
          Effect.gen(function* () {
            for (let index = 0; index < 2; index++) {
              const samples = yield* understanding(journal, browser, {
                driver,
                condition: "picture",
              });

              expect(samples).toHaveLength(1);
              expect(allowance.usage()).toMatchObject({
                admitted: index + 1,
                settled: index + 1,
                costMicrousd: (index + 1) * 200,
                refused: null,
                status: "estimated-from-reported-usage",
              });
            }
            expect(
              (yield* understanding(journal, browser, { driver, condition: "picture" }).pipe(
                Effect.exit,
              ))._tag,
            ).toBe("Failure");
          }),
        );
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
        expect(journal.ownerClose).toBe("confirmed");
        expect(journal.cleanup).toBe("confirmed");
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
  );
