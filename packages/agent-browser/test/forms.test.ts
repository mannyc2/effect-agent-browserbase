import { expect, it } from "@effect/vitest";
import { ScriptedModel, type ScriptedTurnInput } from "@yielded/agent-testing/scripted-model";
import * as Agent from "@yielded/agent/agent";
import * as AgentRuntime from "@yielded/agent/agent-runtime";
import * as InMemory from "@yielded/agent/in-memory";
import { Effect, Exit, Layer, Schema, Scope, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import { Reasons } from "effect-browser/errors";
import { Model, Toolkit } from "effect/ai";

import { fixtureScript, scriptedSession } from "./fixtures/ScriptedSession.ts";

const url = "https://example.test/";

const request = {
  observationId: "observation-1",
  fields: [
    { elementId: "element-1", value: "ada@example.test" },
    { elementId: "element-2", checked: true },
    { elementId: "element-3", options: ["element-4"] },
  ],
  submit: "element-5",
};

const tools = Toolkit.merge(BrowserTools.formToolkit, BrowserTools.observedFormToolkit);

const fill = (
  ready: Toolkit.WithHandler<Toolkit.Tools<typeof tools>>,
  params: unknown = request,
  name: "browser_fill_form" | "browser_fill_form_and_inspect" = "browser_fill_form",
) =>
  // @ts-expect-error Each test pairs the parameters with the Tool it calls.
  ready.handle(name, params, "form-call").pipe(Effect.flatMap(Stream.runCollect));

const fields = [
  { elementId: "element-1", status: "set" as const },
  { elementId: "element-2", status: "unchanged" as const },
  { elementId: "element-3", status: "set" as const },
];

const stoppedScript = (withClick = false) => ({
  documents: fixtureScript.documents.map((document) => ({
    ...document,
    controls: document.controls?.map((control) =>
      control.id === "element-3"
        ? { ...control, disabled: true }
        : withClick && control.id === "element-2"
          ? { ...control, checked: false }
          : control,
    ),
  })),
});

it.effect("a completed form reports actual fields and forwards host policy and options", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const calls: Array<unknown> = [];
      const labels: string[] = [];

      const browser = yield* scriptedSession({
        beforeStart: (action, options) =>
          Effect.sync(() => {
            if (action._tag === "FillForm")
              calls.push({ form: action.options, inputs: Object.keys(options?.inputs ?? {}) });
          }),
      });

      const host = yield* BrowserTools.makeHost(browser, browser.initialPage, {
        policy: {
          admit: (facts) => {
            labels.push(facts.label);

            return true;
          },
        },
        form: { verify: false, settleMillis: 0 },
      });

      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        { isFailure: false, encodedResult: { fields, submitted: true, url } },
      ]);
      expect(calls).toEqual([{ form: { verify: false, settleMillis: 0 }, inputs: ["field-0"] }]);
      expect(labels).toContain("Name");
      expect(labels).toContain("Send");
      expect((yield* browser.control.document.values).get("element-1")).toBe("ada@example.test");
      const receipts = yield* host.receipts;

      expect(receipts.receipts).toHaveLength(1);
      const receipt = receipts.receipts[0];

      if (receipt?._tag !== "Run") return yield* Effect.die("Expected original form run");
      expect((yield* receipt.operation.attempts).attempts).toMatchObject([
        { action: "FillForm", outcome: "performed", completed: true },
      ]);
    }),
  ),
);

it.effect("a stopped form preserves actual completed fields and its native refusal", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scriptedSession({ script: stoppedScript() });
      const host = yield* BrowserTools.makeHost(browser, browser.initialPage);
      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "disabled",
            outcome: "undispatched",
            stage: "field",
            elementId: "element-3",
            completed: fields.slice(0, 2),
          },
        },
      ]);
      expect((yield* host.toolFailures).failures).toMatchObject([
        {
          toolName: "browser_fill_form",
          toolCallId: "form-call",
          error: { operation: "fill-form", reason: { _tag: "Disabled" }, outcome: "undispatched" },
        },
      ]);
    }),
  ),
);

