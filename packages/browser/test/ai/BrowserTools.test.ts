// The browser tools on a real Chromium page in a plain effect/ai loop, with the pictures before
// each turn, driven by scripted models: no model is called.
import * as Chromium from "@effect-browser/chromium/Chromium";
import { assert, it, layer } from "@effect/vitest";
import { Duration, Effect, Layer, Schema } from "effect";
import { AnthropicStructuredOutput, OpenAiStructuredOutput, Prompt, Toolkit } from "effect/ai";

import { refIn, Site, SiteLayer, textOf } from "../../../../tools/testing/agent-site.ts";
import * as BrowserTools from "../../src/ai/BrowserTools.ts";
import { Browser } from "../../src/Browser.ts";
import { answer, call, calling, loop, scripted, type Turn } from "./fixtures.ts";

const tools = BrowserTools.make();

const open = (path: string) =>
  Effect.gen(function* () {
    const browser = yield* Browser;
    const site = yield* Site;

    return yield* Effect.acquireRelease(browser.newPage(site.url(path)), (page) =>
      Effect.ignore(page.close),
    );
  });

const pictures = (prompt: Prompt.Prompt) =>
  prompt.content.flatMap((message) =>
    message.role === "user" ? message.content.filter((part) => part.type === "file") : [],
  );

const files = (message: Prompt.Message | undefined) =>
  message?.role === "user" ? message.content.filter((part) => part.type === "file") : [];

const references = (prompt: Prompt.Prompt) =>
  prompt.content.filter((message) => files(message).length > 0);

const run = (task: string, turns: ReadonlyArray<Turn>, options: BrowserTools.LayerOptions = {}) =>
  Effect.gen(function* () {
    const page = yield* open(task.includes("spin") ? "/slots" : "/form");
    const model = scripted(turns);

    const result = yield* loop(tools.toolkit, task).pipe(
      Effect.provide(Layer.merge(tools.layer({ page }, { task, ...options }), model.layer)),
    );

    return { page, result, prompts: model.prompts };
  });

