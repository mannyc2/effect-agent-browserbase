# Target architecture and public API proposal

**Proposed, not implemented.** This chapter now incorporates the code-organization follow-up. The concrete [directory tree, module ownership and package decision](organization.md) and [pinned Effect conventions](effect-conventions.md) are part of the design, not optional appendices. [Capability map](capability-map.md) describes inspected implementation; [platform research](platform.md) describes provider behavior; [workflows](workflows.md) and [implementation plan](implementation-plan.md) use the target names below. No sketch was typechecked in this sandbox. No runtime/dependency change is made by this documentation PR.

## Decision and dependency direction

Build Browserbase resources and owned browser operations in proposed **`@effect-agent/browserbase`**; retain **`@effect-agent/platform-browserbase`** for Effect Agent integration and legacy exports. Both use Effect. Only the adapter imports the framework. Keep resources/native operations/capture as subpaths of the generic package initially: Playwright is already an optional lazily loaded peer, so another package split needs evidence beyond distinct lifetimes.

```text
                     host application / account store / supervisor
                                       │
                @effect-agent/browserbase (generic Effect integration)
                       Client: one strict HTTP configuration
                    ╱          │             ╲
             Contexts       Sessions       artifacts / files / logs
                               │
                  BrowserbaseBrowser service
                 ╱             │              ╲
       remote acquisition   one Owner      trusted BrowserBinding
            journal         and tickets     lazy Playwright driver
                               │
                 targets / documents / initialization
                      observations / actions
                       capture / page control
                               ▲
            @effect-agent/platform-browserbase (adapter only)
          framework policy + BrowserHandle + Tool/error projections
```

A generic consumer should not install `effect-agent` or manufacture its `InteractiveBrowserPolicy` merely to retrieve a recording or operate an owned browser. Conversely, a framework consumer should not need to understand a new lifecycle just to keep using the existing adapter. That is the purpose of the compatibility facade, not justification for two owners. [Current dependency manifest][manifest], [current public handle contract][interactive], [type assertions][type-tests].

## Resources and identities

Keep provider resources and live capabilities distinct:

| Concept | Durable data | Live authority / deletion |
| --- | --- | --- |
| Browserbase Context | project-qualified Context reference and optional name | Explicit create/retrieve/delete; never deleted by a session finalizer |
| Uploaded extension | qualified resource reference, consumer-controlled artifact digest/version | Provision separately; reference at launch; explicit deletion |
| Remote session | `SessionReference`, allocation attempt, provider metadata, recipe version | Owned acquisition or consumer supervisor requests release and observes terminal status |
| Local browser controller | no native handles persisted | Scoped connection, one mutation owner, page/observation/capture authority |
| Document/observation | bounded returned evidence; document epoch is connection-local | Native retained nodes and readiness belong to the current connection/document |
| Recording/replay/download | provider-qualified artifact identity | Independent retrieval; signed access URLs are temporary authority, not identity |

`References.ts` defines shared qualified IDs and allocation attempt data. Feature modules own their result schemas. The adapter's `Types.ts` reexports canonical constructors instead of creating an alternate schema universe. Native SDK objects, callback closures, writer/control leases, handoff tokens and page suspension receipts are not durable environment data.

An **environment recipe** is application configuration, not a Browserbase resource: Context reference, extension reference/digest, provider settings, viewport policy, bootstrap version and business readiness rules. The application stores account→Context and recipe→code-artifact mappings. Secret references are resolved only on the trusted host. Do not put secrets or serialized closures into provider userMetadata.

There are separate provider-session, Chromium-target, connection-local page/frame/document and provider-artifact-page namespaces. Never join them by discovery order, `page-N` or URL alone. A target may survive reconnection; a connection-local handle does not. Existing source already distinguishes these identities. [Current schemas][types].

## Generic consumer and adapter contracts

The following is a **selected target contract**, not an exhaustive declaration file. All asynchronous public operations are Effect/Stream. `BrowserPolicy`, action requests/results and page/observation data are generic package Schemas, not framework imports. The initial generic network assertion remains trusted `Unrestricted`; provider `allowedDomains` is a separate, weaker navigation filter.

