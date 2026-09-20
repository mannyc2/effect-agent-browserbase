# Worked consumer workflows and customization lifetimes

The first example uses **current APIs**. Later examples explicitly use **proposed APIs** from [architecture.md](architecture.md); they are design fixtures, not code that can be imported from the present package. They have not been typechecked in the pinned workspace during this research session. `portal.example.com`, host service implementations and resource references are consumer-specific placeholders.

## 1. What consumers can do today: inspect a previously provisioned Context and retrieve recording

The Context must already exist; this package cannot currently create it. Use a separate strict account object for artifact layers rather than passing the larger interactive options object. This avoids the configuration mismatch visible in [the existing hosted examples](../../../packages/platform-browserbase/examples/hosted.ts) and [#6's hosted report](https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681).

```ts
import { Effect } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import {
  BrowserbaseRecordings,
  type BrowserbaseOptions,
} from "@effect-agent/platform-browserbase/recordings";
import {
  BrowserNavigateRequest,
  InteractiveBrowserPolicy,
} from "effect-agent/interactive-browser";

const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" }, // trusted host decision, not model input
  maxActions: 20,
  maxElapsedMillis: 120_000,
  maxReturnedBytes: 1024 * 1024,
});

export const inspectSavedContext = (
  account: BrowserbaseOptions,
  contextId: string,
  url: string,
) => {
  // Materialize only the declared HTTP fields; TypeScript structural typing
  // alone does not remove extra runtime properties from a supplied variable.
  const http = {
    projectId: account.projectId,
    apiKey: account.apiKey,
    ...(account.artifactOrigins === undefined ? {} : { artifactOrigins: account.artifactOrigins }),
    ...(account.requestTimeoutMillis === undefined ? {} : { requestTimeoutMillis: account.requestTimeoutMillis }),
  };
  const browsers = BrowserbaseInteractiveHost.layer({
    ...http,
    context: { id: contextId, persist: false },
    recordSession: true,
  });

  return Effect.gen(function* () {
    const result = yield* Effect.scoped(
      Effect.gen(function* () {
        const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);
        yield* session.handle.navigate(BrowserNavigateRequest.make({ url }));
        const observation = yield* session.observe({ maxTextBytes: 8192, maxControls: 16 });
        const cleanup = yield* session.close;
        return { reference: session.reference, observation, cleanup };
      }).pipe(Effect.provide(browsers)),
    );

    // Scope cleanup is not a promise that a failed remote release succeeded.
    if (result.cleanup.remote !== "confirmed") return { ...result, recording: undefined };
    const recordings = yield* BrowserbaseRecordings;
    yield* recordings.request(result.reference);
    const recording = yield* recordings.wait(result.reference, { timeoutMillis: 120_000 });
    return { ...result, recording };
  }).pipe(
    Effect.provide(BrowserbaseRecordings.layer(http)),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  );
};
```

Call this workflow again with the same Context ID to hydrate another session. `persist:false` deliberately does not save changes. Inspect every returned recording page's status/delivery; `wait` does not guarantee all pages succeeded. Download each chosen page through `RecordingPageReference` with explicit byte/time limits, or retrieve HLS through `BrowserbaseReplays`. A session reference remains valid data after scope exit; the session handle does not remain usable.

For a writer today, set `persist:true` and provide the existing `contextLease` callback. That supplies exclusion, not a provider flush receipt. The callback must retain/quarantine a lease when allocation or termination is uncertain and apply the consumer's post-termination reuse policy. The package's [persistentReconnect example](../../../packages/platform-browserbase/examples/hosted.ts) demonstrates only same-scope detach/reconnect, not new-process recovery or creation of Contexts.

## 2. Proposed complete persistent account workflow

### Setup and ownership

Provision one Context for an application account, save its reference in the application's database, and keep a writer coordinator keyed by project/context. Creation is an explicit business resource operation, not an operation repeated every time a browser connects. Context deletion belongs to account offboarding and is separately authorized.

```ts
// PROPOSED services and overloads; AccountStore and coordinator are consumer-owned.
const provision = Effect.gen(function* () {
  const contexts = yield* BrowserbaseContexts;
  const accounts = yield* AccountStore;
  const context = yield* contexts.create({ name: "support-account-42" });
  yield* accounts.setContext("account-42", context.reference);
  return context.reference;
});

const login = Effect.scoped(Effect.gen(function* () {
  const context = yield* (yield* AccountStore).getContext("account-42");
  const coordinator = yield* AccountContextCoordinator;
  const host = yield* BrowserbaseInteractiveHost;
  const acquisition = yield* host.acquire(policy, {
    launch: {
      remoteTimeoutSeconds: 900,
      keepAlive: true,
      context: { reference: context, persist: true },
      viewport: { _tag: "ProviderManaged" },
      provider: { region: "us-east-1", browserSettings: { verified: true } },
    },
    contextCoordinator: coordinator,
  });
  const session = yield* acquisition.connect;
  yield* session.handle.navigate(BrowserNavigateRequest.make({ url: "https://portal.example.com/login" }));
  const handoff = yield* session.beginHandoff(300);
  yield* (yield* TrustedOperator).completeLogin(handoff.view);
  yield* session.resume(handoff.token, true);
  yield* (yield* PortalChecks).assertAccount(session, "account-42");
  const completion = yield* acquisition.release;
  yield* coordinator.settle(context, completion);
  return completion;
}));
```

`contexts.create` is proposed to return metadata including `.reference`. `contextCoordinator`, the overload of `acquire`, and `acquisition.release` are new. The shared host is responsible for associating one lease acquisition/settlement with the attempt; `settle` must be idempotent and the finalizer remains a fallback, not a second independent unlock. The example intentionally does not pass a password through a model-facing fill Tool.

### State changes, failure and cleanup

On a successful login, site state changes in the running browser. Release first confirms that the writer session is terminal; then the coordinator records **flush-unacknowledged** until its policy permits reuse. A second bounded read-only session can read a consumer-controlled marker or an account postcondition as evidence; it does not prove an atomic snapshot of every storage subsystem. Keep the writer lease across that validation so another writer cannot race it.

On lost creation reply, quarantine the attempt and use passive session listing plus the allocation metadata nonce to locate candidates. Do not immediately create another writer. On lost release reply, retrieve the exact session's state; do not confuse a different session's completion with this writer. On `ERROR`/`TIMED_OUT`, retain that actual status in persistence evidence. On database settlement failure, retain a pending cleanup record and let the supervisor reconcile; do not report successful lease release.

On a subsequent job, acquire the same coordinator key, hydrate the Context and verify the expected account before submitting any action. Authenticated state can be expired or revoked. Re-run human authentication when needed rather than assuming a stored cookie proves current identity. Native session storage, service worker data and extension data must be tested independently. [Provider Context contract](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts), [authentication guidance](https://docs.browserbase.com/platform/identity/authentication).

## 3. Proposed customized browser: extension, initialization and a host service

Use an extension for features that need Chrome extension capabilities or browser-resident behavior; use an init script for small document setup; use a host binding for narrow calls to consumer services. Do not make all three mandatory for a simple workflow.

Provision the extension separately using a bounded ZIP upload with manifest validation; store its immutable artifact reference/digest in a versioned recipe. Reference `extensionId` when launching. The library should not invent an extension bundler or claim hot-swapping a running session. [Provider extension guide](https://docs.browserbase.com/platform/browser/core-features/browser-extensions).

```ts
// PROPOSED Bootstrap builders. They compile to maintained native mechanisms.
// Handler dependencies/errors are retained by the builder and host acquire.
const settingsBinding = Bootstrap.binding({
  name: "getShowSettings",
  origins: ["https://portal.example.com"],
  input: Schema.Struct({ version: Schema.Literal(3) }),
  output: Schema.Struct({ label: Schema.String, revision: Schema.Int }),
  maxConcurrent: 2,
  maxInputBytes: 256,
  maxOutputBytes: 4096,
  timeoutMillis: 3000,
  handle: () => Effect.gen(function* () {
    const settings = yield* ShowSettings;
    return yield* settings.publicSettings; // no private keys or admin authority
  }),
});

const bootstrap = Bootstrap.make({
  id: "show-environment",
  version: 3,
  bindings: [settingsBinding],
  scripts: [{
    id: "settings-ready",
    origins: ["https://portal.example.com"],
    content: `
      if (!globalThis.__showReady) {
        globalThis.__showReady = globalThis.getShowSettings({ version: 3 })
          .then(value => { globalThis.__showSettings = value; return true; });
      }
    `,
  }],
  readiness: {
    expression: "globalThis.__showReady",
    timeoutMillis: 5000,
    existingDocuments: "RequireFreshNavigation",
  },
});

const customized = Effect.scoped(Effect.gen(function* () {
  const host = yield* BrowserbaseInteractiveHost;
  const extension = yield* (yield* EnvironmentRecipes).showExtension;
  const acquisition = yield* host.acquire(policy, {
    launch: {
      remoteTimeoutSeconds: 600,
      viewport: { _tag: "Fixed", width: 1280, height: 720 },
      provider: {
        region: "us-east-1",
        extensionId: extension.extensionId,
        browserSettings: { recordSession: true, logSession: true },
      },
    },
    bootstrap,
  });
  const session = yield* acquisition.connect;
  yield* session.handle.navigate(BrowserNavigateRequest.make({ url: "https://portal.example.com/stage" }));
  // The configured host navigation barrier now requires the new document's readiness.
  return yield* session.observe();
}));
```

The expression and script source are **trusted host configuration**, never model-generated evaluation. Production builders must validate them as bounded code artifacts, isolate allowed origins and evaluate readiness under a document epoch. The example's globals are intentionally browser-side JavaScript, not TypeScript objects with host closures. A consumer-controlled application can itself await `__showReady`; otherwise only library actions are gated. Rejected binding calls fail readiness with a typed step error. Re-navigation cancels the old pending readiness, and late resolution must not make the new document ready.

### Extension communication is not the same binding namespace

Chrome content scripts default to an isolated world; they cannot assume a page-world binding/global is directly visible. Prefer explicit `chrome.runtime` messaging inside the extension and, only when needed, a narrow page bridge with schema/source/origin validation. Such a bridge remains callable by hostile page code on the allowed origin, so do not give it secret retrieval or unrestricted commands. Extension service workers can stop and restart; keep durable extension state in storage, not only globals. [Chrome content scripts](https://developer.chrome.com/docs/extensions/develop/concepts/content-scripts), [service-worker lifecycle](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle).

An extension can instead communicate with a consumer HTTPS service using appropriately scoped authorization and a bounded protocol. That service must be reachable from the **remote** browser; `localhost` refers to the Browserbase environment, not the developer's laptop. Authentication, CORS, CSP, egress rules and connection reconnect/backpressure belong in that application's design. The library should not introduce a generic reverse tunnel merely to support a callback that already fits native bindings.

## 4. Customization lifetime matrix

| Mechanism | Install time / scope | Navigation, frames and popups | Reconnect / new session |
| --- | --- | --- | --- |
| Browserbase Context data | Session creation / durable provider resource | Website storage rules apply; not a blanket shared variable across origins/tabs | Same running session keeps live state; new session hydrates saved state under persistence policy |
| Region, proxies, Verified, extension reference | Remote launch / session | Provider/Chrome applies settings; extension matching determines coverage | Same session keeps launch profile; new session must receive the recipe again |
| Native context init bundle | Before first dependent navigation / connection registration | Runs in new documents/frames; each has separate readiness; existing documents need explicit handling | Reinstall/verify in new connection; native retention/removal behavior needs a pinned+hosted test, not an assumption |
| Host service bindings | Before init calls / owning connection scope | Validate current calling frame/document and origins for every invocation | Host closures do not become Context data; pending calls fail or cancel on loss; recreate registrations |
| Native permissions/cookies/environment operations | Bootstrap or explicit owned host operation | Per-origin/context/native rules, not extension permissions | Browser data may persist, but permission override persistence is not promised; reapply declared ephemeral policy |
| One-shot page evaluation | Current selected document only | Not automatically applied to another frame/document/tab | Never treated as durable; this is not a substitute for initialization |
| Extension content scripts/workers | Chrome extension installation and matching | Manifest timing/world/related-frame rules apply; no assumed ordering against independent init scripts | Extension restarts with browser; Context retention of extension storage/ID must be verified |

Use native context-level registration for future documents, plus an owned readiness registry for all admitted pages. Do not wait to hear about a popup and then claim the injection preceded its application scripts. If an extension and an init script depend on one another, require an explicit versioned handshake; neither Browserbase nor Playwright provides a universal ordering guarantee between them.

## 5. Reconnect to an existing session from a new process

**Current API suffices only for intentional same-owner detach/reconnect.** For durable adoption, the proposed consumer stores `SessionReference`, expiry, recipe version and a supervisor lease. It never stores connect URLs or connection-local page/frame handles.

```ts
// PROPOSED borrowed attach. ControlLease is a consumer-issued ownership proof.
const continueSession = (record: SupervisedSessionRecord) => Effect.scoped(
  Effect.gen(function* () {
    const sessions = yield* BrowserbaseSessions;
    const state = yield* sessions.retrieve(record.reference); // passive GET, never reconcile/release
    if (state.status !== "RUNNING") return { _tag: "NeedsSupervisorDecision", state };

    const controlLease = yield* (yield* SessionSupervisor).claimControl(record);
    const host = yield* BrowserbaseInteractiveHost;
    const session = yield* host.attach(record.reference, {
      controlLease,
      policy,
      target: { targetId: record.targetId },
      bootstrap: yield* (yield* EnvironmentRecipes).resolveBootstrap(record.recipeVersion),
      existingDocuments: "AcceptAlreadyRunning",
    });
    const observation = yield* session.observe();
    yield* (yield* BusinessOperationJournal).reconcileBeforeMutation(observation);
    return observation;
  }),
); // disconnects borrowed connection; supervisor still owns remote release
```

The host itself must revalidate state even after the consumer's preliminary GET: expiry can race attachment. Missing target is typed not-found/ambiguous, not “select the first tab.” `AcceptAlreadyRunning` requires explicit verification rather than reloading an unknown transaction. A network break invalidates local registrations and handles. If the provider session has ended, create a **new** session using the Context instead of calling that reconnect. At final completion, the supervisor explicitly requests release and verifies terminal state, then settles any Context writer lease.

## 6. Multiple pages: capture stage while operating scout

This is already expressible through current explicit-target `Capture.start`; do not wait for the resource redesign. Use PageInfo returned by the owned session, not array order or a guessed target ID.

```ts
// CURRENT capture shape. session, stage and scout are already admitted live values.
const interval = yield* Capture.start(session, {
  target: stage,
  size: { width: 960, height: 540 },
  maxDurationMillis: 5000,
  maxBufferedBytes: 8 * 1024 * 1024,
});
// Consume interval.frames through a bounded, scoped encoder/sink while the host
// selects and operates scout. The sink is consumer-owned; Capture does not encode.
```

Take `stage` and `scout` from explicit page creation/selection results; retain their different native identities. A scout selection/navigation must not invalidate stage capture; stage navigation/closure/resize ends its own interval. A closed target needs confirmed stop/reservation release; an unconfirmed live stop remains quarantined. Concurrent intervals share the existing aggregate budget. Preserve source time and host receipt time separately; do not clamp discontinuities or invent minimum FPS. [Current capture admission](../../../packages/platform-browserbase/src/Capture.ts), [native source](../../../packages/platform-browserbase/src/internal/Playwright.ts).

With bootstrap enabled, await stage document readiness before starting a dependent presentation or suspending its clocks. A popup is separately admitted and initialized. Inspect each selected frame through the existing observation API. The operator journal should retain target/document IDs alongside capture interval IDs, not log entire pages.

After closing a recorded session, request MP4 assembly once, poll each page and retrieve selected completed outputs. A partial failure does not fail unrelated pages; BYOS completion may have no download URL. Replay page IDs remain in a provider namespace until a measured join is available. For duplicate URLs, guessed ordinal correlation is unacceptable. Test with distinguishable visual markers and duplicate-URL tabs to establish what the API actually exposes.

## 7. Failure scenarios the examples must not hide

A configuration conflict fails before any allocation. A known 401/429 allocation rejection is different from a lost response; an unknown mutation is never automatically replayed. A bootstrap timeout either closes the owned browser or disconnects/quarantines the borrowed connection according to ownership—it must not leave a usable half-initialized handle. Human handoff failure stays paused. A frozen document cannot be assumed to run readiness timers. A Context commit lacking visibility stays unconfirmed. A recording endpoint returning no data under disabled/ZDR settings is not proof the browser never ran.

The [ZDR guide](https://docs.browserbase.com/account/enterprise/zero-data-retention) states that logs/replay are suppressed while Live View remains available; uploads/downloads/Contexts/extensions are separate storage concerns. Preserve the effective launch recipe to explain absence, and test the documented 404/disabled outcomes rather than mapping every missing artifact to a transient failure. Keep business validation, provider status, initialization evidence and media capture as separate observations throughout the workflow.
