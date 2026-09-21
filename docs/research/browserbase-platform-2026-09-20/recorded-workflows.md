# Issue #34: faithful browser execution, evidence, and recorded presentation

Research date: 21 September 2026.

**Status:** source-backed research and proposed modelling, not an implemented API, a typechecked declaration design, or a new native/hosted acceptance result. The research phase performed no production changes or native/hosted execution. This chapter incorporates it into documentation PR #30; that documentation update is not implementation or acceptance of its proposed APIs.

**Reviewed application baseline:** `mannyc2/effect-agent-browserbase` PR #31, source `5ce468e7fec5f6dd37b336c80a4da2fcd69969cb`; issue #34 was filed against the earlier `39cb587` baseline. Native implementation evidence below is from Playwright **v1.63.0**, the repository pin. Web standards and current provider documentation are comparison material, not proof that every feature is available on the pinned or hosted browser.

## Applicability and decision precedence

This is a follow-on to the canonical hard cutover, not additional production scope silently added to #31. The maintainer has superseded the original #30 compatibility-window proposal: no facades, legacy constructors/aliases/reexports/error projections, `internal/Legacy.ts`, or fourth legacy consumer. Migrate maintained consumers directly and verify two artifacts in three strict consumer profiles. Historical passages elsewhere in the original report do not override that decision.

The latest issue body also requires checkpoints and holds to compose with exact observed-element tools. Section 7.1 below addresses this separately from visible text and from safe admission. The shared binding-service prerequisite remains #31/#6 work. #33 owns the hosted registry and its individually narrowed authorized claims; a registry or a passing narrow probe is not proof of every original H1–H7 question, and this research does not expand spending authorization.

## Recommendation

Implement #34 as **modeled browser operations plus evidence that remains meaningful while work is in progress**, not as a new recording product, natural-language planner, or presentation runtime.

The library should own actual browser inputs, target/document identity, scoped in-flight operations, supported page holds, bounded viewport evidence, capture continuity, geometry, timing provenance, and admission enforcement. The application should choose the interaction's purpose and pace, synthesize any desired pointer trajectory, encode/composite footage, draw cursor graphics and browser chrome, choose camera crops and narration timing, and manage playback.

Owning less presentation obliges the library to expose more precise facts. Merely returning JPEG bytes and an eventual navigation result is insufficient: it forces consumers to recover hidden native state, infer timing, or open another debugger connection.

Keep `@effect-agent/browserbase` generic. The existing adapter borrows the same owner and projects only the installed Effect Agent contract. Do not add an Agent runtime, replace upstream PageCapture/PageCrawl/PageScreenshot/InteractiveBrowser abstractions, introduce a third lifecycle for a recording, or expose raw Page/CDP handles.

## 1. Research findings that affect the design

### 1.1 A supported cursor decoration already exists, but it is not neutral instrumentation

Playwright v1.63.0 exposes `Screencast.showActions`, with a `cursor: "pointer" | "none"` option introduced in v1.61. It renders an animated cursor decoration. Its implementation runs in `onBeforeInputAction`, installs an injected annotation, and waits for the annotation duration (500 ms by default) before continuing. It derives the displayed action title from protocol metadata. In that same pinned source, both `Frame.fill` and `ElementHandle.fill` have a title containing the supplied value.

Consequences:

- A decorative pointer does not establish that intermediate native pointer movements or hover events occurred.
- Enabling the facility changes action timing; it is not a passive recording switch.
- It can paint input values into the recording. That is unacceptable as a default in a library that omits field values from observations and diagnostics.
- Do not wrap `showActions()` indiscriminately, use CSS tricks to hide its label, or create private native-object escape hatches to enable it.

Default to undecorated source frames and explicit, content-safe input receipts. A consumer compositor can render a cursor from the positions the library actually dispatched. A sanitized optional decoration feature can be evaluated separately if it becomes a recurring requirement; do not build it into the owner or make it a prerequisite for recording.

Sources: [pinned public API][screencast-api], [pinned implementation][screencast-source], [pinned action metadata][metainfo].

