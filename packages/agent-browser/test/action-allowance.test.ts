import { expect, it } from "@effect/vitest";
import { Effect, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Testing from "effect-browser/testing";
import { Toolkit } from "effect/unstable/ai";

const origin = "https://form.test";

const site: Testing.Script = {
  documents: [
    {
      url: `${origin}/`,
      text: "Sign up.",
      controls: [
        { id: "name", kind: "input", label: "Name", inputType: "text" },
        { id: "go", kind: "button", label: "Sign up", activates: `${origin}/done` },
      ],
    },
    { url: `${origin}/done`, text: "Thanks." },
  ],
};

const tools = Toolkit.merge(BrowserTools.observedToolkit, BrowserTools.observedFormToolkit);

it.effect(
  "an _and_inspect Tool spends its action and its follow-up reading from the owner's allowance",
  () =>
    Browser.scoped(
      Testing.open(site, { policy: BrowserPolicy.unrestricted({ maxActions: 8 }) }),
      (browser) =>
        Effect.gen(function* () {
          const host = yield* BrowserTools.makeHost(browser);
          const ready = yield* tools.pipe(Effect.provide(host.layer));

          const used = browser.status.pipe(Effect.map((status) => status.actions.used));

          const call = (name: "browser_navigate_and_inspect", params: { url: string }) =>
            ready.handle(name, params, name).pipe(Effect.flatMap(Stream.runCollect));

          // Navigation and its reading: two actions.
          expect(yield* call("browser_navigate_and_inspect", { url: `${origin}/` })).toMatchObject([
            { isFailure: false },
          ]);
          expect(yield* used).toBe(2);

          // One field, the submit and the reading: three actions; the verification is free.
          const filled = yield* ready
            .handle(
              "browser_fill_form_and_inspect",
              {
                observationId: "observation-1",
                fields: [{ elementId: "name", value: "Ada" }],
                submit: "go",
              },
              "form",
            )
            .pipe(Effect.flatMap(Stream.runCollect));

          expect(filled).toMatchObject([
            {
              isFailure: false,
              encodedResult: {
                action: { submitted: true, url: `${origin}/done` },
                observation: { _tag: "Available", observation: { url: `${origin}/done` } },
              },
            },
          ]);
          expect(yield* used).toBe(5);

          // The next navigation takes the sixth action and its reading the seventh; the eighth
          // is left, so a further action with its reading overruns only on the reading.
          yield* call("browser_navigate_and_inspect", { url: `${origin}/` });
          const last = yield* call("browser_navigate_and_inspect", { url: `${origin}/` });

          expect(last).toMatchObject([
            {
              isFailure: false,
              encodedResult: {
                observation: {
                  _tag: "Unavailable",
                  failure: { reason: "limit", outcome: "undispatched" },
                },
              },
            },
          ]);
          expect((yield* browser.status).actions).toEqual({ used: 8, maximum: 8 });
        }),
    ),
);
