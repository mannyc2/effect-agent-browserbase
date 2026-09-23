import { ScriptedModel, type ScriptedTurnInput } from "@effect-agent/testing/scripted-model";
import { NodeCrypto } from "@effect/platform-node";
import { expect, it } from "@effect/vitest";
import { Effect, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import type { AgentPolicyInput } from "effect-agent/agent-policy";
import * as AgentRuntime from "effect-agent/agent-runtime";
import * as InMemory from "effect-agent/in-memory";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy, type Observation } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import { type LanguageModel, Model, Toolkit } from "effect/unstable/ai";

import { inspectionObservation } from "../fixtures/Inspection.ts";
import { toolSite } from "../fixtures/ToolSite.ts";

const usage = { inputTokens: {}, outputTokens: {} };

const calls = (...parts: ReadonlyArray<readonly [string, string, unknown]>): ScriptedTurnInput => ({
  _tag: "Stream",
  parts: [
    ...parts.map(([id, name, params]) => ({ type: "tool-call" as const, id, name, params })),
    { type: "finish", reason: "tool-calls", usage },
  ],
  termination: { _tag: "Complete" },
});

const answer = (
  assertRequest?: (request: LanguageModel.ProviderOptions) => void,
): ScriptedTurnInput => ({
  _tag: "Stream",
  parts: [
    { type: "text-start", id: "answer" },
    { type: "text-delta", id: "answer", delta: '{"done":true}' },
    { type: "text-end", id: "answer" },
    { type: "finish", reason: "stop", usage },
  ],
  termination: { _tag: "Complete" },
  ...(assertRequest === undefined ? {} : { assertRequest }),
});

const results = (request: LanguageModel.ProviderOptions) =>
  request.prompt.content.flatMap((message) =>
    message.role === "tool" ? message.content.filter((part) => part.type === "tool-result") : [],
  );

const id = (observation: Observation, label: string) => {
  const control = observation.controls.find((candidate) => candidate.label === label);

  if (control === undefined) throw new Error(`No observed control labelled ${label}`);

  return control.elementId;
};

const toolkit = Toolkit.merge(
  BrowserTools.toolkit,
  BrowserTools.readingToolkit,
  BrowserTools.formToolkit,
);

const agent = (policy: Partial<AgentPolicyInput> = BrowserTools.policy()) =>
  Agent.make("form-browser", {
    input: Schema.String,
    output: Schema.Struct({ done: Schema.Boolean }),
    instructions: BrowserTools.instructions(toolkit),
    toolkit,
    policy: { maxTurns: 8, maxToolCalls: 12, maxDuration: "30 seconds", ...policy },
  });

const chromium = Chromium.layer({
  launch: {
    ...(process.env.BROWSERBASE_CHROMIUM === undefined
      ? {}
      : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
    chromiumSandbox: false,
    startupTimeoutMillis: 25000,
  },
  viewport: { width: 640, height: 480 },
}).pipe(Layer.provide(NodeCrypto.layer));

const scripted = (turns: ReadonlyArray<ScriptedTurnInput>) =>
  Layer.mergeAll(
    ScriptedModel.layer(turns),
    Layer.succeed(Model.ProviderName, "scripted"),
    Layer.succeed(Model.ModelName, "forms"),
    InMemory.layer,
  );

/** The whole form from one observation: the parameters are filled in from the actual reading. */
const signup = (observation: Observation) => ({
  observationId: observation.observationId,
  fields: [
    { elementId: id(observation, "Email"), value: "ada@example.test" },
    { elementId: id(observation, "Password"), value: "PRIVATE-SECRET" },
    { elementId: id(observation, "I accept the terms"), checked: true },
    { elementId: id(observation, "Plan"), options: [id(observation, "Pro")] },
  ],
  submit: id(observation, "Create account"),
});

it.live("real AgentRuntime: one browser_fill_form call sets a whole form and submits it once", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* toolSite;
      const form = {};

      yield* Browser.scoped(
        Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 })),
        (browser) =>
          Effect.gen(function* () {
            const host = yield* BrowserTools.makeHost(browser, { maxControls: 32 });

            const run = yield* host.run(
              AgentRuntime.run(agent(), "Create an account on the Pro plan.").pipe(
                Effect.provide(
                  scripted([
                    calls(["navigate", "browser_navigate", { url: `${site.url}signup` }]),
                    calls(["inspect", "browser_inspect", {}]),
                    {
                      ...calls(["form", "browser_fill_form", form]),
                      assertRequest: (request) => {
                        Object.assign(form, signup(inspectionObservation(request)));
                      },
                    },
                    answer((request) => {
                      expect(results(request).at(-1)).toMatchObject({
                        name: "browser_fill_form",
                        isFailure: false,
                        result: { submitted: true },
                      });
                      expect(JSON.stringify(results(request).at(-1))).not.toContain("PRIVATE-");
                    }),
                  ]),
                ),
              ),
            );

            expect(run.output.done).toBe(true);
            expect((yield* browser.readText({ selector: "#result" })).text).toBe(
              "Created ada@example.test on pro with terms",
            );
            expect((yield* host.toolFailures).failures).toEqual([]);
          }),
      ).pipe(Effect.provide(chromium));
    }),
  ),
);

