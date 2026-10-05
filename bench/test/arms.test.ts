// These models and perception coordinates are fixtures for plumbing, not model-quality evidence.
import { assert, layer } from "@effect/vitest";
import { Context, Duration, Effect, Layer, Schema, Stream } from "effect";
import { Browser } from "effect-browser/Browser";
import * as Chromium from "effect-browser/Chromium";
import { Frame, Screenshot } from "effect-browser/Frame";
import * as Moment from "effect-browser/Moment";
import type { Page } from "effect-browser/Page";
import { LanguageModel, type Prompt, type Response, type Tool } from "effect/ai";
import type { Route } from "playwright-core";

import * as Arms from "../Arms.ts";
import * as Perception from "../Perception.ts";
import { tasks } from "../Tasks.ts";

const finish: Response.PartEncoded = {
  type: "finish",
  reason: "tool-calls",
  usage: { inputTokens: { total: 100, cacheRead: 20 }, outputTokens: { total: 10 } },
};

let callId = 0;

const call = (name: string, params: unknown): Response.PartEncoded => ({
  type: "tool-call",
  id: String(++callId),
  name,
  params,
});

type Turn = (
  prompt: Prompt.Prompt,
  tools: ReadonlyArray<Tool.Any>,
) => ReadonlyArray<Response.PartEncoded>;

const scripted = (turns: ReadonlyArray<Turn>) => {
  const prompts: Array<Prompt.Prompt> = [];
  const definitions: Array<ReadonlyArray<Tool.Any>> = [];
  let index = 0;

  return {
    prompts,
    definitions,
    layer: Layer.effect(
      LanguageModel.LanguageModel,
      LanguageModel.make({
        generateText: (options) =>
          Effect.sync(() => {
            const turn = turns[index++];

            if (turn === undefined) throw new Error("No scripted turn " + index);
            prompts.push(options.prompt);
            definitions.push(options.tools);

            return [...turn(options.prompt, options.tools)];
          }),
        streamText: () => Stream.empty,
      }),
    ),
  };
};

const textOf = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((item) =>
      item.role === "system"
        ? [item.content]
        : item.content.flatMap((part) =>
            part.type === "text"
              ? [part.text]
              : part.type === "tool-result"
                ? [JSON.stringify(part.result)]
                : [],
          ),
    )
    .join("\n");

const images = (prompt: Prompt.Prompt) =>
  prompt.content.reduce(
    (sum, item) =>
      sum + (item.role === "user" ? item.content.filter((part) => part.type === "file").length : 0),
    0,
  );

const results = (prompt: Prompt.Prompt) =>
  prompt.content
    .flatMap((item) => (item.role === "tool" ? item.content : []))
    .filter((part) => part.type === "tool-result");

const ref = (prompt: Prompt.Prompt, role: string, name: string) => {
  const matches = textOf(prompt)
    .split("\n")
    .filter((line) => line.includes(role + ' "' + name + '"'))
    .map((line) => /\[ref=(e\d+)\]/.exec(line)?.[1]);

  const value = matches.at(-1);

  assert.isDefined(value);

  return value ?? "";
};

const html = `<!doctype html><title>Fixture</title>
<style>body{margin:0}h1{position:absolute;left:20px;top:0}input,select,button{position:absolute;left:20px;width:180px;height:30px}input{top:80px}select{top:130px}button{top:180px}output{position:absolute;top:240px}</style>
<h1 aria-label="DOM_ONLY_CANARY">Controls</h1><input aria-label="Amount" id="amount" value="old">
<select aria-label="Country" id="country"><option>Canada</option><option>United States</option></select>
<button onclick="document.querySelector('output').textContent=document.querySelector('input').value+' '+document.querySelector('select').value">Submit</button><output></output>`;

const open = Effect.gen(function* () {
  const browser = yield* Browser;

  const handler = (route: Route) => route.fulfill({ contentType: "text/html", body: html });

  yield* Effect.acquireRelease(
    Effect.promise(() => browser.context.route("http://arms.test/**", handler)),
    () => Effect.promise(() => browser.context.unroute("http://arms.test/**", handler)),
  );
  const pages = yield* browser.pages;

  for (const extra of pages.slice(1)) yield* extra.close;
  const page = yield* browser.page;

  yield* page.goto("http://arms.test/first");

  return page;
});

