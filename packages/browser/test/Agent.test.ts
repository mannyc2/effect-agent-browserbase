// The agent, driven by scripted models: no model is called.
import { assert, expectTypeOf, layer } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Schema, Stream, Tracer } from "effect";
import { AiError, LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput";
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput";

import * as Agent from "../src/Agent.ts";
import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Failed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import type { Page } from "../src/Page.ts";
import * as Tools from "../src/Tools.ts";
import { Site, SiteLayer } from "./fixtures.ts";

type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;

class Spent extends Schema.TaggedError<Spent>()("Spent", {}) {}

class Ledger extends Context.Service<
  Ledger,
  { readonly record: (step: number) => Effect.Effect<void> }
>()("test/Ledger") {}

/** A model that answers each call with the next turn, and keeps the prompts and tools it was given. */
const scripted = (turns: ReadonlyArray<Turn>) => {
  const prompts: Array<Prompt.Prompt> = [];
  const offered: Array<ReadonlyArray<Tool.Any>> = [];
  let index = 0;

  const model = LanguageModel.make({
    generateText: (options) =>
      Effect.suspend(() => {
        const turn = turns[index];

        index += 1;
        prompts.push(options.prompt);
        offered.push(options.tools);

        return turn === undefined
          ? Effect.die(`no turn ${index} in the script`)
          : Effect.succeed([...turn(options.prompt)]);
      }),
    streamText: () => Stream.empty,
  });

  return { layer: Layer.effect(LanguageModel.LanguageModel, model), prompts, offered };
};

/** A model that answers each call with the next reply, failures included. */
const replies = (
  outcomes: ReadonlyArray<Effect.Effect<Array<Response.PartEncoded>, AiError.AiError>>,
) => {
  const prompts: Array<Prompt.Prompt> = [];

  const model = LanguageModel.make({
    generateText: (options) =>
      Effect.suspend(() => {
        prompts.push(options.prompt);

        return outcomes[prompts.length - 1] ?? Effect.die(`no reply ${prompts.length}`);
      }),
    streamText: () => Stream.empty,
  });

  return { model, prompts };
};

let calls = 0;

const call = (name: string, params: unknown): Response.PartEncoded => {
  calls += 1;

  return { type: "tool-call", id: `call-${calls}`, name, params };
};

const finish: Response.PartEncoded = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 100, cacheRead: 40 }, outputTokens: { total: 10 } },
};

