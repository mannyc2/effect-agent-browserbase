# Target architecture and public API proposal

**Status: proposed, not implemented.** The sketches in this chapter use the repository's Effect 4 / TypeScript vocabulary but are not compiled production declarations. Existing behavior is documented in the [capability map](capability-map.md); provider facts and limits are in [platform.md](platform.md). This design does not require a dependency upgrade, upstream core-port proposal, general raw-CDP export or new encoder.

## 1. Decision

Build a **Browserbase resource layer plus an owned browser-operation layer**. Preserve the existing mutation owner and bounded capture rather than replacing them. Make provider resources explicit, let consumers configure actual provider capabilities, and introduce one scoped bootstrap mechanism around maintained native APIs.

```text
consumer account credentials / policy / durable application database
                            │
                   BrowserbaseClient
                (one Effect HTTP boundary)
                  ╱        │          ╲
       Contexts/Extensions Sessions    Recordings/Replays/Downloads/Logs
                            │
                BrowserbaseInteractiveHost
                remote resource ownership
                            │
               BrowserbaseBrowserBinding
                  one local connection
                            │
         Bootstrap → document readiness → existing mutation owner
                  ╲ pages / frames / capture / page control
```

`BrowserbaseClient` is a proposed dependency service, not a browser session. Resource services can operate without importing Playwright. `BrowserbaseBrowserBinding` is a trusted composition seam; its default implementation still validates provider-issued endpoints and lazily loads the pinned automation package. It is not an agent-supplied connection URL.

The default host workflow remains `acquire → connect → use → close`, with scope exit releasing its owned remote browser. New lower-level operations make supervision and adoption explicit rather than changing that default under existing users.

## 2. Resources and identities

Use project-qualified, serializable references for provider resources. Keep live handles non-serializable and non-forgeable by structural copying, following the existing [SessionReference/Capture design](../../../packages/platform-browserbase/src/Types.ts).

```ts
// Proposed additions. Existing SessionReference remains the session identifier.
interface ContextReference {
  readonly provider: "browserbase";
  readonly projectId: string;
  readonly contextId: string;
}
interface ExtensionReference {
  readonly provider: "browserbase";
  readonly projectId: string;
  readonly extensionId: string;
}
interface ContextUse {
  readonly reference: ContextReference;
  readonly persist: boolean;
}
```

Production versions should use the existing bounded `Identifier` and `Schema.Class` pattern. Context names are human labels, not substitutes for IDs or an undocumented lookup operation. Store application-user/account→Context relationships in the consumer's database. Do not store API keys, connect URLs, signed artifact URLs, native Page objects, retained DOM nodes, handoff tokens or page suspension receipts as durable configuration.

A versioned **environment recipe** is useful consumer data, not another provider resource: Context reference, extension artifact reference/digest, provider launch settings, viewport mode, bootstrap identifier/version and business readiness policy. Resolve secret references and executable bootstrap registrations at runtime. Never serialize closures or secrets into `userMetadata`.

