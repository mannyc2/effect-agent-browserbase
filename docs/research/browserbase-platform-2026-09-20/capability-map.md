# Capability map, current architecture and target ownership

**Inspected implementation:** [`1b3e9b1916621d036f2568c821e83bed72400f9c`][baseline], unchanged when the structural follow-up began. **Provider reference:** [platform research](platform.md), [SDK v2.20.0][sdk], [Playwright v1.63.0][pw]. **No proposed package or new capability is implemented by this documentation PR.**

Complete means the stated bounded public workflow exists with corresponding test assertions; it is not a claim that this review executed those tests or verified every hosted variant. Partial means a material workflow step is missing. Inaccessible means an upstream/native mechanism exists but cannot be reached through the owned public session. Absent means no modeled implementation. Outside scope means deliberately not a requirement or not currently supplied by the relevant provider contract. Source, test assertions, historical observations and new execution remain separate evidence categories. No package/type/native/hosted tests ran in this review.

**Target owners:** G denotes proposed `@effect-agent/browserbase`; A denotes retained `@effect-agent/platform-browserbase` adapter. Exact folders and current→target moves are in [organization](organization.md). The stage labels refer to the revised [implementation plan](implementation-plan.md): 0A dependency seams, 0B distribution split, 1 launch/inspection, 2 Contexts, 3 bootstrap, 4 lifecycle/attachment, 5 files/diagnostics. Adding an owner/stage below does not change the current support classification.

## 1. Package and dependency capabilities

| Consumer requirement | Current support and inspected evidence | Target owner / acceptance stage |
| --- | --- | --- |
| Use Browserbase without the Effect Agent framework | **Absent as an installation/public-session contract.** Manifest makes `effect-agent` mandatory; public session exposes its BrowserHandle and policy/error types. [Manifest][manifest], [InteractiveBrowser][host], [public type assertions][type-tests] | G supplies generic browser policy, pages and resources; A alone maps framework handles/Tools. Stage 0B must prove a no-framework installed consumer, not merely cleaner source imports |
| Retrieve artifacts without a live browser | **Complete for modeled artifact operations.** Resource services do not require interactive Scope or allocate browsers. [Recordings][recordings], [Replays][replays], [Downloads][downloads] | Keep independent resource Layers in G; preserve service-identity reexports in A. No additional artifact package is justified by this already-existing separation |
| Avoid native peer at runtime for resource-only use | **Complete for lazy interactive loading**, with deliberate optional peer. [Manifest][manifest], [connector][playwright] | Preserve lazy loading; Stage 0B adds declaration closure checks with Playwright absent. Do not claim current artifact imports eagerly allocate/load Playwright |
| One account configuration shared across resource and browser services | **Partial/inconsistent.** Interactive layer projects HTTP fields; artifacts strictly decode supplied options. A shared larger variable can fail at runtime. [HTTP][http], [host][host], [reported failure][composition-issue] | G Client service + explicit feature Layers, Stage 0A. Keep strict credential schema; eliminate repeated construction, not validation authority |
| Inject a trusted native binding without monkeypatching | **Inaccessible publicly.** Private connector/test seams exist, but the fixture rewrites the Playwright method. [Driver][driver], [Playwright][playwright], [fixture][fixture] | G BrowserBinding with native-neutral Effect contracts, Stage 0A/0B. Default provider URL validation remains strict; local injection does not prove hosted connector behavior |
| Separate resource and native runtime packages | Already separable by public subpaths/lazy peer, not separate distributions | **Defer** a third package. Require an additional supported engine/runtime, different release cadence or demonstrated install/declaration cost first |

## 2. Provider resources and launch configuration