/** All the text in a prompt, including tool results, newest last. */
const textOf = (prompt: Prompt.Prompt): string =>
  prompt.content
    .flatMap((message) =>
      message.role === "system"
        ? [message.content]
        : message.content.flatMap((part) =>
            part.type === "text"
              ? [part.text]
              : part.type === "tool-result"
                ? [String(part.result)]
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

const resultsIn = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result");

const valueOf = (page: Page, selector: string) =>
  Effect.promise(() => page.playwright.locator(selector).inputValue());

/** The default observation, counting each look. */
const counting = (observe: Agent.Observe = Agent.observe()) => {
  let looks = 0;

  return {
    observe: (page: Page) =>
      Effect.suspend(() => {
        looks += 1;

        return observe(page);
      }),
    looks: () => looks,
  };
};

/** An observation that fails on its `nth` look, as a page the agent cannot see would. */
const failingOn = (nth: number) =>
  counting((page) =>
    Effect.suspend(() => {
      nth -= 1;

      return nth === 0
        ? Effect.fail(
            new BrowserError({
              operation: "observe",
              reason: new Failed({ detail: "fixture observation failed" }),
              dispatched: false,
            }),
          )
        : Agent.observe()(page);
    }),
  );

/** The newest ref for this role and name in the prompt. */
const refIn = (prompt: Prompt.Prompt, role: string, name: string): string => {
  const refs = [
    ...textOf(prompt).matchAll(new RegExp(`${role} "${name}"[^\\n]*?\\[ref=(e\\d+)\\]`, "g")),
  ];

  const ref = refs.at(-1)?.[1];

  assert.isDefined(ref, `no ${role} "${name}" in the prompt`);

  return ref ?? "";
};

const start = (path: string) =>
  Effect.gen(function* () {
    const page = yield* (yield* Browser).firstPage;

    yield* page.goto((yield* Site).url(path));

    return page;
  });

const read = (page: Page, selector: string) =>
  Effect.promise(() =>
    page.playwright.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector),
  );

const isReceipt = Schema.is(Tools.Receipt);

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Agent", (it) => {
  it.effect("runs a batch in order, observing after every turn but the one that ends the run", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const looks = counting();

      const model = scripted([
        (prompt) => [
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "25" }),
          call("browser_click", { ref: refIn(prompt, "button", "Submit") }),
          finish,
        ],
        () => [call("done", { answer: "Ordered 25 btc" }), finish],
      ]);

      const steps: Array<Agent.Step> = [];

      const result = yield* Agent.run("Submit the order and report the outcome.", {
        page,
        observe: looks.observe,
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(Effect.provide(model.layer));

      assert.strictEqual(result.answer, "Ordered 25 btc");
      assert.strictEqual(result.steps, 2);
      assert.deepStrictEqual(result.usage, {
        inputTokens: 200,
        outputTokens: 20,
        cachedInputTokens: 80,
      });
      assert.strictEqual(yield* read(page, "#outcome"), "Ordered 25 btc");

      // Each call answers with a receipt, whose action carries the model's call id.
      const [typed, clicked] = steps[0]?.results.map(({ result }) => result) ?? [];

      assert.isTrue(isReceipt(typed) && typed.did.includes('Typed "25"'));
      assert.isTrue(
        isReceipt(clicked) &&
          /^Clicked .*"Submit" at \(\d+, \d+\)\.$/.test(clicked.did) &&
          clicked.action?.correlation !== undefined &&
          textOf(result.history).includes(clicked.did),
      );
      assert.include(textOf(model.prompts[1]!), "text: Ordered 25 btc");
      // The turn that answered was not observed: no picture and no look follow it.
      assert.deepStrictEqual(model.prompts.map(pictures), [1, 2]);
      assert.strictEqual(pictures(result.history), 2);
      assert.strictEqual(looks.looks(), 2);
      assert.deepStrictEqual(
        resultsIn(result.history).map((part) => part.name),
        ["browser_type", "browser_click", "done"],
      );
    }),
  );

  it.effect("reads a null parameter as absent and clicks a point given with a ref", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const submit = yield* Effect.promise(() => page.playwright.locator("#submit").boundingBox());

      if (submit === null) return yield* Effect.die("the Submit button has no box");

      // As a model did on a hosted canvas: nulls for what it leaves out, and a point on the
      // control it means alongside a ref it does not.
      const model = scripted([
        (prompt) => [
          call("browser_type", {
            ref: refIn(prompt, "textbox", "Amount"),
            text: "25",
            append: null,
            submit: null,
          }),
          call("browser_click", {
            ref: refIn(prompt, "textbox", "Amount"),
            x: Math.round(submit.x + submit.width / 2),
            y: Math.round(submit.y + submit.height / 2),
            double: null,
            button: null,
          }),
          finish,
        ],
        (prompt) => {
          assert.isTrue(resultsIn(prompt).every((part) => part.isFailure === false));

          return [call("done", { answer: "done" }), finish];
        },
      ]);

      yield* Agent.run("Submit the order.", { page }).pipe(Effect.provide(model.layer));

      assert.strictEqual(yield* read(page, "#outcome"), "Ordered 25 btc");
    }),
  );

  it.effect("halts on failure and answers every remaining call without executing it", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      yield* Effect.promise(() => page.playwright.locator("#amount").focus());

      const model = scripted([
        () => [
          call("browser_click", { ref: "e99999" }),
          call("browser_type", { text: "99" }),
          call("done", { answer: "should not finish" }),
          finish,
        ],
        (prompt) => {
          const results = resultsIn(prompt);

          assert.deepStrictEqual(
            results.map((part) => part.isFailure),
            [true, true, true],
          );
          assert.match(JSON.stringify(results[1]?.result), /not executed/i);
          assert.match(JSON.stringify(results[2]?.result), /not executed/i);

          return [call("done", { answer: "recovered" }), finish];
        },
      ]);

      const result = yield* Agent.run("Try the action.", { page }).pipe(
        Effect.provide(model.layer),
      );

      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
      assert.strictEqual(result.answer, "recovered");
      assert.strictEqual(result.steps, 2);
      assert.strictEqual(resultsIn(result.history).length, 4);
    }),
  );

  it.effect("ends a batch at done without executing later calls", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      const model = scripted([
        (prompt) => [
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "20" }),
          call("done", { answer: "finished" }),
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "99" }),
          finish,
        ],
      ]);

      const result = yield* Agent.run("Set the amount.", { page }).pipe(
        Effect.provide(model.layer),
      );

      const results = resultsIn(result.history);

      assert.strictEqual(result.answer, "finished");
      assert.strictEqual(yield* valueOf(page, "#amount"), "20");
      assert.deepStrictEqual(
        results.map((part) => part.isFailure),
        [false, false, true],
      );
      assert.match(JSON.stringify(results[2]?.result), /not executed/i);
      assert.strictEqual(pictures(result.history), 1);
    }),
  );

  it.effect("gives up at give_up, keeping the run's usage and conversation in its error", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const looks = counting();

      const model = scripted([
        (prompt) => [
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "20" }),
          call("give_up", { reason: "cannot finish the order" }),
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "99" }),
          finish,
        ],
      ]);

      const steps: Array<Agent.Step> = [];

      const failure = yield* Agent.run("Finish the order.", {
        page,
        observe: looks.observe,
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(Effect.provide(model.layer), Effect.flip);

      assert.instanceOf(failure, Agent.AgentError);
      if (!Schema.is(Agent.AgentError)(failure)) return;
      assert.strictEqual(failure.message, "the agent gave up: cannot finish the order");
      assert.strictEqual(yield* valueOf(page, "#amount"), "20");
      assert.deepStrictEqual(
        steps[0]?.results.map((result) => result.isFailure),
        [false, false, true],
      );
      assert.match(JSON.stringify(steps[0]?.results[2]?.result), /not executed/i);
      assert.strictEqual(looks.looks(), 1);
      // The failed run is the one worth reading: it keeps what it spent and said.
      assert.deepStrictEqual(failure.usage, {
        inputTokens: 100,
        outputTokens: 10,
        cachedInputTokens: 40,
      });
      assert.include(textOf(failure.history), "Finish the order.");
      assert.deepStrictEqual(
        resultsIn(failure.history).map((part) => part.name),
        ["browser_type", "give_up", "browser_type"],
      );
    }),
  );

  it.effect(
    "asks again after unreadable arguments, but ends on a provider's unreadable reply",
    () =>
      Effect.gen(function* () {
        const page = yield* start("/next");

        // The failures an adapter raises: its parse of a call's arguments, which is model output,
        // and its client's decoding of the service's reply, which is not.
        const unparsable = AiError.make({
          module: "OpenRouterLanguageModel",
          method: "makeResponse",
          reason: new AiError.ToolParameterValidationError({
            toolName: "browser_snapshot",
            description: "Failed to securely JSON parse tool parameters: SyntaxError",
          }),
        });

        const undecodable = AiError.make({
          module: "OpenRouterClient",
          method: "createChatCompletion",
          reason: new AiError.InvalidOutputError({ description: "Expected a chat completion" }),
        });

        const corrected = replies([
          Effect.fail(unparsable),
          Effect.succeed([call("done", { answer: "read" }), finish]),
        ]);

        const result = yield* Agent.run("Read the page.", { page }).pipe(
          Effect.provideServiceEffect(LanguageModel.LanguageModel, corrected.model),
        );

        assert.strictEqual(result.answer, "read");
        assert.include(
          textOf(corrected.prompts[1] ?? Prompt.empty),
          "Your call to browser_snapshot could not be read",
        );

        const ended = replies([Effect.fail(undecodable)]);

        const failure = yield* Agent.run("Read the page.", { page }).pipe(
          Effect.provideServiceEffect(LanguageModel.LanguageModel, ended.model),
          Effect.flip,
        );

        assert.strictEqual(failure, undecodable);
        assert.strictEqual(ended.prompts.length, 1);
      }),
  );

  it.effect("asks again after a call to an unknown tool, without running any call", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const looks = counting();

      yield* Effect.promise(() => page.playwright.locator("#amount").focus());
      yield* Effect.promise(() => page.playwright.locator("#amount").press("End"));

      const model = scripted([
        () => [
          call("browser_type", { text: "5", append: true }),
          call("browser_screenshot", {}),
          finish,
        ],
        (prompt) => {
          const correction = textOf(prompt).split("\n").slice(-2).join("\n");

          assert.include(correction, "none of its tool calls ran");
          assert.include(correction, "browser_click, ");
          assert.strictEqual(resultsIn(prompt).length, 0);
          assert.isFalse(
            prompt.content.some(
              (message) =>
                message.role === "assistant" &&
                message.content.some((part) => part.type === "tool-call"),
            ),
          );

          return [call("done", { answer: "unchanged" }), finish];
        },
      ]);

      const steps: Array<Agent.Step> = [];

      const result = yield* Agent.run("Append a digit.", {
        page,
        observe: looks.observe,
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(Effect.provide(model.layer));

      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
      assert.strictEqual(result.answer, "unchanged");
      assert.strictEqual(result.steps, 2);
      assert.isString(steps[0]?.rejected);
      assert.deepStrictEqual(steps[0]?.calls, []);
      assert.isUndefined(steps[1]?.rejected);
      assert.strictEqual(looks.looks(), 2);

      const limited = yield* Agent.run("Append a digit.", { page, maxSteps: 1 }).pipe(
        Effect.provide(scripted([() => [call("browser_screenshot", {}), finish]]).layer),
        Effect.flip,
      );

      assert.strictEqual(
        limited._tag === "AgentError" ? limited.reason._tag : limited._tag,
        "StepLimit",
      );
    }),
  );

  it.effect("returns a malformed done to the model for correction", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      const model = scripted([
        (prompt) => [
          call("done", { answer: { amount: "twenty" } }),
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "99" }),
          finish,
        ],
        (prompt) => {
          const results = resultsIn(prompt);

          assert.isTrue(results[0]?.isFailure);
          assert.match(JSON.stringify(results[0]?.result), /amount|number/i);
          assert.match(JSON.stringify(results[1]?.result), /not executed/i);

          return [call("done", { answer: { amount: 10 } }), finish];
        },
      ]);

      const result = yield* Agent.run("Read the amount.", {
        page,
        answer: Schema.Struct({ amount: Schema.Finite }),
      }).pipe(Effect.provide(model.layer));

      assert.deepStrictEqual(result.answer, { amount: 10 });
      assert.strictEqual(result.steps, 2);
      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
    }),
  );

  it.effect("does not execute calls from a turn truncated for length", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const looks = counting();

      const model = scripted([
        (prompt) => [
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "99" }),
          call("done", { answer: "incomplete" }),
          { ...finish, reason: "length" },
        ],
        (prompt) => {
          const results = resultsIn(prompt);

          assert.deepStrictEqual(
            results.map((part) => part.isFailure),
            [true, true],
          );
          assert.isTrue(results.every((part) => /length/i.test(JSON.stringify(part.result))));

          return [call("done", { answer: "retried" }), finish];
        },
      ]);

      const result = yield* Agent.run("Read the amount.", { page, observe: looks.observe }).pipe(
        Effect.provide(model.layer),
      );

      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
      assert.strictEqual(result.answer, "retried");
      assert.strictEqual(looks.looks(), 2);
    }),
  );

  for (const mode of ["outline", "screenshot", "both"] as const) {
    it.effect(`observes only the requested ${mode} content`, () =>
      Effect.gen(function* () {
        const page = yield* start("/form");

        const model = scripted([
          () => [call("browser_wait", { seconds: 0 }), finish],
          () => [call("done", { answer: "seen" }), finish],
        ]);

        const result = yield* Agent.run("Look at the page.", {
          page,
          observe: Agent.observe(mode),
        }).pipe(Effect.provide(model.layer));

        assert.deepStrictEqual(model.prompts.map(pictures), mode === "outline" ? [0, 0] : [1, 2]);
        assert.strictEqual(
          textOf(result.history).includes('heading "Place an order"'),
          mode !== "screenshot",
        );
      }),
    );
  }

  it.effect("replaces what the model sees, its system prompt, and its tools", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      let looked = 0;

      // A preparation agent's tools: the browser's renamed, without zoom or select, and one more.
      const Note = Tool.make("prep_note", {
        parameters: Schema.Struct({ note: Schema.String }),
        success: Schema.String,
      });

      const notes: Array<string> = [];

      const prep = <T extends Tool.Any, const Name extends string>(tool: T, name: Name) =>
        Tool.make(name, {
          description: tool.description,
          parameters: tool.parametersSchema as T["parametersSchema"],
          success: tool.successSchema as T["successSchema"],
          failure: tool.failureSchema as T["failureSchema"],
          failureMode: "return",
        });

      const Prep = Toolkit.make(
        prep(Tools.PageToolkit.tools.browser_type, "prep_type"),
        prep(Tools.PageToolkit.tools.browser_snapshot, "prep_snapshot"),
        Note,
      );

      // The model sees no outline here, so it knows the field's ref from elsewhere.
      const outline = Prompt.make([{ role: "user", content: (yield* page.snapshot()).rendered }]);

      const model = scripted([
        () => [
          call("prep_note", { note: "the amount field" }),
          call("prep_type", { ref: refIn(outline, "textbox", "Amount"), text: "42" }),
          finish,
        ],
        () => [call("done", { answer: "noted" }), finish],
      ]);

      const result = yield* Agent.run("Prepare the order.", {
        page,
        system: (standard) => `${standard}\n\nYou prepare orders for a person to check.`,
        observe: (seen) =>
          Effect.map(seen.text(), ({ text }) => {
            looked += 1;

            return [Prompt.makePart("text", { text: `What the page says: ${text}` })];
          }),
        tools: (defaults) => ({
          toolkit: Prep,
          handlers: Prep.of({
            prep_type: defaults.handlers.browser_type,
            prep_snapshot: defaults.handlers.browser_snapshot,
            prep_note: ({ note }) => Effect.sync(() => notes.push(note)).pipe(Effect.as("Noted.")),
          }),
        }),
      }).pipe(Effect.provide(model.layer));

      const [opening] = model.prompts;
      const [offered] = model.offered;

      assert.strictEqual(result.answer, "noted");
      assert.strictEqual(yield* valueOf(page, "#amount"), "42");
      assert.deepStrictEqual(notes, ["the amount field"]);
      assert.include(textOf(opening!), "You prepare orders for a person to check.");
      assert.include(textOf(opening!), "What the page says:");
      assert.strictEqual(pictures(result.history), 0);
      assert.strictEqual(looked, 2);
      assert.sameMembers(
        (offered ?? []).map((tool) => tool.name),
        ["prep_type", "prep_snapshot", "prep_note", "done", "give_up"],
      );
    }),
  );

  it.effect("keeps a performed action when its following observation fails", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const looks = failingOn(2);

      yield* Effect.promise(() => page.playwright.locator("#amount").press("End"));

      const model = scripted([
        () => [call("browser_type", { text: "1", append: true }), finish],
        (prompt) => {
          const results = resultsIn(prompt);

          assert.strictEqual(results.length, 1);
          assert.isFalse(results[0]?.isFailure);
          assert.include(String(results[0]?.result), 'Typed "1"');
          assert.include(
            textOf(prompt),
            "could not be observed: observe failed: fixture observation failed",
          );

          return [call("done", { answer: "typed once" }), finish];
        },
      ]);

      const result = yield* Agent.run("Append one digit.", {
        page,
        observe: looks.observe,
      }).pipe(Effect.provide(model.layer));

      assert.strictEqual(yield* valueOf(page, "#amount"), "101");
      assert.strictEqual(result.answer, "typed once");
      assert.strictEqual(result.steps, 2);
      assert.strictEqual(looks.looks(), 2);
    }),
  );

  it.effect("ends the run with the browser's error once no page can be had", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      assert.isNotNull(native);
      if (native === null) return;
      const context = yield* Effect.promise(() => native.newContext());
      const browser = yield* makeBrowser(context, { id: "closing", provider: "test" });

      yield* (yield* browser.firstPage).goto((yield* Site).url("/next"));

      const Closing = Toolkit.make(
        Tool.make("close_browser", { parameters: Schema.Struct({}), success: Schema.String }),
      );

      const model = scripted([() => [call("close_browser", {}), finish]]);
      const reported: Array<number> = [];

      const failure = yield* Agent.run("Close the browser.", {
        browser,
        tools: (defaults) => ({
          toolkit: Toolkit.merge(defaults.toolkit, Closing),
          handlers: {
            ...defaults.handlers,
            close_browser: () => Effect.promise(() => context.close()).pipe(Effect.as("Closed.")),
          },
        }),
        onStep: (step) => Effect.sync(() => reported.push(step.usage.inputTokens)),
      }).pipe(Effect.provide(model.layer), Effect.flip);

      assert.strictEqual(failure._tag, "BrowserError");
      assert.strictEqual(model.prompts.length, 1);
      // The paid turn is still reported before the run ends.
      assert.deepStrictEqual(reported, [100]);

      const unused = scripted([]);

      const again = yield* Agent.run("Look again.", { browser }).pipe(
        Effect.provide(unused.layer),
        Effect.flip,
      );

      assert.strictEqual(again._tag, "BrowserError");
      assert.strictEqual(unused.prompts.length, 0);
    }),
  );

  it.effect("ends the run once its pinned page is gone, and keeps an answer given as it went", () =>
    Effect.gen(function* () {
      const browser = yield* Browser;
      const page = yield* browser.newPage("data:text/html,<title>Task</title>The answer is 42");

      // The model answers while the tab closes.
      const answered = replies([
        page.close.pipe(Effect.orDie, Effect.as([call("done", { answer: "42" }), finish])),
      ]);

      const result = yield* Agent.run("Read the answer.", { page }).pipe(
        Effect.provideServiceEffect(LanguageModel.LanguageModel, answered.model),
      );

      assert.strictEqual(result.answer, "42");

      const closing = yield* browser.newPage("data:text/html,<title>Task</title>Wait");

      const waited = replies([
        closing.close.pipe(Effect.orDie, Effect.as([call("browser_wait", { seconds: 0 }), finish])),
      ]);

      const failure = yield* Agent.run("Wait.", { page: closing }).pipe(
        Effect.provideServiceEffect(LanguageModel.LanguageModel, waited.model),
        Effect.flip,
      );

      assert.strictEqual(failure._tag, "BrowserError");
      assert.strictEqual(waited.prompts.length, 1);
    }),
  );

  it.effect("keeps done the agent's own even when a caller's tool takes its name", () =>
    Effect.gen(function* () {
      const page = yield* start("/next");
      let replaced = 0;

      const Clashing = Toolkit.make(
        Tool.make("done", {
          parameters: Schema.Struct({ answer: Schema.String }),
          success: Schema.String,
        }),
      );

      const model = scripted([() => [call("done", { answer: "finished" }), finish]]);

      const result = yield* Agent.run("Finish.", {
        page,
        // @ts-expect-error -- `done` ends the run, so a caller's tool cannot take its name
        tools: () => ({
          toolkit: Clashing,
          handlers: {
            done: () =>
              Effect.sync(() => {
                replaced += 1;

                return "replaced";
              }),
          },
        }),
      }).pipe(Effect.provide(model.layer));

      assert.strictEqual(result.answer, "finished");
      assert.strictEqual(replaced, 0);
    }),
  );

  for (const failureMode of ["return", "error"] as const) {
    it.effect("halts on a caller's tool with failure mode " + failureMode, () =>
      Effect.gen(function* () {
        const page = yield* start("/form");

        const Additional = Toolkit.make(
          Tool.make("fixture_failure", {
            parameters: Schema.Struct({}),
            success: Schema.String,
            failure: Schema.String,
            failureMode,
          }),
        );

        const model = scripted([
          (prompt) => [
            call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "20" }),
            call("fixture_failure", {}),
            call("browser_type", { text: "99" }),
            call("done", { answer: "should not finish" }),
            finish,
          ],
          (prompt) => {
            const results = resultsIn(prompt);

            assert.deepStrictEqual(
              results.map((part) => part.isFailure),
              [false, true, true, true],
            );
            assert.include(String(results[0]?.result), 'Typed "20"');
            assert.include(JSON.stringify(results[1]?.result), "fixture denied");
            assert.match(JSON.stringify(results[2]?.result), /not executed/i);
            assert.match(JSON.stringify(results[3]?.result), /not executed/i);

            return [call("done", { answer: "recovered" }), finish];
          },
        ]);

        const result = yield* Agent.run("Use the extra tool.", {
          page,
          tools: (defaults) => ({
            toolkit: Toolkit.merge(defaults.toolkit, Additional),
            handlers: {
              ...defaults.handlers,
              fixture_failure: () => Effect.fail("fixture denied"),
            },
          }),
        }).pipe(Effect.provide(model.layer));

        assert.strictEqual(yield* valueOf(page, "#amount"), "20");
        assert.strictEqual(result.answer, "recovered");
        assert.strictEqual(result.steps, 2);
        assert.strictEqual(resultsIn(result.history).length, 5);
      }),
    );
  }

  it.effect("observes turns without calls before stopping an idle model", () =>
    Effect.gen(function* () {
      const page = yield* start("/next");
      const looks = counting();

      const idle = () => [
        { type: "text" as const, text: "Still thinking." },
        { ...finish, reason: "stop" as const },
      ];

      const model = scripted([idle, idle, idle]);

      const failure = yield* Agent.run("Continue.", { page, observe: looks.observe }).pipe(
        Effect.provide(model.layer),
        Effect.flip,
      );

      assert.instanceOf(failure, Agent.AgentError);
      assert.include(failure.message, "stopped calling tools");
      assert.strictEqual(model.prompts.length, 3);
      assert.strictEqual(looks.looks(), 4);
    }),
  );

  it.effect("offers every tool with an object schema under each provider's codec", () =>
    Effect.gen(function* () {
      yield* start("/next");
      const model = scripted([() => [call("done", { answer: { credits: 1 } }), finish]]);

      yield* Agent.run("Count the credits.", {
        browser: yield* Browser,
        answer: Schema.Struct({ credits: Schema.Finite }),
      }).pipe(Effect.provide(model.layer));

      const offered = model.offered[0] ?? [];

      assert.sameMembers(
        offered.map((tool) => tool.name),
        [...Object.keys(Tools.BrowserToolkit.tools), "done", "give_up"],
      );
      // A root without `type: "object"` fails the whole request on OpenAI's structured outputs.
      for (const tool of offered)
        for (const transformer of [
          toCodecOpenAI,
          toCodecAnthropic,
          LanguageModel.defaultCodecTransformer,
        ])
          assert.strictEqual(Tool.getJsonSchema(tool, { transformer }).type, "object", tool.name);
    }),
  );

  it.effect("returns an answer in the shape it was asked for", () =>
    Effect.gen(function* () {
      const page = yield* start("/chart");

      const model = scripted([
        () => [call("done", { answer: { price: 64210, trend: "up" } }), finish],
      ]);

      const result = yield* Agent.run("Read the chart.", {
        page,
        answer: Schema.Struct({ price: Schema.Finite, trend: Schema.Literals(["up", "down"]) }),
      }).pipe(Effect.provide(model.layer));

      assert.deepStrictEqual(result.answer, { price: 64210, trend: "up" });
      assert.include(textOf(model.prompts[0]!), 'heading "BTC/USD, 1 hour"');
    }),
  );

  it.effect("keeps only the latest pictures in the conversation", () =>
    Effect.gen(function* () {
      const page = yield* start("/slots");
      const look = () => [call("browser_wait", { seconds: 0 }), finish];

      const model = scripted([
        look,
        look,
        look,
        look,
        () => [call("done", { answer: "seen" }), finish],
      ]);

      const result = yield* Agent.run("Look at the game.", { page, keepPictures: 1 }).pipe(
        Effect.provide(model.layer),
      );

      assert.strictEqual(pictures(model.prompts[0]!), 1);
      assert.isTrue(model.prompts.every((prompt) => pictures(prompt) <= 3));
      assert.include(textOf(result.history), "(an earlier screenshot was removed)");
      assert.isAtLeast(pictures(result.history), 1);
      assert.isAtMost(pictures(result.history), 3);
      assert.strictEqual(resultsIn(result.history).length, 5);
    }),
  );

  it.effect("fails at the step limit, with what the run spent", () =>
    Effect.gen(function* () {
      const page = yield* start("/next");

      const limited = yield* Agent.run("Wait.", { page, maxSteps: 2 }).pipe(
        Effect.provide(
          scripted([
            () => [call("browser_wait", { seconds: 0 }), finish],
            () => [call("browser_wait", { seconds: 0 }), finish],
          ]).layer,
        ),
        Effect.flip,
      );

      assert.instanceOf(limited, Agent.AgentError);
      if (!Schema.is(Agent.AgentError)(limited)) return;
      assert.strictEqual(limited.reason._tag, "StepLimit");
      assert.strictEqual(limited.steps, 2);
      assert.strictEqual(limited.usage.inputTokens, 200);
      assert.strictEqual(resultsIn(limited.history).length, 2);
    }),
  );

  it.effect("requires the services onStep uses", () =>
    Effect.gen(function* () {
      const page = yield* start("/next");
      const recorded: Array<number> = [];
      const model = scripted([() => [call("done", { answer: "seen" }), finish]]);

      const program = Agent.run("Answer.", {
        page,
        onStep: (step) =>
          Effect.gen(function* () {
            yield* (yield* Ledger).record(step.step);
          }),
      });

      expectTypeOf<Effect.Services<typeof program>>().toEqualTypeOf<
        LanguageModel.LanguageModel | Ledger
      >();
      expectTypeOf<Effect.Error<typeof program>>().toEqualTypeOf<
        Agent.AgentError | AiError.AiError | BrowserError
      >();

      const result = yield* program.pipe(
        Effect.provide(model.layer),
        Effect.provideService(
          Ledger,
          Ledger.of({ record: (step) => Effect.sync(() => recorded.push(step)) }),
        ),
      );

      assert.strictEqual(result.answer, "seen");
      assert.deepStrictEqual(recorded, [1]);
    }),
  );

  it.effect("stops with the error onStep fails with, before calling the model again", () =>
    Effect.gen(function* () {
      const page = yield* start("/next");
      const wait = () => [call("browser_wait", { seconds: 0 }), finish];
      const model = scripted([wait, wait, wait]);

      const stopped = yield* Agent.run("Wait.", {
        page,
        onStep: (step) => (step.step === 2 ? Effect.fail(new Spent()) : Effect.void),
      }).pipe(Effect.provide(model.layer), Effect.flip);

      assert.strictEqual(stopped._tag, "Spent");
      assert.strictEqual(model.prompts.length, 2);
    }),
  );

  for (const mode of ["both", "outline"] as const) {
    it.effect(`shows the crops a turn took once, after it, observing ${mode}`, () =>
      Effect.gen(function* () {
        const page = yield* start("/chart");

        const zooms = (count: number) => [
          ...Array.from({ length: count }, (_, index) =>
            call("browser_zoom", { x: index * 10, y: 0, width: 100, height: 60 }),
          ),
          finish,
        ];

        const lastObservation = (prompt: Prompt.Prompt) => {
          const observation = prompt.content.filter((message) => message.role === "user").at(-1);

          return {
            pictures: observation?.content.filter((part) => part.type === "file").length,
            text:
              observation?.content
                .flatMap((part) => (part.type === "text" ? [part.text] : []))
                .join("\n") ?? "",
          };
        };

        const model = scripted([
          (prompt) => {
            // Crops are not magnified, and the model must not be told they are.
            assert.notInclude(textOf(prompt), "full resolution");
            assert.include(textOf(prompt), "the viewport's own CSS pixel scale");

            return zooms(9);
          },
          (prompt) => {
            const { pictures: shown, text } = lastObservation(prompt);

            // At most eight follow a batch; the model is told of the rest.
            assert.strictEqual(shown, mode === "both" ? 9 : 8);
            assert.strictEqual(resultsIn(prompt).length, 9);
            for (let index = 0; index < 8; index++)
              assert.include(text, "viewport origin (" + index * 10 + ", 0)");
            assert.include(text, "Add this origin to image coordinates");
            assert.include(text, "1 more crops are not shown");

            return [call("browser_wait", { seconds: 0 }), finish];
          },
          (prompt) => {
            const { pictures: shown, text } = lastObservation(prompt);

            assert.strictEqual(shown, mode === "both" ? 1 : 0);
            assert.notInclude(text, "Captured when browser_zoom ran");

            return [call("done", { answer: "seen" }), finish];
          },
        ]);

        const result = yield* Agent.run("Inspect small details.", {
          page,
          keepPictures: 1,
          observe: Agent.observe(mode),
        }).pipe(Effect.provide(model.layer));

        assert.strictEqual(result.answer, "seen");
        assert.strictEqual(
          textOf(result.history).split("Captured when browser_zoom ran").length - 1,
          8,
        );
      }),
    );
  }

  it.effect("shows the crops a turn took even when its observation fails", () =>
    Effect.gen(function* () {
      const page = yield* start("/chart");
      const looks = failingOn(2);

      const model = scripted([
        () => [call("browser_zoom", { x: 10, y: 20, width: 100, height: 60 }), finish],
        (prompt) => {
          assert.strictEqual(pictures(prompt), 2);
          assert.include(textOf(prompt), "could not be observed");
          assert.include(textOf(prompt), "viewport origin (10, 20)");
          assert.isFalse(resultsIn(prompt)[0]?.isFailure);

          return [call("done", { answer: "seen" }), finish];
        },
      ]);

      const result = yield* Agent.run("Inspect a detail.", { page, observe: looks.observe }).pipe(
        Effect.provide(model.layer),
      );

      assert.strictEqual(result.answer, "seen");
      assert.strictEqual(looks.looks(), 2);
    }),
  );

  it.effect("runs a caller's own turn in order and halts it at the first failure", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const tools = yield* Tools.make({ page });

      yield* Effect.promise(() => page.playwright.locator("#amount").focus());
      yield* Effect.promise(() => page.playwright.locator("#amount").press("End"));

      const model = scripted([
        () => [
          call("browser_type", { text: "2", append: true }),
          call("browser_wait", { seconds: 0.5 }),
          call("browser_click", { ref: "e99999" }),
          call("browser_type", { text: "9", append: true }),
          finish,
        ],
      ]);

      const response = yield* LanguageModel.generateText({
        prompt: "Append to the amount.",
        ...(yield* tools.batch),
      }).pipe(Effect.provide(model.layer));

      assert.deepStrictEqual(
        response.toolResults.map((result) => [result.name, result.isFailure]),
        [
          ["browser_type", false],
          ["browser_wait", false],
          ["browser_click", true],
          ["browser_type", true],
        ],
      );
      assert.match(JSON.stringify(response.toolResults[3]?.result), /not executed/i);
      assert.strictEqual(yield* valueOf(page, "#amount"), "102");
    }),
  );

  it.effect("reports failure-mode error calls honestly, with their failures encoded", () =>
    Effect.gen(function* () {
      let charged = 0;

      const Payments = Toolkit.make(
        Tool.make("charge", {
          parameters: Schema.Struct({ cents: Schema.Finite }),
          success: Schema.String,
          failure: Schema.Struct({ code: Schema.Finite, detail: Schema.String }),
          failureMode: "error",
        }),
      );

      const toolkit = yield* Payments.pipe(
        Effect.provide(
          Payments.toLayer({
            charge: () =>
              Effect.suspend(() => {
                charged += 1;

                return Effect.fail({ code: 402, detail: "card declined" });
              }),
          }),
        ),
      );

      const model = scripted([
        () => [call("charge", { cents: "a lot" }), call("charge", { cents: 500 }), finish],
        () => [call("charge", { cents: 500 }), finish],
      ]);

      const turn = () =>
        Effect.flatMap(Tools.batch(toolkit), (batch) =>
          LanguageModel.generateText({ prompt: "Charge the card.", ...batch }),
        ).pipe(
          Effect.map((response) =>
            response.toolResults.map((result) => JSON.stringify(result.result)),
          ),
          Effect.provide(model.layer),
        );

      const [rejected, skipped] = yield* turn();

      assert.strictEqual(charged, 0);
      assert.match(rejected ?? "", /Not executed: its parameters are invalid/);
      assert.notInclude(rejected ?? "", "may have taken effect");
      assert.match(skipped ?? "", /Not executed: charge failed/);

      const [declined] = yield* turn();

      assert.strictEqual(charged, 1);
      assert.include(declined ?? "", "may have taken effect");
      assert.include(declined ?? "", String.raw`\"code\":402`);
      assert.include(declined ?? "", "card declined");
    }),
  );

  // effect/ai annotates the span around a tool call with its raw parameters, so a password typed
  // by the last call of a turn reached the model call's span, and any exporter, in plain text.
  it.effect("keeps typed text out of every span it records", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const secret = "correct-horse-battery";
      const spans: Array<Tracer.NativeSpan> = [];

      const tracer = Tracer.make({
        span: (options) => {
          const span = new Tracer.NativeSpan(options);

          spans.push(span);

          return span;
        },
      });

      yield* Effect.promise(() =>
        page.playwright.setContent(
          '<label>Password <input type="password" autocomplete="current-password"></label>',
        ),
      );

      const model = scripted([
        (prompt) => [
          call("browser_type", { ref: refIn(prompt, "textbox", "Password"), text: secret }),
          finish,
        ],
        () => [call("done", { answer: "Signed in" }), finish],
      ]);

      yield* Agent.run("Sign in.", { page }).pipe(
        Effect.provide(model.layer),
        Effect.provideService(Tracer.Tracer, tracer),
      );

      assert.strictEqual(yield* valueOf(page, "input"), secret);
      for (const span of spans)
        assert.notInclude(JSON.stringify([...span.attributes]), secret, span.name);
      assert.isTrue(
        spans.some((span) => span.attributes.get("gen_ai.tool.name") === "browser_type"),
        "the call has a span of its own",
      );
    }),
  );
});