Keep four identifier namespaces explicit: provider session, native CDP target, connection-local page/frame/document, provider recording/replay page. A native target can survive reconnect while connection-local IDs do not. Recording IDs cannot be inferred from `page-N`, discovery order or URL alone. [Current identity comments](../../../packages/platform-browserbase/src/Types.ts), [recording API](https://docs.browserbase.com/platform/browser/observability/recording-downloads).

## 3. Configuration: upstream names, one source of truth

Separate account configuration from launch intent and connected-browser setup:

| Configuration | Lifetime / owner | Examples |
| --- | --- | --- |
| Account | Client service / host deployment | API credential, project, request deadline, artifact origins |
| Remote launch | One Browserbase session | Region, proxy rules, extension, Context, Verified, recording/logging, provider lifetime |
| Automation | One owned connection | Action deadline, page admission, popup/dialog policy, retained observations |
| Bootstrap | Connection registrations plus individual documents | Initialization scripts, bindings, permission grants, readiness |
| Business operation | Consumer workflow | Login completion, account identity, upload success, request idempotency |

Proposed launch shape:

```ts
interface LaunchRecipe {
  readonly remoteTimeoutSeconds: number;
  readonly keepAlive?: boolean;
  readonly context?: ContextUse;
  readonly viewport:
    | { readonly _tag: "ProviderManaged" }
    | { readonly _tag: "Fixed"; readonly width: number; readonly height: number };
  readonly provider: ProviderLaunchOptions;
}
```

`ProviderLaunchOptions` should preserve the names and structure of the current provider request: region, ordered proxies, proxySettings, extensionId, browserSettings and userMetadata. Exclude ownership-managed duplicates: projectId, SDK `api_timeout`/REST timeout, keepAlive, nested Context and viewport. Reject collisions instead of applying an undocumented precedence order. For extensionId's top-level/nested aliases, expose one canonical top-level field. The compiler materializes these values exactly once into the REST body.

Keep existing privacy defaults (`recordSession`, `logSession`, `solveCaptchas` off) in the legacy path; allow explicit opt-in in the new recipe. Do not silently change defaults merely because Browserbase defaults differ. Record effective non-secret settings and the recipe version for diagnosis. Copy nested arrays/objects before allocation so caller mutation cannot change admitted policy.

Before allocation, validate cross-field rules: persistent writer has a lease; Verified uses provider-managed viewport and does not accept later resize; OS customization requires Verified; current page-control incompatibilities remain enforced; target and metadata bounds are valid. Feature entitlement remains a provider decision—do not infer availability from a stale plan-name table. Errors should identify unsupported combinations without leaking proxy credentials.

### Avoid a handwritten second SDK

**Recommended initial transport:** retain the official Effect HTTP implementation already used by this repository. Its manual redirect policy, redaction, bounded streams and dispatch-aware failure handling are valuable. Add DELETE/no-content and bounded multipart support needed by real resource workflows rather than coercing every endpoint through JSON GET/POST.

**Recommended contract maintenance:** use the official SDK/OpenAPI as a development-time contract input, with generated, self-contained request DTOs and contract tests for the exposed browser subset. Export no declarations that depend on an undeclared development-only SDK. The first implementation stage must select a reproducible contract source/generator and retain its version; until that is available, a small explicit snapshot with a checked field-diff is safer than pretending generated coverage exists. Review new ownership-sensitive fields; permit new ordinary provider settings only after the generated contract and cross-field tests update.

An optional SDK-backed transport is defensible if it measurably removes code and passes the same boundary tests. It must not add automatic retries of uncertain resource creation, double timeouts, unsafe credential propagation, eager browser loading or unbounded media buffering. Do not install the runtime SDK merely for fashion, and do not reject it because Effect forbids maintained dependencies—it does not. The architectural seam matters more than the initial transport implementation.

Sources: [current Effect HTTP boundary](../../../packages/platform-browserbase/src/internal/Http.ts), [current SDK request mapping](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts), [installed dependency policy](../../../CONTRIBUTING.md).

## 4. Ownership and lifecycle

Three lifetimes must remain separate:

1. **Persistent Context lifetime:** explicit creation to explicit deletion; not ended by closing a session.
2. **Remote session lifetime:** provider allocation to observed terminal state; finite even with keep-alive.
3. **Local connection lifetime:** scoped attachment, registrations, handles, streams and eventual disconnect.

The proposed ownership contracts are:

| Operation / handle | Default finalizer | What it does not imply |
| --- | --- | --- |
| `host.acquire(policy, options)` → owned remote acquisition | Request release and reconcile exact session | Does not delete its Context or extension |
| `acquisition.connect` → owned connection | Dispose local registrations and disconnect; enclosing remote owner still releases | Does not prove a failed business mutation was undone |
| `host.attach(reference, options)` → borrowed connection | Dispose/disconnect only | Does not grant authority to end someone else's remote session |
| `sessions.requestRelease(reference)` / `waitForTerminal` | Explicit administrative operations | Release request is not terminal observation or Context flush |
| `contexts.delete(reference)` | Explicit destructive operation | Never a hidden finalizer of ordinary browsing |

`host.attach` must validate project, current provider status, supplied host control lease, policy and target identity. Wait boundedly for `PENDING`, accept `RUNNING`, and return a typed terminal/expired result otherwise. Retrieve connection credentials on the server for the exact reference; never accept a serialized stale websocket URL. New connection generation invalidates every old handle and observation. Initialization must complete before admitting dependent actions.

**Do not expose a casual `releaseOnClose:false` switch.** It would make remote leaks easy and blur billing ownership. Durable operation requires a consumer-owned supervisor that stores session identity, expiry, recipe and owner lease, then arranges eventual release. A future transfer operation must be two-phase: persist and acknowledge the new owner before disarming the old finalizer. Failure before acknowledgement retains original cleanup; failure with ambiguous acknowledgement quarantines the transfer. Existing `detach` remains a local disconnect inside its original owner scope unless an explicit transfer succeeds.

A process crash can lose an unknown business operation even when a browser remains running. Reconnection provides current evidence, not transaction recovery. Ask the application to reconcile its own operation ID/postcondition before another mutation. Provider `userMetadata` plus allocation nonce supports locating candidates after an uncertain create, but no exactly-once or idempotent create guarantee is invented.

Sources: [existing cleanup/reconnect implementation](../../../packages/platform-browserbase/src/internal/Session.ts), [keep-alive](https://docs.browserbase.com/platform/browser/long-sessions/keep-alive), [provider session operations](https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts).

## 5. Context write semantics

Keep Context coordination pluggable and consumer-owned: database transaction/advisory lock, durable lease service or another real distributed mechanism. A local semaphore alone cannot coordinate multiple application processes. The package must not imply that a consumer fencing token is enforced by Browserbase itself.

Require an exclusive writer lease before a `persist:true` allocation. Retain ownership through disconnect/reconnect and terminal reconciliation. Expose a structured result separating remote termination, context persistence evidence and application validation:

```ts
// Proposed result vocabulary, not new provider states.
type PersistenceEvidence =
  | { readonly _tag: "NotRequested" }
  | { readonly _tag: "Unconfirmed"; readonly reason: "writer-active" | "writer-unknown" | "flush-unacknowledged" }
  | { readonly _tag: "Observed"; readonly method: "consumer-readback"; readonly observedAtMillis: number };
```

`Observed` means the consumer's selected marker/postcondition was read back; it is not proof that all Chromium storage was durably and atomically saved. A changed Context `updatedAt` is metadata evidence only. Do not define a `Persisted` state backed solely by a sleep or session `COMPLETED`.

The consumer chooses a reuse policy: serialize conservatively, perform bounded readback of a known version marker, or quarantine until operator review. An unexpectedly ended writer produces uncertainty, not silent lease release followed by another write. Read-only hydration (`persist:false`) still needs an overlap policy with an active writer; it must not be assumed to see in-flight changes. Context deletion during an active/uncertain writer is rejected by the local coordinator. Provider behavior for concurrent reuse/deletion remains a hosted question.

Preserve generic Effect error/environment types in coordination hooks. Current hooks erase application requirements by demanding `Effect<..., BrowserbaseError>`; do not force consumers to run their own detached runtime or flatten database failures merely to acquire a lease.

```ts
// Signature sketch: E and R survive composition.
interface ContextCoordinator<E, R> {
  readonly acquireWriter: (
    reference: ContextReference,
  ) => Effect.Effect<ContextWriterLease<E, R>, E, R | Scope.Scope>;
}
```

A production lease should offer an explicit success/failure/quarantine settlement operation, with a bounded finalizer as a fallback. Finalizers cannot silently swallow settlement failures or claim a safe Context when the database did not record the outcome. The original workflow failure stays primary; cleanup/settlement failures are additional sanitized evidence.

## 6. Bootstrap and readiness

Model **what must exist before browser actions**, not a collection of unrelated hooks. Provide a trusted `Bootstrap` description with ordered script bundle, origin-scoped bindings, permission operations and readiness criteria. The implementation uses pinned Playwright primitives behind the binding.

[Playwright 1.63 `BrowserContext.addInitScript`](https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md) returns a **Disposable** and covers new documents and frames. Multiple script registrations have unspecified order. Therefore install a single ordered bundle for dependent steps, retain native disposables, and use the native context registration rather than racing page-created callbacks to inject code. Bindings/function exposure should likewise use native facilities, not repeated polling through a second websocket.

Bootstrap execution sequence:

```text
connect with an environment-preserving configuration
 → resolve default native context and target registry
 → install host binding registrations / permissions
 → install the ordered context init bundle
 → register existing-document readiness policy
 → expose connection in Initializing state
 → navigate/create target as requested
 → identify new document epoch and await its declared readiness
 → publish Ready and admit dependent observations/actions
```

Initialization registration and asynchronous document readiness are different. An init script can start a promise before application scripts, but that does not pause the website's own scripts. The library's barrier gates its own dependent operations. A consumer-controlled page can additionally await that promise itself. A late attachment cannot retroactively run before scripts already executed; require one of `RequireFreshNavigation`, `AcceptAlreadyRunning` with explicit verification, or a consumer-approved reload. Never auto-reload a page containing an uncertain transaction.

Track readiness per **connection generation + target + frame + document epoch**, not only URL. Cancel old readiness on navigation/detachment and fence late callbacks. Newly created pages and popups are not operationally ready merely because a `page` event fired. Keep queue length, pending documents, per-binding calls, payload bytes and bootstrap deadlines bounded. Publish useful failure phase/step identifiers without logging script contents or private return values.

### Consumer services are a trust boundary

A binding call is untrusted browser input, even from an otherwise authenticated page. Validate argument and return schemas; verify current frame origin and document generation; restrict allowed origins; cap concurrency/bytes/time; reject after detach, handoff or closure as appropriate. Origin checks prevent unrelated sites from invoking it, but do not defeat XSS on an allowed site—return only least-privilege data. Proxy/API/database credentials remain in the host.

Execute callback Effects in the owning scope with captured dependencies; cancel them on disposal. A binding invoked by a page action must not synchronously request another mutation behind the same held permit: that deadlocks. Permit read-only host-service callbacks during a pending native action, and queue any requested browser mutation until the original action has settled. The host decides authority; a callback cannot expand the agent's browser policy.

### Deliberate lower-level access

Expose an injectable Browserbase-named binding interface with capability negotiation, not Cloudflare's types and not a general `CDPSession.send`. First-class bootstrap operations should cover scripts, bindings, cookies and permissions. Add targeted native capabilities only for concrete workflows, including file attachment and necessary inspection.

For consumers whose needs cannot fit those operations, a separate explicitly native-authority integration mode may be considered later. It must relinquish the package's managed-operation guarantees for that period and invalidate affected observations before re-entry. Do not advertise an arbitrary callback receiving a raw Browser as safely scoped: the callback can retain that object, initiate background work and bypass all future guards. A branded type alone cannot prevent that. This review recommends **not shipping that raw-object mode in the initial stages**.

## 7. Effect implementation conventions

Use the installed `Context.Service`, `Layer.effect`, `Effect.scoped`, `Effect.acquireRelease`, `Schema`, `Redacted`, `Stream` and bounded owned fibers/queues. The current source and [public type tests](../../../packages/platform-browserbase/test/public-types.test.ts) are the version-specific patterns, not Effect 3 tutorials. Avoid new detached runtimes, global mutable Playwright monkeypatches, unbounded callback promises and parallel finalizers whose ordering is essential.

A public connection method that runs consumer code must retain its `E` and `R`:

```ts
// Proposed signature, not an implementation or currently exported API.
declare const withBrowser: <A, E, R, InitE, InitR>(
  options: OpenOptions<InitE, InitR>,
  use: (session: BrowserbaseSession) => Effect.Effect<A, E, R>,
) => Effect.Effect<
  A,
  E | InitE | BrowserbaseError,
  R | InitR | BrowserbaseClient | BrowserbaseBrowserBinding
>;
```

Internally, this helper provides the scope; explicit acquisition returns `Scope.Scope` in `R`. Schema-validated persistent data must not erase the live owner associated with handles. Account services should not require a browser scope until they actually create resources. Public callback types need declaration/type tests in the packed package, including application-specific errors and services.

Retain a sanitized public failure algebra and separate private diagnostic evidence, in line with [#6](https://github.com/mannyc2/effect-agent-browserbase/issues/6). Prefer phase-specific errors for configuration/rejected allocation/uncertain allocation/bootstrap/terminal session while keeping a compatible projection to existing `BrowserbaseError` during migration. Preserve dispatch classification across core/Tools mapping; do not infer it from native message strings. Expected absence such as BYOS delivery or disabled recording is not a generic transport failure.

Cancellation of a Promise-backed native command cannot undo dispatch. Retain ticket checks, late-result disposal and owner fencing. GET inspection can use bounded backoff; automatic mutation replay is forbidden when outcome is unknown. Finalizers stop streams and callbacks, dispose registrations, disconnect, request release when owned, observe terminal status and settle Context coordination in a specified order. Cleanup evidence remains inspectable even when cleanup cannot be confirmed.

## 8. Customization, observation and capture coexistence

An init script can change page state without a host action. Observations are admission evidence, not immutable DOM snapshots; retain exact-node and generation checks. A binding returning data need not stop unrelated capture. Navigation or geometry changes of a captured target still invalidate the corresponding interval; selection changes on a scout page do not.

Complete bootstrap before suspending a page whose timers/readiness promises must run. Handoff pauses automation, not page JavaScript, extensions or network. Detach leaves the remote browser running only under its keep-alive/lifetime contract; host-service bindings cannot be assumed usable while the host connection is gone. Extension background workers have their own lifecycles, not the Effect connection scope.

Keep recording/replay/live capture separate. Add a bounded event journal connecting allocation attempt, environment version, session, connection generation, target/document, operation phase and artifact reference. Do not record raw URLs, content, screenshots, script arguments or credentials by default. This produces useful operator diagnostics without weakening the current private transport boundary.