it.effect.each([
  ["verify", 3, undefined],
  ["submit", 4, "element-5"],
] as const)(
  "a form stopped at %s reports every completed field and the control the model named",
  ([stage, passes, elementId]) =>
    Effect.scoped(
      Effect.gen(function* () {
        const browser = yield* scriptedSession();
        const open = yield* browser.control.gate;

        // Every earlier fill-form step passes through an open gate; the next one is refused.
        yield* open.open;
        for (let step = 0; step < passes; step++)
          yield* browser.control.next("fill-form", { _tag: "Hold", gate: open, dispatched: true });
        yield* browser.control.next("fill-form", {
          _tag: "Fail",
          reason: Reasons.Stale.make({}),
          outcome: "undispatched",
        });

        const host = yield* BrowserTools.makeHost(browser, browser.initialPage);
        const ready = yield* tools.pipe(Effect.provide(host.layer));

        expect(yield* fill(ready)).toEqual([
          expect.objectContaining({
            isFailure: true,
            encodedResult: {
              _tag: "BrowserFormFailure",
              reason: "stale",
              outcome: "undispatched",
              stage,
              ...(elementId === undefined ? {} : { elementId }),
              completed: fields,
            },
          }),
        ]);
      }),
    ),
);

it.effect("an input callback failure preserves completed fields and the original form stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scriptedSession({ script: stoppedScript(true) });

      const host = yield* BrowserTools.makeHost(browser, browser.initialPage, {
        onInput: () => Effect.fail("PRIVATE-CALLBACK"),
      });

      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "disabled",
            outcome: "undispatched",
            stage: "field",
            elementId: "element-3",
            completed: [
              { elementId: "element-1", status: "set" },
              { elementId: "element-2", status: "set" },
            ],
          },
        },
      ]);
      expect((yield* host.toolFailures).failures).toMatchObject([
        { error: { reason: { _tag: "Disabled" } } },
      ]);
      expect(yield* host.failure.pipe(Effect.flip)).toBe("PRIVATE-CALLBACK");
    }),
  ),
);

it.effect("a callback failure after acknowledged submission preserves performed fields", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scriptedSession();

      const host = yield* BrowserTools.makeHost(browser, browser.initialPage, {
        onInput: () => Effect.fail("PRIVATE-CALLBACK"),
      });

      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "failed",
            outcome: "performed",
            completed: fields,
          },
        },
      ]);
      expect((yield* host.receipts).receipts).toHaveLength(1);
    }),
  ),
);

it.effect("a refused first field and a closed lane report no completed work", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scriptedSession();

      yield* browser.control.next("fill-form", {
        _tag: "Fail",
        reason: Reasons.Unsupported.make({}),
        outcome: "undispatched",
      });
      const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");

      const host = yield* BrowserTools.makeHost(browser, browser.initialPage).pipe(
        Scope.provide(scope),
      );

      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: { reason: "unsupported", outcome: "undispatched", completed: [] },
        },
      ]);
      const beforeClose = (yield* browser.control.calls).length;

      yield* Scope.close(scope, Exit.void);
      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: { reason: "closed", outcome: "undispatched", completed: [] },
        },
      ]);
      expect((yield* browser.control.calls).length).toBe(beforeClose);
    }),
  ),
);

it.effect("observed forms return a new reading and malformed parameters cause no input", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const browser = yield* scriptedSession();
      const host = yield* BrowserTools.makeHost(browser, browser.initialPage);
      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready, request, "browser_fill_form_and_inspect")).toMatchObject([
        {
          isFailure: false,
          encodedResult: {
            action: { submitted: true, url },
            observation: { _tag: "Available", observation: { observationId: "observation-3" } },
          },
        },
      ]);
      const before = (yield* browser.control.calls).length;

      for (const malformed of [
        { observationId: "o", fields: [] },
        { observationId: "o", fields: [{ elementId: "e", value: "x", checked: true }] },
        { observationId: "o", fields: [{ elementId: "e" }] },
        {
          observationId: "o",
          fields: [
            { elementId: "e", value: "x" },
            { elementId: "e", value: "y" },
          ],
        },
        { observationId: "o", fields: [{ elementId: "e", value: "x" }], submit: "e" },
      ]) {
        const exit = yield* Effect.exit(fill(ready, malformed));

        expect(Exit.isFailure(exit) || exit.value.every((result) => result.isFailure)).toBe(true);
      }
      expect((yield* browser.control.calls).length).toBe(before);
    }),
  ),
);