const input = (page: Page) => ({
  page,
  prompt: "Fill the form.",
  schema: Schema.String,
  maxSteps: 8,
  onUsage: () => Effect.void,
});

const value = (page: Page, selector: string) =>
  Effect.promise(() => page.playwright.locator(selector).inputValue());

const output = (page: Page) =>
  Effect.promise(() => page.playwright.locator("output").textContent());

const runtime = { python: "fixture", torch: "fixture", transformers: "fixture", ocr: "fixture" };

const parseProvenance = {
  modelId: "microsoft/OmniParser-v2.0",
  revision: Perception.omniRevision,
  captionProcessorRevision: Perception.captionProcessorRevision,
  captionCodeRevision: Perception.captionCodeRevision,
  preprocessing: Perception.parsePreprocessing,
  ocrDataSha256: Perception.ocrDataSha256,
  device: "cpu",
  runtime,
} as const;

const groundProvenance = {
  modelId: "Hcompany/Holo2-4B",
  revision: Perception.holoRevision,
  preprocessing: Perception.groundPreprocessing,
  device: "cuda",
  runtime,
} as const;

const identity = (image: Perception.Image) => ({
  sha256: image.sha256,
  width: image.width,
  height: image.height,
  page: image.page,
  at: image.at,
});

const elements = [
  {
    id: 1,
    kind: "icon",
    text: "Amount",
    interactable: true,
    bbox: { x0: 20, y0: 80, x1: 200, y1: 110 },
  },
  {
    id: 2,
    kind: "icon",
    text: "Country",
    interactable: true,
    bbox: { x0: 20, y0: 130, x1: 200, y1: 160 },
  },
  {
    id: 3,
    kind: "icon",
    text: "Submit",
    interactable: true,
    bbox: { x0: 20, y0: 180, x1: 200, y1: 210 },
  },
] as const;

const perceptionFixture = (overrides: Partial<Perception.Perception["Service"]> = {}) =>
  Layer.succeed(
    Perception.Perception,
    Perception.Perception.of({
      parse: (image) =>
        Effect.succeed({ observation: identity(image), provenance: parseProvenance, elements }),
      ground: (image) =>
        Effect.succeed({
          observation: identity(image),
          provenance: groundProvenance,
          x: 100,
          y: 195,
        }),
      status: Effect.succeed({
        mode: "parse",
        ready: true,
        reason: null,
        provenance: parseProvenance,
        requiredFreeMiB: 0,
        gpuFreeMiB: null,
      }),
      ...overrides,
    }),
  );

class StrategyFailure extends Schema.TaggedError<StrategyFailure>()("StrategyFailure", {}) {}
class StrategyMarker extends Context.Service<StrategyMarker, { readonly stop: boolean }>()(
  "test/StrategyMarker",
) {}