### 1.2 Capture backpressure is not page suspension

Pinned Playwright uses OR-style screencast acknowledgement across clients: a synchronous client, or any asynchronous client that finishes, can allow frame acknowledgement. Adding a second client can also deliver the cached last frame instead of waiting for a fresh repaint. The upstream backpressure test specifically excludes tracing because tracing can acknowledge independently.

Therefore a slow callback cannot promise that page clocks stopped, that a particular client controls browser production, or that the first delivered frame was newly rendered for that subscription.

Separate three concepts:

1. **Playback hold:** the application keeps displaying a recorded frame or segment.
2. **Capture flow control:** the library bounds buffering, loss, native callbacks and cleanup.
3. **Execution hold:** the host explicitly invokes a supported PageControl transition.

None implicitly substitutes for another. Keep wall-clock deadlines running during all three unless a future explicit contract says otherwise. Source: [screencast-source] and [screencast-tests].

### 1.3 Ordinary screenshots are not a proven non-waking held-page reader

Pinned Playwright's screenshot implementation prepares the page through utility-world JavaScript, normally waits on `document.fonts.ready`, and has paths that obtain geometry or scroll an element into view. Our wrapper also evaluates page geometry before taking a screenshot.

Consequently, `page.screenshot()` is not established as the correct low-level checkpoint primitive during an unfinished response or an execution hold. A page-native screenshot command with explicit current-viewport geometry is a candidate to test; merely replacing one function call is not a proof that it cannot affect page execution or capture a stale surface.

Start with retained checkpoint reads that never execute page code. Add fresh held-page sampling only after a controlled experiment proves the declared mechanism. A retained sample must retain its original acquisition interval and document evidence, not receive a new timestamp implying it was freshly observed. Sources: [screenshotter], [our-driver].

### 1.4 Viewport intersection, pointer hit testing, and actual visibility differ

`checkVisibility()` performs box/CSS visibility checks; it does not generally prove viewport intersection or occlusion. IntersectionObserver's standard explicitly treats pixel-accurate compositing information as a non-goal. Its `trackVisibility` mode is conservative, asynchronous, and has a minimum 100 ms delay; it is not a synchronous authorization check.

Hit testing is useful for interaction admission, but an opaque `pointer-events:none` overlay illustrates why receiving pointer events and seeing text are different facts. A sampled point test is not proof that a full text fragment is visible.

Do not introduce an unexplained `visible: true` field. Model the supported evidence: clipping, intersection, native visibility result where available, sampling interval, and unsupported/uncertain cases. Never include text known to be covered or off-screen in the visible-evidence portion. Keep semantic labels separate from text claimed to be visible.

Sources: [cssom], [intersection].

### 1.5 Native DOM snapshots offer useful text boxes, not automatic bounded extraction

The CDP DOMSnapshot contract provides paint ordering and text-box ranges, useful for clipped text and native inspection. But `captureSnapshot` returns the full DOM/layout snapshot and has no request parameter limiting its node count or reply bytes. Truncating it afterward does not bound work or material already delivered by the native peer.

Prefer an explicitly bounded extractor for running documents. Treat a full DOMSnapshot backend as a separate candidate requiring transport-size, memory, privacy and non-waking evaluation. It is not a free replacement for the existing extractor. Source: [domsnapshot] (current protocol reference, not pinned-native acceptance).

### 1.6 A Playwright route callback is not the requested complete request firewall

The **pinned** Chromium network manager explicitly auto-continues redirected requests rather than exposing them as user routes. It also continues some requests lacking recognised identity, and contains special preflight handling. Current high-level browser-context documentation additionally warns about service-worker interception and notes that enabling routing disables HTTP cache. Popup first-request handling belongs at context level, not after a Page popup event.

This is a concrete blocker to marketing a simple `context.route` wrapper as complete destination admission. It is also a fidelity consideration: a policy feature can change loading/cache behavior and thus the recording itself.

