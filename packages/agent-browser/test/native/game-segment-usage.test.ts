import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Redacted, Schema, Stream } from "effect";
import { HttpClient, HttpClientResponse } from "effect/http";

import { run } from "../bench/Backends.ts";
import { Ledger } from "../bench/Budget.ts";
import { retainedEnd } from "../bench/Film.ts";
import { gameSegment } from "../bench/GameSegment.ts";
import { measured } from "../bench/Models.ts";
import { Journal, type Subject } from "../bench/Records.ts";
import { gameSite } from "../fixtures/GameSite.ts";

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
    source: "fixture prices",
    retrieved: "2026-10-03",
  },
};

const sse = <Event extends { readonly type: string }>(events: ReadonlyArray<Event>) =>
  new TextEncoder().encode(
    events.map((event) => `event: ${event.type}\ndata: ${JSON.stringify(event)}\n\n`).join(""),
  );

const messageStart = sse([
  {
    type: "message_start",
    message: {
      id: "fixture-message",
      type: "message",
      role: "assistant",
      content: [],
      model: subject.model,
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
]);

const caption = sse([
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
      text: JSON.stringify({ caption: "This late caption must not air.", facts: {} }),
    },
  },
  { type: "content_block_stop", index: 0 },
]);

const terminal = (stopReason: "end_turn" | "tool_use") =>
  sse([
    {
      type: "message_delta",
      delta: { stop_reason: stopReason, stop_sequence: null },
      usage: {
        input_tokens: 100,
        output_tokens: 50,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: 0,
      },
    },
    { type: "message_stop" },
  ]);

