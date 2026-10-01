import { expect, it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Layer, Redacted, Schema } from "effect";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/unstable/http";

import { decide, modelName } from "./evaluation/JevClient.ts";
import { Ledger, type Allowance } from "./evaluation/Spend.ts";

const criteria = { click: "Click the visible Continue control", stop: "The goal is complete" };

const good = {
  model: modelName,
  answers: {
    next: {
      type: "choice",
      choice: "click",
      confidence: 0.8,
      probabilities: { click: 0.9, stop: 0.1 },
    },
  },
  usage: { input_tokens: 4_000, output_tokens: 20 },
};

const budget = (limitMicrousd = 10_000) => {
  const ledger = new Ledger(limitMicrousd);

  const allowance = ledger.allowance({
    limitMicrousd,
    rates: { input: 42_000, cacheRead: 42_000, cacheWrite: 42_000, output: 0 },
    maxOutputTokens: Number.MAX_SAFE_INTEGER,
  });

  return { ledger, allowance };
};

const request = (allowance: Allowance) => ({
  apiKey: Redacted.make("sk-SECRET"),
  state: { instruction: "Continue", controls: [{ id: "control-1", label: "Continue" }] },
  criteria,
  instructions: "Choose the next supplied action.",
  allowance,
});

/** The real Effect HTTP wire contract, wholly in memory; credentials are captured as booleans. */
const wire = (options: {
  readonly body?: unknown;
  readonly status?: number;
  readonly fail?: boolean;
  readonly allowance: Allowance;
}) => {
  const sent: Array<{
    readonly url: string;
    readonly method: string;
    readonly authorized: boolean;
    readonly contentType: string | undefined;
    readonly body: Schema.Json;
    readonly admitted: number;
  }> = [];

  const layer = Layer.succeed(
    HttpClient.HttpClient,
    HttpClient.make((outgoing) =>
      Effect.gen(function* () {
        if (outgoing.body._tag !== "Uint8Array") return yield* Effect.die("Expected a JSON body");

        const body = yield* Schema.decodeEffect(Schema.fromJsonString(Schema.Json))(
          new TextDecoder().decode(outgoing.body.body),
        ).pipe(Effect.orDie);

        sent.push({
          url: outgoing.url,
          method: outgoing.method,
          authorized: outgoing.headers.authorization === "Bearer sk-SECRET",
          contentType: outgoing.headers["content-type"],
          body,
          admitted: options.allowance.usage().admitted,
        });
        if (options.fail === true)
          return yield* new HttpClientError.HttpClientError({
            reason: new HttpClientError.TransportError({
              request: outgoing,
              cause: new Error("SECRET private provider failure"),
            }),
          });

        return HttpClientResponse.fromWeb(
          outgoing,
          new Response(JSON.stringify(options.body ?? good), {
            status: options.status ?? 200,
            headers: { "content-type": "application/json", "x-request-id": "req-SECRET" },
          }),
        );
      }),
    ),
  );

  return { layer, sent };
};

it.effect("Jev sends one admitted pinned Choice request and settles real free-output usage", () =>
  Effect.gen(function* () {
    const { ledger, allowance } = budget();
    const transport = wire({ allowance });
    const result = yield* decide(request(allowance)).pipe(Effect.provide(transport.layer));

    expect(transport.sent).toEqual([
      {
        url: "https://api.typesafe.ai/v1/systemone",
        method: "POST",
        authorized: true,
        contentType: "application/json",
        admitted: 1,
        body: {
          model: modelName,
          state: request(allowance).state,
          questions: {
            next: { type: "choice", instructions: request(allowance).instructions, criteria },
          },
        },
      },
    ]);
    expect(result).toEqual({
      choice: "click",
      confidence: 0.8,
      probabilities: { click: 0.9, stop: 0.1 },
      inputTokens: 4_000,
      outputTokens: 20,
    });
    expect(allowance.usage()).toMatchObject({
      admitted: 1,
      settled: 1,
      inputTokens: 4_000,
      outputTokens: 20,
      retainedMicrousd: 0,
      costMicrousd: 168,
    });
    expect(ledger.pendingMicrousd).toBe(0);
    expect(ledger.spentMicrousd).toBe(168);
  }),
);

