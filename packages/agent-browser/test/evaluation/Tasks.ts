import { NodeCrypto } from "@effect/platform-node";
import { Duration, Effect, Exit, Fiber, Layer, Schema } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Agent from "effect-agent/agent";
import * as AgentRuntime from "effect-agent/agent-runtime";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy, Observation, type SessionStatus } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";
import type { BrowserError, InitializationError } from "effect-browser/errors";
import * as Testing from "effect-browser/testing";
import { type LanguageModel, Toolkit } from "effect/unstable/ai";

import { toolSite } from "../fixtures/ToolSite.ts";
import {
  account,
  type cases,
  orderReference,
  Output,
  type Case,
  type Composition,
  type Task,
} from "./Cases.ts";
import { EvidenceError, type Journal, json, tagOf } from "./Evidence.ts";
import { answer, call, history, model, prose, type Turn } from "./Model.ts";

/** Every case offers the same Tools per composition, so comparisons hold the action space fixed. */
export const toolkit = (composition: Composition) =>
  Toolkit.merge(
    composition === "base" ? BrowserTools.toolkit : BrowserTools.observedToolkit,
    composition === "base" ? BrowserTools.formToolkit : BrowserTools.observedFormToolkit,
    BrowserTools.readingToolkit,
  );

export const agent = (composition: Composition, bounds: Case["bounds"]) =>
  Agent.make("fixture-evaluation", {
    input: Schema.String,
    output: Output,
    instructions: BrowserTools.instructions(toolkit(composition)),
    toolkit: toolkit(composition),
    policy: {
      ...BrowserTools.policy(),
      maxTurns: bounds.maxTurns,
      maxToolCalls: bounds.maxToolCalls,
      maxDuration: Duration.millis(bounds.maxDurationMillis),
    },
  });

const done: Output = { status: "done", answer: null };

const observation = (request: LanguageModel.ProviderOptions): Observation => {
  const result = request.prompt.content
    .flatMap((message) => (message.role === "tool" ? message.content : []))
    .filter((part) => part.type === "tool-result")
    .findLast((part) => part.name === "browser_inspect");

  return Schema.decodeUnknownSync(Observation)(result?.result);
};

/** Form arguments from the controls the actual document reported, never from fixed IDs. */
const form = (request: LanguageModel.ProviderOptions, plan: "Pro" | "Free", submit: boolean) => {
  const view = observation(request);

  const id = (label: string) => {
    const control = view.controls.find((candidate) => candidate.label === label);

    if (control === undefined) throw new Error(`Missing fixture control ${label}`);

    return control.elementId;
  };

  return {
    observationId: view.observationId,
    fields: [
      { elementId: id("Email"), value: account.email },
      { elementId: id("I accept the terms"), checked: true },
      { elementId: id("Plan"), options: [id(plan)] },
    ],
    ...(submit ? { submit: id("Create account") } : {}),
  };
};

interface Context {
  readonly composition: Composition;
  readonly url: string;
  readonly maxTurns: number;
}

const names = (composition: Composition) =>
  composition === "base"
    ? { navigate: "browser_navigate", fillForm: "browser_fill_form" }
    : { navigate: "browser_navigate_and_inspect", fillForm: "browser_fill_form_and_inspect" };

/** Navigate, read the whole form, then send one form call; the final turn is the caller's. */
const signup = (
  context: Context,
  choice: { readonly plan: "Pro" | "Free"; readonly submit: boolean },
  after: ReadonlyArray<Turn>,
): ReadonlyArray<Turn> => [
  () => call("navigate", names(context.composition).navigate, { url: context.url }),
  () => call("inspect", "browser_inspect", { scope: "document" }),
  (request) =>
    call("submit", names(context.composition).fillForm, form(request, choice.plan, choice.submit)),
  ...after,
];

/** Re-reads the same view each turn; once the runtime withholds Tools it answers in prose. */
const recheck =
  (index: number): Turn =>
  (request) =>
    request.tools.length === 0 || request.toolChoice === "none"
      ? prose("I checked the receipt several times and could not confirm the reference.")
      : call(`recheck-${index}`, "browser_inspect", {});

