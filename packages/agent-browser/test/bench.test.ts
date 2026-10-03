import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Console, Effect, Schema, Stream } from "effect";
import { Target } from "effect-browser/browser-data";
import * as AiResponse from "effect/unstable/ai/Response";
import { Command } from "effect/unstable/cli";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { Ledger, Sessions } from "./bench/Budget.ts";
import { authorize, cli, printedPlan, validateSelection } from "./bench/Cli.ts";
import { commentary, retainedEnd } from "./bench/Film.ts";
import { withoutDone, withoutNullCacheControl } from "./bench/Models.ts";
import { diagnose, json, Usage } from "./bench/Records.ts";

const rates = { input: 1000000, cacheRead: 500000, cacheWrite: 1000000, output: 2000000 };

const usage = {
  inputTokens: { total: 100, uncached: 80, cacheRead: 20 },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

it("gateway cache adaptation preserves model-authored input and tool schemas", () => {
  expect(
    withoutNullCacheControl({
      system: [{ type: "text", text: "fixture", cache_control: null }],
      messages: [
        { content: [{ type: "tool_use", cache_control: null, input: { cache_control: null } }] },
      ],
      tools: [{ input_schema: { properties: { cache_control: { const: null } } } }],
    }),
  ).toEqual({
    system: [{ type: "text", text: "fixture" }],
    messages: [{ content: [{ type: "tool_use", input: { cache_control: null } }] }],
    tools: [{ input_schema: { properties: { cache_control: { const: null } } } }],
  });
});

it("records copy data-class metadata while refusing non-JSON values", () => {
  const target = Target.make({ generation: 0, pageId: "page", frameId: "frame" });

  expect(json({ target })).toEqual({ target: { generation: 0, pageId: "page", frameId: "frame" } });
  expect(() => json({ at: Number.NaN })).toThrow("Expected JSON value");
  expect(() => json({ bytes: new Uint8Array([1]) })).toThrow("Expected JSON value");
});

it.effect(
  "the reported cap stops the next request and records the bounded request's overshoot",
  () =>
    Effect.gen(function* () {
      const ledger = new Ledger(1000);
      const allowance = ledger.allowance({ limitMicrousd: 150, rates, maxOutputTokens: 50 });

      yield* allowance.admit();
      expect(allowance.settle(usage)).toBe(190);
      expect(allowance.usage()).toMatchObject({
        costMicrousd: 190,
        overshootMicrousd: 40,
        reasoningTokens: 10,
      });
      expect((yield* allowance.admit().pipe(Effect.exit))._tag).toBe("Failure");
      expect(allowance.finish().refused).toBe("run-budget");
    }),
);
it.effect("runs share one invocation cap and unknown usage stops further calls", () =>
  Effect.gen(function* () {
    const ledger = new Ledger(190);
    const first = ledger.allowance({ limitMicrousd: 500, rates, maxOutputTokens: 50 });

    yield* first.admit();
    first.settle(usage);
    const next = ledger.allowance({ limitMicrousd: 500, rates, maxOutputTokens: 50 });

    expect((yield* next.admit().pipe(Effect.exit))._tag).toBe("Failure");
    expect(next.finish().refused).toBe("invocation-budget");
    const unknown = new Ledger(1000);
    const pending = unknown.allowance({ limitMicrousd: 500, rates, maxOutputTokens: 50 });

    yield* pending.admit();
    pending.finish();
    expect(unknown.halted).toBe(true);
    expect(pending.usage().status).toBe("usage-unavailable");
  }),
);
it.effect("malformed native usage cannot refund the budget or allow another request", () =>
  Effect.gen(function* () {
    const cases = [
      { inputTokens: { total: 0 }, outputTokens: { total: -100 } },
      { inputTokens: { total: 1, cacheRead: 2 }, outputTokens: { total: 0 } },
    ];

    for (const counts of cases) {
      const nativeUsage = yield* Schema.decodeEffect(AiResponse.Usage)(counts);
      const ledger = new Ledger(1000);
      const allowance = ledger.allowance({ limitMicrousd: 1000, rates, maxOutputTokens: 50 });

      yield* allowance.admit();
      expect(allowance.settle(nativeUsage)).toBe(0);
      expect(ledger.spentMicrousd).toBe(0);
      expect(ledger.halted).toBe(true);
      expect((yield* allowance.admit().pipe(Effect.exit))._tag).toBe("Failure");
      expect((yield* Schema.decodeEffect(Usage)(allowance.finish())).status).toBe(
        "usage-unavailable",
      );
    }
  }),
);
it.effect("a model run needs its live flag and explicit spending cap", () =>
  Effect.gen(function* () {
    expect(
      (yield* authorize({ backend: "chromium", model: true }, {}).pipe(Effect.exit))._tag,
    ).toBe("Failure");
    expect(
      (yield* authorize({ backend: "chromium", model: true, maxUsd: 0.1 }, {}).pipe(Effect.exit))
        ._tag,
    ).toBe("Failure");
    yield* authorize(
      { backend: "chromium", model: true, maxUsd: 0.1 },
      { EFFECT_AGENT_BROWSER_BENCH_LIVE: "1" },
    );
    expect(
      (yield* authorize({ backend: "browserbase", model: false }, {}).pipe(Effect.exit))._tag,
    ).toBe("Failure");
  }),
);
it("the printed plan counts every run and session with a worst-case spend", () => {
  expect(
    printedPlan({
      scene: "smoke",
      backend: "browserbase",
      trials: 3,
      maxUsd: 0,
      durationMillis: 5000,
    }),
  ).toMatchObject({ runs: 3, sessions: 3, modelWorstCaseUsd: 0 });
});
it.effect(
  "CLI defaults print a single capped segment without requiring optional boolean flags",
  () =>
    Effect.gen(function* () {
      const messages: unknown[] = [];
      const console = yield* Console.Console;

      yield* Command.runWith(cli(), { version: "test" })([
        "plan",
        "game-segment",
        "--max-spins",
        "1",
      ]).pipe(
        Effect.provideService(Console.Console, {
          ...console,
          log: (...values) => {
            messages.push(...values);
          },
        }),
      );
      const value: unknown = JSON.parse(String(messages[0]));

      expect(value).toMatchObject({
        scene: "game-segment",
        maxSpins: 1,
        runs: 1,
        matrix: null,
        announceThenSpin: false,
      });
    }).pipe(Effect.provide(NodeServices.layer)),
);
it.effect(
  "unsupported matrix and hosted selections fail before fixture or session preparation",
  () =>
    Effect.gen(function* () {
      const cases = [
        { scene: "busy", backend: "chromium", matrix: true },
        { scene: "read-table", backend: "browserbase", matrix: true },
        { scene: "replay-drift", backend: "browserbase" },
        { scene: "game-segment", backend: "browserbase" },
        { scene: "game-segment", backend: "chromium", condition: "text" },
        { scene: "read-table", backend: "chromium", driver: "canvas-click" },
        { scene: "smoke", backend: "chromium", fixtureTunnels: "/tool" },
      ] as const;

      for (const invalid of cases) {
        let prepared = false;

        const exit = yield* validateSelection({
          driver: "scripted",
          condition: "picture",
          matrix: false,
          ...invalid,
        }).pipe(
          Effect.andThen(
            Effect.sync(() => {
              prepared = true;
            }),
          ),
          Effect.exit,
        );

        expect(exit._tag).toBe("Failure");
        expect(prepared).toBe(false);
      }
      yield* validateSelection({
        scene: "read-table",
        backend: "chromium",
        driver: "scripted",
        condition: "picture",
        matrix: true,
      });
      yield* validateSelection({
        scene: "game-segment",
        backend: "browserbase",
        driver: "scripted",
        condition: "digest",
        matrix: false,
        fixtureTunnels: "/tool",
      });
      expect(
        printedPlan({
          scene: "read-table",
          backend: "chromium",
          trials: 20,
          durationMillis: 10000,
          maxUsd: 0.5,
          matrix: true,
        }),
      ).toMatchObject({
        runs: 180,
        sessions: 0,
        modelSpendCapUsd: 0.5,
        matrix: { captions: 480, modelCallsMaximum: 720 },
      });
      expect(
        (yield* authorize(
          { backend: "chromium", model: true, maxUsd: 0.00000001 },
          { EFFECT_AGENT_BROWSER_BENCH_LIVE: "1" },
        ).pipe(Effect.exit))._tag,
      ).toBe("Failure");
    }),
);
it("uncertain cleanup prevents another session", () => {
  const sessions = new Sessions(2);

  expect(sessions.admit()).toBe(true);
  sessions.settle("unconfirmed");
  expect(sessions.admit()).toBe(false);
  const bounded = new Sessions(1);

  expect(bounded.admit()).toBe(true);
  bounded.settle("confirmed");
  expect(bounded.admit()).toBe(false);
});
it.effect(
  "OpenRouter's DONE marker is removed across chunk boundaries without losing the last event",
  () =>
    Effect.gen(function* () {
      const client = withoutDone(
        HttpClient.make((request) =>
          Effect.succeed(
            HttpClientResponse.fromWeb(
              request,
              new Response(
                new ReadableStream({
                  start(controller) {
                    for (const chunk of ['data: {"done":true}\n\ndata: [DO', "NE]\n\n"])
                      controller.enqueue(new TextEncoder().encode(chunk));
                    controller.close();
                  },
                }),
              ),
            ),
          ),
        ),
      );

      const response = yield* client.get("https://model.test");

      const text = yield* response.stream.pipe(
        Stream.decodeText,
        Stream.runFold(
          () => "",
          (all, part) => all + part,
        ),
      );

      expect(text).toContain('data: {"done":true}');
      expect(text).not.toContain("[DONE]");
    }).pipe(Effect.provide(NodeServices.layer)),
);
it("diagnostics expose the bounded reason", () =>
  expect(
    diagnose(Cause.fail({ _tag: "AiError", reason: { _tag: "InvalidRequestError" } })),
  ).toEqual({ reason: "InvalidRequestError" }));
it("film captions retain publication time instead of the earlier result time", () => {
  expect(
    commentary([
      { seq: 1, at: 500, kind: "truth", turn: null, value: { resultAtMillis: 500 } },
      {
        seq: 2,
        at: 903,
        kind: "host",
        turn: null,
        value: {
          caption: { atMillis: 900, kind: "result", output: { caption: "The reels stopped." } },
        },
      },
      {
        seq: 3,
        at: 1000,
        kind: "host",
        turn: null,
        value: { output: { caption: "The table is visible." } },
      },
    ]),
  ).toEqual([
    { at: 900, label: "result", caption: "The reels stopped." },
    { at: 1000, label: "narration", caption: "The table is visible." },
  ]);
});
it("films stop at retained capture instead of holding a cutoff frame through later scene work", () => {
  const capture = {
    startedAt: 0,
    endedAt: 5000,
    captureEndedAt: 1500,
    frames: [{ receivedAt: 1000 }],
  };

  expect(retainedEnd(capture)).toBe(1500);
  expect(retainedEnd({ ...capture, limitReached: "frames" })).toBe(1000);
  expect(retainedEnd({ ...capture, limitReached: "bytes" })).toBe(1000);
});