it.effect("Jev refuses invalid or oversized candidates before admission and dispatch", () =>
  Effect.gen(function* () {
    const samples = [
      { criteria: {} },
      { criteria: { "": "An empty key" } },
      { criteria: Object.fromEntries(Array.from({ length: 256 }, (_, n) => [`a${n}`, "Click"])) },
      { state: "😀".repeat(20_000) },
    ];

    for (const sample of samples) {
      const { allowance } = budget();
      const transport = wire({ allowance });

      const error = yield* decide({ ...request(allowance), ...sample }).pipe(
        Effect.provide(transport.layer),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "JevError", reason: "payload", status: null });
      expect(transport.sent).toEqual([]);
      expect(allowance.usage()).toMatchObject({ admitted: 0, settled: 0, costMicrousd: 0 });
    }
  }),
);

it.effect("Jev accepts the full 255 candidate boundary without dropping options", () =>
  Effect.gen(function* () {
    const { allowance } = budget();
    const choices = Object.fromEntries(Array.from({ length: 255 }, (_, n) => [`a${n}`, "Click"]));

    const probabilities = Object.fromEntries(
      Object.keys(choices).map((key, index) => [key, index === 0 ? 1 : 0]),
    );

    const transport = wire({
      allowance,
      body: {
        ...good,
        answers: { next: { type: "choice", choice: "a0", confidence: 1, probabilities } },
      },
    });

    const result = yield* decide({ ...request(allowance), criteria: choices }).pipe(
      Effect.provide(transport.layer),
    );

    expect(result.choice).toBe("a0");
    expect(Object.keys(result.probabilities)).toHaveLength(255);
    expect(transport.sent).toHaveLength(1);
    expect(allowance.usage().settled).toBe(1);
  }),
);

it.effect(
  "Jev refuses scalar state and bounds state plus its longest question before dispatch",
  () =>
    Effect.gen(function* () {
      const samples = [
        { state: null },
        { state: false },
        { state: 42 },
        { state: { article: "x".repeat(33_000) } },
        { state: { article: "x".repeat(16_000) }, instructions: "x".repeat(17_000) },
        { criteria: { click: "x".repeat(33_000) } },
      ];

      for (const sample of samples) {
        const { allowance } = budget();
        const transport = wire({ allowance });

        const error = yield* decide({ ...request(allowance), ...sample }).pipe(
          Effect.provide(transport.layer),
          Effect.flip,
        );

        expect(error).toMatchObject({ _tag: "JevError", reason: "payload", status: null });
        expect(transport.sent).toEqual([]);
        expect(allowance.usage()).toMatchObject({ admitted: 0, settled: 0, costMicrousd: 0 });
      }
    }),
);

it.effect("Jev reserves the full context window and refuses spend before the wire", () =>
  Effect.gen(function* () {
    const { allowance } = budget(100);
    const transport = wire({ allowance });

    const error = yield* decide(request(allowance)).pipe(
      Effect.provide(transport.layer),
      Effect.flip,
    );

    expect(error._tag).toBe("AiError");
    expect(allowance.usage()).toMatchObject({ admitted: 0, refused: "run-budget" });
    expect(transport.sent).toEqual([]);
  }),
);

it.effect("Jev retains uncertain charges and never retries rate limits or transport failures", () =>
  Effect.gen(function* () {
    for (const failure of [{ status: 429 }, { fail: true }]) {
      const { ledger, allowance } = budget();
      const transport = wire({ allowance, ...failure, body: { error: "SECRET rejection" } });

      const error = yield* decide(request(allowance)).pipe(
        Effect.provide(transport.layer),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "JevError", reason: "provider" });
      expect(JSON.stringify(error)).not.toContain("SECRET");
      expect(transport.sent).toHaveLength(1);
      expect(allowance.usage()).toMatchObject({ admitted: 1, settled: 0, retainedMicrousd: 2796 });
      expect(ledger.pendingMicrousd).toBe(2796);
      expect(allowance.finish().costMicrousd).toBe(2796);
      expect(ledger.spentMicrousd).toBe(2796);
    }
  }),
);

