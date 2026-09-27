import { isDeepStrictEqual } from "node:util";

import { ScriptedStreamPart } from "@effect-agent/testing/scripted-model";
import { Effect, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as AgentRuntime from "effect-agent/agent-runtime";
import { Prompt } from "effect/unstable/ai";

import { type Evidence, Journal, json, requestData } from "./Evidence.ts";
import { grade } from "./Grading.ts";
import { history, model, type Turn } from "./Model.ts";
import { agent } from "./Tasks.ts";

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

/**
 * Offline replay returns a retained result, success or failure, only for an identical ordered
 * action. It never opens an owner. `diverge` replaces one retained call's arguments, as a
 * regression seam for the divergence refusal; it is not a live branching mode.
 */
export const replay = Effect.fn("Evaluation.replay")(function* (
  evidence: Evidence,
  diverge?: { readonly call: string; readonly params: Schema.Json },
) {
  // Aliased identifiers still replay: the same aliases name each call and its result.
  if (grade(evidence).exactness === "incomplete")
    return yield* new ReplayDivergence({ reason: "incomplete" });
  const { toolkit: composition, bounds, goal } = evidence.manifest;
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

  const retained = (name: string, params: unknown) =>
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

      if (result === undefined) return reject("result");
      cursor++;

      return Effect.succeed(result);
    });

  /** The retained result decoded by the maintained Tool's own schemas, never trusted raw. */
  const serve =
    <S, F>(
      name: string,
      schemas: {
        readonly successSchema: Schema.Decoder<S>;
        readonly failureSchema: Schema.Decoder<F>;
      },
    ) =>
    (params: unknown): Effect.Effect<S, F> =>
      retained(name, params).pipe(
        Effect.flatMap((result) =>
          result.isFailure
            ? Schema.decodeUnknownEffect(schemas.failureSchema)(result.result).pipe(
                Effect.catch(() => reject("result")),
                Effect.flatMap((failure) => Effect.fail(failure)),
              )
            : Schema.decodeUnknownEffect(schemas.successSchema)(result.result).pipe(
                Effect.catch(() => reject("result")),
              ),
        ),
      );

  const base = BrowserTools.toolkit.tools;
  const observed = BrowserTools.observedToolkit.tools;
  const form = BrowserTools.formToolkit.tools.browser_fill_form;
  const observedForm = BrowserTools.observedFormToolkit.tools.browser_fill_form_and_inspect;
  const readMore = BrowserTools.readingToolkit.tools.browser_read_more;

  const handlers = Layer.mergeAll(
    BrowserTools.toolkit.toLayer({
      browser_navigate: serve("browser_navigate", base.browser_navigate),
      browser_inspect: serve("browser_inspect", base.browser_inspect),
      browser_click: serve("browser_click", base.browser_click),
      browser_fill: serve("browser_fill", base.browser_fill),
      browser_scroll: serve("browser_scroll", base.browser_scroll),
    }),
    BrowserTools.observedToolkit.toLayer({
      browser_navigate_and_inspect: serve(
        "browser_navigate_and_inspect",
        observed.browser_navigate_and_inspect,
      ),
      browser_inspect: serve("browser_inspect", base.browser_inspect),
      browser_click_and_inspect: serve(
        "browser_click_and_inspect",
        observed.browser_click_and_inspect,
      ),
      browser_fill_and_inspect: serve(
        "browser_fill_and_inspect",
        observed.browser_fill_and_inspect,
      ),
      browser_scroll_and_inspect: serve(
        "browser_scroll_and_inspect",
        observed.browser_scroll_and_inspect,
      ),
    }),
    BrowserTools.formToolkit.toLayer({ browser_fill_form: serve("browser_fill_form", form) }),
    BrowserTools.observedFormToolkit.toLayer({
      browser_fill_form_and_inspect: serve("browser_fill_form_and_inspect", observedForm),
    }),
    BrowserTools.readingToolkit.toLayer({
      browser_read_more: serve("browser_read_more", readMore),
    }),
  );

  const turns: Turn[] = requests.map((request) => (actual) => {
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

        return diverge !== undefined && part.type === "tool-call" && part.id === diverge.call
          ? { ...part, params: diverge.params }
          : part;
      });
  });

  const journal = new Journal(evidence.manifest);

  const result = yield* AgentRuntime.run(agent(composition, bounds), evidence.facts.input ?? goal, {
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