// Regression for accepted40c: its whole-work timeout cancels decoded usage at the cutoff.
for (const mode of ["caption", "late-tool", "missing-usage", "episode-cap", "active-tool"] as const)
  it.live(`real Chromium: sealed segment drains provider ${mode}`, () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* gameSite({ seed: 2 });

        const journal = new Journal({
          version: 1,
          runId: `segment-delayed-${mode}`,
          scene: "game-segment",
          backend: "chromium",
          driver: "fixture-http",
          sourceRevision: "native-test",
          sourceDirty: false,
          trial: 0,
          seed: 2,
          viewport: { width: 1280, height: 720 },
          settings: { subject },
          capture: {
            maxFrames: 300,
            maxBytes: 8 * 1024 * 1024,
            quality: 25,
            maxDurationMillis: 5000,
          },
        });

        const twoCalls = mode === "episode-cap" || mode === "active-tool";
        const ledger = new Ledger(twoCalls ? 800 : 400);

        const allowance = ledger.allowance({
          limitMicrousd: ledger.limitMicrousd,
          rates: subject.rates,
          maxOutputTokens: 100,
        });

        let sent = 0;
        let responseClosed = false;

        const driver = measured({
          subject,
          journal,
          allowance,
          apiKey: Redacted.make("fixture-only"),
          transport: Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              Effect.gen(function* () {
                sent++;
                const firstLobby = twoCalls && sent === 1;

                const tool = sse([
                  {
                    type: "content_block_start",
                    index: 0,
                    content_block: {
                      type: "tool_use",
                      id: "late-navigation",
                      name: mode === "active-tool" ? "bench_pause" : "browser_navigate",
                      input: {},
                    },
                  },
                  {
                    type: "content_block_delta",
                    index: 0,
                    delta: {
                      type: "input_json_delta",
                      partial_json: JSON.stringify(
                        mode === "active-tool" ? { millis: 5000 } : { url: site.url },
                      ),
                    },
                  },
                  { type: "content_block_stop", index: 0 },
                ]);

                const body = yield* Stream.toReadableStreamEffect(
                  Stream.fromIterable(
                    mode === "caption" || mode === "episode-cap" || firstLobby
                      ? [messageStart, caption]
                      : [messageStart],
                  ).pipe(
                    Stream.concat(
                      firstLobby
                        ? Stream.make(terminal("end_turn"))
                        : mode === "active-tool"
                          ? Stream.fromIterable([tool, terminal("tool_use")])
                          : mode === "missing-usage"
                            ? Stream.fromEffect(Effect.never)
                            : Stream.fromEffect(Effect.sleep(1800)).pipe(
                                Stream.flatMap(() =>
                                  Stream.fromIterable(
                                    mode === "late-tool"
                                      ? [tool, terminal("tool_use")]
                                      : [terminal("end_turn")],
                                  ),
                                ),
                              ),
                    ),
                    Stream.onExit(() =>
                      Effect.sync(() => {
                        responseClosed = true;
                      }),
                    ),
                  ),
                );

                return HttpClientResponse.fromWeb(
                  request,
                  new Response(body, { headers: { "content-type": "text/event-stream" } }),
                );
              }),
            ),
          ),
        });

        yield* run(journal, (browser) =>
          Effect.gen(function* () {
            yield* gameSegment(journal, browser, {
              driver,
              site,
              durationMillis: 1000,
              settlementDrainMillis: 1500,
              maxSpins: 1,
            });
            expect((yield* browser.initialPage.observe()).url).toBe("about:blank");
          }),
        );

        const metrics = yield* Schema.decodeUnknownEffect(
          Schema.Struct({
            durationMillis: Schema.Finite,
            captions: Schema.Array(Schema.Unknown),
            pictureCalls: Schema.Int,
            stopReason: Schema.String,
            settlementDrain: Schema.Struct({
              status: Schema.String,
              maxDurationMillis: Schema.Int,
              elapsedAfterMeasurementMillis: Schema.Finite,
            }),
          }),
        )(journal.metrics);

        if (mode === "missing-usage") {
          expect(journal.usage).toMatchObject({
            admitted: 1,
            settled: 0,
            costMicrousd: 0,
            status: "usage-unavailable",
          });
          expect(ledger.halted).toBe(true);

          const next = ledger.allowance({
            limitMicrousd: 400,
            rates: subject.rates,
            maxOutputTokens: 100,
          });

          expect((yield* next.admit().pipe(Effect.exit))._tag).toBe("Failure");
          expect(next.usage().refused).toBe("missing-usage");
          expect(metrics.settlementDrain.status).toBe("timed-out");
          expect(metrics.settlementDrain.elapsedAfterMeasurementMillis).toBeLessThan(2000);
        } else {
          expect(journal.usage).toMatchObject({
            admitted: twoCalls ? 2 : 1,
            settled: twoCalls ? 2 : 1,
            costMicrousd: twoCalls ? 400 : 200,
            status: "estimated-from-reported-usage",
          });
          expect(ledger.halted).toBe(false);
          expect(metrics.settlementDrain.status).toBe(
            mode === "active-tool" ? "not-needed" : "completed",
          );
          if (mode === "active-tool")
            expect(metrics.settlementDrain.elapsedAfterMeasurementMillis).toBeLessThan(500);
        }
        expect(responseClosed).toBe(true);
        expect(sent).toBe(twoCalls ? 2 : 1);
        expect(metrics.pictureCalls).toBe(twoCalls ? 2 : 1);
        expect(metrics.captions).toHaveLength(twoCalls ? 1 : 0);
        expect(metrics.stopReason).toBe("duration");
        expect(metrics.durationMillis).toBeCloseTo(1000, 6);
        const recording = journal.recording;

        expect(recording).toBeDefined();
        if (recording === undefined) return yield* Effect.die("Missing native recording");
        expect(retainedEnd(recording)).toBe(recording.measurementEndedAt);
        expect(recording.measurementEndedAt).toBeLessThan(recording.endedAt);
        expect(
          (journal.recording?.endedAt ?? 0) - (journal.recording?.startedAt ?? 0),
        ).toBeLessThan(1500);
        expect(journal.ownerClose).toBe("confirmed");
        expect(journal.cleanup).toBe("confirmed");
      }),
    ).pipe(Effect.provide(NodeServices.layer)),
  );
