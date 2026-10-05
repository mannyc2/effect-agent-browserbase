// The agent, its tools and moment descriptions, driven by scripted models: no model is called.
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { assert, expectTypeOf, layer } from "@effect/vitest";
import { Context, Duration, Effect, Exit, Layer, Schedule, Schema, Stream } from "effect";
import { AiError, LanguageModel, Prompt, type Response, Tool, Toolkit } from "effect/ai";
import { toCodecAnthropic } from "effect/ai/AnthropicStructuredOutput";
import { toCodecOpenAI } from "effect/ai/OpenAiStructuredOutput";
import type { BrowserContext } from "playwright-core";

import * as Agent from "../src/Agent.ts";
import { Browser, make as makeBrowser } from "../src/Browser.ts";
import { BrowserError, Failed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Moment from "../src/Moment.ts";
import type { Page } from "../src/Page.ts";
import * as Tools from "../src/Tools.ts";
import { Site, SiteLayer } from "./fixtures.ts";

type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;

class Spent extends Schema.TaggedError<Spent>()("Spent", {}) {}

class Ledger extends Context.Service<
  Ledger,
  { readonly record: (step: number) => Effect.Effect<void> }
>()("test/Ledger") {}

/** A model that answers each call with the next turn, and keeps the prompts it was given. */
const scripted = (turns: ReadonlyArray<Turn>) => {
  const prompts: Array<Prompt.Prompt> = [];
  let index = 0;

  const model = LanguageModel.make({
    generateText: (options) =>
      Effect.suspend(() => {
        const turn = turns[index];

        index += 1;
        prompts.push(options.prompt);

        return turn === undefined
          ? Effect.die(`no turn ${index} in the script`)
          : Effect.succeed([...turn(options.prompt)]);
      }),
    streamText: () => Stream.empty,
  });

  return { layer: Layer.effect(LanguageModel.LanguageModel, model), prompts };
};

/** Pages of this context take `delay` more milliseconds to register, as over a remote CDP link. */
const slowRegistration = (context: BrowserContext, delay: number): BrowserContext =>
  new Proxy(context, {
    get(target, property) {
      if (property === "newCDPSession")
        return async (page: Parameters<BrowserContext["newCDPSession"]>[0]) => {
          await new Promise((resolve) => {
            setTimeout(resolve, delay);
          });

          return target.newCDPSession(page);
        };
      const value: unknown = Reflect.get(target, property, target);

      return typeof value === "function" ? value.bind(target) : value;
    },
  });

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

/** Count observations while preserving the real Chromium page and every operation on it. */
const trackObservations = Effect.fnUntraced(function* (page: Page) {
  const browser = yield* Browser;
  const observations: Array<Parameters<Page["observe"]>[0]> = [];

  const observed: Page = {
    ...page,
    observe: (options) =>
      Effect.suspend(() => {
        observations.push(options);

        return page.observe(options);
      }),
  };

  return {
    observations,
    browser: Browser.of({
      ...browser,
      page: Effect.succeed(observed),
      pages: browser.pages.pipe(
        Effect.map((pages) => pages.map((open) => (open === page ? observed : open))),
      ),
    }),
  };
});

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
    const page = yield* (yield* Browser).page;

    yield* page.goto((yield* Site).url(path));

    return page;
  });

