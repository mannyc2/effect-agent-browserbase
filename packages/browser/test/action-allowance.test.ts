import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import * as Browser from "../src/Browser.ts";
import { BrowserPolicy, ObservedElement, ReadTextRequest } from "../src/BrowserData.ts";
import * as Testing from "../src/Testing.ts";

const origin = "https://form.test";

const site: Testing.Script = {
  documents: [
    {
      url: `${origin}/`,
      text: "Sign up.",
      controls: [
        { id: "name", kind: "input", label: "Name", inputType: "text" },
        { id: "news", kind: "input", label: "Newsletter", inputType: "checkbox" },
        { id: "go", kind: "button", label: "Sign up", activates: `${origin}/done` },
      ],
    },
    { url: `${origin}/done`, text: "Thanks." },
  ],
};

const read = ReadTextRequest.make({});

const used = (browser: Browser.AnySession) =>
  browser.status.pipe(Effect.map((status) => status.actions.used));

it.effect(
  "status counts every admitted action, each form step included, and no host or verification read",
  () =>
    Browser.scoped(
      Testing.open(site, { policy: BrowserPolicy.unrestricted({ maxActions: 20 }) }),
      (browser) =>
        Effect.gen(function* () {
          expect((yield* browser.status).actions).toEqual({ used: 0, maximum: 20 });
          yield* browser.navigate({ url: `${origin}/` });
          const observation = yield* browser.observe();

          // Host reads spend their own allowance, and reading status spends nothing.
          yield* browser.checkpoint({ picture: true });
          yield* browser.controlFacts(
            ObservedElement.make({ observationId: observation.observationId, elementId: "name" }),
          );
          expect(yield* used(browser)).toBe(2);

          // Two fields and the submit are three actions; the verification between them is not.
          const verified = yield* browser.fillForm({
            observationId: observation.observationId,
            fields: [
              { elementId: "name", value: "Ada" },
              { elementId: "news", checked: true },
            ],
            submit: "go",
          });

          expect({ submitted: verified.submitted, stopped: verified.stopped }).toEqual({
            submitted: true,
            stopped: undefined,
          });
          expect(yield* used(browser)).toBe(5);

          yield* browser.navigate({ url: `${origin}/` });
          const again = yield* browser.observe();

          const unverified = yield* browser.fillForm(
            {
              observationId: again.observationId,
              fields: [
                { elementId: "name", value: "Grace" },
                { elementId: "news", checked: true },
              ],
              submit: "go",
            },
            undefined,
            { verify: false },
          );

          expect(unverified.submitted).toBe(true);
          expect(yield* used(browser)).toBe(10);
          expect((yield* browser.status).actions).toEqual({ used: 10, maximum: 20 });
        }),
    ),
);

it.effect(
  "an allowance above the former 1,000 cap is spent to its maximum, then refused while open",
  () =>
    Browser.scoped(
      Testing.open(site, { policy: BrowserPolicy.unrestricted({ maxActions: 1001 }) }),
      (browser) =>
        Effect.gen(function* () {
          yield* browser.navigate({ url: `${origin}/` });
          for (let action = 1; action < 1001; action++) yield* browser.readText(read);
          expect((yield* browser.status).actions).toEqual({ used: 1001, maximum: 1001 });

          const refused = yield* browser.readText(read).pipe(Effect.flip);

          expect(refused).toMatchObject({
            reason: { _tag: "Limit", dimension: "actions", maximum: 1001, observed: 1001 },
            outcome: "undispatched",
          });
          // A refused action is not counted, and a spent allowance is not a terminal failure.
          expect(yield* browser.status).toMatchObject({
            phase: "open",
            reason: null,
            actions: { used: 1001, maximum: 1001 },
          });
          // Host reads keep their own allowance after the actions are spent.
          yield* browser.checkpoint({ picture: false });
        }),
    ),
);