Use a dedicated, capability-qualified request-admission design. Preserve `Unrestricted` as an explicit opt-out; do not quietly enable `ExactHosts` or `PublicWeb`. Sources: [network-source], [context-route], [page-api].

## 2. Ownership boundary

| Concern | Canonical owner |
| --- | --- |
| Connection, session cleanup, target/document registry, operation conflicts | Generic browser owner |
| Real move/hover/wheel, stale-target and fact checks, dispatch evidence | Generic browser operations through the trusted native binding |
| Supported execution freeze/resume | Existing PageControl under the same owner |
| JPEG production, source timestamps, observed dimensions, bounded loss and continuity records | Existing Capture lifetime/accounting |
| Provider MP4/HLS retrieval | Existing Recordings/Replays resources |
| Cursor drawing, click rings, browser chrome, camera zoom/crop, captions, narration, playback pacing | Application compositor/player |
| Easing choice and trajectory generation | Application; a finite modeled executor may run its requested samples |
| Encoding, storage, broadcast/WebRTC, audio, editorial segment sealing | Application or its existing media stack |
| Model tools and upstream error projection | Existing Effect Agent adapter, without another counter or owner |

An optional maintained consumer example should demonstrate the full recorded workflow without private imports. That is a better initial home for presentation code than another runtime package. It should consume the existing frame stream, not start a second native recording to obtain the same media.

For post-session replay, use the provider path already modeled by the library. Browserbase's current provider architecture describes real frame recording and per-page HLS rather than DOM reenactment. For live intermediate output, use bounded Capture. These solve distinct timing needs; no additional DOM-replay framework is warranted. Sources: [our-guide], [provider-recording], [provider-replay].

## 3. Proposed model: live authority is not stored evidence

Names below are design vocabulary, not new exports or typechecked declarations.

**Page authority:** a live capability resolving one native target under one owner and connection generation. Page-local features must not consult a mutable selected tab after admission. Do not silently change the lifetime semantics of existing selection-coupled handles; introduce/migrate the canonical target-explicit path deliberately.

**Document identity:** an opaque identity for the native document/execution context, qualified by frame and connection. A URL, frame object, numeric context ID, or `document.readyState` is not sufficient. Same-URL reloads and replacement frames matter. Share one internal document registry across bindings, readiness, navigation and observation instead of adding competing epoch maps. Native bindings already retain unique native execution-context identity; reuse that rigor without exposing the CDP object as authority.

**Navigation operation:** a scoped resource with operation ID, exact target, progress, current state, completion, and explicit stop semantics. It is distinct from a frame stream or presentation segment.

**Checkpoint:** returned data associating a bounded observation and picture with target/document evidence and a sampling interval. Include stale/transition/partial status. Same-document checks do not establish same-instant DOM-and-pixel equality. Do not label checkpoints atomic, globally fresh, or website-success evidence.

**Capture evidence:** extend the existing capture resource with page-lifetime continuity and bounded transition/loss metadata. A document boundary is not a new provider session or an independently reserving capture owner.

**Input receipt:** operation identity, supported native command kind, known commanded position/deltas, dispatch state and timing interval. Do not record text/credentials or pretend that an inferred element center is the coordinate used internally by a high-level click. Inputs from an external human/controller are unknown unless actually observed through a supported mechanism.

**PageSuspension:** reuse the existing hold receipt and its explicit resume rules. Do not create a parallel “presentation hold” capability inside the browser library.

Structured public data belongs in feature-owned Effect Schemas. Live operation/registration resources remain scoped values. Consumer callback errors and services remain in E/R; public page replies and model-facing projections remain sanitized. Do not invent a generic application job registry, event sourcing engine, or new service tag for every per-page map. Sources: [conventions], [our-owner], [our-identities], [native-bindings].

## 4. Navigation progress without a second controller

The current owner holds its semaphore for a whole operation, and the native navigation awaits DOMContentLoaded. Release that coarse scheduling assumption, not the safety invariants.

Recommended sequence:

1. Under a short owner transition, validate target and policy, reserve action/time/native-work budgets, register lifecycle observers, and establish the operation record before issuing navigation exactly once.
2. Retain the outstanding native work under a scoped fiber/operation lifetime. The start result must say only what is established: local admission and dispatch are not browser commit or website acceptance.
3. Release the short transition guard while retaining the conflict reservation for the navigation. A second navigation/input on that target remains busy; explicitly supported checkpoints/holds may be admitted; healthy independent-page work can proceed.
4. Track commitment and lifecycle by the same navigation/document identity. A waiter must never complete because a successor document reached a matching URL or lifecycle state.
5. Keep the convenient full `navigate` operation implemented on the same machinery, rather than maintaining two navigators.

Do not hold the global transition permit while invoking arbitrary consumer Effects, waiting for a model, waiting for narration, or awaiting stream demand. Use bounded nonwaiting conflict admission, not an unbounded queue. Keep all action and capture accounting under the original owner. Session-wide close, expiry, disconnect and fail-session callback supervision still preempt affected work.

`waitUntil: "commit"` alone is insufficient: it does not expose progress while commitment itself is still pending. Likewise, forking the existing `navigate` does not release its existing permit.

Distinguish cancelling a waiter from stopping a navigation. Interrupting `operation.completed` should not pretend the browser rolled back. A dedicated stop operation may issue the narrow native stop command and report its result; it must retain unknown external outcomes and must not clear an uncertainty fence simply because a Promise rejected. Closing the operation's owning scope must dispose observers and classify outstanding native work, not leak it. Keep conservative session-wide quarantine where current semantics require it until finer isolation is justified.

## 5. Capture continuity and three clocks

Start the capture resource before navigation. Prefer a physical capture that follows the same page across document changes where the pinned native path supports it, while exposing logical document segments. Do not implement media segments by stopping and restarting the native capture after each action. Where a native restart is necessary, report the uncovered interval.

Capture frames currently provide a presentation timestamp and viewport dimensions, not a native loader/document ID. A callback arriving after a navigation event does not by itself identify the pixels' document. Cached initial frames make that particularly important. Model ambiguous transition attribution explicitly; do not label every frame with whichever document is current when the host callback runs.

Separate:

- **Browser presentation clock:** preserve the source frame timestamp exactly.
- **Host monotonic clock:** use it for deadlines, admission, receipt and native settle intervals.
- **Output media clock:** application-owned playback/encoding timeline.

A measured relationship between clocks can include an uncertainty bound; do not equate the clocks or infer an exact offset from one frame arrival. Repeated output frames, playback freezes and speed changes are application transformations, not newly captured source frames. Keep their source mapping when provenance matters.

Return actual geometry, coordinate-space information, frame sequence/capture identity and explicit known drops. A quiet source is not automatically a dropped-frame gap. Recorded buffer drops are known; upstream omissions remain unknown. Bound metadata as well as frame bytes, report metadata overflow, and make the terminal receipt available independently of a lossy progress stream.

Holding the presentation should normally use retained footage. Invoke PageControl only when preventing future page work is the application's actual requirement. Freezing a real page can affect its own timeout/network interactions and should never be triggered implicitly by a slow encoder.

## 6. Input primitives and realistic motion

Native move/hover/wheel belong in the generic library. Playwright documents mouse coordinates in main-frame viewport CSS pixels; wheel dispatch does not await scroll completion. Preserve that distinction in receipts. Scripted scroll and wheel input must remain separately identifiable. Hover can run application handlers and is not necessarily a harmless read.

A library that exposes only a one-point call can make every consumer reinvent timing and budget accounting. Evaluate an optional finite gesture request containing caller-specified point/delta samples and relative time offsets. The caller chooses easing and choreography; the executor owns scoped scheduling, target revalidation, per-event/time bounds and late completion. W3C WebDriver's modeled input actions provide useful precedent, not a reason to add a new transport or dependency here.