it.effect("interrupted Jev requests retain their reservation and release the invocation lane", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { ledger, allowance } = budget();
      const entered = yield* Deferred.make<void>();
      let sent = 0;

      const transport = Layer.succeed(
        HttpClient.HttpClient,
        HttpClient.make(() =>
          Effect.gen(function* () {
            sent++;
            yield* Deferred.succeed(entered, undefined);

            return yield* Effect.never;
          }),
        ),
      );

      const active = yield* decide(request(allowance)).pipe(
        Effect.provide(transport),
        Effect.forkScoped,
      );

      yield* Deferred.await(entered);
      yield* Fiber.interrupt(active);
      expect(sent).toBe(1);
      expect(allowance.usage()).toMatchObject({ admitted: 1, settled: 0, retainedMicrousd: 2796 });
      // A subsequent admission retains the first uncertainty instead of treating it as refunded.
      yield* allowance.admit(65_536);
      expect(ledger.spentMicrousd).toBe(2796);
      expect(ledger.pendingMicrousd).toBe(2796);
      expect(allowance.finish().costMicrousd).toBe(5592);
    }),
  ),
);

it.effect(
  "Jev rejects ungrounded or malformed distributions without accepting their decisions",
  () =>
    Effect.gen(function* () {
      const answers = [
        { ...good.answers.next, choice: "invented" },
        { ...good.answers.next, probabilities: { click: 1 } },
        { ...good.answers.next, probabilities: { click: 0.8, stop: 0.1, invented: 0.1 } },
        { ...good.answers.next, probabilities: { click: 0.8, stop: 0.1 } },
        { ...good.answers.next, probabilities: { click: 0.1, stop: 0.9 } },
        { ...good.answers.next, probabilities: { click: 1.1, stop: -0.1 } },
        { ...good.answers.next, confidence: 2 },
        { ...good.answers.next, type: "noul" },
      ];

      for (const next of answers) {
        const { ledger, allowance } = budget();
        const transport = wire({ allowance, body: { ...good, answers: { next } } });

        const error = yield* decide(request(allowance)).pipe(
          Effect.provide(transport.layer),
          Effect.flip,
        );

        expect(error).toMatchObject({ _tag: "JevError", reason: "response" });
        expect(transport.sent).toHaveLength(1);
        expect(allowance.usage()).toMatchObject({ settled: 0, retainedMicrousd: 2796 });
        expect(ledger.closed).toBeNull();
      }
    }),
);

it.effect(
  "Jev closes campaign admission when the returned model or usage breaks its price contract",
  () =>
    Effect.gen(function* () {
      const samples = [
        { ...good, model: "jev-future" },
        { ...good, usage: { input_tokens: -1, output_tokens: 20 } },
        { ...good, usage: { input_tokens: 4_000, output_tokens: 0.5 } },
        { ...good, usage: { input_tokens: 4_000, output_tokens: Number.MAX_SAFE_INTEGER + 1 } },
        { ...good, usage: { input_tokens: 65_537, output_tokens: 20 } },
      ];

      for (const body of samples) {
        const { ledger, allowance } = budget();
        const transport = wire({ allowance, body });

        const error = yield* decide(request(allowance)).pipe(
          Effect.provide(transport.layer),
          Effect.flip,
        );

        expect(allowance.usage()).toMatchObject({ admitted: 1, overrun: true, refused: null });

        const refused = yield* decide(request(allowance)).pipe(
          Effect.provide(transport.layer),
          Effect.flip,
        );

        expect(error._tag).toBe("JevError");
        expect(refused._tag).toBe("AiError");
        expect(ledger.closed).toBe("contract");
        expect(allowance.usage()).toMatchObject({ overrun: true, refused: "closed" });
        expect(transport.sent).toHaveLength(1);
      }
    }),
);

it.effect(
  "Jev bounds response bytes before accepting a response with excessive provider data",
  () =>
    Effect.gen(function* () {
      const { allowance } = budget();
      const transport = wire({ allowance, body: { ...good, private: "SECRET".repeat(12_000) } });

      const error = yield* decide(request(allowance)).pipe(
        Effect.provide(transport.layer),
        Effect.flip,
      );

      expect(error).toMatchObject({ _tag: "JevError", reason: "response", status: 200 });
      expect(JSON.stringify(error)).not.toContain("SECRET");
      expect(transport.sent).toHaveLength(1);
      expect(allowance.usage()).toMatchObject({ settled: 0, retainedMicrousd: 2796 });
    }),
);
