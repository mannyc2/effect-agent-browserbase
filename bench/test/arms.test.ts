// The paired experiment's arms, driven by scripted models over the bench's own pages in a local
// Chromium: what each arm shows the model, which tools it has, and how its outcomes classify and
// pair. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit, Layer, Stream } from "effect";
import * as Chromium from "effect-browser/Chromium";
import { LanguageModel, type Prompt, type Response, Tool } from "effect/ai";

import type { Arm } from "../Arms.ts";
import { noCalls } from "../Budget.ts";
import { frameHistory, tasks } from "../Tasks.ts";
import { classify, isolatedTrial } from "../Trial.ts";

type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;

interface Seen {
  readonly prompt: Prompt.Prompt;
  readonly tools: ReadonlyArray<Tool.Any>;
}

/** A model that answers each call with the next turn, and keeps what it was shown. */
const scripted = (turns: ReadonlyArray<Turn>) => {
  const seen: Array<Seen> = [];

  const model = LanguageModel.make({
    generateText: (options) =>
      Effect.suspend(() => {
        const turn = turns[seen.length];

        seen.push({ prompt: options.prompt, tools: options.tools });

        return turn === undefined
          ? Effect.die(`no turn ${seen.length} in the script`)
          : Effect.succeed([...turn(options.prompt)]);
      }),
    streamText: () => Stream.empty,
  });

  return { layer: Layer.effect(LanguageModel.LanguageModel, model), seen };
};

let ids = 0;

const call = (name: string, params: unknown): Response.PartEncoded => {
  ids += 1;

  return { type: "tool-call", id: `call-${ids}`, name, params };
};

const finish: Response.PartEncoded = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 100 }, outputTokens: { total: 10 } },
};

const answer = (value: unknown): ReadonlyArray<Response.PartEncoded> => [
  { type: "text", text: JSON.stringify(value) },
  { ...finish, reason: "stop" },
];

/** The text the model was shown, tool results included. */
const textOf = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text"
              ? [part.text]
              : part.type === "tool-result"
                ? [JSON.stringify(part.result)]
                : [],
          ),
    )
    .join("\n");

const pictures = (prompt: Prompt.Prompt): number =>
  prompt.content.reduce(
    (count, message) =>
      count +
      (message.role === "user" ? message.content.filter((part) => part.type === "file").length : 0),
    0,
  );

const parameters = (tools: ReadonlyArray<Tool.Any>, name: string): ReadonlyArray<string> => {
  const tool = tools.find((candidate) => candidate.name === name);
  const schema = tool === undefined ? undefined : Tool.getJsonSchema(tool);

  return Object.keys((schema?.["properties"] as object | undefined) ?? {});
};

const names = (tools: ReadonlyArray<Tool.Any>) => tools.map((tool) => tool.name);

/** Run one task in one arm with a scripted model, and classify its outcome as the runner does. */
const trial = (name: string, arm: Arm, turns: ReadonlyArray<Turn>) =>
  Effect.gen(function* () {
    const task = tasks.find((candidate) => candidate.name === name);

    if (task === undefined) return yield* Effect.die(`the bench has no ${name} task`);
    const model = scripted(turns);

    const exit = yield* isolatedTrial(
      task.withModel({ seed: 23, arm, onUsage: () => Effect.void }),
      Chromium.layer({ frameHistory }),
    ).pipe(Effect.provide(model.layer), Effect.exit);

    return {
      exit,
      outcome: classify(exit, noCalls),
      seen: model.seen,
      outcomeValue: Exit.isSuccess(exit) ? exit.value : undefined,
    };
  });

/** The first text field the outline shows: the seed sets the checkout's labels and their order. */
const firstField = (prompt: Prompt.Prompt) => {
  const [, label = "missing", ref = "missing"] =
    /textbox "([^"]+)" \[ref=(e\d+)\]/.exec(textOf(prompt)) ?? [];

  return { label, ref };
};

