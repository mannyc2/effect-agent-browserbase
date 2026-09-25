import { ScriptedModel, type ScriptedTurnInput } from "@effect-agent/testing/scripted-model";
import { expect, it } from "@effect/vitest";
import { Effect, Exit, Layer, Schema, Scope, Stream } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import * as InMemory from "effect-agent/in-memory";
import {
  FillFormResult,
  FormStop,
  InputReceipt,
  Observation,
  Target,
} from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";
import { Model, Toolkit } from "effect/unstable/ai";

import { scriptedSession } from "./fixtures/ScriptedSession.ts";

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
];

it.effect(
  "a completed form reports each field and the submit, and passes host options through",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const calls: Array<unknown> = [];

        const browser = scriptedSession({
          fillForm: (form, admission, options) =>
            Effect.sync(() => {
              calls.push({ form, admitted: admission?.admit({} as never), options });

              return FillFormResult.make({ fields, submitted: true, url });
            }),
        });

        const host = yield* BrowserTools.makeHost(browser, {
          admission: { admit: () => true },
          form: { verify: false, settleMillis: 0 },
        });

        const ready = yield* tools.pipe(Effect.provide(host.layer));

        expect(yield* fill(ready)).toMatchObject([
          { isFailure: false, encodedResult: { fields, submitted: true, url } },
        ]);
        expect(calls).toEqual([
          { form: request, admitted: true, options: { verify: false, settleMillis: 0 } },
        ]);
      }),
    ),
);

it.effect("a form that stopped fails with what it completed, where it stopped and why", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const stop = BrowserError.make({
        operation: "fill-form",
        reason: Reasons.Stale.make({}),
        outcome: "undispatched",
      });

      const browser = scriptedSession({
        fillForm: () =>
          Effect.succeed(
            FillFormResult.make({
              fields,
              submitted: false,
              url,
              stopped: FormStop.make({ stage: "verify", elementId: "element-1", error: stop }),
            }),
          ),
      });

      const host = yield* BrowserTools.makeHost(browser);
      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "stale",
            outcome: "undispatched",
            stage: "verify",
            elementId: "element-1",
            completed: fields,
          },
        },
      ]);
      expect((yield* host.toolFailures).failures).toMatchObject([
        {
          toolName: "browser_fill_form",
          toolCallId: "form-call",
          error: { operation: "fill-form", reason: { _tag: "Stale" }, outcome: "undispatched" },
        },
      ]);
    }),
  ),
);

it.effect("an input callback failure preserves completed fields and the original form stop", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const stop = BrowserError.make({
        operation: "fill-form",
        reason: Reasons.Stale.make({}),
        outcome: "undispatched",
      });

      const input = InputReceipt.make({
        target: Target.make({ generation: 1, pageId: "page", frameId: "frame" }),
        kind: "click",
        position: null,
        startedMonotonicNanos: 1n,
        completedMonotonicNanos: 2n,
      });

      const browser = scriptedSession({
        fillForm: () =>
          Effect.succeed(
            FillFormResult.make({
              fields: [{ ...fields[0]!, input }, fields[1]!],
              submitted: false,
              url,
              stopped: FormStop.make({ stage: "verify", elementId: "element-3", error: stop }),
            }),
          ),
      });

      const callbackError = "PRIVATE-CALLBACK";

      const host = yield* BrowserTools.makeHost(browser, {
        onInput: () => Effect.fail(callbackError),
      });

      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "stale",
            outcome: "undispatched",
            stage: "verify",
            elementId: "element-3",
            completed: fields,
          },
        },
      ]);
      expect((yield* host.toolFailures).failures).toMatchObject([
        {
          toolName: "browser_fill_form",
          toolCallId: "form-call",
          error: { operation: "fill-form", reason: { _tag: "Stale" }, outcome: "undispatched" },
        },
      ]);
      expect(yield* host.failure.pipe(Effect.flip)).toBe(callbackError);
    }),
  ),
);