layer(Layer.mergeAll(Chromium.layer(), SiteLayer), {
  excludeTestServices: true,
  timeout: Duration.seconds(60),
})("BrowserTools", (it) => {
  it.effect(
    "runs the tools on a page, showing the model the current screen before every turn",
    () =>
      Effect.gen(function* () {
        const { page, result, prompts } = yield* run("Order 25 Ethereum", [
          () => calling(call("observe", {})),
          (prompt) =>
            calling(
              call("act", {
                actions: [
                  { kind: "fill", ref: refIn(prompt, "textbox", "Amount"), value: "25" },
                  { kind: "select", ref: refIn(prompt, "combobox", "Coin"), value: "Ethereum" },
                  { kind: "click", ref: refIn(prompt, "button", "Submit") },
                ],
              }),
            ),
          () => answer("Ordered 25 Ethereum."),
        ]);

        assert.strictEqual(result, "Ordered 25 Ethereum.");
        assert.strictEqual(
          (yield* page.read(() => document.querySelector("#outcome")?.textContent ?? null, {
            arg: undefined,
            result: Schema.NullOr(Schema.String),
          })).value,
          "Ordered 25 eth",
        );
        assert.strictEqual(prompts.length, 3);
        // Each request shows the screen as it is, and never an earlier one.
        for (const prompt of prompts) {
          assert.strictEqual(pictures(prompt).length, 1);
          assert.strictEqual(prompt.content.at(-1)?.role, "user");
        }
        assert.include(textOf(prompts[2]!), '\\"Not ordered\\" became \\"Ordered 25 eth\\"');
      }),
  );

  it.effect("reads null as left out in the control tools' parameters, as models send it", () =>
    Effect.gen(function* () {
      const { prompts } = yield* run("Look around", [
        () =>
          calling(
            call("inspect", { selector: "form", frame: null, optionFilter: null }),
            call("scroll", { ref: null, deltaX: 0, deltaY: 100 }),
            call("wait", {
              selector: "form",
              frame: null,
              state: "visible",
              text: null,
              timeoutMillis: 500,
            }),
          ),
        () => answer("Looked around."),
      ]);

      const results = prompts[1]!.content.flatMap((message) =>
        message.role === "tool"
          ? message.content.flatMap((part) =>
              part.type === "tool-result" ? [[part.name, part.isFailure]] : [],
            )
          : [],
      );

      assert.deepStrictEqual(results, [
        ["inspect", false],
        ["scroll", false],
        ["wait", false],
      ]);
    }),
  );

  it.effect("plays a canvas by point, and shows a crop before the next turn", () =>
    Effect.gen(function* () {
      const { page, prompts } = yield* run("Press spin once", [
        () => calling(call("click_at", { x: 300, y: 320 }), call("wait_still", { seconds: 10 })),
        () => calling(call("zoom", { x: 50, y: 60, width: 150, height: 180 })),
        () => answer("Spun once."),
      ]);

      const { value: state } = yield* page.read(() => Reflect.get(window, "state"), {
        arg: undefined,
        result: Schema.Struct({ spins: Schema.Int }),
      });

      assert.strictEqual(state.spins, 1);
      assert.include(textOf(prompts[1]!), "The screen is still.");
      assert.strictEqual(pictures(prompts[2]!).length, 2);
      assert.include(textOf(prompts[2]!), "Zoom: viewport origin (50, 60), 150x180");
      // The crop is shown once, before the turn after it was taken.
      assert.strictEqual(pictures(prompts[1]!).length, 1);
    }),
  );

  it.effect("with placement by crop, shows a crop around a point before clicking in it", () =>
    Effect.gen(function* () {
      const { page, prompts } = yield* run(
        "Press spin once",
        [
          () => calling(call("click_at", { x: 300, y: 320 })),
          () => calling(call("click_at", { x: 302, y: 318 }), call("wait_still", { seconds: 10 })),
          () => answer("Spun once."),
        ],
        { placement: "crop" },
      );

      const { value: state } = yield* page.read(() => Reflect.get(window, "state"), {
        arg: undefined,
        result: Schema.Struct({ spins: Schema.Int }),
      });

      assert.strictEqual(state.spins, 1);
      assert.include(textOf(prompts[1]!), "Not done yet");
      assert.include(textOf(prompts[1]!), "Zoom: viewport origin (200, 260), 200x120");
      assert.include(textOf(prompts[2]!), "at (302, 318)");
    }),
  );

  it.effect("with device pixels, shows the screen at the device's scale and maps points back", () =>
    Effect.gen(function* () {
      const { page, prompts } = yield* run(
        "Press spin once",
        [
          () => calling(call("click_at", { x: 150, y: 160 }), call("wait_still", { seconds: 10 })),
          () => calling(call("zoom", { x: 25, y: 30, width: 75, height: 90 })),
          () => answer("Spun once."),
        ],
        { pixels: "device" },
      );

      const { value: state } = yield* page.read(() => Reflect.get(window, "state"), {
        arg: undefined,
        result: Schema.Struct({ spins: Schema.Int }),
      });

      assert.strictEqual(state.spins, 1);
      assert.include(textOf(prompts[0]!), "The current tab's viewport, 640x360.");
      // The receipt and the crop give the picture's coordinates back.
      assert.include(textOf(prompts[1]!), "(150, 160)");
      assert.include(textOf(prompts[2]!), "Zoom: viewport origin (25, 30), 75x90");
    }).pipe(Effect.provide(Chromium.layer({ deviceScaleFactor: 0.5 }))),
  );

  it.effect("shows no pictures without vision, and refuses a crop it could not show", () =>
    Effect.gen(function* () {
      const { prompts } = yield* run(
        "Press spin once",
        [
          () => calling(call("zoom", { x: 0, y: 0, width: 10, height: 10 })),
          () => answer("No crop."),
        ],
        { vision: false },
      );

      assert.deepStrictEqual(prompts.map(pictures), [[], []]);
      assert.include(textOf(prompts[1]!), "a crop cannot be shown");
      // The model is told the failure as the tools' own error.
      assert.deepStrictEqual(
        prompts[1]!.content.flatMap((message) =>
          message.role === "tool"
            ? message.content.flatMap((part) =>
                part.type === "tool-result"
                  ? [[part.isFailure, Reflect.get(Object(part.result), "_tag")]]
                  : [],
              )
            : [],
        ),
        [[true, "ToolError"]],
      );
    }),
  );

  it.effect("with vision ask, shows the screen only after look, and a crop on its own", () =>
    Effect.gen(function* () {
      const page = yield* open("/form");

      const model = scripted([
        () => calling(call("observe", {})),
        () => calling(call("look", {})),
        () => calling(call("zoom", { x: 0, y: 0, width: 200, height: 100 })),
        () => answer("Looked."),
      ]);

      yield* loop(Toolkit.merge(tools.toolkit, BrowserTools.Look), "Look at the form").pipe(
        Effect.provide(Layer.merge(tools.layer({ page }, { vision: "ask" }), model.layer)),
      );

      assert.deepStrictEqual(
        model.prompts.map((prompt) => pictures(prompt).length),
        [0, 0, 1, 1],
      );
      assert.include(textOf(model.prompts[2]!), "The current tab's viewport");
      assert.include(textOf(model.prompts[3]!), "Zoom: viewport origin (0, 0), 200x100");
      assert.notInclude(textOf(model.prompts[3]!), "The current tab's viewport");
    }),
  );

  it.effect("with vision page, shows the screen after pointer input and over a canvas", () =>
    Effect.gen(function* () {
      const form = yield* run(
        "Hover the amount",
        [
          () => calling(call("observe", {})),
          (prompt) => calling(call("hover", { ref: refIn(prompt, "textbox", "Amount") })),
          () => calling(call("observe", {})),
          () => answer("Hovered."),
        ],
        { vision: "page" },
      );

      assert.deepStrictEqual(
        form.prompts.map((prompt) => pictures(prompt).length),
        [0, 0, 1, 0],
      );

      const slots = yield* run("Look at the spin", [() => answer("Seen.")], { vision: "page" });

      assert.strictEqual(pictures(slots.prompts[0]!).length, 1);
    }),
  );

  // #293 discussion_r4249413869: a crop's coordinates cannot be used after selecting another tab.
  it.effect("keeps queued crops out of a newly selected tab", () =>
    Effect.gen(function* () {
      const browser = yield* Chromium.make();
      const site = yield* Site;

      yield* browser.newPage(site.url("/form"));
      yield* browser.newPage(site.url("/next"));

      const model = scripted([
        () => calling(call("observe", {})),
        () =>
          calling(
            call("zoom", { x: 0, y: 0, width: 100, height: 100 }),
            call("select_tab", { ref: "tab2" }),
          ),
        () => answer("Selected the next page."),
      ]);

      yield* loop(tools.toolkit, "Inspect the first tab, then select the next.").pipe(
        Effect.provide(Layer.merge(tools.layer({ browser }), model.layer)),
      );
      const shown = references(model.prompts.at(-1)!).at(-1);

      assert.strictEqual(files(shown).length, 1, "the new tab has only its own screenshot");
      assert.notInclude(textOf(Prompt.fromMessages([shown!])), "Zoom:");
    }).pipe(Effect.scoped),
  );
});

it("gives every tool parameters both pinned providers' structured outputs accept", () => {
  const all = {
    ...BrowserTools.make().toolkit.tools,
    ...BrowserTools.make({ mode: "single" }).toolkit.tools,
  };

  // Each provider's codec takes any schema; a tool's own parameters are one.
  const schemas: ReadonlyArray<[string, Schema.Top]> = Object.entries(all).map(([name, tool]) => [
    name,
    tool.parametersSchema,
  ]);

  const refused = schemas.flatMap(([name, schema]) =>
    [OpenAiStructuredOutput.toCodecOpenAI, AnthropicStructuredOutput.toCodecAnthropic].flatMap(
      (codec) => {
        try {
          codec(schema);

          return [];
        } catch (error) {
          return [`${name}: ${String(error)}`];
        }
      },
    ),
  );

  assert.deepStrictEqual(refused, []);
});
