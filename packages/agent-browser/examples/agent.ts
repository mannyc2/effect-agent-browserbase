// One execution owns one Browserbase session; every model turn borrows it.
//
// The generic package's guide already shows what a session can do. This example shows the three
// things only the adapter adds, each on the same fixed Toolkit:
//
//   runBrowserAgent  the host opens a session, the agent works, and the host reads what it left
//   runWithOperator  the agent stops at something only a person may do; that person takes the
//                    same session through Live View; the agent continues from where they left it
//   runSupervised    a typed page→host binding whose failure ends the whole run
//
// Credentials, launch and budgets are host configuration and never Tool parameters. The model is
// the caller's: provide a LanguageModel layer beside these programs. `test/native/agent.test.ts`
// runs this same wiring against a local Chromium with a scripted model.
import { Context, Effect, Layer, Schema } from "effect";
import * as InMemory from "effect-agent/in-memory";
import * as Bootstrap from "effect-browser/bootstrap";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import * as Account from "effect-browserbase/account";
import { BrowserbaseBrowser, type LiveView } from "effect-browserbase/browser";
import { recipe } from "effect-browserbase/launch";

import { turns } from "./BrowserAgent.ts";
export { browserAgent } from "./BrowserAgent.ts";

const genericPolicy = BrowserPolicy.unrestricted({
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const launch = recipe({ viewport: { _tag: "Fixed", width: 1280, height: 720 } });

// BROWSERBASE_PROJECT_ID and BROWSERBASE_API_KEY are read from the ConfigProvider when the
// Layer is built. Building it allocates nothing.
const account = Account.layerConfig();

// One thread store for the execution, so a later run can continue an earlier conversation.
const host = Layer.mergeAll(
  BrowserbaseBrowser.layer({ launch }).pipe(Layer.provide(account)),
  InMemory.layer,
);

/** The execution owns the session, so the host can still look after the agent is done. */
export const runBrowserAgent = (request: string) =>
  Browser.scoped(BrowserbaseBrowser.open(genericPolicy), (session) =>
    Effect.gen(function* () {
      const run = yield* turns(session, request);

      // Through the generic session, with the host-only facts an Observation handed to a model
      // never carries. Leaving the scope releases the browser and reports how that went.
      const seen = yield* session.observe({ scope: "viewport" });

      return { ...run.output, url: seen.url, turns: run.turns };
    }),
  ).pipe(Effect.provide(host));

/**
 * Both runs borrow the one session, so nothing is allocated twice and the second run sees the
 * page exactly as the person left it — signed in, say. It continues the first run's thread, so
 * the model keeps what it learned before the handoff.
 */
export const runWithOperator = (
  request: string,
  operator: (view: LiveView) => Effect.Effect<void>,
) =>
  Browser.scoped(BrowserbaseBrowser.open(genericPolicy), (session) =>
    Effect.gen(function* () {
      const first = yield* turns(session, request);

      if (!first.output.needsOperator) return first.output;

      // Automation is paused before the Live View leaves this process. Its URL grants control of
      // the browser: show it to a person, never to the model or a log.
      const handoff = yield* session.beginHandoff(300);

      yield* operator(handoff.view);
      // The boolean is this host's own decision that the operator has let go. The page cannot say.
      yield* session.resume(handoff.token, true);

      const second = yield* turns(
        session,
        "The operator has signed in; continue from the page as it is now.",
        first.threadId,
      );

      return second.output;
    }),
  ).pipe(Effect.provide(host));

export class ApprovalUnavailable extends Schema.TaggedError<ApprovalUnavailable>()(
  "ApprovalUnavailable",
  { amount: Schema.Finite },
) {}

export class Approvals extends Context.Service<
  Approvals,
  { readonly approve: (amount: number) => Effect.Effect<boolean, ApprovalUnavailable> }
>()("example/Approvals") {}

const portal = "https://portal.example.com";

// A page the host trusts may call the host while the agent works on it. The call is admitted by
// the calling document's origin and identity, decoded with this codec, and answered by a handler
// that runs with the application's own services.
const bootstrap = Bootstrap.binding({
  name: "requestApproval",
  origins: [portal],
  input: Schema.Struct({ amount: Schema.Finite }),
  output: Schema.Struct({ approved: Schema.Boolean }),
  maxConcurrent: 1,
  maxInputBytes: 128,
  maxOutputBytes: 64,
  timeoutMillis: 5_000,
  // An approval service that cannot answer is not something the page should retry around.
  failureMode: "fail-session",
  handle: ({ amount }) =>
    Effect.flatMap(Approvals, (approvals) => approvals.approve(amount)).pipe(
      Effect.map((approved) => ({ approved })),
    ),
});

/**
 * `Browser.scoped` races the agent against the binding's failure and confirms the release before
 * reporting success. The callback keeps `BrowserbaseSession<ApprovalUnavailable>`, so
 * `Approvals` remains a requirement of this program and `ApprovalUnavailable` one of its
 * failures.
 */
export const runSupervised = (request: string) =>
  Browser.scoped(BrowserbaseBrowser.open(genericPolicy, { bootstrap }), (browser) =>
    turns(browser, request),
  ).pipe(Effect.provide(host));