Do not let one high-level gesture bypass the action budget with unlimited native packets. Use a finite sample/event allowance and total duration, preserve partial dispatch counts, and stop rather than emitting a catch-up burst after a deadline or target replacement. First measure whether the added gesture form is needed under realistic transport latency; basic bounded primitives can land independently.

For overlays, supply geometry and provenance that let the application map viewport points into source-fit frames and then output media coordinates. Page zoom, visual viewport offsets, device scale, iframe transforms, cropping and resizing must not be guessed. A supported mapping should be associated with the geometry sample it came from; reject stale mappings for input. Unknown mapping is preferable to clicking a guessed coordinate.

Do not promise that every command produces a frame or that native capture reaches a fixed FPS. Do not replay a click merely to obtain prettier footage. Sources: [mouse], [webdriver], [screencast-api].

## 7. Viewport evidence and checked control admission

Implement document and viewport observation as distinct requested modes sharing the same identity model. Filter before the output control limit. Bound traversal, text fragments, geometry/occlusion work and bytes; do not collect an arbitrary entire body or all query matches and call the final slice a work bound.

For viewport text, use rendered text fragments/ranges rather than copying a whole text node when only one line intersects. Keep partially clipped or uncertain fragments explicitly qualified; exclude unsupported content from guaranteed-visible evidence. Accessibility names, placeholders, form labels and visual text should not be conflated. DOM extraction cannot be marketed as complete pixel interpretation of canvas or every compositing effect.

A practical implementation can combine a bounded isolated-world extractor, clipping and native visibility evidence. It must separately represent sampled hit testing and compositor visibility. Do not create a speculative universal occlusion engine to justify a boolean the native APIs cannot support.

Control metadata should contain bounded effective link/form destinations, input type, autocomplete tokens, enabled/editable state and geometry, without field values, HTML, raw event listeners or sensitive trace strings by default. Account for base-URL resolution and form/button overrides.

Provide a checked host action for decisions that need to be current: re-read the exact native node and necessary facts, run the host's bounded admission policy, revalidate, then dispatch or return an undispatched rejection. An attribute change on the same attached node matters just as a replacement does. Mutation observers can flag suspected changes but are not a complete DOM version or the final authority.

Do not claim an atomic check-and-native-pointer-input transaction. Page tasks may run between host checks and native input. If a stronger same-task operation uses DOM activation, expose that semantic difference explicitly; never switch ordinary native clicks into DOM clicks silently. The adjacent upstream guide already makes this distinction for its guarded actions. Site scripts can also send data when a field is filled, so authorizing only form submission is inadequate. Sources: [our-driver], [upstream-guide], [intersection], [cssom].

### 7.1 Passive checkpoints must not replace actionable observations

