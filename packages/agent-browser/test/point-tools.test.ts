import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Testing from "effect-browser/testing";

const script: Testing.Script = {
  documents: [
    {
      url: "https://canvas.test/",
      text: "Canvas",
      controls: [
        {
          id: "button",
          kind: "input",
          inputType: "checkbox",
          label: "Region",
          facts: { box: { x: 20, y: 20, width: 100, height: 100 } },
        },
      ],
    },
  ],
};

it.effect(
  "both point tools use the bound Page and keep native hit-test facts out of model results",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* Testing.open(script);
        const page = browser.initialPage;
        const peer = yield* browser.createPage();

        yield* browser.selectPage(peer);

        const host = yield* BrowserTools.makeHost(browser, page, {
          policy: { admit: () => false },
          coordinatePolicy: { admit: (point) => point.x === 40 },
        });

        const tools = yield* BrowserTools.nativeToolkit.pipe(Effect.provide(host.nativeHandlers));

        const observed = yield* BrowserTools.observedNativeToolkit.pipe(
          Effect.provide(host.observedHandlers),
        );

        const result = yield* Stream.runCollect(
          yield* tools.handle("browser_click_at", { x: 40, y: 50 }),
        );

        expect(result).toMatchObject([{ isFailure: false, encodedResult: { dispatched: true } }]);
        expect(
          (yield* page.observe()).controls.find((control) => control.elementId === "button")
            ?.checked,
        ).toBe(true);

        const followed = yield* Stream.runCollect(
          yield* observed.handle("browser_click_at_and_inspect", { x: 40, y: 50 }),
        );

        expect(followed).toMatchObject([
          {
            isFailure: false,
            encodedResult: { action: { dispatched: true }, observation: { _tag: "Available" } },
          },
        ]);
        expect(JSON.stringify(followed)).not.toMatch(/backendNodeId|hitTest/);
        expect(
          (yield* page.observe()).controls.find((control) => control.elementId === "button")
            ?.checked,
        ).toBe(false);

        const denied = yield* Stream.runCollect(
          yield* tools.handle("browser_click_at", { x: 30, y: 50 }, "denied-point"),
        );

        expect(denied).toMatchObject([
          { isFailure: true, encodedResult: { reason: "denied", outcome: "undispatched" } },
        ]);
        expect((yield* host.toolFailures).failures.at(-1)).toMatchObject({
          toolName: "browser_click_at",
          toolCallId: "denied-point",
          error: { operation: "pointer-click", reason: { _tag: "Denied" } },
        });
      }),
    ),
);