| Workflow/capability | Current support, code and consequence | Recommended module / stage / value |
| --- | --- | --- |
| Allocate, connect, operate and release an execution-owned session | **Complete for bounded path.** Host acquire/open → acquireSession → Provider.create → connector; identity retained before connect. [Host][host], [Session][session], [ownership cases][ownership-tests] | G Browser + session/Acquisition + Owner, preserved in 0A/0B. Highest-value invariant: failed connect still has a release identity |
| General provider launch configuration | **Partial.** Recording/keepAlive/Context/viewport forwarded, but request hard-codes proxies/logging/CAPTCHA off and lacks region/extensions/identity/caller metadata. [Provider.create][provider] | G provider/Contract and Launch; Stage 1. Very high value: one recipe compiler rather than flags distributed through framework/native setup |
| Recording/privacy defaults | **Partial but intentional.** recordSession defaults off; logSession and solveCaptchas are always false, not configurable defaults. [Host][host], [provider][provider], [SDK settings][sdk-sessions] | Stage 1 opt-ins while A Legacy preserves prior defaults. Do not silently adopt changing provider defaults |
| Remote timeout versus execution/action/request deadlines | **Partial.** Provider timeout derived from execution budget, clamped 60–21,600 seconds; local timer still closes the resource. [Session][session] | G Launch/Acquisition/Deadline, Stage 1. Separate remote lifetime and local deadlines without turning keepAlive into indefinite billing |
| PENDING→RUNNING readiness | **Partial.** PENDING is accepted by schema, but no public general wait/inspection flow. [Types][types], [Provider][provider] | G Sessions passive bounded waits, Stage 1. Schema membership alone is not behavior; do not infer a provider queue |
| Known rejection versus uncertain allocation | **Partial/lossy.** HTTP keeps status, but no-known-reference allocation failures become allocation-unknown. [HTTP][http], [Session][session] | G allocation error/journal in Stage 1; A compatible projection. Distinguish rejected 401/429 from lost POST response; never automatically replay uncertainty |
| Persistent Context hydration | **Partial.** ID/persist forwarded; consumer provides existing Context and lease for writers. [Session][session], [hosted examples][hosted-examples] | G Contexts + qualified References + Launch, Stage 2. Preserve reuse while completing provisioning and account association |
| Context create/name/retrieve/delete | **Absent.** No Context service/public routes. [Exports][manifest], [SDK Contexts][sdk-contexts] | G Contexts Stage 2; no invented list/flush API. High consumer value; explicit deletion, not session cleanup |
| Context writer exclusion and persistence evidence | **Partial.** Lease acquired before allocation, finalized after teardown; remote cleanup is not a data commit acknowledgement. [Session][session], [Context guide][contexts-doc] | G scoped Context writer permit/attempt facts; consumer distributed backend, Stage 2. Very high correctness value; retain quarantine and separate readback evidence |
| Legacy Context profile upload/import | **Outside available provider support.** SDK retains non-functional sentinel upload URLs for compatibility. [SDK Contexts][sdk-contexts] | Deliberately absent; do not implement obsolete fields just because TypeScript accepts them |
| Regions and managed/external proxy routing | **Absent.** Provider body forces proxies:false. [Provider][provider], [SDK rules][sdk-sessions] | G Launch Stage 1; ordered rules, credential redaction and region/geolocation distinctions. High value, no in-library proxy engine |
| Verified/OS identity and provider-managed viewport | **Absent**, with a current behavioral conflict: native setup always sets a viewport. [Host][host], [Playwright][playwright], [Verified docs][verified] | G Launch + native Connect/Pages profile checks, Stage 1. A boolean alone is insufficient; forbid incompatible native resize |
| CAPTCHA selectors/solving, ad blocking, TLS behavior | **Absent.** Native clicks do not compensate for missing launch fields. [SDK settings][sdk-sessions] | G Launch Stage 1; expose upstream names and safe opt-ins, prefer CA references where applicable. Medium/high workflow value |
| Provider allowedDomains filter | **Absent** as provider setting. It is weaker than whole-browser containment. [SDK exact semantics][sdk-sessions] | G Launch Stage 1. Preserve its name/meaning; A still rejects unprovable ExactHosts/PublicWeb |
| Extensions provisioning/selection | **Absent.** No resource service or launch field. [Extensions docs][extensions-doc], [manifest][manifest] | Selection G Launch Stage 1, resource provisioning G Extensions Stage 3. High customization value; load at launch, not via second unfenced connection |
| Project CA resources | **Implemented** ([#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32)): `certificates` create/list/retrieve/delete with a bounded multipart upload and project-identity checks; selected through `proxySettings.caCertificates`. | Superseded the earlier "later only with workflow demand" deferral |
| Project metadata/usage/quota/admission | **Passive inspection implemented** ([#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32)): `projects` list/retrieve/usage for the Client's project. | Still no scheduler or admission policy; inspection only |
| Caller metadata and unknown-allocation search | **Partial.** Internal `effectAgentAttempt` nonce sent; no caller metadata/list query API. [Provider][provider], [SDK session list][sdk-sessions] | G Launch/Sessions Stage 1; reserved metadata namespace, bounded query. High diagnostic value; nonce is reconciliation evidence, not idempotency |

## 3. Connections, documents and operations

| Workflow/capability | Current support/evidence | Recommended module / stage |
| --- | --- | --- |
| Intentional same-owner detach/reconnect | **Complete within original scope.** keepAlive, remembered target, acknowledgement and fresh observation required. [Session][session] | G Connection/Owner; A legacy methods unchanged. Stage 4 adds a separate borrowed attach, not a reinterpretation |
| Fresh-process attachment | **Absent.** Reconnect target and owner live in old closure; no attach(reference) host API. [Host][host], [Session][session] | G Browser.attach + Connection Stage 4; control claim, fresh credentials and disconnect-only cleanup. High value for supervisors |
| Unexpected disconnect/unknown prior mutation | **Partial.** Fences uncertainty; no generic recovery assessment or automatic safe continuation. [Owner][owner], [Session][session] | G Connection/Owner + consumer business journal; Stage 4 establishes current state but never replays lost actions |
| Passive inspect versus release | Metadata implementation **private/partial publicly**; `reconcile` requests release. [Provider][provider] | G Sessions Stage 1; A retains deprecated release-oriented reconcile for compatibility. High operator-safety value |
| Cooperative Live View handoff | **Complete for cooperative authorization.** Pause before URL; token/ack and fresh observation under permit. [Session][session], [ownership tests][ownership-tests] | G Handoff/Owner, retained during extraction. URL/token does not prove all external clients relinquished control |
| Pages/frames and selected-target handles | **Complete for modeled controls.** Explicit selection and returned handles invalidate on replacement. [Host][host], [Driver][driver], [Types][types] | G Targets + BrowserPage; A BrowserHandle projection. Stage 0B preserves behavior; Stage 3 adds document readiness |
| Exact observed-node actions | **Complete for modeled click/fill.** Retained node identity and detachment checks, no re-resolve onto replacement. [Playwright][playwright], [Owner][owner] | G Observation/Actions extracted Stage 3; keep one mutation owner. A Tool schema remains narrow |
| Additional native BrowserContexts | **Partial by deliberate restriction.** Requires exactly one default native context. [Playwright][playwright] | Keep restriction until persistence/recording/native permissions across additional contexts are verified. Browserbase Context ID is not Playwright BrowserContext ID |
| Init scripts | **Inaccessible** through public owner; native context registration exists. [Pinned native context API][pw-context], [public host][host] | G Bootstrap/Initialization + native Registrations Stage 3; native Disposable and ordered bundle, not a second injection engine |
| Browser→consumer service binding | **Inaccessible** through public owner; native mechanism exists. [Pinned native API][pw-context] | G typed Plan<E,R> and bounded scoped runtime Stage 3. Preserve errors/services and supervise post-install failures; never expose secrets/raw host service environment |
| Cookies/permissions/geolocation/headers/routing | **Inaccessible** through owned public connection; these are native mechanisms, not arbitrary launch settings. [Native API][pw-context], [host][host] | G modeled Bootstrap/native capabilities Stage 3, preserving origin/lifetime limits. Not a network containment claim |
| Document readiness and late attach | **Absent.** Current registry has target/dialog/capture behavior but no consumer bootstrap barrier. [Playwright][playwright] | G Documents/Initialization Stage 3; connection/target/frame/document key, explicit existing-document policy. Very high value |
| Page suspension | **Complete for documented opt-in subset**, not universal time freeze. [PageControl][page-control], [PageExecution][page-execution] | G PageControl/native execution, retained. Bootstrap before hold; preserve keepAlive/handoff/pause-policy incompatibilities and no implicit resume |
| General raw Browser/CDPSession export | **Intentionally outside contract.** [PR #27][pr27] establishes boundary. | No new raw escape hatch. Native-neutral trusted binding plus modeled customization; arbitrary retained native objects cannot be made safe by branding |
| Effect Agent Tools | **Complete as deliberate local extension**, not upstream endorsement or host confinement. [Tools][tools], [latest #4 disposition][issue4] | A only, Stage 0B. Generic consumer does not inherit framework policy or mandatory dependency. Actual Tool/Toolkit retained |

## 4. Files, capture and observability

| Workflow/capability | Current support/evidence | Recommended module / stage |
| --- | --- | --- |
| Session logs | **Provider logs implemented** ([#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32)): `sessions.logs` with CDP payloads omitted unless requested; `logSession` remains an explicit opt-in. | Native console signals and application lifecycle events remain Stage 5 |
| Session/per-page Live View | **Complete for URL issuance.** TTL/project/origin checks; redacted output; some presentation metadata projected away. [Provider][provider], [Live View docs][live-view] | G Sessions/Handoff; add bounded presentation metadata only when needed. Read-only styling is not authorization |
| Individual website download retrieval | **Complete for bounded files; partial for wider workflows.** Metadata/list(offset)/stream with byte/MIME checks, wait rejects incomplete first listing. [Downloads][downloads] | G Downloads Stage 5 pagination and correlation; no mandatory browser lifetime |
| Native download event→provider file identity | **Partial, deliberately separate.** Native `downloadId` is not provider ID. [Types][types] | G download action/Downloads correlation; Stage 5 tests concurrent ambiguity, never use first fresh item as proof |
| Upload→file selection/chooser | **Absent/inaccessible.** No modeled complete public workflow. [Manifest][manifest], [uploads docs][uploads-doc] | G Uploads plus native Actions Stage 5; bounded in-memory and remote-upload variants; no arbitrary model filesystem paths |
| MP4 assembly/status/retrieval | **Complete for bounded terminal sessions.** GET before POST, per-page results, refreshed URL/BYOS absence. [Recordings][recordings] | G Recordings retained in 0B; Stage 5 operational improvements. Provider-wide retry behavior must not be advertised as surgical single-page retry |
| HLS replay | **Complete for bounded terminal media playlists** under parser constraints; not live HLS. [Replays][replays] | G Replays retained; no player/encoder dependency. Keep validated URI/transfer limits |
| Concurrent explicit-target live capture and source sizing | **Complete for current bounded contract**, subject to separately open native reliability questions. [Capture][capture], [native source][playwright] | G Capture/Manager/Interval; same target reservations and aggregate bounds across generic/legacy entry points. Do not re-propose already-landed pinning/sizing |
| Capture audio/fixed FPS/lossless onFrame | **Not supplied** by current live JPEG seam. Provider recording audio unresolved separately. [Capture][capture], [#13][issue13] | No fake audio, minimum FPS or clock repair. Investigate actual provider output before another transport |
| Native target ↔ Live View/recording page join | **Partial.** Distinct IDs exist, no universal verified join. [Types][types], [Provider][provider], [Recordings][recordings] | G bounded correlation evidence Stage 5; H5 validates duplicate-URL targets, not guessed positional mapping |
| BYOS/ZDR/retention | **Partial.** External-storage outcomes and media-origin policy modeled; project storage administration not. [Recordings][recordings], [BYOS][byos], [ZDR][zdr] | G resources preserve absent/disabled/expired/delivery distinctions; account setup external. No S3 control plane dependency |
| Cross-resource operational diagnostics | **Partial.** Useful local cleanup/capture facts; no unified allocation/recipe/connection/document/artifact correlation. [Session][session], [Capture][capture] | G safe events/spans Stage 5 and phase-specific additions earlier; no raw page data, URLs, native causes or credentials in default telemetry |
| Webhooks | **Implemented as administration** ([#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32)): `webhooks` CRUD and secret rotation for the provider's Functions-only events. | Still no speculative session/Context-flush events; browser lifecycle stays on bounded polling |
| Search, Fetch, Agents, Functions | **Implemented as host platform APIs** ([#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32)): `search`, `page-fetch`, `agents`, `functions` (invoke/observe; deployment stays with Browserbase's CLI). Hosted runs persisting a Context are refused while a local writer holds it. | Separate subpaths; never model-facing tools; no new dependencies |

## 5. Architectural findings that determine extraction order

**Keep the owner, remove its accidental framework coupling.** `Owner.ts` has one nonwaiting mutation permit, dispatch tickets, late-continuation checks and generation fencing. Those protect direct consumer operations as much as agent Tools. They belong in G. The current `BrowserHandle` type assertion belongs in A and must continue to pass. [Owner][owner], [type tests][type-tests].

**Configuration duplication has a real consumer failure.** Four Layer families independently construct their HTTP/provider objects and disagree on input projection. Normalize the account dependency once, leaving launch compilation and artifact media access as separate responsibilities. The inspected code does not establish four rate schedulers; do not repeat that older issue interpretation as a fact. [HTTP][http], [artifact constructors][recordings], [reported failure][composition-issue].

**State must have one writable authority.** Session currently owns resource/connection/handoff/capture orchestration and mutates owner phase; Playwright owns targets, native handles, observations and callback tasks in one large closure. Separate remote facts, owner stamps, target values, document readiness and per-target capture admission—not a new independent phase machine in every extracted file. The [ownership table](organization.md#4-state-authority-and-dependency-rules) assigns each state explicitly.

**Shorter finalizers are not automatically equivalent.** The current journal/finalizer is installed before remote creation can return, and known identity survives later validation failures. Native promises may settle after Effect interruption. Extract those properties before simplifying with Scope/FiberSet. Mechanical stages preserve current ordering; local-before-remote cleanup is a later reviewed change. [Session][session], [Effect conventions](effect-conventions.md#6-cleanup-one-ordered-program-and-honest-receipts).

**Public subpaths are already useful but do not remove a mandatory manifest dependency.** Artifact lifetimes and lazy Playwright imports deserve preservation, not claims that a package split newly invents them. The measurable gain of G/A is a generic installed browser/resource consumer with no framework dependency and framework-free declarations. [Manifest][manifest], [release/consumer machinery][packed-consumer].

## 6. Compatibility and unresolved evidence

Source support classifications above remain unchanged until implementation stages actually land. New generic imports do not exist yet. The adapter compatibility window must preserve old subpaths, framework handle, service/schema identities, error/outcome shapes, privacy defaults, single owner and existing cleanup behavior. Internal `src/internal` imports and fabricated native/capture authority are not compatibility promises.

[#4's latest disposition][issue4] recognizes implemented capture/page controls, accepts the local Tool extension and moves remaining binding/composition work to #6. Older issue descriptions of single-target capture are not the current source. [#7][issue7] remains parked/not planned; this is not a cross-provider standardization proposal.

Keep [#9][issue9], [#19][issue19] and [#28][issue28] separate. Their historical failures are not explained by the proposed package split, and a green later run is not a diagnosed fix. No skip/retry-until-green/synthetic-frame workaround belongs in these stages. [H1–H7](implementation-plan.md#hosted-experiments-and-unresolved-questions) preserve actual provider uncertainties, particularly Context visibility, extension state, reconnect registrations and cross-page evidence.

[baseline]: https://github.com/mannyc2/effect-agent-browserbase/commit/1b3e9b1916621d036f2568c821e83bed72400f9c
[sdk]: https://github.com/browserbase/sdk-node/tree/v2.20.0/src/resources
[sdk-sessions]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/sessions/sessions.ts
[sdk-contexts]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/contexts.ts
[webhooks]: https://github.com/browserbase/sdk-node/blob/v2.20.0/src/resources/webhooks.ts
[pw]: https://github.com/microsoft/playwright/tree/v1.63.0
[pw-context]: https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-browsercontext.md
[manifest]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/package.json
[host]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/InteractiveBrowser.ts
[types]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Types.ts
[type-tests]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/public-types.test.ts
[provider]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Provider.ts
[session]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Session.ts
[owner]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Owner.ts
[driver]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Driver.ts
[playwright]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Playwright.ts
[fixture]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/fixtures/LocalBrowser.ts
[http]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/Http.ts
[ownership-tests]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/test/fixtures/OwnershipCases.ts
[hosted-examples]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/examples/hosted.ts
[recordings]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Recordings.ts
[replays]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Replays.ts
[downloads]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Downloads.ts
[capture]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Capture.ts
[page-control]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/PageControl.ts
[page-execution]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/internal/PageExecution.ts
[tools]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/packages/platform-browserbase/src/Tools.ts
[packed-consumer]: https://github.com/mannyc2/effect-agent-browserbase/blob/1b3e9b1916621d036f2568c821e83bed72400f9c/tools/packed-consumer.sh
[contexts-doc]: https://docs.browserbase.com/platform/browser/core-features/contexts
[extensions-doc]: https://docs.browserbase.com/platform/browser/core-features/browser-extensions
[verified]: https://docs.browserbase.com/platform/identity/verified-customization
[live-view]: https://docs.browserbase.com/platform/browser/observability/session-live-view
[uploads-doc]: https://docs.browserbase.com/platform/browser/files/uploads
[byos]: https://docs.browserbase.com/account/enterprise/byos-setup-guide
[zdr]: https://docs.browserbase.com/account/enterprise/zero-data-retention
[composition-issue]: https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681
[issue4]: https://github.com/mannyc2/effect-agent-browserbase/issues/4#issuecomment-5751302698
[pr27]: https://github.com/mannyc2/effect-agent-browserbase/pull/27
[issue7]: https://github.com/mannyc2/effect-agent-browserbase/issues/7
[issue9]: https://github.com/mannyc2/effect-agent-browserbase/issues/9
[issue13]: https://github.com/mannyc2/effect-agent-browserbase/issues/13
[issue19]: https://github.com/mannyc2/effect-agent-browserbase/issues/19
[issue28]: https://github.com/mannyc2/effect-agent-browserbase/issues/28
