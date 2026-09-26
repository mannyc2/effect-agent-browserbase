import type { ScriptedStreamPart } from "@effect-agent/testing/scripted-model";
import { Effect, Layer, Schema, Stream } from "effect";
import * as InMemory from "effect-agent/in-memory";
import { AiError, LanguageModel, Model, Prompt } from "effect/unstable/ai";

import type { Output } from "./Cases.ts";
import { type Journal, json, requestData } from "./Evidence.ts";

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

export const answer = (output: Output) => text(JSON.stringify(output));

/** A final turn that ignores the output contract, as a real model did when its turns ran out. */
export const prose = (delta: string) => text(delta);

const modelError = () =>
  AiError.AiError.make({
    module: "Evaluation",
    method: "script",
    reason: AiError.UnknownError.make({
      description: "Finite evaluation script exhausted or unsupported invocation",
    }),
  });

/** This is the scripted provider seam, not an HTTP payload or a real-model measurement. */
export const model = (journal: Journal, turns: ReadonlyArray<Turn>) =>
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