```ts
// PROPOSED generic contracts; each named data type has one feature-owned Schema.
interface BrowserPage {
  readonly target: Target; // connection + selection generation bound at acquisition
  readonly navigate: (request: NavigateRequest) => Effect.Effect<NavigationResult, BrowserbaseError>;
  readonly readText: (request: ReadTextRequest) => Effect.Effect<TextResult, BrowserbaseError>;
  readonly click: (request: ClickRequest) => Effect.Effect<ActionResult, BrowserbaseError>;
  readonly fill: (request: FillRequest) => Effect.Effect<ActionResult, BrowserbaseError>;
  readonly scroll: (request: ScrollRequest) => Effect.Effect<ActionResult, BrowserbaseError>;
  readonly screenshot: (request: ScreenshotRequest) => Effect.Effect<ScreenshotResult, BrowserbaseError>;
}

interface BrowserSession<InitE = never> {
  readonly reference: SessionReference;
  readonly currentPage: Effect.Effect<BrowserPage, BrowserbaseError>;
  readonly pages: Effect.Effect<ReadonlyArray<PageInfo>, BrowserbaseError>;
  readonly frames: Effect.Effect<ReadonlyArray<FrameInfo>, BrowserbaseError>;
  readonly selectPage: (pageId: string) => Effect.Effect<BrowserPage, BrowserbaseError>;
  readonly selectFrame: (frameId: string) => Effect.Effect<BrowserPage, BrowserbaseError>;
  readonly createPage: Effect.Effect<PageInfo, BrowserbaseError>;
  readonly closePage: (page: PageInfo) => Effect.Effect<void, BrowserbaseError>;
  readonly observe: (options?: ObserveOptions) => Effect.Effect<Observation, BrowserbaseError>;
  readonly clickElement: (element: ObservedElement) => Effect.Effect<ActionResult, BrowserbaseError>;
  readonly fillElement: (element: ObservedElement, value: string) => Effect.Effect<ActionResult, BrowserbaseError>;
  readonly failure: Effect.Effect<never, InitE | BrowserbaseError>;
  readonly disconnect: Effect.Effect<LocalCleanupResult, BrowserbaseError>;
}

interface OwnedBrowserAcquisition<InitE = never> {
  readonly reference: SessionReference;
  readonly attempt: AllocationAttempt;
  readonly connect: Effect.Effect<BrowserSession<InitE>, InitE | BrowserbaseError>;
  readonly release: Effect.Effect<CleanupResult, BrowserbaseError>;
}
```

The acquisition itself requires Scope. `connect` borrows that existing acquisition lifetime; its returned session cannot escape it. Repeated initial `connect` calls share the one live controller, as today. The complete API also carries the existing compound waits, downloads, viewport/handoff controls and same-owner keep-alive `detach/reconnect` operations; they are omitted from this sketch only for readability, not removed by the split. `disconnect` ends local attachment; explicit keep-alive `detach` retains reconnectability inside the original controller scope. Neither transfers remote ownership. Borrowed attachments use local-only cleanup and cannot expose remote release authority accidentally.

`BrowserPage` is a binding to a selected target/generation, not a raw Playwright Page. It becomes stale after a selection/generation change, preserving the current handle contract. A selected-page convenience method must resolve/check its target under the same owner admission; reading a current page and later mutating an unrelated new selection is not acceptable. Document readiness failures fence admission and are reported through the configured supervision contract, without claiming that a completed installation Effect can fail retroactively.

Adapter composition is deliberately thin:

```ts
// PROPOSED adapter entry, implemented only in platform-browserbase.
interface HandleAuthority {
  readonly close: Effect.Effect<CleanupResult, BrowserbaseError>;
}
declare const toBrowserHandle: (
  page: BrowserPage,
  authority: HandleAuthority,
) => BrowserHandle; // imported from the installed effect-agent only HERE

declare const fromOwned: <InitE>(
  acquisition: OwnedBrowserAcquisition<InitE>,
  session: BrowserSession<InitE>,
) => BrowserbaseSession; // legacy facade; no allocation or additional semaphore
```

`toBrowserHandle` translates request/result/error values exactly once. Its close authority is explicit because a page controller is not inherently allowed to release a remote session. `fromOwned` preserves the existing `.handle`, `.currentHandle`, two-phase host acquisition and cleanup behavior. Legacy `Capture.start`/PageControl wrappers delegate using the facade's canonical generic session, not an independent WeakMap of cloned authority. Generic users call generic Capture directly. Reexports preserve resource service tag identity across both packages.

