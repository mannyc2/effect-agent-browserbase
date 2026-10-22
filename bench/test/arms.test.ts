// The paired experiment's arms, driven by scripted models over the bench's own pages in a local
// Chromium: what each arm shows the model, which tools it has, and how its outcomes classify and
// pair. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { type Prompt, Tool } from "effect/ai";

import type { Arm, Step } from "../Arms.ts";
import { noCalls } from "../Budget.ts";
import { frameHistory, tasks } from "../Tasks.ts";
import { classify, isolatedTrial } from "../Trial.ts";
import * as Chromium from "./browser.ts";
import { answer, call, finish, pictures, scripted, textOf, type Turn } from "./scripted.ts";

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
    const steps: Array<Step> = [];

    const exit = yield* isolatedTrial(
      task.withModel({
        seed: 23,
        arm,
        onUsage: () => Effect.void,
        // Copied when reported, as a recording copies it.
        trace: (entry) =>
          Effect.sync(() => {
            if (entry._tag === "Step")
              steps.push({ ...entry.step, results: [...entry.step.results] });
          }),
      }),
      Chromium.layer({ frameHistory }),
    ).pipe(Effect.provide(model.layer), Effect.exit);

    return {
      exit,
      outcome: classify(exit, noCalls),
      seen: model.seen,
      steps,
      outcomeValue: Exit.isSuccess(exit) ? exit.value : undefined,
    };
  });

/**
 * The first text field the outline shows, where a tool's result quotes it too: the seed sets the
 * checkout's labels and their order.
 */
const firstField = (prompt: Prompt.Prompt) => {
  const [, label = "missing", ref = "missing"] =
    /textbox \\?"([^"\\]+)\\?" \[ref=(e\d+)\]/.exec(textOf(prompt)) ?? [];

  return { label, ref };
};

describe("arm 1, Yielded's tools alone", () => {
  it.live("observes and acts on refs, one action at a time, and shows no pictures", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 1, [
        () => [call("observe", {}), finish],
        (prompt) => [
          call("act", { action: { kind: "fill", ref: firstField(prompt).ref, value: "Ada" } }),
          finish,
        ],
        () => [call("give_up", { reason: "scripted" }), finish],
      ]);

      const [first, second, third] = result.seen;

      assert.isDefined(first);
      assert.isDefined(second);
      assert.isDefined(third);
      if (first === undefined || second === undefined || third === undefined) return;

      assert.includeMembers(names(first.tools), ["observe", "act", "inspect", "navigate"]);
      assert.notInclude(names(first.tools), "click_at");
      assert.notInclude(names(first.tools), "zoom");
      assert.sameMembers([...parameters(first.tools, "act")], ["action"]);

      // The fill's result carries the next outline, showing the typed value.
      const field = firstField(second.prompt);

      assert.notStrictEqual(field.ref, "missing");
      assert.include(textOf(third.prompt), `textbox \\"${field.label}\\"`);
      assert.include(textOf(third.prompt), "Ada");
      for (const { prompt } of result.seen) assert.strictEqual(pictures(prompt), 0);

      // Giving up is the model's wrong answer, graded, never infrastructure.
      assert.deepStrictEqual(result.outcome, { status: "graded", reason: "gave-up", pass: false });
    }),
  );
});

describe("recorded steps", () => {
  it.live("records each turn with its tools' results, which come after the turn completes", () =>
    Effect.gen(function* () {
      const { steps } = yield* trial("checkout", 5, [
        () => [call("observe", {}), finish],
        () => [call("give_up", { reason: "scripted" }), finish],
      ]);

      assert.deepStrictEqual(
        steps.map(({ step, calls, results }) => [
          step,
          calls.map(({ name }) => name),
          results.map(({ name, isFailure }) => [name, isFailure]),
        ]),
        [
          [1, ["observe"], [["observe", false]]],
          [2, ["give_up"], [["give_up", false]]],
        ],
      );
    }),
  );
});

describe("arm 2, vision first", () => {
  it.live("shows the screen before each turn, never an outline, and acts by pixels", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 2, [
        () => [
          call("click_at", { x: 200, y: 120 }),
          call("zoom", { x: 0, y: 0, width: 320, height: 200 }),
          finish,
        ],
        () => [call("done", { answer: { confirmation: "CONF-0" } }), finish],
      ]);

      const [first, second] = result.seen;

      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;

      // Only the current screen, and the crop taken since the last turn.
      assert.strictEqual(pictures(first.prompt), 1);
      assert.strictEqual(pictures(second.prompt), 2);
      for (const { prompt } of result.seen) assert.notMatch(textOf(prompt), /\[ref=e\d+\]/);

      const tools = names(first.tools);

      assert.notInclude(tools, "observe");
      assert.notInclude(tools, "act");
      assert.include(tools, "zoom");
      assert.sameMembers([...parameters(first.tools, "click_at")], ["x", "y", "double", "button"]);
      assert.sameMembers([...parameters(first.tools, "type_text")], ["text", "submit"]);
      assert.deepStrictEqual(result.outcome, { status: "graded", reason: "answered", pass: false });
      assert.strictEqual(result.outcomeValue?.actions, 3);
      assert.strictEqual(result.outcomeValue?.steps, 2);
    }),
  );
});

describe("arms 7 and 8, programs", () => {
  // A program finds the first field in an observation and fills it, and returns only what it read.
  const program = `async () => {
    const seen = await browser.observe({});
    const field = seen.controls.find((control) => control.kind === "textbox");
    const filled = await browser.act({ actions: [{ kind: "fill", ref: field.ref, value: "Ada" }] });
    return { field: field.name, dispatch: filled.dispatch, holds: filled.observation.text.includes("Ada") };
  }`;

  it.live("runs a program's browser calls on the page and shows the model what it returns", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 7, [
        () => [call("browser_program", { code: program }), finish],
        () => [call("give_up", { reason: "scripted" }), finish],
      ]);

      const [first, second] = result.seen;

      assert.isDefined(first);
      assert.isDefined(second);
      if (first === undefined || second === undefined) return;

      assert.sameMembers(names(first.tools), ["done", "give_up", "browser_program"]);
      assert.sameMembers([...parameters(first.tools, "browser_program")], ["code"]);

      // The program's result, not the outline it read, is what the model is shown.
      const shown = textOf(second.prompt);

      assert.include(shown, '"dispatch":"acknowledged"');
      assert.include(shown, '"holds":true');
      assert.notMatch(shown, /\[ref=e\d+\]/);
      for (const { prompt } of result.seen) assert.strictEqual(pictures(prompt), 1);
      assert.deepStrictEqual(
        result.steps.map(({ calls }) => calls.map(({ name }) => name)),
        [["browser_program"], ["give_up"]],
      );
    }),
  );

  it.live("offers the program beside the tools in arm 8", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 8, [
        () => [call("give_up", { reason: "scripted" }), finish],
      ]);

      const [first] = result.seen;

      assert.isDefined(first);
      if (first === undefined) return;

      assert.includeMembers(names(first.tools), ["observe", "act", "click_at", "browser_program"]);
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
