import type { ScriptedStreamPart } from "@effect-agent/testing/scripted-model";
import { Effect, Layer, Schema, Stream, type Tracer } from "effect";
import * as InMemory from "effect-agent/in-memory";
import type { RunCostEstimator } from "effect-agent/run-options";
import type { Page } from "effect-browser/browser";
import { AiError, LanguageModel, Model, Prompt } from "effect/unstable/ai";

import { resize } from "./Images.ts";
import { type Journal, type Usage, json, requestData } from "./Records.ts";

export type Turn = (request: LanguageModel.ProviderOptions) => ReadonlyArray<ScriptedStreamPart>;
const usage = { inputTokens: {}, outputTokens: {} };

export const call = (
  id: string,
  name: string,
  params: unknown,
): ReadonlyArray<ScriptedStreamPart> => [
  { type: "tool-call", id, name, params },
  { type: "finish", reason: "tool-calls", usage },
];

const text = (delta: string): ReadonlyArray<ScriptedStreamPart> => [
  { type: "text-start", id: "answer" },
  { type: "text-delta", id: "answer", delta },
  { type: "text-end", id: "answer" },
  { type: "finish", reason: "stop", usage },
];

export const answer = (output: Schema.Json) => text(JSON.stringify(output));

/** A final turn that ignores the output contract, as a real model did when its turns ran out. */
export const prose = (delta: string) => text(delta);

const modelError = () =>
  AiError.AiError.make({
    module: "Bench",
    method: "script",
    reason: AiError.UnknownError.make({
      description: "Finite bench script exhausted or unsupported invocation",
    }),
  });

/** This is the scripted provider seam, not an HTTP payload or a real-model measurement. */
export const model = (journal: Journal, turns: ReadonlyArray<Turn>, spans: Tracer.Span[] = []) =>
  Layer.mergeAll(
    InMemory.layer,
    Layer.succeed(Model.ProviderName, "scripted"),
    Layer.succeed(Model.ModelName, "fixture-policy-v1"),
    Layer.effect(
      LanguageModel.LanguageModel,
      Effect.gen(function* () {
        let turn = 0;

        return yield* LanguageModel.make({
          generateText: () => Effect.fail(modelError()),
          streamText: (request) =>
            Stream.unwrap(
              Effect.gen(function* () {
                const index = turn++;

                if (spans.length < 2000) spans.push(request.span);

                journal.append({ kind: "request", turn: index, value: requestData(request) });
                const script = turns[index];

                if (script === undefined) return yield* modelError();

                return Stream.fromIterable(script(request)).pipe(
                  Stream.tap((part) =>
                    Effect.sync(() => {
                      journal.append({ kind: "response", turn: index, value: json(part) });
                    }),
                  ),
                );
              }),
            ),
        });
      }),
    ),
  );

/** AgentRuntime publishes history after tool projection, even when there is no following model call. */
export const history = (journal: Journal) => (prompt: Prompt.Prompt) =>
  Schema.encodeEffect(Prompt.Prompt)(prompt).pipe(
    Effect.tap((encoded) =>
      Effect.sync(() => {
        journal.append({ kind: "history", turn: null, value: json(encoded) });
      }),
    ),
  );

/** The services an agent run needs from its model: a script's, or a real provider's. */
export type ModelServices = Layer.Success<ReturnType<typeof model>>;

/**
 * What drives a run's model: its services, the history it records and, for a real model, the
 * estimator that records reported usage and the spend facts it leaves.
 */
export interface Driver {
  readonly provide: <A, E, R>(
    effect: Effect.Effect<A, E, R>,
  ) => Effect.Effect<A, E, Exclude<R, ModelServices>>;
  readonly history: (prompt: Prompt.Prompt) => Effect.Effect<unknown, Schema.SchemaError>;
  readonly estimate: RunCostEstimator | undefined;
  /** Spend facts once the run ends, including any unavailable usage; null for a script. */
  readonly finish: () => Usage | null;
  readonly callLatencies?: () => ReadonlyArray<number>;
}

/** Host-only span references are projected after completion; no native span enters a record. */
export const latencies = (spans: ReadonlyArray<Tracer.Span>) =>
  spans.flatMap((span) =>
    span.status._tag === "Ended" ? [Number(span.status.endTime - span.status.startTime) / 1e6] : [],
  );

export const scripted = (journal: Journal, turns: ReadonlyArray<Turn>): Driver => {
  const spans: Tracer.Span[] = [];

  return {
    provide: (effect) => Effect.provide(effect, model(journal, turns, spans)),
    history: history(journal),
    estimate: undefined,
    finish: () => null,
    callLatencies: () => latencies(spans),
  };
};

/** Per-turn images are transient references; they never accumulate in conversation history. */
export const picture = (
  page: Page,
  options: { readonly every: "call"; readonly scale: 0.5 | 1 },
) => ({
  load: () =>
    Effect.gen(function* () {
      const screenshot = yield* page.screenshot({ fullPage: false });
      const bytes = yield* resize(screenshot.bytes, options.scale);

      return Prompt.make([
        Prompt.makeMessage("user", {
          content: [
            Prompt.makePart("text", {
              text: `Current viewport PNG at ${options.scale} scale. Multiply pictured coordinates by ${1 / options.scale} to obtain main-viewport CSS pixels.`,
            }),
            Prompt.makePart("file", {
              mediaType: "image/png",
              data: Buffer.from(bytes).toString("base64"),
            }),
          ],
        }),
      ]);
    }),
});