const read = (page: Page, selector: string) =>
  Effect.promise(() =>
    page.playwright.evaluate((s) => document.querySelector(s)?.textContent ?? null, selector),
  );

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("Agent", (it) => {
  it.effect("runs a batch in order with one observation per turn, including done", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const tracked = yield* trackObservations(page);

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
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(Effect.provide(model.layer), Effect.provideService(Browser, tracked.browser));

      assert.strictEqual(result.answer, "Ordered 25 btc");
      assert.strictEqual(result.steps, 2);
      assert.deepStrictEqual(result.usage, {
        inputTokens: 200,
        outputTokens: 20,
        cachedInputTokens: 80,
      });
      assert.strictEqual(yield* read(page, "#outcome"), "Ordered 25 btc");
      assert.include(String(steps[0]?.results[0]?.result), 'Typed "25"');
      assert.match(String(steps[0]?.results[1]?.result), /^Clicked .*"Submit" at \(\d+, \d+\)\.$/);
      assert.include(textOf(model.prompts[1]!), "text: Ordered 25 btc");
      assert.deepStrictEqual(model.prompts.map(pictures), [1, 2]);
      assert.strictEqual(pictures(result.history), 3);
      assert.strictEqual(tracked.observations.length, 3);
      assert.deepStrictEqual(
        resultsIn(result.history).map((part) => part.name),
        ["browser_type", "browser_click", "done"],
      );
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

      const result = yield* Agent.run("Try the action.").pipe(Effect.provide(model.layer));

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

      const result = yield* Agent.run("Set the amount.").pipe(Effect.provide(model.layer));
      const results = resultsIn(result.history);

      assert.strictEqual(result.answer, "finished");
      assert.strictEqual(yield* valueOf(page, "#amount"), "20");
      assert.deepStrictEqual(
        results.map((part) => part.isFailure),
        [false, false, true],
      );
      assert.match(JSON.stringify(results[2]?.result), /not executed/i);
      assert.strictEqual(pictures(result.history), 2);
    }),
  );

  it.effect("ends a batch at give_up and preserves the reason", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const tracked = yield* trackObservations(page);

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
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(
        Effect.provide(model.layer),
        Effect.provideService(Browser, tracked.browser),
        Effect.flip,
      );

      assert.instanceOf(failure, Agent.AgentError);
      assert.strictEqual(failure.message, "the agent gave up: cannot finish the order");
      assert.strictEqual(yield* valueOf(page, "#amount"), "20");
      assert.deepStrictEqual(
        steps[0]?.results.map((result) => result.isFailure),
        [false, false, true],
      );
      assert.match(JSON.stringify(steps[0]?.results[2]?.result), /not executed/i);
      assert.strictEqual(tracked.observations.length, 2);
    }),
  );

  it.effect(
    "asks again after unreadable arguments, but ends on a provider's unreadable reply",
    () =>
      Effect.gen(function* () {
        yield* start("/next");

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

        const result = yield* Agent.run("Read the page.").pipe(
          Effect.provideServiceEffect(LanguageModel.LanguageModel, corrected.model),
        );

        assert.strictEqual(result.answer, "read");
        assert.include(
          textOf(corrected.prompts[1] ?? Prompt.empty),
          "Your call to browser_snapshot could not be read",
        );

        const ended = replies([Effect.fail(undecodable)]);

        const failure = yield* Agent.run("Read the page.").pipe(
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
      const tracked = yield* trackObservations(page);

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
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(Effect.provide(model.layer), Effect.provideService(Browser, tracked.browser));

      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
      assert.strictEqual(result.answer, "unchanged");
      assert.strictEqual(result.steps, 2);
      assert.isString(steps[0]?.rejected);
      assert.deepStrictEqual(steps[0]?.calls, []);
      assert.isUndefined(steps[1]?.rejected);
      assert.strictEqual(tracked.observations.length, 3);

      const limited = yield* Agent.run("Append a digit.", { maxSteps: 1 }).pipe(
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
      const tracked = yield* trackObservations(page);

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

      const result = yield* Agent.run("Read the amount.").pipe(
        Effect.provide(model.layer),
        Effect.provideService(Browser, tracked.browser),
      );

      assert.strictEqual(yield* valueOf(page, "#amount"), "10");
      assert.strictEqual(result.answer, "retried");
      assert.strictEqual(tracked.observations.length, 3);
    }),
  );

  for (const observation of ["outline", "screenshot", "both"] as const) {
    it.effect(`observes only the requested ${observation} content`, () =>
      Effect.gen(function* () {
        const page = yield* start("/form");
        const tracked = yield* trackObservations(page);

        const model = scripted([
          () => [call("browser_wait", { seconds: 0 }), finish],
          () => [call("done", { answer: "seen" }), finish],
        ]);

        const result = yield* Agent.run("Look at the page.", { observation }).pipe(
          Effect.provide(model.layer),
          Effect.provideService(Browser, tracked.browser),
        );

        assert.deepStrictEqual(
          model.prompts.map(pictures),
          observation === "outline" ? [0, 0] : [1, 2],
        );
        assert.strictEqual(
          textOf(model.prompts[0]!).includes('heading "Place an order"'),
          observation !== "screenshot",
        );
        assert.strictEqual(
          textOf(result.history).includes('heading "Place an order"'),
          observation !== "screenshot",
        );
        assert.strictEqual(tracked.observations.length, 3);
        assert.isTrue(tracked.observations.every((options) => options?.mode === observation));
      }),
    );
  }

  it.effect("keeps built-in handlers unless the caller explicitly adds their tools", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const Ambient = Toolkit.make(Tools.Type);
      let ambientCalled = false;

      const model = scripted([
        (prompt) => [
          call("browser_type", { ref: refIn(prompt, "textbox", "Amount"), text: "25" }),
          finish,
        ],
        () => [call("done", { answer: "typed" }), finish],
      ]);

      const result = yield* Agent.run("Set the amount.").pipe(
        Effect.provide([
          Ambient.toLayer({
            browser_type: () =>
              Effect.sync(() => {
                ambientCalled = true;

                return "ambient handler";
              }),
          }),
          model.layer,
        ]),
      );

      assert.isFalse(ambientCalled);
      assert.strictEqual(yield* valueOf(page, "#amount"), "25");
      assert.include(String(resultsIn(result.history)[0]?.result), 'Typed "25"');
    }),
  );

  it.effect("keeps a performed action when its following observation fails", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      yield* Effect.promise(() => page.playwright.locator("#amount").press("End"));
      const browser = yield* Browser;
      let observations = 0;

      const observed: Page = {
        ...page,
        observe: (options) =>
          Effect.suspend(() => {
            observations += 1;

            return observations === 2
              ? Effect.fail(
                  new BrowserError({
                    operation: "observe",
                    reason: new Failed({ detail: "fixture observation failed" }),
                    dispatched: false,
                  }),
                )
              : page.observe(options);
          }),
      };

      const model = scripted([
        () => [
          call("browser_type", {
            text: "1",
            append: true,
          }),
          finish,
        ],
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

      const result = yield* Agent.run("Append one digit.").pipe(
        Effect.provide(model.layer),
        Effect.provideService(
          Browser,
          Browser.of({
            ...browser,
            page: Effect.succeed(observed),
            pages: browser.pages.pipe(
              Effect.map((pages) => pages.map((open) => (open === page ? observed : open))),
            ),
          }),
        ),
      );

      assert.strictEqual(yield* valueOf(page, "#amount"), "101");
      assert.strictEqual(result.answer, "typed once");
      assert.strictEqual(result.steps, 2);
      assert.strictEqual(observations, 3);
      assert.deepStrictEqual(
        resultsIn(result.history).map((part) => part.name),
        ["browser_type", "done"],
      );
    }),
  );

  it.effect("ends the run with the browser's error once no page can be had", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      assert.isNotNull(native);
      if (native === null) return;
      const context = yield* Effect.promise(() => native.newContext());
      const browser = yield* makeBrowser(context, { id: "closing", provider: "test" });

      yield* (yield* browser.page).goto((yield* Site).url("/next"));

      const Closing = Toolkit.make(
        Tool.make("close_browser", { parameters: Schema.Struct({}), success: Schema.String }),
      );

      const closing = Closing.toLayer({
        close_browser: () => Effect.promise(() => context.close()).pipe(Effect.as("Closed.")),
      });

      const model = scripted([() => [call("close_browser", {}), finish]]);
      const reported: Array<number> = [];

      const failure = yield* Agent.run("Close the browser.", {
        additionalTools: Closing,
        onStep: (step) => Effect.sync(() => reported.push(step.usage.inputTokens)),
      }).pipe(
        Effect.provide([closing, model.layer]),
        Effect.provideService(Browser, browser),
        Effect.flip,
      );

      assert.strictEqual(failure._tag, "BrowserError");
      assert.strictEqual(model.prompts.length, 1);
      // The paid turn is still reported before the run ends.
      assert.deepStrictEqual(reported, [100]);

      const unused = scripted([]);

      const again = yield* Agent.run("Look again.").pipe(
        Effect.provide(unused.layer),
        Effect.provideService(Browser, browser),
        Effect.flip,
      );

      assert.strictEqual(again._tag, "BrowserError");
      assert.strictEqual(unused.prompts.length, 0);
    }),
  );

  it.effect("keeps the answer of the turn in which the browser went away", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      assert.isNotNull(native);
      if (native === null) return;
      const context = yield* Effect.promise(() => native.newContext());
      const browser = yield* makeBrowser(context, { id: "expiring", provider: "test" });

      yield* (yield* browser.page).goto("data:text/html,<title>Task</title>The answer is 42");
      const reported: Array<number> = [];

      // The model answers while the hosted session expires.
      const model = replies([
        Effect.promise(() => context.close()).pipe(
          Effect.as([call("done", { answer: "42" }), finish]),
        ),
      ]);

      const result = yield* Agent.run("Read the answer.", {
        onStep: (step) => Effect.sync(() => reported.push(step.usage.inputTokens)),
      }).pipe(
        Effect.provideServiceEffect(LanguageModel.LanguageModel, model.model),
        Effect.provideService(Browser, browser),
      );

      assert.strictEqual(result.answer, "42");
      assert.deepStrictEqual(reported, [100]);
    }),
  );

  it.effect("uses additional tool definitions and handlers on a name clash", () =>
    Effect.gen(function* () {
      yield* start("/next");

      const Additional = Toolkit.make(
        Tool.make("browser_wait", {
          parameters: Schema.Struct({ label: Schema.String }),
          success: Schema.String,
        }),
      );

      const labels: Array<string> = [];

      const model = scripted([
        () => [call("browser_wait", { label: "custom" }), finish],
        () => [call("done", { answer: "seen" }), finish],
      ]);

      const result = yield* Agent.run("Use the extra tool.", { additionalTools: Additional }).pipe(
        Effect.provide([
          Additional.toLayer({
            browser_wait: ({ label }) =>
              Effect.sync(() => {
                labels.push(label);

                return "custom wait: " + label;
              }),
          }),
          model.layer,
        ]),
      );

      assert.deepStrictEqual(labels, ["custom"]);
      assert.strictEqual(resultsIn(result.history)[0]?.result, "custom wait: custom");
    }),
  );

  it.effect("keeps done the agent's own even when an added tool takes its name", () =>
    Effect.gen(function* () {
      yield* start("/next");
      let replaced = 0;

      const Clashing = Toolkit.make(
        Tool.make("done", {
          parameters: Schema.Struct({ answer: Schema.String }),
          success: Schema.String,
        }),
      );

      const model = scripted([() => [call("done", { answer: "finished" }), finish]]);

      const result = yield* Agent.run("Finish.", {
        // @ts-expect-error -- `done` ends the run, so an added tool cannot take its name
        additionalTools: Clashing,
      }).pipe(
        Effect.provide([
          Clashing.toLayer({
            done: () =>
              Effect.sync(() => {
                replaced += 1;

                return "replaced";
              }),
          }),
          model.layer,
        ]),
      );

      assert.strictEqual(result.answer, "finished");
      assert.strictEqual(replaced, 0);
    }),
  );

  for (const failureMode of ["return", "error"] as const) {
    it.effect("halts on an additional tool with failure mode " + failureMode, () =>
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
          additionalTools: Additional,
        }).pipe(
          Effect.provide([
            Additional.toLayer({
              fixture_failure: () => Effect.fail("fixture denied"),
            }),
            model.layer,
          ]),
        );

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
      const tracked = yield* trackObservations(page);

      const idle = () => [
        { type: "text" as const, text: "Still thinking." },
        { ...finish, reason: "stop" as const },
      ];

      const model = scripted([idle, idle, idle]);

      const failure = yield* Agent.run("Continue.").pipe(
        Effect.provide(model.layer),
        Effect.provideService(Browser, tracked.browser),
        Effect.flip,
      );

      assert.instanceOf(failure, Agent.AgentError);
      assert.include(failure.message, "stopped calling tools");
      assert.strictEqual(model.prompts.length, 3);
      assert.strictEqual(tracked.observations.length, 4);
    }),
  );

  it.effect("offers every tool with an object schema under each provider's codec", () =>
    Effect.gen(function* () {
      yield* start("/next");
      const offered: Array<Tool.Any> = [];

      const model = LanguageModel.make({
        generateText: (options) =>
          Effect.sync(() => {
            offered.push(...options.tools);

            return [call("done", { answer: { credits: 1 } }), finish];
          }),
        streamText: () => Stream.empty,
      });

      yield* Agent.run("Count the credits.", {
        answer: Schema.Struct({ credits: Schema.Finite }),
      }).pipe(Effect.provideServiceEffect(LanguageModel.LanguageModel, model));

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
      yield* start("/chart");

      const model = scripted([
        () => [call("done", { answer: { price: 64210, trend: "up" } }), finish],
      ]);

      const result = yield* Agent.run("Read the chart.", {
        answer: Schema.Struct({ price: Schema.Finite, trend: Schema.Literals(["up", "down"]) }),
      }).pipe(Effect.provide(model.layer));

      assert.deepStrictEqual(result.answer, { price: 64210, trend: "up" });
      assert.include(textOf(model.prompts[0]!), 'heading "BTC/USD, 1 hour"');
    }),
  );

  it.effect("keeps only the latest pictures in the conversation", () =>
    Effect.gen(function* () {
      yield* start("/slots");
      const look = () => [call("browser_wait", { seconds: 0 }), finish];

      const model = scripted([
        look,
        look,
        look,
        look,
        () => [call("done", { answer: "seen" }), finish],
      ]);

      const result = yield* Agent.run("Look at the game.", { keepPictures: 1 }).pipe(
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

  it.effect("fails with the reason when the model gives up, and at the step limit", () =>
    Effect.gen(function* () {
      yield* start("/next");

      const gaveUp = yield* Agent.run("Buy a house.", {}).pipe(
        Effect.provide(
          scripted([() => [call("give_up", { reason: "there is no shop" }), finish]]).layer,
        ),
        Effect.flip,
      );

      const limited = yield* Agent.run("Wait.", { maxSteps: 2 }).pipe(
        Effect.provide(
          scripted([
            () => [call("browser_wait", { seconds: 0 }), finish],
            () => [call("browser_wait", { seconds: 0 }), finish],
          ]).layer,
        ),
        Effect.flip,
      );

      assert.strictEqual(gaveUp._tag === "AgentError" ? gaveUp.reason._tag : gaveUp._tag, "GaveUp");
      assert.strictEqual(
        limited._tag === "AgentError" ? limited.reason._tag : limited._tag,
        "StepLimit",
      );
    }),
  );

  it.effect("requires the services onStep uses", () =>
    Effect.gen(function* () {
      yield* start("/next");
      const recorded: Array<number> = [];
      const model = scripted([() => [call("done", { answer: "seen" }), finish]]);

      const program = Agent.run("Answer.", {
        onStep: (step) =>
          Effect.gen(function* () {
            yield* (yield* Ledger).record(step.step);
          }),
      });

      expectTypeOf<Effect.Services<typeof program>>().toEqualTypeOf<
        Browser | LanguageModel.LanguageModel | Ledger
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
      yield* start("/next");
      const wait = () => [call("browser_wait", { seconds: 0 }), finish];
      const model = scripted([wait, wait, wait]);

      const stopped = yield* Agent.run("Wait.", {
        onStep: (step) => (step.step === 2 ? Effect.fail(new Spent()) : Effect.void),
      }).pipe(Effect.provide(model.layer), Effect.flip);

      assert.strictEqual(stopped._tag, "Spent");
      assert.strictEqual(model.prompts.length, 2);
    }),
  );

  for (const observationMode of ["both", "outline"] as const) {
    it.effect(
      "delivers every new zoom crop once with the " + observationMode + " turn observation",
      () =>
        Effect.gen(function* () {
          const page = yield* start("/chart");
          const tracked = yield* trackObservations(page);

          const model = scripted([
            (prompt) => {
              // Crops are not magnified, and the model must not be told they are.
              assert.notInclude(textOf(prompt), "full resolution");
              assert.include(textOf(prompt), "the viewport's own CSS pixel scale");

              return [
                ...Array.from({ length: 8 }, (_, index) =>
                  call("browser_zoom", {
                    x: index * 10,
                    y: 0,
                    width: 100,
                    height: 60,
                  }),
                ),
                finish,
              ];
            },
            (prompt) => {
              const observation = prompt.content
                .filter((message) => message.role === "user")
                .at(-1);

              const text =
                observation?.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n") ?? "";

              assert.strictEqual(
                observation?.content.filter((part) => part.type === "file").length,
                observationMode === "both" ? 9 : 8,
              );
              assert.strictEqual(resultsIn(prompt).length, 8);
              assert.isTrue(resultsIn(prompt).every((part) => !part.isFailure));
              for (let index = 0; index < 8; index++) {
                assert.include(text, "viewport origin (" + index * 10 + ", 0)");
              }
              assert.include(text, "Add this origin to image coordinates");

              return [call("browser_wait", { seconds: 0 }), finish];
            },
            (prompt) => {
              const observation = prompt.content
                .filter((message) => message.role === "user")
                .at(-1);

              const text =
                observation?.content
                  .filter((part) => part.type === "text")
                  .map((part) => part.text)
                  .join("\n") ?? "";

              assert.strictEqual(
                observation?.content.filter((part) => part.type === "file").length,
                observationMode === "both" ? 1 : 0,
              );
              assert.notInclude(text, "Zoom from page");
              assert.strictEqual(pictures(prompt), 1);

              return [call("done", { answer: "seen" }), finish];
            },
          ]);

          const result = yield* Agent.run("Inspect small details.", {
            keepPictures: 1,
            observation: observationMode,
          }).pipe(Effect.provide(model.layer), Effect.provideService(Browser, tracked.browser));

          assert.strictEqual(result.answer, "seen");
          assert.strictEqual(tracked.observations.length, 4);
          assert.strictEqual(textOf(result.history).split("Zoom from page").length - 1, 8);
        }),
    );
  }

  it.effect("delivers requested crops in outline mode even when the observation fails", () =>
    Effect.gen(function* () {
      const page = yield* start("/chart");
      const browser = yield* Browser;
      let observations = 0;

      const observed: Page = {
        ...page,
        observe: (options) =>
          Effect.suspend(() => {
            observations += 1;

            return observations === 2
              ? Effect.fail(
                  new BrowserError({
                    operation: "observe",
                    reason: new Failed({ detail: "fixture observation failed" }),
                    dispatched: false,
                  }),
                )
              : page.observe(options);
          }),
      };

      const model = scripted([
        () => [call("browser_zoom", { x: 10, y: 20, width: 100, height: 60 }), finish],
        (prompt) => {
          assert.strictEqual(pictures(prompt), 1);
          assert.include(textOf(prompt), "could not be observed");
          assert.include(textOf(prompt), "viewport origin (10, 20)");
          assert.isFalse(resultsIn(prompt)[0]?.isFailure);

          return [call("done", { answer: "seen" }), finish];
        },
      ]);

      const result = yield* Agent.run("Inspect a detail.", { observation: "outline" }).pipe(
        Effect.provide(model.layer),
        Effect.provideService(
          Browser,
          Browser.of({
            ...browser,
            page: Effect.succeed(observed),
            pages: browser.pages.pipe(
              Effect.map((pages) => pages.map((open) => (open === page ? observed : open))),
            ),
          }),
        ),
      );

      assert.strictEqual(pictures(model.prompts[0]!), 0);
      assert.strictEqual(pictures(result.history), 1);
      assert.strictEqual(textOf(result.history).split("Zoom from page").length - 1, 1);
      assert.strictEqual(observations, 3);
    }),
  );

  it.effect("runs a caller's own turn in order and halts it at the first failure", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const tools = yield* Tools.make();

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

  it.effect("bounds concurrent pending zooms before capture and drains them once", () =>
    Effect.gen(function* () {
      const page = yield* start("/chart");
      const tools = yield* Tools.make();
      const screenshot = page.playwright.screenshot.bind(page.playwright);
      let captures = 0;

      yield* Effect.acquireRelease(
        Effect.sync(() => {
          page.playwright.screenshot = (...args: Parameters<typeof screenshot>) => {
            captures += 1;

            return screenshot(...args);
          };
        }),
        () =>
          Effect.sync(() => {
            page.playwright.screenshot = screenshot;
          }),
      );

      const attempts = yield* Effect.forEach(
        Array.from({ length: 9 }, (_, index) => ({ x: index, y: 0, width: 100, height: 60 })),
        (region) => tools.handlers.browser_zoom(region).pipe(Effect.exit),
        { concurrency: 9 },
      );

      assert.strictEqual(attempts.filter(Exit.isSuccess).length, 8);
      assert.strictEqual(attempts.filter(Exit.isFailure).length, 1);
      assert.strictEqual(captures, 8);
      assert.strictEqual((yield* tools.takeZooms).length, 8);
      assert.strictEqual((yield* tools.takeZooms).length, 0);
      yield* tools.handlers.browser_zoom({ x: 10, y: 0, width: 100, height: 60 });
      assert.strictEqual(captures, 9);
      assert.strictEqual((yield* tools.takeZooms).length, 1);
      assert.strictEqual((yield* tools.takeZooms).length, 0);
    }),
  );

  it.effect("follows a tab that registers after its click's receipt, before acting again", () =>
    Effect.gen(function* () {
      const native = (yield* Browser).context.browser();

      assert.isNotNull(native);
      if (native === null) return;

      const context = yield* Effect.acquireRelease(
        Effect.promise(() => native.newContext({ viewport: { width: 1280, height: 720 } })),
        (owned) => Effect.promise(() => owned.close()),
      );

      // A remote browser's round trips make a new tab register well after a click settles.
      const browser = yield* makeBrowser(slowRegistration(context, 1000), {
        id: "slow-registration",
        provider: "test",
      });

      yield* Effect.gen(function* () {
        const page = yield* browser.page;

        yield* page.goto((yield* Site).url("/form"));
        const tools = yield* Tools.make();
        const snapshot = yield* tools.handlers.browser_snapshot({});
        const link = /link "Open in a new tab" \[ref=(e\d+)\]/.exec(snapshot)?.[1] ?? "";

        yield* tools.handlers.browser_click({ ref: link });
        yield* browser.pages.pipe(
          Effect.repeat({
            schedule: Schedule.spaced(Duration.millis(25)),
            until: (open) => open.length === 2,
          }),
          Effect.timeout(Duration.seconds(10)),
        );
        yield* Effect.promise(() => page.playwright.locator("#amount").focus());

        const refused = yield* tools.handlers
          .browser_type({ text: "7", append: true })
          .pipe(Effect.flip);

        assert.include(refused, "A new tab opened and is now the current tab");
        assert.notInclude(refused, "may have taken effect");
        assert.strictEqual(yield* valueOf(page, "#amount"), "10");

        const current = yield* tools.page;

        assert.notStrictEqual(current.id, page.id);
        assert.include(yield* current.url, "/next");
        const outline = yield* tools.handlers.browser_snapshot({});
        const proceed = /button "Continue" \[ref=(e\d+)\]/.exec(outline)?.[1] ?? "";

        assert.include(outline, "The next page");
        assert.include(yield* tools.handlers.browser_click({ ref: proceed }), "Clicked");
      }).pipe(Effect.provideService(Browser, browser));
    }),
  );

  it.effect("refuses the rest of a batch on a tab that opened in it, until it is observed", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const browser = yield* Browser;
      const tools = yield* Tools.make();
      const snapshot = yield* tools.handlers.browser_snapshot({});
      const submit = /button "Submit" \[ref=(e\d+)\]/.exec(snapshot)?.[1] ?? "";
      const before = (yield* browser.pages).length;

      // The page opens a tab after the model last looked. Waiting for its registration makes
      // the batch meet it at its first call, as a tab opened by an earlier call would be met.
      yield* Effect.promise(() => page.playwright.evaluate(() => void window.open("/next")));
      yield* browser.pages.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(Duration.millis(50)),
          until: (open) => open.length > before,
        }),
        Effect.timeout(Duration.seconds(5)),
      );

      const model = scripted([
        () => [call("browser_snapshot", {}), call("browser_click", { ref: submit }), finish],
      ]);

      const response = yield* LanguageModel.generateText({
        prompt: "Submit the order.",
        ...(yield* tools.batch),
      }).pipe(Effect.provide(model.layer));

      const [outline, refused] = response.toolResults;

      // Reading the tab within the batch does not count: the model sees it only afterwards.
      assert.include(
        JSON.stringify(outline?.result),
        "A new tab opened and is now the current tab.",
      );
      assert.include(JSON.stringify(outline?.result), "The next page");
      assert.isTrue(refused?.isFailure);
      assert.match(JSON.stringify(refused?.result), /^"Not done: A new tab opened/);
      assert.strictEqual(yield* read(page, "#outcome"), "Not ordered");

      const observed = yield* tools.page;
      const fresh = yield* tools.handlers.browser_snapshot({});
      const proceed = /button "Continue" \[ref=(e\d+)\]/.exec(fresh)?.[1] ?? "";

      assert.include(yield* observed.url, "/next");
      assert.include(yield* tools.handlers.browser_click({ ref: proceed }), "Clicked");
      yield* observed.close;
    }),
  );

  it.effect("opens typed addresses, but never a local file, from the navigation tools", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");
      const browser = yield* Browser;
      const tools = yield* Tools.make();
      const { host } = new URL((yield* Site).url("/next"));

      // A host and port is an address, not a `localhost:` scheme; loopback is plain HTTP.
      assert.strictEqual(
        yield* tools.handlers.browser_navigate({ url: `localhost:${host.split(":")[1]}/next` }),
        `Opened http://localhost:${host.split(":")[1]}/next.`,
      );
      assert.include(yield* page.url, "/next");

      const directory = yield* Effect.acquireRelease(
        Effect.promise(() => mkdtemp(join(tmpdir(), "effect-browser-"))),
        (path) => Effect.promise(() => rm(path, { recursive: true, force: true })),
      );

      const file = pathToFileURL(join(directory, "secret.html")).href;

      yield* Effect.promise(() => writeFile(new URL(file), "<title>Secret</title>secret"));

      for (const url of [file, "javascript:alert(1)", "chrome://settings"]) {
        const refused = yield* tools.handlers.browser_navigate({ url }).pipe(Effect.flip);

        assert.include(refused, "was not opened");
        assert.notInclude(refused, "may have taken effect");
      }
      const tabs = (yield* browser.pages).length;

      assert.include(
        yield* tools.handlers.browser_tabs({ action: "new", url: file }).pipe(Effect.flip),
        "was not opened",
      );
      assert.strictEqual((yield* browser.pages).length, tabs);
      assert.include(yield* page.url, "/next");

      // The consumer's own navigation is not the model's, and still opens what it is given.
      yield* page.goto(file);
      assert.strictEqual(yield* page.title, "Secret");
      yield* page.goto(host + "/form");
      assert.strictEqual(yield* page.url, `http://${host}/form`);
    }),
  );

  it.effect("plays a canvas game by point and follows tabs", () =>
    Effect.gen(function* () {
      const page = yield* start("/slots");
      const tools = yield* Tools.make();

      const spin = yield* tools.handlers.browser_click({ x: 300, y: 320 });

      const still = yield* tools.handlers.browser_wait({ still: true });

      const state = yield* Effect.promise(() =>
        page.playwright.evaluate(
          () => (window as unknown as { state: { spins: number } }).state.spins,
        ),
      );

      assert.include(spin, "<canvas#game>");
      assert.include(spin, "at (300, 320).");
      assert.include(still, "The screen is still.");
      assert.strictEqual(state, 1);

      yield* page.goto((yield* Site).url("/form"));

      const snapshot = yield* tools.handlers.browser_snapshot({});

      const ref = /link "Open in a new tab" \[ref=(e\d+)\]/.exec(snapshot)?.[1] ?? "";

      const browser = yield* Browser;

      assert.include(yield* tools.handlers.browser_click({ ref }), "Clicked");
      // The receipt names the tab only if it registered within the click; the next look follows
      // it either way.
      yield* browser.pages.pipe(
        Effect.repeat({
          schedule: Schedule.spaced(Duration.millis(50)),
          until: (open) => open.length > 1,
        }),
        Effect.timeout(Duration.seconds(5)),
      );
      assert.notStrictEqual((yield* tools.page).id, page.id);
      assert.include(yield* tools.handlers.browser_tabs({ action: "list" }), "2. [current] Next");
      yield* tools.handlers.browser_tabs({ action: "close", index: 2 });
      assert.strictEqual((yield* tools.page).id, page.id);
      assert.include(
        yield* tools.handlers.browser_click({ ref: "e99999" }).pipe(Effect.flip),
        "take a new snapshot",
      );
    }),
  );

  it.effect("captures a moment of a spinning game and describes it in one call", () =>
    Effect.gen(function* () {
      const page = yield* start("/slots");

      yield* page.screencast().pipe(Stream.runDrain, Effect.forkScoped);
      yield* Effect.sleep(Duration.millis(300));
      yield* page.click({ x: 300, y: 320 });
      yield* Effect.sleep(Duration.millis(400));
      const moment = yield* Moment.capture(page, { frames: 2 });

      const model = scripted([
        (prompt) => {
          assert.strictEqual(pictures(prompt), 2);
          assert.include(textOf(prompt), "click 300,320");

          return [
            {
              type: "text",
              text: JSON.stringify({
                summary: "Three reels are spinning.",
                activity: "spinning the reels",
                change: "the reels started",
                subjects: ["reels", "SPIN button"],
                mood: "tense",
              }),
            },
            { ...finish, reason: "stop" },
          ];
        },
      ]);

      const { value: description, usage } = yield* Moment.describe(moment).pipe(
        Effect.provide(model.layer),
      );

      assert.strictEqual(moment.frames.length, 2);
      assert.isTrue(
        moment.events.some((event) => event._tag === "Action" && event.name === "click"),
      );
      assert.strictEqual(description.activity, "spinning the reels");
      assert.deepStrictEqual(usage, { inputTokens: 100, outputTokens: 10, cachedInputTokens: 40 });
    }),
  );
});
