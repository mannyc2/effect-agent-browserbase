# Implementation stages, migration and acceptance

This is a documentation-only plan. No stage below is claimed implemented by this PR. The [capability map](capability-map.md) describes the baseline; [architecture](architecture.md) and [workflows](workflows.md) define the target. A stage is accepted by a complete workflow and failure evidence, not by adding type fields.

## Stage 0 — one account/client boundary and a testable browser binding

**Priority:** immediate. **Dependencies:** none beyond existing pins. **Outcome:** provide interactive browsing and all artifact services together without configuration drift or global Playwright monkeypatching.

Work in `src/internal/Http.ts`, `Provider.ts`, `Driver.ts`, `Playwright.ts`, public `InteractiveBrowser.ts`, `Recordings.ts`, `Replays.ts`, `Downloads.ts`, `index.ts`, `package.json`, and hosted examples. Add proposed `Client.ts` and `BrowserBinding.ts` only with concrete responsibilities: one strict account configuration and scoped transport; a trusted injectable native binding with the current production validation. Keep imports lazy and artifact-only consumers free of native browser requirements.

Normalize account input once. Existing artifact layers should keep their declared strict contract; fix examples that pass launch options into the account decoder. New composition should consume the shared client rather than silently dropping arbitrary extra credential fields. Preserve existing convenience layer constructors by delegating through the new services with explicit projection where their declared API includes launch settings.

