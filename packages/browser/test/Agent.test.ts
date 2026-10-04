// The agent, its tools and moment descriptions, driven by scripted models: no model is called.
import { assert, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Schema, Stream } from "effect";
import { LanguageModel, type Prompt, type Response } from "effect/ai";

import * as Agent from "../src/Agent.ts";
import { Browser } from "../src/Browser.ts";
import * as Chromium from "../src/Chromium.ts";
import * as Moment from "../src/Moment.ts";
import type { Page } from "../src/Page.ts";
import * as Tools from "../src/Tools.ts";
import { Site, SiteLayer } from "./fixtures.ts";

type Turn = (prompt: Prompt.Prompt) => ReadonlyArray<Response.PartEncoded>;

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
  it.effect("runs a task through the tools until the model calls done", () =>
    Effect.gen(function* () {
      const page = yield* start("/form");

      const model = scripted([
        (prompt) => [call("browser_click", { ref: refIn(prompt, "button", "Submit") }), finish],
        () => [call("browser_screenshot", {}), finish],
        () => [call("done", { answer: "Ordered 10 btc" }), finish],
      ]);

      const steps: Array<Agent.Step> = [];

      const result = yield* Agent.run("Submit the order and report the outcome.", {
        onStep: (step) => Effect.sync(() => steps.push(step)),
      }).pipe(Effect.provide(model.layer));

      assert.strictEqual(result.answer, "Ordered 10 btc");
      assert.strictEqual(result.steps, 3);
      assert.deepStrictEqual(result.usage, {
        inputTokens: 300,
        outputTokens: 30,
        cachedInputTokens: 120,
      });
      assert.strictEqual(yield* read(page, "#outcome"), "Ordered 10 btc");
      assert.include(String(steps[0]?.results[0]?.result), "Clicked e");
      assert.include(String(steps[0]?.results[0]?.result), "text: Ordered 10 btc");
      assert.strictEqual(pictures(model.prompts[1] ?? model.prompts[0]!), 0);
      assert.strictEqual(pictures(model.prompts[2]!), 1);
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
      const look = () => [call("browser_screenshot", {}), finish];

      const model = scripted([
        look,
        look,
        look,
        look,
        () => [call("done", { answer: "seen" }), finish],
      ]);

      yield* Agent.run("Look at the game.", { keepPictures: 1 }).pipe(Effect.provide(model.layer));
      assert.deepStrictEqual(model.prompts.map(pictures), [0, 1, 2, 3, 2]);
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

      const description = yield* Moment.describe(moment).pipe(Effect.provide(model.layer));

      assert.strictEqual(moment.frames.length, 2);
      assert.isTrue(
        moment.events.some((event) => event._tag === "Action" && event.name === "click"),
      );
      assert.strictEqual(description.activity, "spinning the reels");
    }),
  );
});