it.effect(
  "a failed receipt callback after form submission reports completed fields as unknown",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = InputReceipt.make({
          target: Target.make({ generation: 1, pageId: "page", frameId: "frame" }),
          kind: "click",
          position: null,
          startedMonotonicNanos: 1n,
          completedMonotonicNanos: 2n,
        });

        let fills = 0;

        const browser = scriptedSession({
          fillForm: () =>
            Effect.sync(() => {
              fills++;

              return FillFormResult.make({
                fields: [{ ...fields[0]!, input }, fields[1]!],
                submitted: true,
                url,
              });
            }),
        });

        const host = yield* BrowserTools.makeHost(browser, {
          onInput: () => Effect.fail("PRIVATE-CALLBACK"),
        });

        const ready = yield* tools.pipe(Effect.provide(host.layer));

        expect(yield* fill(ready)).toMatchObject([
          {
            isFailure: true,
            encodedResult: {
              _tag: "BrowserFormFailure",
              reason: "failed",
              outcome: "unknown",
              completed: fields,
            },
          },
        ]);
        expect(fills).toBe(1);
      }),
    ),
);

it.effect("a refused first step and a refused lane both report that nothing was completed", () =>
  Effect.scoped(
    Effect.gen(function* () {
      let forms = 0;

      const browser = scriptedSession({
        fillForm: () =>
          Effect.suspend(() => {
            forms++;

            return Effect.fail(
              BrowserError.make({
                operation: "fill-form",
                reason: Reasons.Unsupported.make({}),
                outcome: "undispatched",
              }),
            );
          }),
      });

      const scope = yield* Scope.fork(yield* Scope.Scope, "sequential");
      const host = yield* BrowserTools.makeHost(browser).pipe(Scope.provide(scope));
      const ready = yield* tools.pipe(Effect.provide(host.layer));

      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "unsupported",
            outcome: "undispatched",
            completed: [],
          },
        },
      ]);
      yield* Scope.close(scope, Exit.void);
      expect(yield* fill(ready)).toMatchObject([
        {
          isFailure: true,
          encodedResult: {
            _tag: "BrowserFormFailure",
            reason: "closed",
            outcome: "undispatched",
            completed: [],
          },
        },
      ]);
      expect(forms).toBe(1);
    }),
  ),
);

it.effect(
  "the observed form returns a fresh reading, and malformed forms never reach the browser",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        let forms = 0;

        const browser = scriptedSession({
          fillForm: () =>
            Effect.sync(() => {
              forms++;

              return FillFormResult.make({ fields, submitted: true, url });
            }),
          observe: () =>
            Effect.succeed(
              Observation.make({
                target: Target.make({ generation: 1, pageId: "page", frameId: "frame" }),
                observationId: "after",
                revision: 1,
                scope: "viewport",
                url,
                text: "Thanks",
                controls: [],
                controlsTruncated: false,
                textTruncated: false,
                viewport: {
                  width: 640,
                  height: 480,
                  clippedText: 0,
                  coveredText: 0,
                  uncertainText: 0,
                  unreachableControls: 0,
                  exhausted: false,
                },
              }),
            ),
        });

        const host = yield* BrowserTools.makeHost(browser);
        const ready = yield* tools.pipe(Effect.provide(host.layer));

        expect(yield* fill(ready, request, "browser_fill_form_and_inspect")).toMatchObject([
          {
            isFailure: false,
            encodedResult: {
              action: { submitted: true, url },
              observation: { _tag: "Available", observation: { observationId: "after" } },
            },
          },
        ]);

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
          // Parameter validation fails the call, or returns its failure, before any browser work.
          const exit = yield* Effect.exit(fill(ready, malformed));

          expect(Exit.isFailure(exit) || exit.value.every((result) => result.isFailure)).toBe(true);
        }
        expect(forms).toBe(1);
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

        const browser = scriptedSession({
          fillForm: (form) =>
            Effect.sync(() => {
              forms.push(form);

              return FillFormResult.make({ fields, submitted: form.submit !== undefined, url });
            }),
        });

        // Only a form that would be sent asks first.
        const gated = Toolkit.make(
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

        const host = yield* BrowserTools.makeHost(browser);

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

        const approved = yield* run("approved", [
          call("fill", unsent),
          call("send", request),
          answer,
        ]);

        expect(approved.output.done).toBe(true);
        expect(forms).toEqual([unsent, request]);
        expect(asked).toEqual([{ toolName: "browser_fill_form", parameters: request }]);

        const denied = yield* run("denied", [call("send", request), answer]).pipe(Effect.flip);

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
