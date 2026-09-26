import { isDeepStrictEqual } from "node:util";

import { ScriptedStreamPart } from "@effect-agent/testing/scripted-model";
import { Effect, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as AgentRuntime from "effect-agent/agent-runtime";
import { Prompt } from "effect/unstable/ai";

import { type Evidence, grade, Journal, json, requestData } from "./Evidence.ts";
import { history, model, type Turn } from "./Model.ts";
import { agent, goal } from "./Tasks.ts";

export class ReplayDivergence extends Schema.TaggedError<ReplayDivergence>()("ReplayDivergence", {
  reason: Schema.Literals(["incomplete", "schema", "action", "result", "remaining", "request"]),
}) {}

const Call = Schema.Struct({
  type: Schema.Literal("tool-call"),
  id: Schema.String,
  name: Schema.String,
  params: Schema.Json,
});

const Request = Schema.Struct({
  tools: Schema.Array(Schema.Struct({ name: Schema.String, parameters: Schema.Json })),
});

/** Offline replay returns retained results only for an identical ordered action. It never opens an owner. */
export const replay = Effect.fn("Evaluation.replay")(function* (
  evidence: Evidence,
  changeFirstUrl?: string,
) {
  if (grade(evidence).exactness !== "complete-normalized-inputs")
    return yield* new ReplayDivergence({ reason: "incomplete" });
  const composition = evidence.manifest.toolkit;
  const requests = evidence.events.filter((event) => event.kind === "request");
  const lastHistory = evidence.events.findLast((event) => event.kind === "history");

  const prompt = yield* Schema.decodeUnknownEffect(Prompt.Prompt)(lastHistory?.value).pipe(
    Effect.mapError(() => new ReplayDivergence({ reason: "incomplete" })),
  );

  const results = prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result");

  const calls = evidence.events
    .filter((event) => event.kind === "response" && Schema.is(Call)(event.value))
    .map((event) => Schema.decodeUnknownSync(Call)(event.value));

  let cursor = 0;
  let consumedRequests = 0;
  let divergence: ReplayDivergence | undefined;

  const reject = (reason: ReplayDivergence["reason"]) => {
    divergence ??= new ReplayDivergence({ reason });

    // Tool failures are model-visible and retryable. A replay mismatch is terminal to the host.
    return Effect.die(divergence);
  };

  const value = (name: string, params: unknown) =>
    Effect.suspend(() => {
      if (divergence !== undefined) return Effect.die(divergence);
      const expected = calls[cursor];

      if (
        expected === undefined ||
        expected.name !== name ||
        !isDeepStrictEqual(expected.params, json(JSON.parse(JSON.stringify(params))))
      )
        return reject("action");
      const result = results.find((part) => part.id === expected.id && part.name === name);

      if (result === undefined || result.isFailure) return reject("result");
      cursor++;

      return Effect.succeed(result.result);
    });

  const base = BrowserTools.toolkit.tools;
  const observed = BrowserTools.observedToolkit.tools;
  const form = BrowserTools.formToolkit.tools.browser_fill_form;
  const observedForm = BrowserTools.observedFormToolkit.tools.browser_fill_form_and_inspect;

  const decode = <A, I>(schema: Schema.Codec<A, I>, input: Effect.Effect<unknown>) =>
    input.pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(schema)),
      Effect.catch(() => reject("result")),
    );

  const handlers = Layer.mergeAll(
    BrowserTools.toolkit.toLayer({
      browser_navigate: (params) =>
        decode(base.browser_navigate.successSchema, value("browser_navigate", params)),
      browser_inspect: (params) =>
        decode(base.browser_inspect.successSchema, value("browser_inspect", params)),
      browser_click: (params) =>
        decode(base.browser_click.successSchema, value("browser_click", params)),
      browser_fill: (params) =>
        decode(base.browser_fill.successSchema, value("browser_fill", params)),
      browser_scroll: (params) =>
        decode(base.browser_scroll.successSchema, value("browser_scroll", params)),
    }),
    BrowserTools.observedToolkit.toLayer({
      browser_navigate_and_inspect: (params) =>
        decode(
          observed.browser_navigate_and_inspect.successSchema,
          value("browser_navigate_and_inspect", params),
        ),
      browser_inspect: (params) =>
        decode(base.browser_inspect.successSchema, value("browser_inspect", params)),
      browser_click_and_inspect: (params) =>
        decode(
          observed.browser_click_and_inspect.successSchema,
          value("browser_click_and_inspect", params),
        ),
      browser_fill_and_inspect: (params) =>
        decode(
          observed.browser_fill_and_inspect.successSchema,
          value("browser_fill_and_inspect", params),
        ),
      browser_scroll_and_inspect: (params) =>
        decode(
          observed.browser_scroll_and_inspect.successSchema,
          value("browser_scroll_and_inspect", params),
        ),
    }),
    BrowserTools.formToolkit.toLayer({
      browser_fill_form: (params) => decode(form.successSchema, value("browser_fill_form", params)),
    }),
    BrowserTools.observedFormToolkit.toLayer({
      browser_fill_form_and_inspect: (params) =>
        decode(observedForm.successSchema, value("browser_fill_form_and_inspect", params)),
    }),
  );

  const turns: Turn[] = requests.map((request, index) => (actual) => {
    consumedRequests++;
    const retainedTools = Schema.decodeUnknownSync(Request)(request.value);
    const actualTools = Schema.decodeUnknownSync(Request)(requestData(actual));

    if (!isDeepStrictEqual(retainedTools, actualTools)) {
      divergence ??= new ReplayDivergence({ reason: "schema" });
      throw divergence;
    }
    if (!isDeepStrictEqual(requestData(actual), request.value)) {
      divergence ??= new ReplayDivergence({ reason: "request" });
      throw divergence;
    }

    return evidence.events
      .filter((event) => event.kind === "response" && event.turn === request.turn)
      .map((event) => {
        const part = Schema.decodeUnknownSync(ScriptedStreamPart)(event.value);

        return index === 0 && changeFirstUrl !== undefined && part.type === "tool-call"
          ? { ...part, params: { url: changeFirstUrl } }
          : part;
      });
  });

  const journal = new Journal(evidence.manifest);

  const result = yield* AgentRuntime.run(agent(composition), goal, {
    onHistory: history(journal),
  }).pipe(
    Effect.provide(Layer.mergeAll(handlers, model(journal, turns))),
    Effect.catchCause(() => Effect.fail(divergence ?? new ReplayDivergence({ reason: "result" }))),
  );

  if (cursor !== calls.length || consumedRequests !== requests.length)
    return yield* new ReplayDivergence({ reason: "remaining" });

  if (!isDeepStrictEqual(json(result.output), evidence.facts.output))
    return yield* new ReplayDivergence({ reason: "result" });

  return result;
});
