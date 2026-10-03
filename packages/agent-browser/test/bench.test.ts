import { NodeServices } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Cause, Effect, Stream } from "effect";
import { Target } from "effect-browser/browser-data";
import { HttpClient, HttpClientResponse } from "effect/unstable/http";

import { Ledger, Sessions } from "./bench/Budget.ts";
import { authorize, printedPlan } from "./bench/Cli.ts";
import { withoutDone } from "./bench/Models.ts";
import { diagnose, json } from "./bench/Records.ts";

const rates = { input: 1000000, cacheRead: 500000, cacheWrite: 1000000, output: 2000000 };

const usage = {
  inputTokens: { total: 100, uncached: 80, cacheRead: 20 },
  outputTokens: { total: 50, text: 40, reasoning: 10 },
};

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