/** Each declared policy has exactly one script, checked against the case declarations. */
const policies: {
  readonly [T in Task]: Readonly<
    Record<keyof (typeof cases)[T]["policies"], (context: Context) => ReadonlyArray<Turn>>
  >;
} = {
  signup: {
    completes: (context) => signup(context, { plan: "Pro", submit: true }, [() => answer(done)]),
    "skips-submit": (context) =>
      signup(context, { plan: "Pro", submit: false }, [() => answer(done)]),
    "wrong-plan": (context) =>
      signup(context, { plan: "Free", submit: true }, [() => answer(done)]),
    understates: (context) =>
      signup(context, { plan: "Pro", submit: true }, [
        () => answer({ status: "failed", answer: null }),
      ]),
  },
  "lost-acknowledgement": {
    // Reading back is the right move after an unknown outcome; a fenced owner refuses it.
    "stops-unresolved": (context) =>
      signup(context, { plan: "Pro", submit: true }, [
        () => call("read-back", "browser_inspect", { scope: "document" }),
        () => answer({ status: "unresolved", answer: null }),
      ]),
    "repeats-submit": (context) => {
      let repeated: unknown;

      return [
        () => call("navigate", names(context.composition).navigate, { url: context.url }),
        () => call("inspect", "browser_inspect", { scope: "document" }),
        (request) => {
          repeated = form(request, "Pro", true);

          return call("submit", names(context.composition).fillForm, repeated);
        },
        () => call("submit-again", names(context.composition).fillForm, repeated),
        () => answer(done),
      ];
    },
  },
  "cancelled-mutation": {
    "waiter-cancelled": () => [
      () => call("inspect", "browser_inspect", {}),
      () =>
        call("accept", "browser_click", { observationId: "observation-1", elementId: "accept" }),
      () => answer(done),
    ],
  },
  reading: {
    searches: () => [
      () => call("search", "browser_inspect", { find: "order reference", scope: "document" }),
      () => answer({ status: "done", answer: orderReference }),
    ],
    rechecks: (context) =>
      Array.from({ length: context.maxTurns + 1 }, (_, index) => recheck(index)),
    guesses: () => [() => answer({ status: "done", answer: orderReference })],
    "answers-late": (context) => [
      ...Array.from({ length: context.maxTurns - 1 }, (_, index) => recheck(index)),
      () => call("search", "browser_inspect", { find: "order reference", scope: "document" }),
      () => answer({ status: "done", answer: orderReference }),
    ],
  },
};

const script = (journal: Journal, url: string) => {
  const { task, policy, toolkit: composition, bounds } = journal.manifest;

  const found = Object.entries<(context: Context) => ReadonlyArray<Turn>>(policies[task]).find(
    ([name]) => name === policy,
  )?.[1];

  return found === undefined
    ? Effect.fail(new EvidenceError({ operation: `script for ${task}/${policy}` }))
    : Effect.succeed(found({ composition, url, maxTurns: bounds.maxTurns }));
};

/**
 * An agent run's own outcome. Host browser faults and a provider (here, script) failure are kept
 * apart from agent failures such as an exhausted policy or an invalid final answer.
 */
const settle =
  (journal: Journal) =>
  (exit: Exit.Exit<AgentRuntime.AgentResult<Output>, unknown>): Effect.Effect<void> =>
    Effect.sync(() => {
      if (Exit.isSuccess(exit)) {
        journal.facts = {
          ...journal.facts,
          terminal: "completed",
          finishReason: exit.value.finishReason,
          exhausted: exit.value.exhausted ?? null,
          turns: exit.value.turns,
          output: json(exit.value.output),
          outputValid: true,
        };

        return;
      }
      const tag = tagOf(exit.cause);

      journal.facts = {
        ...journal.facts,
        terminal: tag === "Interrupt" ? "cancelled" : "failed",
        failure: {
          category:
            tag === "Interrupt"
              ? "interrupted"
              : tag === "BrowserError" || tag === "InitializationError"
                ? "browser"
                : tag === "AiError" || tag === "Defect"
                  ? "infrastructure"
                  : "agent",
          tag,
        },
      };
    });

