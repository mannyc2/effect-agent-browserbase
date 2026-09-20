# Implementation stages, structural migration and acceptance

**Documentation-only proposal.** No stage is implemented by this PR. The baseline remains `1b3e9b1916621d036f2568c821e83bed72400f9c`. [Organization](organization.md) specifies the target tree/dependency graph; [architecture](architecture.md) defines resource/session contracts; [Effect conventions](effect-conventions.md) define code/error/scope rules; [workflows](workflows.md) use the same APIs. References to new paths below are implementation instructions, not existing files.

## Sequence and review discipline

Establish shared dependency/ownership boundaries first; then split distribution; then add provider capabilities and extract their native responsibilities when needed. Do not precede useful capability work with an all-at-once rewrite of every private module.

| Stage | Independently verifiable result | Structural work it owns |
| --- | --- | --- |
| 0A | Shared strict account configuration and injectable trusted binding inside existing distribution | Client service, explicit policy/handle projection seam; preserve cleanup/owner behavior |
| 0B | Generic Browserbase and Effect Agent adapter install as two candidate packages | Actual generic moves, compatibility facade, two-package bootstrap/build/pack/release tests |
| 1 | Faithful launch and passive inspection | Contract/Launch compiler, Sessions service, semantic provider errors |
| 2 | Complete Context resource/coordination workflow | Contexts/References, acquisition journal and typed coordinator settlement |
| 3 | Customized documents, tabs, frames and callbacks become ready coherently | Targets/Documents/Initialization/Observation/Actions extraction and native registration ports |
| 4 | Borrowed cross-process attachment and explicit lifecycle cleanup | Connection/Cleanup/Handoff boundaries, independently tested target finalizer ordering |
| 5 | Files and multi-page operational diagnosis | Uploads/Logs/correlation plus existing artifact services; capture extraction only where justified |

Keep exact Effect/framework/Playwright/toolchain pins throughout structural stages. New runtime dependencies, public breaking changes and provider behavior changes each need their own explicit decision. Each implementation slice should be revertible without losing persisted identities or changing unrelated applications in the pinned upstream workspace.

## Stage 0A — dependency boundaries before file/package movement

**Priority:** immediate. **Dependency:** current pins only. **Outcome:** one account Client and one controlled browser binding; current consumers still behave the same.

1. Add `Client.ts`/strict configuration construction in the existing package. Resource Layers consume that service through explicit `layer`/`layerWithClient` composition; retain existing option-taking convenience constructors as delegates.
2. Fix examples that pass interactive options into strict artifact configuration. Do not globally accept unknown account fields. Test both supported legacy constructors and the new single-Client composition.
3. Extract framework request/policy/error projection from generic operation construction in `InteractiveBrowser.ts`. Identify the existing framework `BrowserHandle` as the adapter facade, not the eventual generic contract.
4. Introduce a Browserbase-named trusted binding service with Effect-based native-neutral contracts. Default binding retains strict provider-issued URL checks and lazy Playwright loading. Local fixtures supply the binding rather than changing `chromium.connectOverCDP` globally.
5. Hide external writes to owner phase/generation behind named transitions, retaining the same permit/ticket semantics. Do not change selection invalidation, busy admission, privacy defaults, cleanup ordering or error classes in the same extraction.

**Touched current modules:** `InteractiveBrowser.ts`, `internal/Http.ts`, `Provider.ts`, `Driver.ts`, `Session.ts`, `Playwright.ts`; public artifact Layer constructors; examples and neighboring tests. A DTO compiler is not yet a new public setting.

**Acceptance:** build a shared Client with all four existing service families; one configuration construction, no provider call or Playwright import during Layer construction; same-account identity and cross-account rejection; strict unknown-field behavior consistent with declared constructors; ambient fetch/header/tracing isolation unchanged. Count provider requests and native connections, not merely service instances. Test production connector URL rejection independently: an injected local binding does not establish hosted connector behavior. Preserve late connection disposal after interruption. Run the existing packed consumer unchanged.

