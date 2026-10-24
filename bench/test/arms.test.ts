// The paired experiment's arms, driven by scripted models over the bench's own pages in a local
// Chromium: what each arm shows the model, which tools it has, and how its outcomes classify and
// pair. No model is called.
import { assert, describe, it } from "@effect/vitest";
import { Effect, Exit } from "effect";
import { type Prompt, Tool } from "effect/ai";

import { type Arm, deviceScale, type Step } from "../Arms.ts";
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

/**
 * Run one task in one arm with a scripted model, on a browser at the arm's device scale, and
 * classify its outcome as the runner does.
 */
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
      Chromium.layer({ frameHistory, deviceScaleFactor: deviceScale(arm) }),
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
      assert.deepStrictEqual(result.outcomeValue?.tools, { click_at: 1, zoom: 1, done: 1 });
      assert.strictEqual(result.outcomeValue?.steps, 2);
    }),
  );
});

describe("arms 9 and 10, fewer pictures", () => {
  const counts = (seen: ReadonlyArray<{ readonly prompt: Prompt.Prompt }>) =>
    seen.map(({ prompt }) => pictures(prompt));

  it.live("arm 9 shows the screen after pointer input on a page its outline reads", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 9, [
        () => [call("observe", {}), finish],
        () => [call("click_at", { x: 5, y: 5 }), finish],
        () => [call("observe", {}), finish],
        () => [call("done", { answer: { confirmation: "CONF-0" } }), finish],
      ]);

      assert.deepStrictEqual(counts(result.seen), [0, 0, 1, 0]);
      assert.include(names(result.seen[0]?.tools ?? []), "look");
    }),
  );

  it.live("arm 10 shows the screen only after look", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 10, [
        () => [call("observe", {}), finish],
        () => [call("click_at", { x: 5, y: 5 }), finish],
        () => [call("look", {}), finish],
        () => [call("done", { answer: { confirmation: "CONF-0" } }), finish],
      ]);

      assert.deepStrictEqual(counts(result.seen), [0, 0, 0, 1]);
    }),
  );
});

describe("arms 11 and 12, picture sizes", () => {
  for (const [arm, size] of [
    [11, "640x360"],
    [12, "1920x1080"],
  ] as const)
    it.live(`arm ${arm} shows the 1280x720 viewport at ${size}`, () =>
      Effect.gen(function* () {
        const result = yield* trial("checkout", arm, [
          () => [call("done", { answer: { confirmation: "CONF-0" } }), finish],
        ]);

        assert.include(textOf(result.seen[0]!.prompt), `The current tab's viewport, ${size}.`);
      }),
    );
});

describe("arms 13 to 16, the outline and the picture", () => {
  const done = () => [call("done", { answer: { confirmation: "CONF-0" } }), finish];

  it.live("arm 13 gives each control's box, and arm 14 has find", () =>
    Effect.gen(function* () {
      const boxed = yield* trial("checkout", 13, [() => [call("observe", {}), finish], done]);
      const finding = yield* trial("checkout", 14, [done]);

      assert.match(textOf(boxed.seen[1]!.prompt), /\d+x\d+ at \(\d+,\d+\)/);
      assert.notInclude(names(boxed.seen[0]?.tools ?? []), "find");
      assert.include(names(finding.seen[0]?.tools ?? []), "find");
    }),
  );

  it.live("arm 16 shows a crop around a point before clicking it", () =>
    Effect.gen(function* () {
      const result = yield* trial("checkout", 16, [
        () => [call("click_at", { x: 5, y: 5 }), finish],
        () => [call("click_at", { x: 6, y: 6 }), finish],
        done,
      ]);

      assert.include(textOf(result.seen[1]!.prompt), "Not done yet");
      assert.deepStrictEqual(
        result.seen.map(({ prompt }) => pictures(prompt)),
        [1, 2, 1],
      );
      assert.include(textOf(result.seen[2]!.prompt), "Clicked");
    }),
  );
});

describe("arms 17 and 19 to 21, a chart's own tools", () => {
  it.live(
    "arm 17 reads the chart, arm 20 also changes it, and arms 19 and 21 do so in programs",
    () =>
      Effect.gen(function* () {
        const give = () => [call("give_up", { reason: "scripted" }), finish];
        const reads = yield* trial("checkout", 17, [give]);
        const changes = yield* trial("checkout", 20, [give]);
        const draw = `async () => await chart.draw({ shape: "horizontal_line", points: [{ time: 1, price: 1 }] })`;

        const programs = (arm: Arm) =>
          trial("checkout", arm, [
            () => [call("chart_program", { code: "async () => await chart.state({})" }), finish],
            () => [call("chart_program", { code: draw }), finish],
            give,
          ]);

        const reading = yield* programs(19);
        const changing = yield* programs(21);

        assert.includeMembers(names(reads.seen[0]?.tools ?? []), ["chart_bars", "chart_point"]);
        assert.notInclude(names(reads.seen[0]?.tools ?? []), "chart_draw");
        assert.includeMembers(names(changes.seen[0]?.tools ?? []), [
          "chart_point",
          "chart_draw",
          "chart_inputs",
        ]);

        for (const program of [reading, changing]) {
          assert.includeMembers(names(program.seen[0]?.tools ?? []), ["click_at", "chart_program"]);
          assert.notInclude(names(program.seen[0]?.tools ?? []), "chart_bars");
          // The checkout has no chart, and the program's call says so.
          assert.include(textOf(program.seen[1]!.prompt), "TradingView chart was not found");
        }

        // Only arm 21's programs can change the chart: arm 19's have no chart.draw to call.
        const second = (program: typeof reading) =>
          textOf(program.seen[2]!.prompt).slice(textOf(program.seen[1]!.prompt).length);

        assert.include(second(reading), "chart.draw is not a function");
        assert.include(second(changing), "TradingView chart was not found");
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

  it.live("returns the pointer tools' receipts to a program, without their absent options", () =>
    Effect.gen(function* () {
      // Each call leaves an option out: a program's results cross a JSON boundary, which an
      // undefined field cannot.
      const pointing = `async () => {
        const clicked = await browser.click_at({ x: 5, y: 5 });
        // Before a field has focus and its caret blinks.
        const still = await browser.wait_still({ seconds: 5 });
        const typed = await browser.type_text({ text: "A" });
        const pressed = await browser.press_keys({ keys: "Tab" });
        return [clicked, still, typed, pressed].map((receipt) => receipt.did);
      }`;

      const result = yield* trial("checkout", 7, [
        () => [call("browser_program", { code: pointing }), finish],
        () => [call("give_up", { reason: "scripted" }), finish],
      ]);

      const [, second] = result.seen;

      assert.isDefined(second);
      if (second === undefined) return;
      const shown = textOf(second.prompt);

      assert.notInclude(shown, "outside JSON");
      for (const did of ["Clicked", "Typed", "Pressed Tab.", "The screen is still."])
        assert.include(shown, did);
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