The adapter owns `InteractiveBrowserPolicy` validation and rejection of `ExactHosts`/`PublicWeb`, framework errors, current implementation identity, and actual Effect AI Tool/Toolkit composition. It must not add its own browser-operation counter or mutation permit. Host/direct and agent actions debit the same generic owner. Keep current legacy signatures during the compatibility window; do not silently add arbitrary callback errors to the installed framework's closed error algebra. Opt-in generic helpers retain consumer E/R; framework projection reports sanitized framework errors while detailed host supervision stays on the generic session.

## Shared configuration and provider evolution

Separate immutable account configuration, per-session launch intent, connection policy, bootstrap and business logic:

```ts
// PROPOSED request shared by generic acquire/withBrowser.
interface OpenRequest<InitE = never, InitR = never> {
  readonly policy: BrowserPolicy;
  readonly launch: LaunchRecipe;
  readonly automation?: AutomationOptions;
  readonly bootstrap?: Bootstrap.Plan<InitE, InitR>;
  // Writer/control coordination is host-owned and generically typed;
  // exact generic port contracts are described in the Effect chapter.
}
interface LaunchRecipe {
  readonly remoteTimeoutSeconds: number;
  readonly keepAlive?: boolean;
  readonly context?: { readonly reference: ContextReference; readonly persist: boolean };
  readonly viewport:
    | { readonly _tag: "ProviderManaged" }
    | { readonly _tag: "Fixed"; readonly width: number; readonly height: number };
  readonly provider: ProviderLaunchOptions;
}
```

Context writer coordination should be supplied as a typed capability acquired by the caller and associated with the attempt, not as an untyped callback field on the account singleton. Read-only Context use needs no writer receipt, but still follows the application's overlap/reuse policy. Extension reference validation belongs to launch compilation, not native connection setup.

`ProviderLaunchOptions` follows provider names for region, ordered proxies, proxySettings, extensionId, browserSettings and userMetadata. Exclude duplicates managed by ownership: project ID, REST timeout/SDK api_timeout, keepAlive, nested Context and viewport. Canonicalize extension selection to its top-level field; reject duplicate conflicting aliases rather than choosing an undocumented precedence. Protect the allocation metadata namespace and copy nested mutable input once before POST.

Retain legacy recording/logging/CAPTCHA-off defaults. Make new opt-ins explicit rather than silently inheriting provider defaults. Cross-field admission includes a persistent writer capability, Verified/provider-managed viewport, supported OS configuration, page-control incompatible modes, identifier/metadata bounds and region/configuration shape. Entitlement is a provider result, not a hard-coded plan-name decision. [Current launch body][provider], [SDK request and timeout translation][sdk-sessions].

Keep official Effect HTTP transport initially. It already owns credential isolation, manual redirects, bounded streams and deadlines; an SDK replacement must pass those tests and disable uncertain-mutation retries. Add no-content DELETE and bounded multipart as required by actual resources. The Client may expose a host-only control-plane request port, but resource services remain the documented workflow API and model-facing tools never receive that port. Raw browser/CDP access is not implied.

Select a reproducible pinned SDK/OpenAPI contract input and an offline field-diff/generation procedure in Stage 1. Emit self-contained DTOs; no `.d.mts` may import an undeclared development-only SDK. Until reproducible generation exists, use a small explicit browser-subset snapshot with provenance and drift tests. Do not claim automatic coverage or blindly pass unknown ownership-sensitive fields. The current repository has no installed Browserbase SDK dependency to upgrade. [Manifest][manifest].

## Lifetimes and cleanup ownership

| Operation | Required owner | Cleanup consequence |
| --- | --- | --- |
| `Contexts.create/retrieve/delete` | application account authority | Persistent resource; no session-scope deletion |
| `BrowserbaseBrowser.acquire(request)` | enclosing execution Scope + writer capability where needed | Register cleanup journal before POST; finalizer releases owned remote session |
| `acquisition.connect` | existing acquisition/controller lifetime | Connection, targets, registrations and intervals attach to the one owner |
| `BrowserbaseBrowser.attach(reference, options)` | caller Scope + supervisor-issued control claim | Borrowed local connection; disconnect-only finalizer |
| `Sessions.retrieve/list/waitForTerminal` | account service | Passive inspection; never releases by surprise |
| `Sessions.requestRelease` | explicit administrative authority | Request accepted is not terminal or Context-flush evidence |
| Legacy host `reconcile` | legacy adapter | Retains release-oriented semantics; deprecated in favor of explicit names |