layer(Chromium.layer(), { excludeTestServices: true, timeout: Duration.seconds(60) })(
  "benchmark arms",
  (it) => {
    it.effect(
      "arm 1 takes outlines after each action, preserves batch order and sends only explicit pictures",
      () =>
        Effect.gen(function* () {
          const page = yield* open;

          const model = scripted([
            (prompt) => {
              assert.strictEqual(images(prompt), 0);

              return [
                call("browser_type", { ref: ref(prompt, "textbox", "Amount"), text: "first" }),
                call("browser_type", { ref: ref(prompt, "textbox", "Amount"), text: "second" }),
                finish,
              ];
            },
            (prompt) => {
              const receipts = results(prompt);

              assert.lengthOf(receipts, 2);
              assert.include(JSON.stringify(receipts[0]?.result), "first");
              assert.include(JSON.stringify(receipts[1]?.result), "second");
              assert.isTrue(
                receipts.every((receipt) =>
                  JSON.stringify(receipt.result).includes("DOM_ONLY_CANARY"),
                ),
              );
              assert.strictEqual(images(prompt), 0);

              return [call("browser_screenshot", {}), finish];
            },
            (prompt) => {
              assert.strictEqual(images(prompt), 1);

              return [
                call("done", { answer: "done" }),
                call("browser_type", { text: "must not run" }),
                finish,
              ];
            },
          ]);

          const result = yield* Arms.baseline
            .operate(input(page))
            .pipe(Effect.provide(model.layer));

          assert.strictEqual(result.steps, 3);
          assert.strictEqual(yield* value(page, "#amount"), "second");
        }).pipe(Effect.scoped),
    );

    it.effect(
      "arm 2 supplies images without outline/ref/select/text-wait backdoors and halts an invalid batch",
      () =>
        Effect.gen(function* () {
          const page = yield* open;

          const model = scripted([
            (prompt, tools) => {
              assert.strictEqual(images(prompt), 1);
              assert.notInclude(textOf(prompt), "DOM_ONLY_CANARY");
              assert.notInclude(
                tools.map((tool) => tool.name),
                "browser_snapshot",
              );
              assert.notInclude(
                tools.map((tool) => tool.name),
                "browser_select",
              );
              const click = tools.find((tool) => tool.name === "browser_click");
              const wait = tools.find((tool) => tool.name === "browser_wait");

              assert.isFalse(Schema.is(click!.parametersSchema)({ ref: "e1" }));
              assert.notInclude(
                JSON.stringify(Schema.toJsonSchemaDocument(wait!.parametersSchema)),
                '"text"',
              );

              return [
                call("browser_click", { x: 100, y: 95 }),
                call("browser_press", { keys: "ControlOrMeta+A" }),
                call("browser_type", { text: "pixels" }),
                finish,
              ];
            },
            (prompt) => {
              assert.strictEqual(images(prompt), 2);
              assert.notInclude(textOf(prompt), "DOM_ONLY_CANARY");

              return [
                call("browser_click", { ref: "e1" }),
                call("browser_type", { text: "must not run" }),
                finish,
              ];
            },
            (prompt) => {
              assert.match(JSON.stringify(results(prompt).at(-1)?.result), /not executed/i);
              assert.notInclude(textOf(prompt), "DOM_ONLY_CANARY");

              return [call("done", { answer: "done" }), finish];
            },
          ]);

          yield* Arms.vision.operate(input(page)).pipe(Effect.provide(model.layer));
          assert.strictEqual(yield* value(page, "#amount"), "pixels");
        }).pipe(Effect.scoped),
    );

    it.effect(
      "arm 3 maps numbered click/type/select through pixels and rejects IDs from an earlier view",
      () =>
        Effect.gen(function* () {
          const page = yield* open;
          const parsedImages: Array<Perception.Image> = [];

          const perception = perceptionFixture({
            parse: (image) =>
              Effect.sync(() => {
                parsedImages.push(image);

                return { observation: identity(image), provenance: parseProvenance, elements };
              }),
          });

          const model = scripted([
            (prompt) => {
              assert.strictEqual(images(prompt), 0);
              assert.notInclude(textOf(prompt), "DOM_ONLY_CANARY");
              assert.include(textOf(prompt), "Parsed view 1");

              return [
                call("browser_type", { view: 1, id: 1, text: "numbered" }),
                call("browser_select", { view: 1, id: 2, label: "United States" }),
                call("browser_click", { view: 1, id: 3 }),
                finish,
              ];
            },
            (prompt) => {
              assert.include(textOf(prompt), "Parsed view 2");
              assert.strictEqual(images(prompt), 0);

              return [
                call("browser_type", { view: 1, id: 1, text: "stale" }),
                call("browser_click", { view: 2, id: 3 }),
                finish,
              ];
            },
            (prompt) => {
              assert.match(JSON.stringify(results(prompt).at(-2)?.result), /stale parsed view/i);
              assert.match(JSON.stringify(results(prompt).at(-1)?.result), /not executed/i);

              return [call("done", { answer: "done" }), finish];
            },
          ]);

          yield* Arms.parsed.operate(input(page)).pipe(Effect.provide([model.layer, perception]));
          assert.strictEqual(yield* value(page, "#amount"), "numbered");
          assert.strictEqual(yield* value(page, "#country"), "United States");
          assert.strictEqual(yield* output(page), "numbered United States");
          assert.lengthOf(parsedImages, 4);
          assert.isTrue(
            parsedImages.every((image) => image.data.length > 0 && image.page === page.id),
          );
        }).pipe(Effect.scoped),
    );

    it.effect("arm 3 invalidates coordinates after navigation to the same URL", () =>
      Effect.gen(function* () {
        const page = yield* open;

        const model = scripted([
          () => [
            call("browser_navigate", { url: "http://arms.test/first" }),
            call("browser_type", { view: 1, id: 1, text: "must not run" }),
            finish,
          ],
          (prompt) => {
            assert.match(JSON.stringify(results(prompt).at(-1)?.result), /stale parsed view/i);

            return [call("done", { answer: "done" }), finish];
          },
        ]);

        yield* Arms.parsed
          .operate(input(page))
          .pipe(Effect.provide([model.layer, perceptionFixture()]));
        assert.strictEqual(yield* value(page, "#amount"), "old");
      }).pipe(Effect.scoped),
    );

    it.effect("arm 3 accounts a completed model call before a subsequent parser failure", () =>
      Effect.gen(function* () {
        const page = yield* open;
        let parses = 0;
        let charged = 0;

        const perception = perceptionFixture({
          parse: (image) =>
            Effect.suspend(() => {
              parses += 1;

              return parses === 1
                ? Effect.succeed({
                    observation: identity(image),
                    provenance: parseProvenance,
                    elements,
                  })
                : Effect.fail(new Perception.PerceptionError({ reason: "Unavailable" }));
            }),
        });

        const model = scripted([() => [call("browser_wait", { seconds: 0 }), finish]]);

        const failure = yield* Arms.parsed
          .operate({
            ...input(page),
            onUsage: (usage) =>
              Effect.sync(() => {
                charged += usage.inputTokens;
              }),
          })
          .pipe(Effect.provide([model.layer, perception]), Effect.flip);

        assert.strictEqual(failure._tag, "PerceptionError");
        assert.strictEqual(charged, 100);
        assert.lengthOf(model.prompts, 1);
      }).pipe(Effect.scoped),
    );

    it.effect(
      "arm 4 grounds on the selected new tab and rejects a changed image before any click",
      () =>
        Effect.gen(function* () {
          const first = yield* open;
          const browser = yield* Browser;
          let grounded = 0;
          let groundedPage = "";

          const perception = perceptionFixture({
            ground: (image) =>
              Effect.gen(function* () {
                grounded += 1;
                groundedPage = image.page;
                const active = (yield* browser.pages).find((page) => page.id === image.page);

                assert.isDefined(active);
                if (grounded === 2)
                  yield* Effect.promise(() =>
                    active!.playwright.locator("h1").evaluate((element) => {
                      element.textContent = "Changed during grounding";
                    }),
                  );

                return {
                  observation: identity(image),
                  provenance: groundProvenance,
                  x: 100,
                  y: 195,
                };
              }),
          });

          const model = scripted([
            () => [
              call("browser_tabs", { action: "new", url: "http://arms.test/second" }),
              call("click_described", { what: "Submit" }),
              finish,
            ],
            () => [
              call("click_described", { what: "Submit" }),
              call("browser_type", { text: "must not run" }),
              finish,
            ],
            (prompt) => {
              assert.match(JSON.stringify(results(prompt).at(-2)?.result), /image changed/i);
              assert.match(JSON.stringify(results(prompt).at(-1)?.result), /not executed/i);

              return [call("done", { answer: "done" }), finish];
            },
          ]);

          yield* Arms.grounder
            .operate(input(first))
            .pipe(Effect.provide([model.layer, perception]));
          const second = (yield* browser.pages).find((page) => page.id === groundedPage);

          assert.isDefined(second);
          assert.notStrictEqual(second!.id, first.id);
          assert.strictEqual(yield* output(first), "");
          assert.strictEqual(yield* output(second!), "old Canada");
          assert.strictEqual(yield* value(second!, "#amount"), "old");

          const clicks = (yield* browser.recentEvents).filter(
            (event) =>
              event._tag === "Action" && event.name === "click" && event.page === second!.id,
          );

          assert.lengthOf(clicks, 1);
        }).pipe(Effect.scoped),
    );

    it.effect(
      "understanding arms retain every timed frame; 1/4/5 remain the exact shipping control",
      () =>
        Effect.gen(function* () {
          const page = yield* open;
          const captured = yield* Moment.capture(page, { frames: 1 });
          const finalFrame = captured.frames[0]!;

          const earlier = new Frame({
            ...finalFrame,
            timing: new Screenshot({ hostTime: finalFrame.hostTime - 1000, uncertaintyMillis: 0 }),
          });

          const moment = new Moment.Moment({ ...captured, frames: [earlier, finalFrame] });
          const controls: Array<Prompt.Prompt> = [];

          for (const arm of [1, 4, 5] as const) {
            const model = scripted([
              (prompt) => {
                controls.push(prompt);

                return [
                  { type: "text", text: '{"seen":true}' },
                  { ...finish, reason: "stop" },
                ];
              },
            ]);

            const result = yield* Arms.strategies[arm]
              .understand({
                moment,
                schema: Schema.Struct({ seen: Schema.Boolean }),
                instructions: "Compare the frames.",
                onUsage: () => Effect.void,
              })
              .pipe(Effect.provide([model.layer, perceptionFixture()]));

            assert.deepStrictEqual(result.answer, { seen: true });
          }
          assert.deepStrictEqual(controls[0], controls[1]);
          assert.deepStrictEqual(controls[1], controls[2]);
          assert.include(textOf(controls[0]!), "DOM_ONLY_CANARY");
          const parsedTimes: Array<number> = [];

          for (const arm of [2, 3] as const) {
            const model = scripted([
              (prompt) => {
                assert.notInclude(textOf(prompt), "DOM_ONLY_CANARY");
                assert.strictEqual(images(prompt), arm === 2 ? 2 : 0);
                assert.include(textOf(prompt), "-1.0s:");

                return [
                  { type: "text", text: '{"seen":true}' },
                  { ...finish, reason: "stop" },
                ];
              },
            ]);

            yield* Arms.strategies[arm]
              .understand({
                moment,
                schema: Schema.Struct({ seen: Schema.Boolean }),
                instructions: "Compare the frames.",
                onUsage: () => Effect.void,
              })
              .pipe(
                Effect.provide([
                  model.layer,
                  perceptionFixture({
                    parse: (image) =>
                      Effect.sync(() => {
                        parsedTimes.push(image.at);

                        return {
                          observation: identity(image),
                          provenance: parseProvenance,
                          elements,
                        };
                      }),
                  }),
                ]),
              );
          }
          assert.deepStrictEqual(
            parsedTimes,
            moment.frames.map((frame) => frame.hostTime),
          );
        }).pipe(Effect.scoped),
    );

    it.effect(
      "the task seam shares graders and preserves strategy services/errors without exposing truth",
      () =>
        Effect.gen(function* () {
          const task = tasks.find((candidate) => candidate.name === "chart-trade")!;
          const phases: Array<string> = [];
          const keys: Array<string> = [];

          const strategy: Arms.Strategy<StrategyFailure, StrategyMarker> = {
            operate: (operation) =>
              Effect.gen(function* () {
                keys.push(...Object.keys(operation));
                if ((yield* StrategyMarker).stop) return yield* new StrategyFailure();

                return yield* Arms.current.operate(operation);
              }),
            understand: (operation) => Arms.current.understand(operation),
          };

          const model = scripted([
            (prompt) => [
              call("browser_type", { ref: ref(prompt, "textbox", "Quantity (BTC)"), text: "0.25" }),
              call("browser_click", { ref: ref(prompt, "button", "Place order") }),
              finish,
            ],
            (prompt) => [
              call("done", { answer: { orderId: /ORD-\d+/.exec(textOf(prompt))?.[0] ?? "" } }),
              finish,
            ],
          ]);

          const options = {
            seed: 25,
            onUsage: () => Effect.void,
            onPhase: (phase: "prepare" | "run" | "grade") =>
              Effect.sync(() => {
                phases.push(phase);
              }),
          };

          const result = yield* task
            .withStrategy(strategy, options)
            .pipe(
              Effect.provide(model.layer),
              Effect.provideService(StrategyMarker, { stop: false }),
            );

          assert.isTrue(result.pass);
          assert.deepStrictEqual(phases, ["prepare", "run", "grade"]);
          assert.deepStrictEqual(keys.sort(), ["maxSteps", "onUsage", "page", "prompt", "schema"]);

          const failure = yield* task
            .withStrategy(strategy, options)
            .pipe(
              Effect.provide(model.layer),
              Effect.provideService(StrategyMarker, { stop: true }),
              Effect.flip,
            );

          assert.strictEqual(failure._tag, "StrategyFailure");
        }),
    );
  },
);