it.effect(
  "a form Tool gated for approval keeps the maintained handler, and a denial fails the run before it",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const forms: Array<unknown> = [];
        const asked: Array<unknown> = [];
        const usage = { inputTokens: {}, outputTokens: {} };

        const browser = yield* scriptedSession({
          beforeStart: (action) =>
            Effect.sync(() => {
              if (action._tag === "FillForm") forms.push(action);
            }),
        });

        // Only a form that would be sent asks first.
        const gated = Toolkit.make(
          BrowserTools.toolkit.tools.browser_inspect,
          BrowserTools.formToolkit.tools.browser_fill_form.setNeedsApproval(
            (params) => params.submit !== undefined,
          ),
        );

        const agent = Agent.make("gated-form", {
          input: Schema.String,
          output: Schema.Struct({ done: Schema.Boolean }),
          instructions: BrowserTools.instructions(gated),
          toolkit: gated,
          policy: BrowserTools.policy({ maxTurns: 4, maxToolCalls: 4, maxDuration: "30 seconds" }),
        });

        const call = (id: string, params: unknown): ScriptedTurnInput => ({
          _tag: "Stream",
          parts: [
            { type: "tool-call", id, name: "browser_fill_form", params },
            { type: "finish", reason: "tool-calls", usage },
          ],
          termination: { _tag: "Complete" },
        });

        const answer: ScriptedTurnInput = {
          _tag: "Stream",
          parts: [
            { type: "text-start", id: "answer" },
            { type: "text-delta", id: "answer", delta: '{"done":true}' },
            { type: "text-end", id: "answer" },
            { type: "finish", reason: "stop", usage },
          ],
          termination: { _tag: "Complete" },
        };

        const host = yield* BrowserTools.makeHost(browser, browser.initialPage);

        const run = (decision: "approved" | "denied", turns: ReadonlyArray<ScriptedTurnInput>) =>
          host.run(
            AgentRuntime.run(agent, "Create the account.", {
              approval: {
                request: ({ toolName, parameters }) =>
                  Effect.sync(() => {
                    asked.push({ toolName, parameters });

                    return decision === "approved"
                      ? { _tag: "approved" as const }
                      : { _tag: "denied" as const, reason: "A person sends this form." };
                  }),
              },
            }).pipe(
              Effect.provide(
                Layer.mergeAll(
                  ScriptedModel.layer(turns),
                  Layer.succeed(Model.ProviderName, "scripted"),
                  Layer.succeed(Model.ModelName, "gated"),
                  InMemory.layer,
                ),
              ),
            ),
          );

        const { submit: _, ...unsent } = request;
        const sent = { ...request, observationId: "observation-3" };

        const inspectTurn: ScriptedTurnInput = {
          _tag: "Stream",
          parts: [
            { type: "tool-call", id: "inspect", name: "browser_inspect", params: {} },
            { type: "finish", reason: "tool-calls", usage },
          ],
          termination: { _tag: "Complete" },
        };

        const approved = yield* run("approved", [
          call("fill", unsent),
          inspectTurn,
          call("send", sent),
          answer,
        ]);

        expect(approved.output.done).toBe(true);
        expect(forms).toHaveLength(2);
        expect(asked).toEqual([{ toolName: "browser_fill_form", parameters: sent }]);

        const denied = yield* run("denied", [call("send", sent), answer]).pipe(Effect.flip);

        expect(denied).toMatchObject({
          _tag: "AgentApprovalDenied",
          toolName: "browser_fill_form",
          message: "A person sends this form.",
        });
        expect(forms).toHaveLength(2);
        expect(asked).toHaveLength(2);
      }),
    ),
);