[Current Session][session] already registers teardown before create, remembers identity before validating the connect URL and distinguishes local and remote cleanup. Extract these guarantees intact. Narrow factory/port boundaries should make them easier to locate, not replace them with a single optimistic SDK call.

The [Effect chapter's ordered cleanup contract](effect-conventions.md#6-cleanup-one-ordered-program-and-honest-receipts) is authoritative. Mechanical extraction preserves current remote-first ordering. A later separately tested lifecycle change uses quiesce children → disconnect local → independently release/reconcile remote → settle/quarantine writer. Both paths preserve actual failures; neither can infer provider termination from a broken socket. Cached close execution coalesces explicit close, timeout and finalizer callers.

Do not add a casual `releaseOnClose:false` option to the owned default. A durable supervisor stores reference/expiry/recipe/lease and arranges eventual release. Cross-process attachment retrieves fresh connection credentials after checking project/status/target; it cannot recover lost business transaction outcomes. Any future transfer of remote ownership is a separate two-phase acknowledgement protocol, not serializing a session handle. No default exactly-once or automatic mutation replay guarantee is added.

## Context persistence coordination

The existing `{context:{id,persist}, contextLease}` is a valid partial foundation. New Context operations use qualified references; generic coordination preserves consumer error/service types. The consumer supplies actual distributed exclusion, not a library-local semaphore advertised as a multi-process lock. Browserbase does not thereby enforce the consumer's fencing token.

A writer lease must precede allocation and survive disconnect/reconnect and uncertain cleanup. Associate settlement with the exact attempt/reference. Separate provider terminal status, Context metadata change and consumer readback:

```ts
// Evidence vocabulary, not new Browserbase states.
type PersistenceEvidence =
  | { readonly _tag: "NotRequested" }
  | { readonly _tag: "Unconfirmed"; readonly reason:
      "writer-active" | "writer-unknown" | "flush-unacknowledged" }
  | { readonly _tag: "Observed"; readonly method: "consumer-readback";
      readonly observedAtMillis: number };
```

`Observed` proves only the selected marker/postcondition, not an atomic snapshot of every storage system. Do not release a quarantined writer merely because the scope ended, `updatedAt` changed or a fixed sleep elapsed. Read-only hydration during a writer needs an explicit policy; unexpected termination and lease-settlement failure remain uncertain. Deletion while active/uncertain is rejected by the cooperating application coordinator, while provider overlap/deletion semantics remain hosted questions H1/H2.

A coordinator can provide `withWriter(reference, use)` or explicit scoped acquisition. The former removes Scope from consumer requirements; the latter retains it. Explicit settlement returns typed errors and receipts; fallback finalization records/quarantines without overwriting the primary workflow cause. No deprecated Context upload/import API is added. [Current Context SDK deprecations][sdk-contexts].

## Bootstrap, document readiness and consumer services

`Bootstrap.Plan<E,R>` describes trusted registrations and readiness requirements. It is a typed value, not another provider resource or ambient service. Native registration implementation lives behind the trusted Effect binding; no raw Playwright object escapes into a consumer callback.

```text
validated launch → retained allocation identity → connect under current epoch
 → default native context/target discovery
 → install host bindings and permissions
 → install one ordered init bundle using native context registration
 → choose explicit policy for documents already running
 → fresh navigation/document epoch → await configured readiness
 → admit dependent observations/actions under the same owner
```

Registration and asynchronous readiness are different. Playwright can run an init script before fresh document scripts, but an async promise started there does not freeze website execution. The library gates its own operations; a consumer-controlled page may also await that promise. Existing documents cannot be made pre-script retroactively: choose `RequireFreshNavigation` or verified `AcceptAlreadyRunning`; an explicit consumer-approved reload is a business decision and never a response to uncertain input.

Use the pinned native `addInitScript` registration and Disposable. Bundle dependent initialization steps rather than assuming order across multiple context/page registrations. Track readiness by connection generation + target + frame + document epoch, not URL. Navigation/detachment cancels old readiness; late callbacks cannot satisfy new documents. New tabs/popups receive context-level registration, not a late event-handler injection advertised as early execution. [Pinned Playwright documentation][pw-context].

Bindings validate input/output schemas, source origin and live epoch, byte limits, admission count and deadline. They capture consumer services in the connection scope, supervise callback errors separately from completed installation Effects and cancel on disposal. Page-side errors are sanitized. Allowed-origin XSS can still call an exposed binding; only least-privilege operations belong there. A callback waiting behind the same mutation permit as its triggering action deadlocks; host-service calls are separate from explicit queued browser follow-up. [Effect callback design](effect-conventions.md#5-consumer-callback-er-including-failures-after-installation).

Extensions may need Chrome isolated-world and service-worker messaging; they cannot assume shared globals with page-world bindings. Their durable storage/identity across Context reuse remains H3, and reconnect registration retention/removal remains H4. No extension bundler, generic reverse tunnel, raw CDP mode, or new audio transport is a prerequisite for scoped customization.

## Maintainability: remove layers of work, not guarantees

| Before | Target | Preserved invariant |
| --- | --- | --- |
| Four `makeHttp` and `makeProvider` paths, differing strict-option behavior | One Client dependency; feature services own routes; no forwarding-only Provider layer | One account validation and transport policy; resource-only calls remain browser-free |
| Provider launch fields hidden inside Session/InteractiveBrowser construction | One validated recipe→wire compiler | Attempt identity, reserved fields, exact body defaults and no uncertain retries |
| Framework `BrowserHandle` is the only general action surface | Generic BrowserPage/session operations; one adapter mapping | One owner/mutation budget and installed framework compatibility |
| Session closure mixes provider, connection, callbacks, capture and lease settlement | Explicit acquisition journal, connection epoch, cleanup coordinator | Known identity survives failure; independent remote/local facts and quarantine |
| One Playwright closure mixes discovery, observation, action and screencast state | Injected target/document/observation controllers plus native primitives | Exact-node validation, no selection race, child capture invalidation and source clocks |
| Mixed global Types file | Shared References/Errors and feature-owned Schemas; legacy reexports | Existing encoded IDs/shapes and constructor identity |

A setting change should touch Contract/Launch and wire tests, not Owner or Tools. A Context route should touch Contexts/transport tests, not Playwright. A new permission/bootstrap capability should touch Bootstrap, native registration, document readiness and callback tests, not rewrite remote allocation. File-by-file steps and change recipes are in [the plan](implementation-plan.md).

## Effect conventions and compatibility

Follow the exact rc.115 [conventions and code examples](effect-conventions.md): `Context.Service`/Layer dependencies, Schema boundaries, typed error families, inline `Effect.gen`, useful traced `Effect.fn`, internal `fnUntraced`, scoped native callbacks and bounded concurrency. Per-session mutable controllers are not singleton service tags. `Owner` alone mutates lifecycle/generation/admission state; named transitions replace external writable state.

Scope-providing helpers return `BrowserbaseBrowser | Exclude<R | InitR, Scope.Scope>`, not an unchanged R union. Initialization can fail after installation, so explicit sessions expose supervised failure; structured helpers monitor it. Native interruption is not undo, and late results still require ticket checks and disposal. Finalizers record sanitized cleanup outcomes; arbitrary blocking/uninterruptible consumer code is outside a hard timing guarantee.

Preserve all existing adapter subpaths and signatures during an explicit prerelease compatibility window, including legacy Types/service identities and capture authority. Add a separate generic no-framework consumer test rather than declaring success after reorganizing imports. The root wrapper's one-package bootstrap/one-tarball release assumptions must change as part of the package stage; no package is considered split until emitted Node/Bun consumers install the candidate tarballs successfully. The proposal is independent of npm publication authorization or an upstream merge.

[manifest]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/package.json
[interactive]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/InteractiveBrowser.ts
[type-tests]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/public-types.test.ts
[types]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Types.ts
[provider]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Provider.ts
[session]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Session.ts
[sdk-sessions]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts
[sdk-contexts]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts
[pw-context]: https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md
