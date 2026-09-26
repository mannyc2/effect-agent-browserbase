import { NodeCrypto } from "@effect/platform-node";
import { Cause, Effect, Exit, Fiber, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy, Observation } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import * as Testing from "effect-browser/testing";
import { type LanguageModel, Toolkit } from "effect/unstable/ai";

import { toolSite } from "../fixtures/ToolSite.ts";
import { EvidenceError, type Journal, json } from "./Evidence.ts";
import { answer, call, history, model } from "./Model.ts";

export const toolkit = (composition: "base" | "observed") =>
  Toolkit.merge(
    composition === "base" ? BrowserTools.toolkit : BrowserTools.observedToolkit,
    composition === "base" ? BrowserTools.formToolkit : BrowserTools.observedFormToolkit,
  );

export const agent = (composition: "base" | "observed") =>
  Agent.make("fixture-evaluation", {
    input: Schema.String,
    output: Schema.Struct({ done: Schema.Boolean }),
    instructions: BrowserTools.instructions(toolkit(composition)),
    toolkit: toolkit(composition),
    policy: { ...BrowserTools.policy(), maxTurns: 8, maxToolCalls: 8, maxDuration: "30 seconds" },
  });

export const goal =
  "Create one account for ada@example.test on the Pro plan, accepting the terms. Use only the supplied local fixture.";

const observation = (request: LanguageModel.ProviderOptions): Observation => {
  const result = request.prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result")
    .findLast((part) => part.name === "browser_inspect");

  return Schema.decodeUnknownSync(Observation)(result?.result);
};

const signupParameters = (request: LanguageModel.ProviderOptions) => {
  const view = observation(request);

  const id = (label: string) => {
    const control = view.controls.find((candidate) => candidate.label === label);

    if (control === undefined) throw new Error(`Missing fixture control ${label}`);

    return control.elementId;
  };

  return {
    observationId: view.observationId,
    fields: [
      { elementId: id("Email"), value: "ada@example.test" },
      { elementId: id("I accept the terms"), checked: true },
      { elementId: id("Plan"), options: [id("Pro")] },
    ],
    submit: id("Create account"),
  };
};

const chromium = (journal: Journal) =>
  Chromium.layer({
    onCleanup: (receipt) =>
      Effect.sync(() => {
        const retained = {
          connection: receipt.connection,
          process: receipt.process,
          issues: receipt.issues.map(({ step, reason }) => ({ step, reason })),
        };

        journal.facts = {
          ...journal.facts,
          cleanup:
            receipt.connection === "closed" &&
            receipt.process === "terminated" &&
            receipt.issues.length === 0
              ? "confirmed"
              : "unconfirmed",
          cleanupReceipt: json(retained),
        };
      }),

    launch: {
      ...(process.env.BROWSERBASE_CHROMIUM === undefined
        ? {}
        : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
      chromiumSandbox: false,
      startupTimeoutMillis: 25000,
    },
    viewport: { width: 640, height: 480 },
  }).pipe(Layer.provide(NodeCrypto.layer));

type SignupError =
  | Effect.Error<typeof toolSite>
  | BrowserError
  | InitializationError
  | AgentRuntime.AgentRuntimeFailure<ReturnType<typeof agent>, Schema.SchemaError>;

export const signup = Effect.fn("Evaluation.signup")(function* (
  journal: Journal,
): Effect.fn.Return<void, SignupError> {
  yield* Effect.scoped(
    Effect.gen(function* () {
      const site = yield* toolSite;

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          journal.facts = {
            ...journal.facts,
            applicationWrites: site.submissions.length,
            submission: site.submissions[0] ?? null,
          };
        }),
      );

      yield* Browser.scoped(
        Chromium.launch(BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60000 })),
        (browser) =>
          Effect.gen(function* () {
            const composition = journal.manifest.toolkit;

            const run = yield* BrowserTools.run(
              browser,
              AgentRuntime.run(agent(composition), goal, { onHistory: history(journal) }).pipe(
                Effect.provide(
                  model(journal, [
                    () =>
                      call(
                        "navigate",
                        composition === "base"
                          ? "browser_navigate"
                          : "browser_navigate_and_inspect",
                        { url: `${site.url}signup` },
                      ),
                    () => call("inspect", "browser_inspect", { scope: "document" }),
                    (request) =>
                      call(
                        "submit",
                        composition === "base"
                          ? "browser_fill_form"
                          : "browser_fill_form_and_inspect",
                        signupParameters(request),
                      ),
                    () => answer,
                  ]),
                ),
              ),
              { maxControls: 64, maxTextBytes: 8192 },
            );

            journal.facts = {
              ...journal.facts,
              terminal: "completed",
              output: json(run.output),
              outputValid: true,
            };
          }),
      ).pipe(Effect.provide(chromium(journal)));
    }),
  ).pipe(
    Effect.onExit((exit) =>
      Effect.sync(() => {
        if (Exit.isFailure(exit))
          journal.facts = {
            ...journal.facts,
            terminal: Cause.hasInterrupts(exit.cause) ? "cancelled" : "failed",
            failure: Cause.hasInterrupts(exit.cause) ? "interrupted" : "infrastructure",
          };
      }),
    ),
  );
});