it.live(
  "real AgentRuntime: a batched response is refused after its first action, and the policy helper lets the run recover",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* toolSite;
        const email = { observationId: "unobserved", elementId: "unobserved" };
        const password = { ...email };
        const terms = { ...email };
        const create = { ...email };
        const form = {};

        const batch = [
          calls(["navigate", "browser_navigate", { url: `${site.url}signup` }]),
          calls(["inspect", "browser_inspect", {}]),
          {
            ...calls(
              ["email", "browser_fill", { reference: email, value: "ada@example.test" }],
              ["password", "browser_fill", { reference: password, value: "PRIVATE-SECRET" }],
              ["terms", "browser_click", terms],
              ["create", "browser_click", create],
            ),
            assertRequest: (request: LanguageModel.ProviderOptions) => {
              const observation = inspectionObservation(request);

              for (const [target, label] of [
                [email, "Email"],
                [password, "Password"],
                [terms, "I accept the terms"],
                [create, "Create account"],
              ] as const)
                Object.assign(target, {
                  observationId: observation.observationId,
                  elementId: id(observation, label),
                });
            },
          },
        ];

        yield* Browser.scoped(
          Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 })),
          (browser) =>
            Effect.gen(function* () {
              const host = yield* BrowserTools.makeHost(browser, { maxControls: 32 });

              // The engine's default of three consecutive failures ends the run right there.
              const strict = yield* host
                .run(
                  AgentRuntime.run(
                    agent({ repeatedFailureLimit: 3 }),
                    "Create an account on the Pro plan.",
                  ).pipe(Effect.provide(scripted([...batch, answer()]))),
                )
                .pipe(Effect.flip);

              expect(strict).toMatchObject({ _tag: "AgentPolicyError" });
              expect((yield* browser.readText({ selector: "#result" })).text).toBe("Not created");

              const run = yield* host.run(
                AgentRuntime.run(agent(), "Create an account on the Pro plan.").pipe(
                  Effect.provide(
                    scripted([
                      ...batch,
                      {
                        ...calls(["again", "browser_inspect", {}]),
                        assertRequest: (request) => {
                          const batched = results(request).slice(-4);

                          // Declared order: the first fill ran, and it retired the observation
                          // the rest named, so nothing else was sent.
                          expect(batched.map((part) => [part.id, part.isFailure])).toEqual([
                            ["email", false],
                            ["password", true],
                            ["terms", true],
                            ["create", true],
                          ]);
                          for (const refused of batched.slice(1))
                            expect(refused.result).toMatchObject({
                              reason: "stale",
                              outcome: "undispatched",
                            });
                        },
                      },
                      {
                        ...calls(["form", "browser_fill_form", form]),
                        assertRequest: (request) => {
                          Object.assign(form, signup(inspectionObservation(request)));
                        },
                      },
                      answer(),
                    ]),
                  ),
                ),
              );

              expect(run.output.done).toBe(true);
              expect((yield* browser.readText({ selector: "#result" })).text).toBe(
                "Created ada@example.test on pro with terms",
              );
            }),
        ).pipe(Effect.provide(chromium));
      }),
    ),
);

it.live(
  "real AgentRuntime: find reaches a control the limit crowded out, and read_more continues long text",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const site = yield* toolSite;
        const create = { observationId: "unobserved", elementId: "unobserved" };
        const more = { observationId: "unobserved" };

        yield* Browser.scoped(
          Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 60000 })),
          (browser) =>
            Effect.gen(function* () {
              const host = yield* BrowserTools.makeHost(browser, { maxTextBytes: 4096 });

              const run = yield* host.run(
                AgentRuntime.run(agent(), "Create the account, then read the terms.").pipe(
                  Effect.provide(
                    scripted([
                      calls(["navigate", "browser_navigate", { url: `${site.url}signup` }]),
                      calls(["inspect", "browser_inspect", {}]),
                      {
                        ...calls([
                          "find",
                          "browser_inspect",
                          { find: "create", scope: "document" },
                        ]),
                        assertRequest: (request) => {
                          const crowded = inspectionObservation(request);

                          expect(crowded.controls).toHaveLength(16);
                          expect(crowded.controlsTruncated).toBe(true);
                          expect(crowded.controls.map((control) => control.label)).not.toContain(
                            "Create account",
                          );
                        },
                      },
                      {
                        ...calls(["create", "browser_click", create]),
                        assertRequest: (request) => {
                          const found = inspectionObservation(request);

                          expect(found.match).toBe("create");
                          expect(found.controls.map((control) => control.label)).toEqual([
                            "Create account",
                          ]);
                          Object.assign(create, {
                            observationId: found.observationId,
                            elementId: id(found, "Create account"),
                          });
                        },
                      },
                      calls(["document", "browser_inspect", { scope: "document" }]),
                      {
                        ...calls(["more", "browser_read_more", more]),
                        assertRequest: (request) => {
                          const whole = inspectionObservation(request);

                          expect(whole.textTruncated).toBe(true);
                          expect(whole.text).toContain("Created on free");
                          expect(whole.text).not.toContain("END OF TERMS");
                          Object.assign(more, { observationId: whole.observationId });
                        },
                      },
                      answer((request) => {
                        const next = results(request).at(-1);

                        expect(next).toMatchObject({
                          name: "browser_read_more",
                          isFailure: false,
                          result: { remaining: false, textTruncated: false },
                        });
                        expect(JSON.stringify(next?.result)).toContain("END OF TERMS");
                      }),
                    ]),
                  ),
                ),
              );

              expect(run.output.done).toBe(true);
              expect((yield* host.toolFailures).failures).toEqual([]);
            }),
        ).pipe(Effect.provide(chromium));
      }),
    ),
);