The updated [issue #34][issue] adds an important composition failure at the reviewed source: `observe()` disposes the current retained-node observation, while `PageControl.suspend` and `resume` use mutation admission that invalidates it. The ordinary inspect → record/checkpoint → hold → resume → click/fill workflow can therefore reject an unchanged inspected node. `readText` and screenshot do not replace that node map, but neither supplies the requested viewport checkpoint while held. This is source inspection, not a newly reproduced failure. Sources: [native observation lifecycle][our-driver], [page-control admission][our-session], [owner invalidation][our-owner].

Separate two responsibilities under the same owner:

- **Recording evidence** is bounded passive data. Taking a checkpoint must not dispose or replace the live node references issued to an agent's action observation. It need not issue actionable references at all. Passive here means no deliberate page-input or authority replacement, not a claim that sampling consumes no time or cannot trigger browser layout work.
- **Action authority** is a bounded, connection/document-qualified retained-node capability plus the facts required for checked input. A snapshot cannot mint authority by copying IDs, and retaining evidence cannot silently renew an expired capability.

For holds, do not simply disable invalidation. Preserve the exact retained native node where the lifetime/budget permits, then offer explicit checked revalidation of that same node and relevant facts after resume. If revalidation succeeds, it may return a newly valid reference to the *same* node under the current owner revision; it may not search a selector, label or URL for a substitute. No stale token is automatically revived, and no input is automatically replayed. Known document replacement, node detachment/replacement, disposed registrations, unconfirmed transitions, expiry or connection loss refuse revalidation before dispatch. Host policy may still reject changed attributes on an attached node.

Bound retained observation sets, nodes, bytes and lifetime under the existing owner. Overflow or expiry must be explicit; making checkpoints passive is not permission to keep unlimited ElementHandles. The adapter's fixed tools should use this canonical identity/admission path, not a parallel observation map or replacement toolkit.

Acceptance must run a generic recorder and the actual AgentRuntime on one owner: inspect an element; obtain one or more passive checkpoints; hold and resume explicitly; revalidate and interact with the unchanged exact node. Verify separate failures for replacement, detachment, changed sensitive facts, same-URL navigation, interruption and stale receipts. Check that recorder samples neither replace action observations nor change selected targets, and that denied cases send zero input. Retained pictures remain historical evidence even when their corresponding action authority expires.

## 8. Request admission is a separate coverage contract

Start with typed allow/deny decisions over narrowly selected host-only facts, not raw Route/CDP handles or arbitrary body/header rewriting. Capture consumer services in Scope, keep E/R, bound pending decisions before forking, and abort covered requests on policy error/timeout. Do not call policy code behind the browser permit that is waiting for that same request.

Declare and test coverage: initial navigation, every redirect, first popup request, frames/OOPIFs, subresources, workers, service workers, WebSockets and an already-running borrowed session. Unsupported required coverage must refuse installation before claiming protection. Observer notifications after a request was sent are not admission.

The pinned route implementation is insufficient for the issue's redirect guarantee. A private native interception backend on the **existing owned connection** could be researched, but it must have exclusive ownership of interception for its covered targets and must coexist with Playwright's own native setup. Do not attach an independent interception client and hope the competing handlers agree.

A URL allowlist is not connection-time public-address containment. DNS pre-resolution, provider navigation filters and artifact download-origin allowlists do not supply that guarantee. `PublicWeb` requires a supported enforcing boundary that controls actual connections, such as a verified provider/egress policy. Reject it when unavailable.

Because interception can alter cache and request behavior, expose that fact instead of claiming untouched browser fidelity. Sources: [network-source], [context-route], [upstream-guide].

## 9. Implementation order and experiments

### Existing hard-cutover prerequisites

Finish the shared native-neutral Effect binding and migrate fixtures away from global Playwright connection rewriting. Keep separate-process borrowed attachment proof and existing reliability investigations distinct. The hosted registry and its narrowed H1/H3/H4/H6/H7 probes belong to #33; reuse that infrastructure rather than describing it as missing or rebuilding it. Its interactive handoff and the broader original H1–H7 questions keep their own evidence status.

### First production increment

Canonical page/document identity and bounded operation/input evidence; passive checkpoints separated from actionable observations; exact-node hold revalidation; viewport observation and control facts; native move/hover/wheel. Add a maintained recorded-workflow consumer that encodes/composites via application code and uses only public package APIs.

### Second production increment

Navigation operation lifetime, checkpoints and capture continuity together, driven by one incremental-HTML fixture. Do not treat a semaphore edit as sufficient without the conflict/late-native model.

### Separate security increment

Request-admission coverage, native interception experiments if necessary, and explicit unsupported policy outcomes.

### Focused experiments before stronger guarantees

1. Serve incremental HTML without completing the response. Observe and capture before DOMContentLoaded; hold and send another chunk; measure parser markers, timers, RAF, CSS, workers and a separate live page. Distinguish server delivery from browser parsing and from callbacks. Resume once or cancel without another navigation request.
2. Compare existing screenshot, current-viewport native screenshot and retained-checkpoint reads under a hold. Record blocked, timeout and geometry outcomes; never resume implicitly to make the probe pass.
3. Navigate between documents with distinguishable rendered markers, including same-URL reload and cross-process replacement. Inspect first/cached frames, attribution and any stop/restart gap without sorting/clamping timestamps.
4. Cross hover targets and wheel nested scrolling containers; record event counts/coordinates and decoded changing pixels. Exercise cancellation and latency; verify no stale packet targets a successor page. Measure whether finite gesture batching is worthwhile.
5. Cover clipping, overlays including `pointer-events:none`, opacity, edge-crossing text, transforms, iframes and long DOMs. Prove bounds and that uncertain data is not promoted to guaranteed-visible evidence.
6. Mutate a control's type, destination or form while an asynchronous admission decision is pending; prove rejected operations dispatch no input. Test native-pointer versus same-task DOM semantics separately.
7. Test admission bypass cases, callback saturation/failure, redirect identity and borrowed contexts with existing workers. Do not claim connection-level containment from an HTTP callback.
8. Compose actual AgentRuntime observed-node tools with recorder checkpoints and explicit holds. Revalidate the unchanged exact node; refuse replaced/detached/changed nodes, document replacement and interrupted transitions without retargeting or replay.

For each production increment, preserve all failed results, use the unchanged pins, run the canonical type/style/unit/native gates, and verify the two artifacts in all three strict Node/Bun consumers. Resource-only consumption must still require neither Playwright nor the framework. Native tests and hosted tests establish different things; neither source inspection nor an upstream test file is a new execution.

## Decision summary

**Accept the core request. Own the trustworthy browser execution and evidence substrate. Leave presentation choices and media infrastructure to consumers, but ship enough target, input, timing, geometry and continuity information—and a real public-API consumer example—that they do not need private internals.**

The next design decisions are the page/operation conflict model, the supported checkpoint/held-read guarantees, and the precise visibility/admission vocabulary. Cursor styling is a comparatively small presentation concern, not the organizing abstraction for the library.

## Sources

[issue]: https://github.com/mannyc2/effect-agent-browserbase/issues/34
[our-session]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/packages/browserbase/src/internal/browser/Session.ts#L603-L665
[our-owner]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/packages/browserbase/src/internal/browser/Owner.ts
[our-driver]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/packages/browserbase/src/internal/browser/Playwright.ts
[our-identities]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/packages/browserbase/src/BrowserData.ts
[native-bindings]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/packages/browserbase/src/internal/browser/NativeBindings.ts
[our-guide]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/packages/browserbase/README.md
[conventions]: https://github.com/mannyc2/effect-agent-browserbase/blob/5ce468e7fec5f6dd37b336c80a4da2fcd69969cb/docs/research/browserbase-platform-2026-09-20/effect-conventions.md
[screencast-api]: https://github.com/microsoft/playwright/blob/v1.63.0/docs/src/api/class-screencast.md
[screencast-source]: https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/screencast.ts
[screencast-tests]: https://github.com/microsoft/playwright/blob/v1.63.0/tests/library/screencast.spec.ts
[metainfo]: https://github.com/microsoft/playwright/blob/v1.63.0/packages/isomorphic/protocolMetainfo.ts
[screenshotter]: https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/screenshotter.ts
[network-source]: https://github.com/microsoft/playwright/blob/v1.63.0/packages/playwright-core/src/server/chromium/crNetworkManager.ts
[mouse]: https://playwright.dev/docs/api/class-mouse
[context-route]: https://playwright.dev/docs/api/class-browsercontext#browser-context-route
[page-api]: https://playwright.dev/docs/api/class-page
[cssom]: https://drafts.csswg.org/cssom-view/#dom-element-checkvisibility
[intersection]: https://w3c.github.io/IntersectionObserver/
[domsnapshot]: https://github.com/ChromeDevTools/devtools-protocol/blob/master/pdl/domains/DOMSnapshot.pdl
[webdriver]: https://www.w3.org/TR/webdriver2/
[upstream-guide]: https://github.com/danieljvdm/effect-agent/blob/4ef48dc4c5f86ccf21572ee52f32e66fefa4a6c8/docs/guide/browser.md
[provider-recording]: https://www.browserbase.com/blog/session-recordings
[provider-replay]: https://www.browserbase.com/blog/session-replay