/** The scripted public seam proves cancellation/fencing, not a write-before-lost-ack application state. */
export const cancelledMutation = Effect.fn("Evaluation.cancelledMutation")(function* (
  journal: Journal,
) {
  yield* Browser.scoped(
    Testing.open(
      {
        documents: [
          {
            url: "https://fixture.test/",
            text: "Accept terms",
            controls: [{ id: "accept", kind: "button", label: "Accept" }],
          },
        ],
      },
      {
        policy: BrowserPolicy.unrestricted({ maxActions: 20, maxElapsedMillis: 60000 }),
        viewport: { width: 640, height: 480 },
        onCleanup: (receipt) =>
          Effect.sync(() => {
            journal.facts = {
              ...journal.facts,
              cleanup:
                receipt.connection === "closed" && receipt.issues.length === 0
                  ? "confirmed"
                  : "unconfirmed",
              cleanupReceipt: json({
                connection: receipt.connection,
                issues: receipt.issues.map(({ step, reason }) => ({ step, reason })),
              }),
            };
          }),
      },
    ),
    (browser) =>
      Effect.gen(function* () {
        const gate = yield* browser.control.gate;

        yield* browser.control.next("click", { _tag: "Hold", gate, dispatched: true });
        const host = yield* BrowserTools.makeHost(browser);

        const running = yield* host
          .run(
            AgentRuntime.run(agent("base"), "Accept terms once.", {
              onHistory: history(journal),
            }).pipe(
              Effect.provide(
                model(journal, [
                  () => call("inspect", "browser_inspect", {}),
                  () =>
                    call("accept", "browser_click", {
                      observationId: "observation-1",
                      elementId: "accept",
                    }),
                  () => answer,
                ]),
              ),
            ),
          )
          .pipe(Effect.forkChild);

        yield* gate.reached.pipe(
          Effect.raceFirst(
            Fiber.join(running).pipe(
              Effect.andThen(
                Effect.fail(
                  new EvidenceError({ operation: "agent completed before dispatched gate" }),
                ),
              ),
            ),
          ),
          Effect.timeout(5000),
        );
        yield* Fiber.interrupt(running);

        const retry = yield* browser
          .clickElement({ observationId: "observation-1", elementId: "accept" })
          .pipe(Effect.result);

        yield* gate.open;
        const calls = yield* browser.control.calls;
        const status = yield* browser.status;
        const clicks = calls.filter((entry) => entry.operation === "click");

        journal.append({
          kind: "host",
          turn: null,
          value: json({
            calls: calls.map(({ sequence, operation, dispatched, settled }) => ({
              sequence,
              operation,
              dispatched,
              settled,
            })),
            phase: status.phase,
            unresolvedDispatch: status.unresolvedDispatch,
            originalOwner: true,
            diagnosticsBoundary: "unavailable",
          }),
        });
        journal.facts = {
          ...journal.facts,
          terminal: "cancelled",
          failure: "interrupted",
          dispatchCount: clicks.filter((entry) => entry.dispatched).length,
          settlement: clicks[0]?.settled ?? null,
          ownerFenced: status.unresolvedDispatch,
          retryRefused: retry._tag === "Failure" && retry.failure.outcome === "undispatched",
        };
      }),
  ).pipe(
    Effect.catchTag("BrowserError", (error) =>
      error.operation === "close" ? Effect.void : Effect.fail(error),
    ),
  );
});