describe("arm 1, per-action outline", () => {
  it.live("answers every action with an outline and shows pictures only on request", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 1, [
        (prompt) => [call("browser_type", { ref: firstField(prompt).ref, text: "Ada" }), finish],
        () => [call("browser_screenshot", {}), finish],
        () => [call("give_up", { reason: "scripted" }), finish],
      ]);

      const [first, second, third] = result.seen;

      assert.isDefined(first);
      assert.isDefined(second);
      assert.isDefined(third);
      if (first === undefined || second === undefined || third === undefined) return;

      // The opening is an outline alone.
      const field = firstField(first.prompt);

      assert.notStrictEqual(field.ref, "missing");
      assert.strictEqual(pictures(first.prompt), 0);
      assert.includeMembers(names(first.tools), ["browser_screenshot", "browser_snapshot"]);
      assert.notInclude(names(first.tools), "browser_zoom");
      assert.notInclude(textOf(first.prompt), "Batch two or more");

      // The type receipt carries a fresh outline, showing the typed value; no picture follows.
      const receipt = textOf(second.prompt).split('Typed \\"Ada\\"').at(1) ?? "";

      assert.include(receipt, `textbox \\"${field.label}\\"`);
      assert.strictEqual(pictures(second.prompt), 0);
      assert.strictEqual(pictures(third.prompt), 1);

      // Giving up is the model's wrong answer, graded, never infrastructure.
      assert.deepStrictEqual(result.outcome, { status: "graded", reason: "gave-up", pass: false });
    }),
  );
});

describe("arm 2, vision first", () => {
  it.live("shows a picture after each batch, never an outline, and acts by pixels", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 2, [
        () => [
          call("browser_click", { x: 200, y: 120 }),
          call("browser_zoom", { x: 0, y: 0, width: 320, height: 200 }),
          finish,
        ],
        () => [call("done", { answer: { confirmation: "CONF-0" } }), finish],
      ]);

      const [first, second] = result.seen;

      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;

      assert.strictEqual(pictures(first.prompt), 1);
      assert.strictEqual(pictures(second.prompt), 3);
      for (const { prompt } of result.seen) assert.notMatch(textOf(prompt), /\[ref=e\d+\]/);

      const tools = names(first.tools);

      assert.notInclude(tools, "browser_snapshot");
      assert.notInclude(tools, "browser_select");
      assert.include(tools, "browser_zoom");
      assert.sameMembers(
        [...parameters(first.tools, "browser_click")],
        ["x", "y", "double", "button"],
      );
      assert.sameMembers([...parameters(first.tools, "browser_type")], ["text", "submit"]);
      assert.deepStrictEqual(result.outcome, { status: "graded", reason: "answered", pass: false });
      assert.strictEqual(result.outcomeValue?.actions, 3);
      assert.strictEqual(result.outcomeValue?.steps, 2);
    }),
  );
});

describe("understand arms", () => {
  const quote = {
    ticker: "X",
    price: 1,
    change1h: 0,
    change24h: 0,
    column: "24h %",
    table: "Spot markets",
  };

  it.live("add the outline to arm 1's moment and leave it out of arm 5's", () =>
    Effect.gen(function* () {
      const outlined = yield* trial("quote-table", 1, [() => answer(quote)]);
      const batched = yield* trial("quote-table", 5, [() => answer(quote)]);
      const [control] = outlined.seen;
      const [shown] = batched.seen;

      assert.isDefined(shown);
      assert.isDefined(control);
      if (shown === undefined || control === undefined) return;

      assert.match(textOf(control.prompt), /\[ref=e\d+\]/);
      assert.notMatch(textOf(shown.prompt), /\[ref=e\d+\]/);
      assert.strictEqual(pictures(shown.prompt), pictures(control.prompt));
      assert.strictEqual(batched.outcome.status, "graded");
    }),
  );
});
