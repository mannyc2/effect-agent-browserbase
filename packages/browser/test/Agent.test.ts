// The agent, its tools and moment descriptions, driven by scripted models: no model is called.
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, type Prompt, type Response, Tool, Toolkit } from "effect/ai";

import * as Agent from "../src/Agent.ts";
import { Browser } from "../src/Browser.ts";
import { BrowserError, Failed } from "../src/BrowserError.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Moment from "../src/Moment.ts";
import type { Page } from "../src/Page.ts";
import * as Tools from "../src/Tools.ts";
import { Site, SiteLayer } from "./fixtures.ts";

type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;

class Spent extends Schema.TaggedError<Spent>()("Spent", {}) {}

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
      assert.match(String(steps[0]?.results[1]?.result), /^Clicked e\d+\.$/);
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
          assert.include(textOf(prompt), "could not be observed");

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

      assert.include(spin, "Clicked (300, 320).");
      assert.include(still, "The screen is still.");
      assert.strictEqual(state, 1);

      yield* page.goto((yield* Site).url("/form"));

      const snapshot = yield* tools.handlers.browser_snapshot({});

      const ref = /link "Open in a new tab" \[ref=(e\d+)\]/.exec(snapshot)?.[1] ?? "";

      const opened = yield* tools.handlers.browser_click({ ref });

      assert.include(opened, "A new tab opened and is now the current tab.");
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