**Acceptance:** a public packed consumer composes all four services from one account/client; zero provider calls or Playwright imports during layer construction; separate projects cannot cross-authorize references; missing/extra account fields produce consistent errors; captured fetch remains isolated from ambient credentials and tracing; production URL validation stays strict; native tests inject a local binding without reassigning global `chromium.connectOverCDP`. Test cancellation/late connection disposal through that same seam. Add a regression for [#6's concrete configuration failure](https://github.com/mannyc2/effect-agent-browserbase/issues/6#issuecomment-5751167681).

**Migration:** additive client/layer composition first. Do not combine wholesale error taxonomy or owner rewrites. Document account options versus launch options in the quickstart. Keep the existing dependency direction (`effect-agent` regular coordinated dependency, Playwright optional peer).

## Stage 1 — provider-faithful launch, inspection and error classification

**Priority:** high. **Depends on:** Stage 0. **Outcome:** consumers can launch the browser environment they requested, and inspect it without accidentally releasing it.

Add a self-contained provider contract module generated from or checked against the current official SDK/OpenAPI. Select and document a reproducible generator/input before claiming code generation. Add golden wire tests to `Provider` and launch compiler tests to public configuration suites. No emitted declaration may rely on an undeclared development-only SDK. Keep exact coordinated runtime pins; a future SDK adapter is a separate measured decision.

Expose region, proxy rules and CA references, extension reference, Verified/OS, allowedDomains, CAPTCHA/ad-block/logging/recording settings, TLS settings and caller metadata. Separate provider timeout from execution/action/request deadlines. Add provider-managed versus fixed viewport. Reserve ownership fields and the allocation metadata namespace; reject duplicates/conflicting aliases. Add passive session metadata/listing, terminal/pending waits, and typed known rejection versus uncertain allocation. Extend HTTP transport for explicit no-content and multipart operations as needed, retaining limits and redaction.

**Acceptance:** each supported public field has an assertion on the exact emitted provider body; default-body compatibility is tested; mutation of caller arrays after admission cannot change proxy order or bounds; invalid Verified/viewport/OS combinations fail before POST; native setup and resize do not override provider-managed identity. Verify API wire `timeout` versus SDK `api_timeout`. Known 401/403/429 responses retain rejection/retry information; lost POST response stays unknown and is never automatically retried. `PENDING` readiness is bounded/cancellable and retains session identity. Passive inspection emits no release POST. Verify allowedDomains does not enable rejected `ExactHosts`/`PublicWeb` policies.

**Migration:** current `recordSession`, `keepAlive`, viewport and Context fields remain supported through a compatibility compiler. Reject simultaneous conflicting old/new forms. No privacy default changes without explicit release notes. A limited hosted profile matrix is required before advertising all launch combinations as verified.

## Stage 2 — first-class Context resources and persistence coordination

**Priority:** high, correctness-critical. **Depends on:** Stages 0–1. **Outcome:** provision, use, save, reuse and explicitly delete a persistent browser identity without implying unsupported flush guarantees.

Add `Contexts.ts`, reference/metadata/result schemas, create/get/delete provider methods, name handling and examples using a consumer account store. Do not add deprecated profile-upload support or invent a list endpoint. Evolve `ContextLease` into a generic Effect coordination port, preserving existing callbacks through an adapter. Add explicit settlement results and bounded fallback finalization; keep primary failure and cleanup evidence separate.

**Acceptance:** project-qualified IDs cannot cross accounts; Context use compiles to the correct nested settings; persist:false does not request a writer commit; writer acquisition precedes allocation; duplicate writer admission is rejected by a test coordinator; cancellation during creation/release/settlement quarantines correctly. Session completion, Context metadata change and consumer readback must produce distinct evidence. Error/timeout endings never get mislabeled as confirmed flush. Lease finalization cannot hang cleanup indefinitely. Consumer database errors and service requirements survive inferred `E`/`R` and packed declarations. Deletion is explicit and locally rejected while a writer is active/uncertain.

**Migration:** retain the current `{context:{id,persist}, contextLease}` form temporarily, with clear project association. Existing `CleanupResult.remote` keeps its current meaning; do not silently reinterpret it as persistent data readiness. A new persistence-evidence field/result is additive. Context state migration or account→Context backfill belongs to the consumer, not a package upgrade side effect.

**Hosted gate:** H1/H2 below. Without those results, publish the documented save-after-close behavior and the unconfirmed visibility state; do not publish a guaranteed delay or transactional commit model.

## Stage 3 — extension provisioning, scoped bootstrap and document readiness

**Priority:** high. **Depends on:** Stages 0–1; uses Stage 2 for persistent recipes. **Outcome:** a customized browser behaves predictably on first navigation, frames, tabs and popups.

Add `Extensions.ts` for bounded upload/retrieve/delete as supported by the provider, plus `Bootstrap.ts` and a document readiness registry. Split the native driver only along responsibilities needed here: target registry, native registration/disposal and readiness. Do not refactor capture/owner behavior simply to reduce file size. Implement scripts/bindings through Playwright 1.63 native APIs and retain their Disposables. Add cookies and permission operations through the owned binding; configuration not present in the provider API remains explicitly native.

**Acceptance:** use an unpaid native fixture with two origins, dynamic frames, popups, repeated navigation, duplicate URLs and intentionally delayed/rejected initialization. Assert registration precedes application scripts on fresh documents, but do not claim async completion blocks the page itself. The first library action waits for its document epoch; late callbacks cannot mark a new document ready. Existing-page modes are explicit and never reload an uncertain transaction automatically. Binding arguments/results/origins/generations/bytes/time/concurrency are checked; calls after disposal fail; callback fibers cancel; a page-triggered callback does not deadlock the mutation permit. Init ordering is bundled rather than assumed across registrations. Disposal and reconnect are tested, including duplicate registration names.

Keep extension-world communication explicit. Validate ZIP limits/root manifest without unbounded extraction or path traversal. An existing uploaded extension can be reused without reupload on every connection. Upload cancellation/unknown outcome is retained; extension deletion is not a browser-session finalizer. Test extension storage/identity with hosted H3 before claiming persistence.

**Migration:** bootstrap is opt-in. No hidden script injection into existing consumers. The proposed generic API examples must become real typechecked examples as part of this stage. Current `pageControl:true` restrictions remain in force; bootstrap completion must precede suspension. No general native Browser/CDP escape hatch is introduced.

## Stage 4 — explicit borrowed attachment and durable supervision

**Priority:** high for long-running consumers. **Depends on:** Stages 0–3. **Outcome:** another process can attach to a running session without acquiring accidental remote-release authority or reusing stale local handles.

Add passive `Sessions.ts` operations and `host.attach` with host control lease, current reference validation, target resolution, bootstrap and connection generation. Keep the default acquire/open owner. Define explicit disconnect-only versus release-owned finalizers. Initially, keep durable supervision in the application: stored reference/expiry/recipe/lease plus eventual release. Only add transfer/adoption APIs after their two-phase acknowledgement semantics have dedicated tests.

**Acceptance:** fresh-process attachment does not rely on closures from the allocating process; credentials are retrieved and redacted; `PENDING`, expiration, wrong project, wrong target and multiple candidates are typed outcomes. Scope exit of a borrowed connection emits no release request. Scope exit of an owned resource still releases it. Old handles, callbacks, observations and capture intervals cannot operate after generation replacement. Unexpected disconnect and unknown prior mutation require application reconciliation, not automatic replay. A failed owner transfer never silently abandons the session or unlocks a Context writer. Detached keep-alive billing/lifetime remains visible.

**Migration:** keep existing `session.detach/reconnect` behavior. Name the new cross-process operation `attach`, not an undocumented overload of `reconnect`. Do not add `releaseOnClose:false` as an escape hatch. Hosted H4 is required to validate actual provider connection and registration semantics.

## Stage 5 — complete file workflows and operational inspection

**Priority:** medium/high. **Depends on:** Stages 0–1 and binding support from Stage 3. **Outcome:** authenticated upload/download workflows and operator diagnosis work across multiple pages.

Add bounded `Uploads.ts` and owned attachment/file-chooser operations; small in-memory files should not require the provider's large-upload path. Add a lightweight `Logs.ts` and bounded sanitized session event stream/journal. Reuse current transfer policies and artifact services. Provide complete paginated download enumeration or an explicit partial-list result; correlate native download evidence with provider candidates rather than taking the first new ID.

**Acceptance:** MIME/byte/path controls, cancellation during upload/attachment, exactly-once attachment dispatch, safe filenames, remote versus local path separation, simultaneous page downloads and ambiguity. Recording request remains separate from polling; retry-failed documents provider-wide re-enqueue behavior. Test all per-page outcomes and signed URL refresh; preserve BYOS absence, disabled/ZDR absence and expiration distinctions. Live View URL issuance checks recipient authorization/TTL; copied URLs are not advertised as read-only. Provider logs, native console signals and application events have different provenance. No raw content or credentials appear in default telemetry.

**Migration:** use existing recording/replay/download references; add new types only for genuinely different identities. Do not force consumers to install a new encoder/player, AWS client or job scheduler. Native target↔recording-page correlation is only published as verified when H5 supports it.

## Parallel reliability work — do not hide existing failures in the redesign

[#9](https://github.com/mannyc2/effect-agent-browserbase/issues/9), [#19](https://github.com/mannyc2/effect-agent-browserbase/issues/19) and [#28](https://github.com/mannyc2/effect-agent-browserbase/issues/28) require separate bounded investigations. Add identity/timing metadata before choosing a cause. Preserve every trial's outcome; do not rerun until green, skip native checks, pad missing frames, clamp timestamps or widen intervals without an accepted contract. A page-index fixture defect and a runtime target-adoption defect would require separate changes. [#13 audio](https://github.com/mannyc2/effect-agent-browserbase/issues/13) likewise starts with inspecting provider media, not adding a fake audio option.

## Hosted experiments and unresolved questions

**No experiment below was executed in this review.** Each requires explicit authorization, a disposable non-production project/Context, bounded sessions/time, a cleanup supervisor and redacted evidence. Use consumer-controlled test pages and no private account data. A reasonable initial per-experiment ceiling is six sessions with at most 120 seconds each; request a different budget explicitly when the scenario requires it. Do not run unattended six-hour sessions or infer success from absence of an error.

| ID | Question and bounded procedure | Evidence / decision it enables |
| --- | --- | --- |
| H1: persistence visibility | Write distinct version markers to persistent/session cookies, localStorage, IndexedDB, Session Storage and service-worker-owned state. Terminate normally, retrieve metadata and hydrate bounded read-only sessions at recorded intervals. Repeat a separately approved timeout/error ending. | Retain per-store marker/version, terminal status and hydration time, not secrets. Determine observed visibility and what Session Storage actually restores across tabs. Do not turn measured latency into an SLA. |
| H2: overlap / deletion | In a disposable Context only, test overlapping read-only/writer and two unmanaged writers with distinguishable markers; test coordinator rejection locally first. Probe deletion while active only under explicit approval. | Establish whether provider rejects, snapshots, overwrites or exhibits another result. Design around no guaranteed concurrent merge regardless. Verify consumer quarantine protects all cooperating processes. |
| H3: extension and identity profile | Upload a minimal MV3 extension, record extension identity and storage marker, observe its content script handshake and worker restart; repeat in a new session with the same Context and chosen Verified/proxy profile. | Establish extension-state persistence/identity and supported setting combinations. Verify actual viewport/fingerprint preservation without setting it again natively. Capture startup timings separately from action readiness. |
| H4: reconnect / registration disposal | Start keep-alive, install one versioned init bundle and binding; navigate/frame/popup; intentionally disconnect. Attach from a new process with the same target and a new binding generation; observe old/new documents and eventual termination. | Detect retained/removed native registrations, duplicate calls, stale callbacks, automatic native overrides and whether dispose changes already-running documents. Demonstrate borrowed disconnect does not end the remote resource. |
| H5: multipage evidence | Use stage, scout and duplicate-URL tabs with unique rendered markers; capture stage while scout navigates and popups open/close; retrieve all replay/MP4 metadata after terminal state. | Verify target isolation, native stop, provider page coverage and any real cross-ID mapping. Decode outputs rather than inferring frame/audio presence from container metadata. |
| H6: files / certificates / routing | Small in-memory and larger remote uploads; concurrent downloads; external proxy with approved CA; controlled main-frame redirects plus frames/subresources and service-worker requests. | Complete upload→attachment evidence, file identity ambiguity, CA success/failure and demonstrated limits of allowedDomains. Never promote these checks into an exact-host containment guarantee. |
| H7: observability / retention | Compare recording/logging on/off and an authorized BYOS/ZDR project; request logs, Live View, replay and MP4. Observe rate-limit headers using a safe fixture or coordinated provider test rather than flooding production. | Establish exact missing/disabled responses, storage delivery and safe retry classification. Context/upload/extension storage is assessed separately from log/replay retention. |

Other unresolved provider questions: behavior of additional native BrowserContexts with persistence/recording; Context portability across regions; actual extension alias precedence (avoid specifying both); native permission override persistence; session log completeness; recording audio and per-page alignment; feature entitlements by actual account. Unsupported or uncertain cases must remain explicit capability results, not silent fallbacks.

## Acceptance common to every implementation stage

Follow [AGENTS.md](../../../AGENTS.md) and [CONTRIBUTING.md](../../../CONTRIBUTING.md): bootstrap the exact pinned workspace using `tools/pinned-toolchain.sh`; run canonical formatter/checks, emitted tests, packed Node/Bun consumers, relevant native fixtures and the full clean-commit acceptance gate. Do not treat a source-only fixture, previous CI result or uncompiled documentation sketch as new acceptance. Retain exact source revision, runtime/native versions, command exits and failing evidence.

Keep implementation PRs independently revertible and scoped to one stage or a smaller meaningful slice. Put contract tests and a complete consumer example beside each feature. A declared field without a wire assertion, an upload without attachment, a Context without a reuse policy, or a reconnect without ownership cleanup does not meet the completion standard.