**Evidence motivating this stage:** the source mismatch between `httpOptions` and artifact `makeHttp(options)`, and the [attributed hosted failure/fix in #6](https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681). Shared client construction does not itself implement global rate scheduling; avoid copying that unsupported claim from an older issue body.

## Stage 0B — two-package distribution and compatibility

**Priority:** before adding broad generic capabilities. **Depends on:** 0A. **Outcome:** a resource-only consumer and a generic browser consumer install no Effect Agent dependency, while existing adapter consumers continue to work.

### Moves and public exports

Create proposed `packages/browserbase` (`@effect-agent/browserbase`). Move generic Client/transport/provider/owner/native/capture/artifact implementations there **without semantic rewrites**. Add the generic `Browser.ts`/`BrowserPage` contract and canonical References/feature schema exports. At this stage, retain cohesive portions of Session/Playwright internally where their deeper extraction belongs to later capability work.

Keep `packages/platform-browserbase` as adapter: `Adapter.ts`, legacy `InteractiveBrowser.ts`, `Tools.ts`, framework policy/error projections and compatibility reexports. Its `Types.ts` reexports identical constructors; artifact services reexport identical service tags. Capture/PageControl facade functions unwrap the one canonical generic session. No second owner, generation counter, buffer-budget registry or action permit may be created by adapter composition.

Retain existing root namespaces and all nine existing export-map entries. Add `adapter` deliberately and update export inventories. Generic entry points expose no framework or Playwright types in declarations. Preserve the existing legacy `BrowserbaseSession.handle: BrowserHandle` and E/R assertions; add separate generic assertions instead of weakening them.

### Required packaging changes — this is not only a source move

| File / subsystem | Concrete change | Acceptance obligation |
| --- | --- | --- |
| `tools/packages.mjs` (new) | Explicit ordered inventory of the two owned names, directories, allowed subpaths and allowed workspace edges | Dependency-free Node module; reject an unknown package, duplicate name/path or cycle |
| `tools/bootstrap.sh` | Copy tracked regular files from **both** approved package roots; preserve fresh-destination, symlink and dirty-source constraints | A fixture proves both packages are copied, untracked/ignored files excluded and no arbitrary root path admitted |
| `upstream.patch` | Add both workspace manifests/lock entries, generic→adapter build order and root dependencies/check inventories as required; update the existing Changeset/fixed release group explicitly | Apply once to clean pinned upstream; both frozen installs succeed; no catalog drift or unrelated workspace edits |
| Package manifests | Generic: Effect peer + optional exact Playwright peer, no framework dependency. Adapter: regular `workspace:*` edges to generic and framework, rewritten to exact versions in distribution | Published generic dependency graph excludes framework/testing; all peers/catalog references resolved correctly; no unapproved package names |
| Vite+/declarations | Build generic first, then adapter through the task graph; externalize cross-package dependencies rather than embedding duplicate generic schema/service code | All public exports resolve to emitted `.mjs`/`.d.mts`; declarations are named/self-contained; no source path, workspace alias or private native type leaks |
| `tools/package-release.mjs` | Replace one hard-coded package with the explicit inventory and a validated workspace-version map. Do not generalize `workspace:*` into arbitrary package discovery | Produce and verify **two immutable tarballs** and one release-set receipt; each exact adapter dependency matches the generic candidate version |
| Release receipt consumers | Introduce an explicitly versioned `release-set.json` containing per-package name/version/path/hash/size/source SHA and dependency edges; update every current `release.json` consumer atomically | Reject missing/extra/replaced tarballs, mixed source revisions and wrong dependency versions. Do not silently reinterpret schemaVersion 1 |
| `tools/packed-consumer.sh` | Exercise four clean consumers described below, using unmodified candidate tarballs and tracked consumer programs | Both Node and Bun resolve candidate packages, never an already published generic package or workspace source |
| `tools/run-acceptance.sh` | Build/check/package both packages and keep command exit/evidence accounting per package and consumer | All relevant independent stages run and retain failures; required unpaid acceptance remains red on any failure |
| Root/upstream export and purity checks | Add the generic package, approved adapter→generic edge and forbidden generic→framework/native-declaration edges | Test namespace imports and declaration closure, not only direct source import strings |
| Examples/native fixtures | Move provider-only examples/tests to generic ownership; retain real AgentRuntime example/tests in adapter; share native test fixtures by explicit tooling copy, not a runtime package dependency | Resource/native examples compile without framework; agent example uses both public packages; legacy emitted program remains unchanged |
| Release workflow/docs | Validate a two-member release set and publish dependency-first only in the separately authorized release job | No publishing/permissions/registry setup is authorized by this plan; OIDC remains isolated and package identity is checked for each member |

The existing release script asserts one specific name/directory/export set and only permits `effect-agent` as a workspace dependency. The existing packed consumer installs one tarball and explicitly installs framework/testing/Playwright, so it **cannot demonstrate generic isolation**. These are inspected constraints, not hypothetical work. [Bootstrap][bootstrap], [package-release][pack], [packed consumer][consumer], [upstream patch][patch].

Keep repository maintenance scripts dependency-free and under `tools/`. Do not introduce Effect, a Schema runtime, an SDK, a shell-out formatter installer or a package-manager plugin into the OIDC-authorized publishing process. Runtime source belongs in the packages; release tooling is not a generic browser subpath.

### Four emitted consumer gates

| Consumer | Installed runtime graph | Required checks |
| --- | --- | --- |
| `resources-only` | generic candidate + exact Effect; **no framework, testing, Playwright or Browserbase SDK** | Import every generic non-native subpath and root; NodeNext `skipLibCheck:false`; fake-HTTP Context/session/artifact operations; inspect dependency/declaration graph |
| `generic-browser` | generic candidate + exact Effect/Playwright | Real local Chromium/CDP navigation, exact-node action, capture and close; no framework import/dependency |
| `agent` | both candidate tarballs + exact Effect Agent/Effect/testing/Playwright as test requirements | Real AgentRuntime/scripted model borrows the same generic owner; action budget and cleanup not duplicated |
| `legacy` | same two candidate tarballs through old adapter imports | Existing program and type assertions unchanged; old shapes/defaults/errors/close/capture behavior preserved |

Use test-only consumer overrides to resolve the adapter's exact generic dependency to the generic candidate tarball if needed by the package manager. Do not edit the tarball's production dependency to a `file:` URL. Assert installed name/version/hash and real import paths; fail rather than fetching a different registry version. External type checking must not resolve a sibling workspace source file through tsconfig paths.

Initial release versions are coordinated, with exact regular adapter→generic and adapter→framework distribution dependencies. There is no atomic npm transaction for two packages: publish generic before adapter, retain per-member receipts, and on partial publication resume only after checking an existing version's identity. Never rebuild or overwrite an already published version to make a release set appear complete. Actual registry/OIDC authorization for a new name is a separate maintainer prerequisite.

**Migration gate:** no automatic removal of old exports in the split. Document a prerelease compatibility window, provide old→new imports, and test both. Removal/narrowing of legacy constructors, fields, error tags or peer windows requires a subsequent announced breaking release. `reconcile` keeps release semantics under its legacy name. Preserve encoded resource/reference fields and same constructor identity across reexports. The generic namespace must not expand the framework's security claims.

## Stage 1 — faithful provider configuration, inspection and failures

**Depends on:** 0B. **Outcome:** requested browser configuration reaches the provider, and operators can inspect without releasing.

Add `internal/provider/Contract.ts` and `Launch.ts`; `Sessions.ts` owns the actual HTTP operations and bounded passive waits. Select a reproducible SDK/OpenAPI input and offline generation/field-diff check before claiming generated coverage. No undeclared SDK dependency may leak into declarations. Retain official Effect HTTP transport initially; add no-content DELETE/multipart only with actual resource use and tests.

Expose region, ordered managed/external proxy rules and CA references, extension selection, Verified/OS, provider allowedDomains, CAPTCHA/ad-block/logging/recording/TLS settings and caller metadata. Separate remote timeout from execution/action/request/initialization deadlines. Add provider-managed viewport and reject conflicting native resize/setup. Compile ownership-reserved fields once; reject duplicate aliases. Preserve old defaults through `internal/Legacy.ts` rather than maintaining two independent provider request builders.

Add `Sessions.retrieve/list/waitForTerminal` and explicit `requestRelease`; handle bounded PENDING admission without inventing a provider queue. Distinguish known HTTP rejection from lost-create uncertainty. Evolve errors by coherent families (configuration/provider, allocation, browser operation, bootstrap, transfer), not a distinct class for every operation and not one ever-growing reason union. Adapter mapping preserves legacy reason/status/outcome for old callers.

**Acceptance:** golden wire body for each exposed field and existing defaults; immutable admitted proxy order/metadata; invalid combinations fail before POST; native setup never overrides provider-managed viewport; REST `timeout` versus SDK `api_timeout` correct. Known 401/403/429 reject once with useful retry information; lost POST remains unknown and is never auto-retried. Passive APIs send no release POST. No allowedDomains option silently enables `ExactHosts`/`PublicWeb`. Host telemetry excludes secrets and raw provider error bodies.

## Stage 2 — Context resources and typed persistence coordination

**Depends on:** 1. **Outcome:** provision, reuse and explicitly delete a persistent browser identity with honest persistence evidence.

`Contexts.ts` owns create/retrieve/delete and Context metadata; `References.ts` owns qualified IDs. Do not invent a list/flush API or revive deprecated upload URLs. `session/Acquisition.ts` owns allocation journal, consumer writer receipt association and settlement fallback. Coordinator ports preserve their E/R rather than demanding environment-free `BrowserbaseError` callbacks.

A caller can explicitly acquire a scoped writer capability or use `withWriter`, which discharges Scope and retains other consumer dependencies. Settlement is associated with one exact attempt. The application chooses conservative serialization/readback/quarantine; a local Semaphore is only the test coordinator, not distributed exclusion. Context deletion is never a session finalizer.

**Acceptance:** exact project/Context mapping; writer receipt precedes POST; persist:false never claims a writer commit; cancellation before/after identity capture; lost creation/release and failed coordinator settlement retain quarantine; metadata change, remote termination and consumer readback produce distinct evidence. Consumer-defined errors and services survive public and packed declarations. Explicit settlement errors remain typed; finalizer fallback retains safe receipt/diagnostic evidence. No timeout is advertised as preempting malicious synchronous/uninterruptible consumer code.

**Migration:** adapt old `contextLease` callbacks without changing the meaning of `CleanupResult.remote`. New persistence evidence is additive; stored account mappings are application data and are not rewritten by package installation. Hosted H1/H2 remain required before claiming flush timing, storage coverage or safe overlap.

## Stage 3 — native responsibilities extracted with bootstrap capability

**Depends on:** 1; composes with 2. **Outcome:** extension/script/binding/permission customization is ready across documents and pages.

Add Extensions provisioning, typed `Bootstrap.Plan<E,R>`, native registrations and a supervised callback failure contract. Extract `Targets`, `Documents`, `Initialization`, `Observation` and `Actions` from the Playwright/Session closure **in feature-sized commits**. The default native driver provides primitives and Disposables; browser controllers own generic policy/evidence. `Owner` alone owns phase/generation/admission; document epochs belong to Documents; retained nodes belong to Observation.

Expose necessary cookies/permissions/environment setup as modeled host capabilities. Use context-level native init registration, one ordered dependent script bundle and per-document readiness. Existing-page policy is explicit; never silently reload uncertain work. Consumer callbacks use a scoped runtime such as FiberSet, finite admission before spawning, input/output validation and origin/epoch verification. Keep host-service calls out of the mutation-permit reentrancy path.

**Acceptance:** two origins, dynamic frames, popups, duplicate URLs, repeated navigation, delayed/rejected initialization, closure while callbacks run, duplicate binding names and a callback requiring a consumer service/error. Registration precedes fresh document scripts; asynchronous readiness does not claim to pause website scripts. Old document completion cannot ready a new document. A fail-session callback is supervised after installation; reject-call is explicitly different. Disposal closes admission first and cancels managed tasks; late native results cannot leak authority. Existing exact-node and captured-target invalidation tests remain intact.

Extension ZIP checks are bounded and reject traversal; provisioned references are reusable without reuploading on connect. Keep extension content-script worlds/worker restart semantics explicit. Bootstrap must complete before page suspension; preserve current page-control/keepAlive/handoff incompatibilities. No raw Browser/CDP escape hatch or new encoder. Hosted H3/H4 validate provider identity/storage/registration retention.

## Stage 4 — borrowed attachment and cleanup coordinator

**Depends on:** 2–3 for full persistent/customized workflows. **Outcome:** fresh-process attachment has explicit control and release authority.

Separate `Connection.ts`, `Cleanup.ts` and `Handoff.ts` where not already extracted. Add `BrowserbaseBrowser.attach` with current reference/project/status/target validation, fresh redacted connection access, bounded initialization and supervisor control claim. Scoped attachment disconnects locally; the durable supervisor retains remote release and Context writer ownership. Preserve old same-owner detach/reconnect through the adapter.

Adopt the target local-before-remote cleanup ordering only in a separately reviewed lifecycle slice. Use one cached close program: fence; quiesce capture/callbacks/observations/registrations; local disconnect; independently attempt remote release/reconciliation when owned; retain receipt; settle/quarantine writer. Sequential scope construction must match that order; do not rely on accidental Layer finalizer ordering. No casual `releaseOnClose:false` switch and no implicit ownership transfer.

**Acceptance:** new-process attach requires no allocating-process closures; terminal/PENDING/wrong-project/missing-or-ambiguous-target outcomes; stale handles/callbacks rejected; borrowed scope emits no release POST; owned scope still releases; local failure does not suppress remote reconciliation; remote failure does not skip local teardown; unknown prior mutation never replayed. Failpoint every cleanup step and concurrent close callers. If connection settlement arrives late, dispose it under its retired attempt. Keep allocation/report identity even when teardown cannot confirm safety. H4 provides the hosted disconnect/keepAlive/registration check; local success is not equivalent.

## Stage 5 — files, artifacts and operational evidence

**Depends on:** 1 and appropriate native ports from 3–4. **Outcome:** complete upload→attachment/download workflows and multi-page diagnostics.

Add Uploads and modeled file chooser/input operations; small in-memory selection must not require large-upload provisioning. Add Logs and bounded sanitized lifecycle events. Keep Recordings/Replays/Downloads independent of browser scopes and use their existing transfer policies. Extract capture manager versus interval only where aggregate admission/per-target cleanup become clearer; do not rewrite proven byte/timestamp handling just to complete the folder tree.

**Acceptance:** byte/MIME/path restrictions, cancellation, exactly one attachment dispatch, no arbitrary model filesystem paths; multiple simultaneous download candidates reported as ambiguity rather than `fresh[0]`; pagination with explicit completeness. Recording request/status/wait remain distinct, per-page failures and BYOS/disabled/expired outcomes preserved, access URLs refreshed, provider-wide retry behavior documented. Native page/recording/Live View IDs correlated only by evidence. Logs/native console/application events retain provenance; no default raw page content or native exception logging. H5–H7 remain the provider gates. Audio remains #13's separate measured question.

## Three ordinary change recipes

### Add a provider setting (for example `browserSettings.blockAds`)

Update the pinned contract snapshot/drift expectation and `provider/Launch` admission/compilation; add exact wire/default/conflict tests in `test/contract/launch.test.ts`; update the generic example and capability-map row. Add a legacy adapter field only when deliberately supported. No Owner, capture buffer, page registry or framework Tool change should be necessary. If the setting affects native setup, add a corresponding native/profile test and explicit incompatibility, not an implicit override.

### Add a Context resource operation

Put schema and operation in `Contexts.ts`, sharing Client and qualified references. Add HTTP request/response/identity/error/cancellation fixtures and a no-Playwright packed-consumer use. Add a transport verb/body mode only if required, with its own security test. No intermediate repository/provider/service forwarding stack and no native driver edit. Deletion must be explicit; a helper scope must not silently delete a durable resource.

### Add a bootstrap permission capability

Add the public capability description to Bootstrap/BrowserBinding, implement the supported native permission call in `playwright/Registrations`, and include its registration/disposal/readiness behavior in Initialization. Test unsupported capability before exposure, origin scoping, navigation/new pages, reconnect reapplication, disposal and interaction with page holds. Compile a consumer-service callback example. No remote Context flush promise follows from a successful permission call.

## Compatibility obligations and explicit breaking decisions

During structural stages preserve source signatures on old adapter subpaths, encoded reference/error shapes, service/schema identities, import laziness, one owner, privacy defaults, dispatch classification, selection generation behavior, capture count/byte/time limits, cleanup evidence and supported network-policy rejection. These are acceptance tests, not just release notes.

Do **not** claim compatibility for private `src/internal` imports, unsafe structural session copies, raw native/CDP objects, all peer-range combinations or untested runtimes. The current declaration tests already explicitly assert the framework handle and Scope requirement; retain them. [Type tests][types-test].

Stage 1 introduces new generic errors/options additively, with legacy projection. Stage 3 adds opt-in callbacks/readiness, not hidden injection. Stage 4's teardown reordering is a named behavior change with failure-order tests; cross-process attach is new, not a silent reinterpretation of reconnect. Removing compatibility exports or narrowing peers requires an announced later release. No existing stored Context/session ID needs migration merely because its TypeScript module moved.

The proposed package-local examples initially follow this wrapper's accepted layout; an actual upstream monorepo submission would separately move runnable examples into its leaf-workspace convention and review its package policy. Do not claim that this local package split constitutes upstream approval. Keep the root wrapper private and checkpoints immutable.

## Parallel reliability work

Keep [#9 backward timestamps](https://github.com/mannyc2/effect-agent-browserbase/issues/9), [#19 insufficient frames](https://github.com/mannyc2/effect-agent-browserbase/issues/19) and [#28 native page identity/readiness](https://github.com/mannyc2/effect-agent-browserbase/issues/28) as independent investigations. Preserve all bounded trial outcomes. No test skipping, synthesized frames/audio, timestamp clamping, retry-until-green or unexplained longer intervals. Test fixture identity and runtime target-admission defects require separate evidence and changes. [#13 audio](https://github.com/mannyc2/effect-agent-browserbase/issues/13) starts with provider media inspection, not an option on JPEG capture.

## Hosted experiments and unresolved questions

**H1–H7 are carried forward, not executed or converted into guarantees.** Require explicit hosted authorization, disposable resources, a cleanup supervisor and redacted evidence. Initial proposal: at most six sessions of at most 120 seconds per experiment; a larger budget requires a separate decision. No production credentials or private account data.

| ID | Bounded procedure | Decision/evidence |
| --- | --- | --- |
| H1 persistence visibility | Write distinct markers to persistent/session cookies, localStorage, IndexedDB, Session Storage and service-worker-owned state; normal end, metadata retrieval and read-only hydration at recorded intervals; separately approved timeout/error ending | Per-store visibility and timing, not a universal flush receipt or SLA; terminal, metadata and readback evidence remain distinct |
| H2 overlap/deletion | Disposable Context only: overlapping reader/writer and two unmanaged writers with different markers; coordinator rejection tested locally first; active deletion only with explicit approval | Provider rejection/snapshot/overwrite observations; no guaranteed merge or provider-enforced consumer lock inferred |
| H3 extension/profile | Minimal MV3 extension identity/storage marker and handshake; worker restart; new session with same Context and selected Verified/proxy profile | Extension storage/ID behavior and native viewport preservation; startup versus readiness timing |
| H4 reconnect/cleanup | Keep-alive with a versioned init bundle/binding, documents/frames/popup; detach and attach from a new process; repeat owned/borrowed cleanup and target ordering | Registration retention/removal/duplicates, retired callbacks, local disconnect versus remote end, borrowed cleanup ownership |
| H5 multi-page evidence | Stage/scout/duplicate-URL targets with unique rendered markers; simultaneous capture and navigation/popups; retrieve per-page replay/MP4 | Target isolation/stop, real ID correspondence if available; decoded frames/audio evidence rather than container inference |
| H6 files/network | Small/large uploads and attachment, concurrent downloads, approved CA/external proxy, controlled main-frame redirects/frames/resources/service workers | Complete file identity and routing/certificate behavior; not exact-host containment |
| H7 observability/retention | Recording/logging on/off and separately authorized BYOS/ZDR configurations; logs, Live View, replay and MP4; rate-limit behavior via safe fixtures/coordinated tests | Disabled/missing/expired/storage-delivery classifications; Context/upload/extension retention assessed separately |

Also unresolved: additional native BrowserContexts with recording/persistence, Context portability across regions, extension alias precedence, native permission persistence, log completeness, provider audio/alignment and actual account entitlements. Their absence must remain visible in capability results and docs.

## Common acceptance and evidence requirements

Use [repository instructions][agents] and [contributor commands][contributing]. Install the exact pinned toolchain; bootstrap fresh from the clean pinned upstream plus one tracked integration patch. Run canonical `vp` formatting/check/tests/builds, both distributions' public declarations, the four emitted consumers on pinned Node/Bun, relevant native fixtures and full clean-commit unpaid acceptance. Keep ordinary CI read-only and credential-free. Do not add scratchpad workflows to compensate for local prerequisites.

Record exact source revision, package hashes, tool/native versions, command exits and failing evidence. Inspected assertions are not executed tests; typechecked sketches are not native/provider acceptance; historical hosted results remain attributed. This documentation follow-up ran no package/type/native/hosted acceptance because the sandbox could not obtain the pinned workspace. Another engineer should be able to implement each stage from its public contract, owning modules and independent verification without guessing which proposed behavior is already supported.

[bootstrap]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/bootstrap.sh
[pack]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/package-release.mjs
[consumer]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/packed-consumer.sh
[patch]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/upstream.patch
[types-test]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/public-types.test.ts
[agents]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/AGENTS.md
[contributing]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/CONTRIBUTING.md