/** Host-only owner state and the original failures, read after the agent and before close. */
const owner = (
  journal: Journal,
  status: Effect.Effect<SessionStatus>,
  failures: Effect.Effect<BrowserTools.ToolFailureSnapshot>,
  scripted: Partial<NonNullable<Journal["facts"]["owner"]>> = {},
) =>
  Effect.gen(function* () {
    const current = yield* status;
    const snapshot = yield* failures;

    journal.facts = {
      ...journal.facts,
      owner: {
        phase: current.phase,
        unresolvedDispatch: current.unresolvedDispatch,
        actionsUsed: current.actions.used,
        dispatched: null,
        settlement: null,
        hostRetry: "not-attempted",
        ...scripted,
      },
      toolFailuresDropped: snapshot.dropped,
      toolFailures: snapshot.failures.map((entry) => ({
        tool: entry.toolName,
        operation: entry.error.operation,
        reason: entry.error.reason._tag,
        outcome: entry.error.outcome,
      })),
    };
  });

const closed = (journal: Journal, result: "confirmed" | "failed") =>
  Effect.sync(() => {
    journal.facts = { ...journal.facts, ownerClose: result };
  });

const chromium = (journal: Journal) =>
  Chromium.layer({
    actionTimeoutMillis: journal.manifest.bounds.actionTimeoutMillis,
    onCleanup: (receipt) =>
      Effect.sync(() => {
        journal.facts = {
          ...journal.facts,
          cleanup:
            receipt.connection === "closed" &&
            receipt.process === "terminated" &&
            receipt.issues.length === 0
              ? "confirmed"
              : "unconfirmed",
          cleanupReceipt: json({
            connection: receipt.connection,
            process: receipt.process,
            issues: receipt.issues.map(({ step, reason }) => ({ step, reason })),
          }),
        };
      }),
    launch: {
      ...(process.env.BROWSERBASE_CHROMIUM === undefined
        ? {}
        : { executablePath: process.env.BROWSERBASE_CHROMIUM }),
      chromiumSandbox: false,
      startupTimeoutMillis: 25000,
    },
    viewport: journal.manifest.viewport,
  }).pipe(Layer.provide(NodeCrypto.layer));

const scriptedOptions = (journal: Journal) => ({
  policy: BrowserPolicy.unrestricted({
    maxActions: journal.manifest.bounds.maxActions,
    maxElapsedMillis: 60000,
  }),
  viewport: journal.manifest.viewport,
  onCleanup: (receipt: Testing.ScriptedCleanupResult) =>
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
});

const hostOptions = (journal: Journal) => ({
  maxControls: journal.manifest.bounds.maxControls,
  maxTextBytes: journal.manifest.bounds.maxTextBytes,
});

const runAgent = (journal: Journal, turns: ReadonlyArray<Turn>) =>
  AgentRuntime.run(
    agent(journal.manifest.toolkit, journal.manifest.bounds),
    journal.manifest.goal,
    {
      onHistory: history(journal),
    },
  ).pipe(Effect.provide(model(journal, turns)));

/** ToolSite cases: the server's ledger is read after Chromium has been released. */
const onChromium = (journal: Journal, path: string): Effect.Effect<void, RunFailure> =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* toolSite;
      const turns = yield* script(journal, `${site.url}${path}`);

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          journal.facts = {
            ...journal.facts,
            applicationWrites: site.submissions.length,
            submissions: site.submissions.slice(0, 8),
          };
        }),
      );

      yield* Browser.scoped(
        Chromium.launch(
          BrowserPolicy.unrestricted({
            maxActions: journal.manifest.bounds.maxActions,
            maxElapsedMillis: 60000,
          }),
        ),
        (browser) =>
          Effect.gen(function* () {
            const host = yield* BrowserTools.makeHost(browser, hostOptions(journal));

            yield* host
              .run(runAgent(journal, turns))
              .pipe(Effect.exit, Effect.flatMap(settle(journal)));
            yield* owner(journal, browser.status, host.toolFailures);
          }),
      ).pipe(
        Effect.provide(chromium(journal)),
        Effect.andThen(closed(journal, "confirmed")),
        Effect.catchTag("BrowserError", (error) =>
          error.operation === "close" ? closed(journal, "failed") : Effect.fail(error),
        ),
      );
    }),
  );

const receipt: Testing.Script = {
  documents: [
    {
      url: "https://fixture.test/receipt",
      title: "Receipt",
      text: [
        "Receipt for your purchase.",
        ...Array.from(
          { length: 120 },
          (_, index) => `Line ${index + 1}: item ${index + 1}, quantity 1, delivered.`,
        ),
        `Order reference: ${orderReference}`,
      ].join("\n"),
    },
  ],
};

/** Scripted operations that change page state; scrolling, pointer moves and navigation do not. */
const changesPage: ReadonlySet<string> = new Set([
  "click",
  "click-and-wait",
  "fill",
  "fill-form",
  "select-option",
  "select-files",
  "press",
  "type",
]);

/** A long scripted receipt; reading it needs no state-changing operation. */
const onReceipt = (journal: Journal): Effect.Effect<void, RunFailure> =>
  Effect.gen(function* () {
    const turns = yield* script(journal, "https://fixture.test/receipt");

    yield* Browser.scoped(Testing.open(receipt, scriptedOptions(journal)), (browser) =>
      Effect.gen(function* () {
        const host = yield* BrowserTools.makeHost(browser, hostOptions(journal));

        yield* host
          .run(runAgent(journal, turns))
          .pipe(Effect.exit, Effect.flatMap(settle(journal)));
        const calls = yield* browser.control.calls;

        yield* owner(journal, browser.status, host.toolFailures, {
          dispatched: calls.filter((entry) => entry.dispatched && changesPage.has(entry.operation))
            .length,
        });
      }),
    ).pipe(
      Effect.andThen(closed(journal, "confirmed")),
      Effect.catchTag("BrowserError", (error) =>
        error.operation === "close" ? closed(journal, "failed") : Effect.fail(error),
      ),
    );
  });

/** The scripted public seam proves cancellation and fencing, not a write-before-lost-ack application state. */
const onCancelledWaiter = (journal: Journal): Effect.Effect<void, RunFailure> =>
  Effect.gen(function* () {
    const turns = yield* script(journal, "https://fixture.test/");

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
        scriptedOptions(journal),
      ),
      (browser) =>
        Effect.gen(function* () {
          const gate = yield* browser.control.gate;

          yield* browser.control.next("click", { _tag: "Hold", gate, dispatched: true });
          const host = yield* BrowserTools.makeHost(browser, hostOptions(journal));
          const running = yield* host.run(runAgent(journal, turns)).pipe(Effect.forkChild);

          // Either way the gate is missed, the run cannot show a held dispatch: a harness fault.
          yield* gate.reached.pipe(
            Effect.raceFirst(
              Fiber.await(running).pipe(
                Effect.andThen(
                  Effect.fail(
                    new EvidenceError({ operation: "agent completed before dispatched gate" }),
                  ),
                ),
              ),
            ),
            Effect.timeoutOrElse({
              duration: 5000,
              orElse: () =>
                Effect.fail(new EvidenceError({ operation: "dispatched gate not reached" })),
            }),
          );
          yield* Fiber.interrupt(running);

          const retry = yield* browser
            .clickElement({ observationId: "observation-1", elementId: "accept" })
            .pipe(Effect.result);

          yield* gate.open;
          const calls = yield* browser.control.calls;
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
              originalOwner: true,
              diagnosticsBoundary: "unavailable",
            }),
          });
          journal.facts = {
            ...journal.facts,
            terminal: "cancelled",
            failure: { category: "interrupted", tag: "Interrupt" },
          };
          yield* owner(journal, browser.status, host.toolFailures, {
            dispatched: clicks.filter((entry) => entry.dispatched).length,
            settlement: clicks[0]?.settled ?? null,
            hostRetry:
              retry._tag === "Failure" && retry.failure.outcome === "undispatched"
                ? "refused-undispatched"
                : "dispatched-or-unknown",
          });
        }),
    ).pipe(
      Effect.andThen(closed(journal, "confirmed")),
      Effect.catchTag("BrowserError", (error) =>
        error.operation === "close" ? closed(journal, "failed") : Effect.fail(error),
      ),
    );
  });

/** Harness faults only; the agent's own outcome is recorded as facts, never raised. */
type RunFailure =
  | Effect.Error<typeof toolSite>
  | EvidenceError
  | BrowserError
  | InitializationError;

/** Run one declared case into its journal; only a harness fault fails the returned Effect. */
export const run = (journal: Journal): Effect.Effect<void, RunFailure> => {
  switch (journal.manifest.task) {
    case "signup":
      return onChromium(journal, "signup");
    case "lost-acknowledgement":
      return onChromium(journal, "signup?ack=late");
    case "cancelled-mutation":
      return onCancelledWaiter(journal);
    case "reading":
      return onReceipt(journal);
  }
};
