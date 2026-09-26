# Project status

The `0.2.0-beta` package set separates `effect-browser`, `effect-browserbase` and `effect-agent-browser`. Self-managed Chromium is supplied by `effect-browser/chromium`; both Chromium and Browserbase use the same scoped runtime and Agent tools. All three were published through the release workflow, with provenance, on the `beta` dist-tag: `0.2.0-beta.0` on 23 September 2026 from tag `v0.2.0-beta.0` (`089a6ea`), `0.2.0-beta.1` on 25 September from `v0.2.0-beta.1` (`f7b9b7b`) and `0.2.0-beta.2` the same day from `v0.2.0-beta.2` (`1fec922`); later changes on `main` are unreleased. Current validation belongs to each PR and its exact source revision; the records below retain the evidence and package identities of their original releases.

The shared capture API adds an explicitly owned `Capture.openFrames` source, independent bounded
subscriptions, first-frame readiness and sequenced metadata observations with JSON codecs.
`Recording.start` borrows a source subscription and supervises sequential writing, drainage and
checked finalization; `Recording.scoped` composes recording failures with the recorded workflow.
The explicit `effect-browser/recording-ffmpeg` entry supplies a progressive fragmented MP4 writer
with source-time resampling and typed process outcomes. These APIs preserve the original browser
owner and native-stop quarantine. The [browser guide](../packages/browser/README.md#one-source-independent-viewers-and-recorders)
describes ownership, bounds and evidence; the candidate PR records verification. Hosted capture
and provider recording qualification remain governed by the separate records below.

[Issue #66](https://github.com/mannyc2/effect-agent-browserbase/issues/66) owns the ordered release-gate work. WP0 establishes explicit host peers, registry refusals, stored-workflow inference and dispatch-aware navigation stopping. WP1 replaces the overlapping retained-target APIs with checked `retain`, makes page creation/selection/closure use `PageInfo`, adds tagged host reasons with required dispatch evidence, and keeps model failures separate from bounded host diagnostics. Concrete checked close returns its receipt; capture accounting uses disjoint discarded-frame components. The [migration table](../README.md#api-migration) is the current API reference. These shape changes do not themselves claim the later timeout-recovery, page-scoped retirement, lifecycle/diagnostic, tool-sequencing or observer-isolation behavior assigned to subsequent packages.

WP2 adds bounded main-frame loading-timeout recovery through the existing stop owner and
page-scoped retirement of the single observation. Selection-only excursions preserve exact-node
references without changing retained-handle semantics; reconnect cannot reuse an old observation
ID. Child-frame timeouts and uncertain stop outcomes remain fenced. These are unpaid local-runtime
changes, not hosted Browserbase equivalence; the exact candidate PR's checks remain the validation
record.

WP3 adds passive owner status and bounded native/policy diagnostics, separates known terminal
triggers from unresolved native work, and accounts for checkpoint/control-facts reads through a
separate finite host allowance. Popup/dialog policy cleanup has bounded native capacity that is
retained through lost acknowledgement; confirmed overflow cleanup can preserve the original page.
WP4 sequences complete tool invocations, including callback finalizers and navigation stop cleanup,
with 32 outstanding calls and a 30-second queue deadline. Native admission stays fail-fast and
same-host reentry is refused. Plain handler Layers remain caller-managed.

WP5 contains optional cleanup-notification failures independently of canonical receipt storage,
writer settlement and checked closure, with explicit guidance for Layer-held sessions and receipts
outside races. Qualification of the `0.2.0-beta.0` publication-gate candidate is the clean WP5 full
acceptance run linked from its PR: five packed consumers, declaration parity, Node/Bun execution,
native suites, release identities and dry-runs. This is unpaid acceptance only and does not publish
or tag the packages. Hosted timeout recovery, before-unload/popup policy behavior, page holds,
provider reconnect/registration retention and Context persistence remain separate qualification
questions; earlier narrowly scoped hosted records below do not qualify this changed runtime.
The maintainer authorized WP6/WP7 before publication. WP6 adds native selection through exact
observed option IDs and an opt-in Agent toolkit; option metadata and retained handles share the
existing finite control budget. WP7 adds independently owned bounded waits, concurrent recorder
reads, an opt-in exact-node wait tool and separately named mutation tools whose results preserve
action evidence when the following observation fails or exceeds its bound. Publishing, hosted qualification and the issue's evidence-dependent deferrals remain
separate actions.

The agent Tools were then reworked around what a real model does with them. `browser_inspect`
takes object parameters (`find`, `scope`): its former empty struct was refused by the pinned
OpenAI model before any request was sent, a failure no scripted-model test could see, and every
Tool is now checked against both pinned providers' schema transforms. Host options are checked once,
when the host is built, and cover the result bound, text continuation, form behaviour, lane limits
and scheduling, with a hook that replaces how readings are taken. Results are fitted under one
bound instead of being cut by the engine, observations default to the viewport, and `find` is
applied inside the page before any limit. `host.run` schedules browser calls sequentially, in the
order the model declared them. `effect-browser` adds a gated `fillForm`, which
`browser_fill_form` exposes, so a whole form costs one call; `fillElement` refuses before dispatch
what Playwright would otherwise refuse only after it. This is unpaid local evidence against
Chromium with a scripted model: no model provider has been called and no hosted session run.

The Browserbase runtime's completed unpaid implementation was merged in [PR #3](https://github.com/mannyc2/effect-agent-browserbase/pull/3). Its immutable source identity, exact acceptance results and artifact checksums are retained in the [2026-09-19 acceptance record](history/2026-09-19-acceptance.md).

Current maintenance uses `Library CI` and a separate, manual, default-off npm OIDC workflow. Check the exact current PR/commit's Actions results; the historical acceptance record is not a claim that later changes were tested. Release procedures and required account configuration are in [RELEASING.md](RELEASING.md).

Both packages were published to npm as `0.1.0-beta.102` on 22 September 2026 from tag `v0.1.0-beta.102` (`c2afec83`) with a direct `npm publish` rather than the repository's `npm release` workflow, so that version carries no provenance. `v0.1.0-beta.103` was tagged and dispatched through the `npm release` workflow, which reused a full run and then failed inside the pinned release engine 0.4.0: it rejected npm's successful OIDC exchange because it could not parse the response's `created` and `expires` fields, so nothing was published and the tag stays unreleased. `0.1.0-beta.104` was the first version released through the workflow, with the engine's fix carried as a patched dependency; `tools/release` now pins ts-release 0.4.1, which contains that fix and accepts npm's asynchronous publish acknowledgement, so the patch is gone and a release needs one dispatch. Live View _authorization_ and actual operator handoff, persistent-context behavior, provider keep-alive reconnection, and replays remain separately authorized hosted checks. Local CDP/video and scripted-provider results are not substituted for those guarantees. Provider recording assembly and signed-URL download were covered by the 2026-09-20 run below; Live View issuance was exercised there too, but issuing a URL is not the same as proving an operator takeover.

The capabilities added after that merge — extension provisioning and launch selection, session uploads with modeled file selection, the bootstrap plan with per-document readiness, and borrowed attachment — are covered by unpaid acceptance only. Extension load and storage identity, provider upload identity and routing, and registration retention across a provider reconnect are hosted questions that no local run answers.

The platform services added for [#32](https://github.com/mannyc2/effect-agent-browserbase/issues/32) — session logs, project-wide Live View links, download filters and deletion, Projects, Certificates, Search, PageFetch, Webhooks, Agents and Functions, alongside the scoped binding runner, the single account layer, standalone scoped allocation, and the credential, policy and recipe defaults — carry the same unpaid-only standing. No request in that set has been sent to Browserbase; log payload sizes and Functions behavior stay unobserved. The signed-URL host is no longer among the unknowns — see the 21 September 2026 run below — but it is recorded as an observation rather than adopted as a default, because the specification promises only a "signed CDN URL" and the observed value is an opaque CDN distribution the provider can re-point without notice.

The recorded-workflow capabilities added for [#34](https://github.com/mannyc2/effect-agent-browserbase/issues/34) and its follow-up [#47](https://github.com/mannyc2/effect-agent-browserbase/issues/47) — real pointer, wheel and key input, viewport observation with host-only control facts and checked admission, passive checkpoints with exact-node revalidation across a page hold, a navigation left in flight with its own completion and stop, and page-lifetime capture with document boundaries that carry the address each document committed ([#48](https://github.com/mannyc2/effect-agent-browserbase/issues/48)) — have the same unpaid-only standing, against a local Chromium over CDP. None has run in a hosted session. That a held page stops parsing as well as timers is a local observation of the pinned Chromium, not a documented guarantee. The same is true of what the key-input focus guard relies on: that a document reports focus without the engine's focus emulation, which page control switches off, was observed in headless Chromium and has not been checked in a hosted browser, where a refusal would be `not-focused` with nothing sent. Request admission was not added: the generic guide's Network policy section records why it does not fit the single owner and which boundary can enforce containment instead, and that boundary has no hosted evidence either, so `ExactHosts` and `PublicWeb` stay refused.

`internal/provider/Contract.ts` records the reviewed session-create subset against two authorities, and `node tools/verify-launch-contract.mjs` checks it against both. On 21 September 2026 that check re-derived all nine request fields and fourteen `browserSettings` fields from the pinned SDK revision `fe805b86cd860436eae63a2551b12cf02d708ce1`, whose bytes matched the recorded digest, and from the published OpenAPI specification, which names `timeout` directly and so establishes the SDK's `api_timeout` as a rename rather than a competing contract. `browserSettings.advancedStealth` and `browserSettings.extensionId` remain the only deliberate exclusions, and v2.20.0 was the latest SDK release at that time. The check reads the network and is run deliberately; ordinary acceptance covers its parsing rules offline against synthetic sources, so a provider field added later fails a deliberate check rather than any scheduled one.

[HOSTED.md](HOSTED.md) describes the manual, default-off workflow those checks run under and the separate demo recording that documentation publishes. A demo recording is documentation rather than evidence for any check above; the run records below are the evidence for the two checks they cover. Every hosted question is now a registered check in `packages/browserbase/hosted/checks.ts`, which names the claim each supports and the run record behind it. The narrowed H1, H3, H4, H6 and H7 checks have run once against the provider, recorded below, and operator handoff has run once with the owner at the Live View.

## Consumer testing entry points, 23 September 2026

`effect-browser/testing` and `effect-browserbase/testing` are public. The first opens the real session owner over a scripted native engine, so admission, budgets, staleness, dispatch evidence, capture accounting, page holds and typed callbacks are the production code with only the pages and native outcomes scripted; a test arms the next call of one operation to fail before or after dispatch, hold at a gate, or disconnect, and reads a recorder that carries dispatch evidence and never a value. The second answers the reviewed session subset of the provider API from a script and composes the real account and browser Layers over it and over the scripted engine. Deterministic identifiers (`observation-1`, `session-1`, a control's scripted `id` as its `elementId`) let a scripted model turn name a node statically, and the scripted clocks follow the caller's, so `TestClock` reaches release and navigation bounds with nothing real elapsing.

Their standing is unpaid and local. The unit suites of both packages, the actual AgentRuntime composition in `packages/agent-browser/test/scripted-agent.test.ts`, and the `resources` and `agent-hosted` installed consumers run them from source and from the packed tarballs on Node and Bun. `packages/browser/test/native/scripted-parity.test.ts` runs one case list against the scripted engine and a real Chromium over CDP and requires the same reason and outcome from both; it belongs to the `browser` consumer's native suite. The script schema refuses a destination on a control where a real document reports none, which that suite found. The repository's own owner and provider regressions now run on these entries inside the packages, and the root `test/integration` tree, its private scripted provider and the separate Node/Bun boundary harness are gone. Form filling and matched readings take the same steps and refusals over a script as over Chromium, and the parity cases cover a form that stops at a disabled field, a verified form that submits, a refused disabled fill and a matched reading. A scripted pass says what the owner and the provider code do with the answers they were given; it establishes nothing about what Chromium reports for a page beyond the parity cases, and nothing about what Browserbase answers, which only the hosted records below cover. Exact-commit acceptance remains the authority for which candidate artifacts and checks passed.

## Hard-cutover callback implementation, 21 September 2026

The implementation in PR #31 now connects `Bootstrap.binding` to the actual generic browser owner. Bootstrap is acquired through `open`, `acquire`, `attach` or `withBrowser`, not stored as an environment-free browser Layer option. Handler errors and services survive heterogeneous plan composition; invocation Scope is discharged. `fromSession` adapts that exact generic session into the fixed Agent Toolkit without another allocation, connection, action budget or capture reservation.

Callback admission, input/output bytes, codecs, deadlines, native replies and late native completion are bounded. Native execution-context identity and origin authorize decoding and handler work; the calling document is rechecked before a reply can be published. The pinned Playwright callback exposes only a frame, which survives navigation, so the implementation uses maintained Chromium Runtime bindings on child CDP sessions belonging to the existing connection rather than treating the frame's replacement URL as caller authority. Page replies never contain consumer causes or host stacks. Registration failure also supervises a waiting workflow while its page-action admission is paused; a retired connection cannot fault its replacement.

Natural Scope shutdown and explicit close share the same order: fence browser and callback admission, interrupt managed callbacks, remove owned registrations, disconnect locally, and independently reconcile remote release. The focused regression reproduces the old failure—callback finalizers dispatching before the fence—under both sequential and parallel application parent scopes. It now requires that attempted finalizer action to fail closed and undispatched, followed by one confirmed cleanup receipt. The maintained generic and actual AgentRuntime consumer programs exercise typed callbacks alongside shared actions and live capture. Exact-commit acceptance remains the authority for which candidate artifacts and checks passed.

The Stage 0A trusted binding is now a public, Effect-based service. `browser-binding` issues opaque bindings, defaults to Playwright with the provider's own address, and resolves the engine before any allocation, so an unissued value is refused without a provider request. `BrowserBinding.playwright({ resolveEndpoint, onConnected })` routes the unmodified Playwright engine to a host-resolved endpoint only after the provider-issued address passes the default checks. The generic and Agent native fixtures, and the scripted-provider unit fixture, now supply a binding and replace nothing global; the production address checks are exercised independently of any injected binding.

Borrowed attachment is proved from a separately started process: `test/native/handoff-process.test.ts` starts a fresh runtime that receives only the durable reference, a target id and fixture addresses, attaches through the public API over the scripted control plane, changes the page and closes as a borrower without a release request, after which the allocating process drives the same page and releases it. That is local CDP evidence, not a hosted handoff.

The earlier unexplained native failure was the owned Fixed viewport test, and it was deterministic rather than intermittent: the stage page's `window.outerHeight` reads the native window's outer height (623) and later the emulated height (480) once Chromium applies the device-metrics override, with emulated viewport, inner size, layout, device pixel ratio and native window bounds unchanged throughout. The package sets neither outer value; the test now compares the geometry the owner controls, native bounds included.

The hosted checks for H1, H3, H4, H6 and H7, narrowed, and for operator handoff are registered in `packages/browserbase/hosted/checks.ts`, and their runs are recorded below. Exact-commit acceptance remains the authority for which candidate artifacts and checks passed.

## Maintainer-reported hosted execution

The PR #16 author reported hosted allocation and cleanup on 2026-09-19, against source `d5892f2f7e1bdaf06c99f210891af6d7b0750a05`, producing the recording committed under [`media/`](media/README.md). Three sessions ran for 37.8s of total browser lifetime:

| Session                                | Runtime      | Outcome                             | Lifetime |
| -------------------------------------- | ------------ | ----------------------------------- | -------- |
| `1fcd0607-cffb-4c48-918a-bf1d999fd332` | Bun 1.4.2    | complete                            | 11.2s    |
| `73727a3d-a2b3-4c71-8961-4b7e6658fb7d` | Node 22.22.0 | complete                            | 11.5s    |
| `eff029fb-16fe-4d33-a000-0ee8b224ea1c` | Bun 1.3.14   | `connect` / `timeout`, undispatched | 15.1s    |

Both complete runs allocated a session, connected over CDP, navigated, dispatched four bounded scrolls and captured 31 frames with `dropped: 0`, `duplicates: 0`, `nativeStop: "confirmed"` and `reason: "duration-limit"`, then released with `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"` and provider status `COMPLETED`. The third allocated and then timed out inside `chromium.connectOverCDP`; its scope finalizer released the session anyway, which exercises cleanup after failed attachment to a known allocation, not an unknown allocation outcome. No session was left running.

Two limits on this record. It ran `examples/hosted-demo.ts` (now the `demo` check) directly rather than through the `Hosted Browserbase` workflow, whose credentials are not configured, and on Node 22.22.0 rather than the pinned 24.14.1; Bun was the pinned 1.4.2. And it covers allocation, connect, navigation, bounded actions, live capture, observation and cleanup only. `recordSession` was `false`, so no provider recording, replay, download or signed URL was requested, and Live View, handoff, persistent context and keep-alive reconnection were not touched.

The Bun 1.3.14 failure does not establish a runtime-version root cause or minimum supported version. The reported success on pinned Bun 1.4.2 is a separate observation, not a controlled reproduction. This reconciliation independently checks committed media and unpaid acceptance; it does not repeat the hosted sessions or independently prove their reported provider cleanup responses.

## Owner-authorized hosted run, 2026-09-20

A second hosted execution was authorized by the repository owner and run from a maintenance host, this time through `tools/hosted-acceptance.sh` rather than an example script. Four sessions were allocated in total and all were released; none was left running.

`examples/hosted-acceptance.ts` failed `configure`/`configuration` before allocating anything, because it shared one options object between the interactive host layer and `BrowserbaseRecordings.layer`. Only the interactive layer projects its options through `httpOptions`, and `makeHttp` rejects excess keys. That was fixed in the example, since replaced by the registered `acceptance` check on one account layer; the inconsistency between the four construction sites is recorded on [#6](https://github.com/mannyc2/effect-agent-browserbase/issues/6). This script had apparently never executed successfully before.

With that corrected, one bounded session covered allocation, navigation, a 129-byte observation, a 29,810-byte full-page screenshot, a three-second live capture ending `nativeStop: "confirmed"` with `dropped: 0` and `duplicates: 0`, Live View issuance, and cleanup reporting `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"` and `observedStatus: "COMPLETED"`. Provider recording was then requested, assembled to `COMPLETED`, and downloaded — 1,545,695 bytes through the `artifactOrigins` allowlist. Recording downloads are served from a signed CloudFront URL that expires six hours after issue and is re-minted on each list call.

Three separate recordings were decoded with `ffprobe`. Each contains exactly one h264 video stream and no audio stream, including one from a page confirmed from inside the document to be playing a 440 Hz tone (`AudioContext.state: "running"`, media element unpaused, `currentTime` advancing). That closed [#13](https://github.com/mannyc2/effect-agent-browserbase/issues/13): provider recording does not carry website audio, and the README now records the measurement.

Limits on this record. It ran on Node 24.14.1 and Bun 1.4.2 — both pinned — but not through the `Hosted Browserbase` workflow, whose credentials remain unconfigured. It did not exercise operator takeover or release, persistent contexts, keep-alive reconnection, replays, or BYOS delivery. `pageControl` was not enabled. The audio finding is about Browserbase's recording pipeline, not about any future self-hosted transport.

## Owner-authorized hosted acceptance, 21 September 2026

The repository owner supplied credentials and authorized paid execution. `tools/hosted-acceptance.sh` (since folded into the registered `acceptance` check) ran once, from a bootstrapped workspace whose `packages/browserbase` source matched `c694403` apart from README prose, and exited 0. One session was allocated, no model was invoked, and no second session was created. Account, project and session identifiers are deliberately omitted: they identify the owner's provider account rather than this source, and the run's own JSON record retains them privately.

It allocated, connected over CDP, navigated to `https://example.com/` and read 129 text bytes, captured a 29,810-byte screenshot, ran live capture to its duration limit with `nativeStop: "confirmed"`, `dropped: 0` and `duplicates: 0`, retrieved one Live View page at a 120-second requested TTL, and released with `releaseRequested: true`, `remote: "confirmed"`, `local: "closed"`, `observedStatus: "COMPLETED"` and no issues. It then requested the provider recording, observed one page go `PENDING` to `COMPLETED` with `delivery: "download"`, and streamed 1,629,128 bytes of it.

That download is what lifts the signed-URL blocker, because the bytes arrived through the `artifactOrigins` check rather than around it. The origin itself is not recorded here. It is an opaque CDN distribution rather than a branded endpoint, the specification promises only a "signed CDN URL", and the observation covers one project in one region, so it cannot be published as the host every consumer should trust — and a BYOS project returns no signed URL at all. What generalizes is the procedure: read `downloadUrl` from `GET /v1/sessions/{id}/recording/downloads` for a completed session and approve exactly that origin. Keeping it explicit means a host change surfaces as a refused transfer rather than as this client trusting whatever later answers at a name compiled into it.

This run does not establish operator takeover and release, persistent-context durability, keep-alive reconnection against the provider, extension load and storage identity, provider upload identity and routing, or replay and BYOS delivery. Retrieving a Live View URL is not authorization or handoff. Those remain separately authorized checks, and no probe for them was run.

## Owner-authorized hosted checks, 21 September 2026

The repository owner supplied credentials and authorized paid execution of the registered checks. `tools/hosted-run.sh` ran `acceptance`, `context-durability`, `keepalive-reconnect`, `extension-identity`, `upload-routing` and `replay-delivery` once each, from a bootstrapped workspace at `f78c96c`, and every one exited 0 with its claim established. Seven sessions were allocated, every one released with `remote: "confirmed"`, provider status `COMPLETED` and no cleanup issues, and none was left running; the probe context and extension were deleted. No model was invoked. Account, project, session and resource identifiers are omitted, as above.

| Check                      | Observed                                                                                                                                                                                                                                                                                  |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `acceptance`               | Same outcome as the earlier run: navigation, 129 text bytes, screenshot, capture to its limit with `nativeStop: "confirmed"`, one Live View page, and a 1,604,098-byte recording downloaded through the approved origin.                                                                  |
| `context-durability` (H1)  | A cookie and a localStorage marker written by a persisting session were both read by a later non-persisting session on the same context, 10 s after the writer ended. The readback ran as the writer's verification, so the writer settled as released with `consumer-readback` evidence. |
| `keepalive-reconnect` (H4) | After detach and reconnect the same target was selected, and an init script registered before detach reported `Ready` on a fresh document afterwards, as it had before.                                                                                                                   |
| `extension-identity` (H3)  | A registered two-file MV3 archive retrieved under the same identity, and when selected at launch its content script rendered its marker in the page.                                                                                                                                      |
| `upload-routing` (H6)      | Uploaded bytes arrived intact at `/tmp/.uploads/<filename>`, with the same name, size and content. Selected immediately after the upload reply, the file was not yet readable (`NotFoundError`, size 0); selected into a fresh input 5 s later it was.                                    |
| `replay-delivery` (H7)     | The recording reported `delivery: "download"`, the replay playlist validated with two media URIs, and its first segment downloaded through the approved origin. This project is not BYOS, so BYOS delivery was not exercised.                                                             |

Two findings changed source before this run. The provider's upload reply carries only a message and never a path, so `Uploads.create` never issued an attachable receipt; it now names the documented upload location. And the reply precedes the file becoming readable, which the check rides out by retrying; `selectFiles` itself still attaches whatever the browser sees at that moment, so a caller selecting straight after an upload can attach an empty file.

`handoff` ran separately at `5e9b5c2`, with the owner as operator. One session navigated to `https://example.com/` and issued a Live View; the owner took control through it, followed the page's link, let go and said so, and `resume` with that statement returned a fresh observation of the same session at the destination page. The session released with `remote: "confirmed"` and `COMPLETED`. The Live View URL was shown only at the operator's terminal and is not in the record. Its first attempt found that `tools/hosted-run.sh` gave each check the plan text as stdin, so an operator check could never see a terminal; the runner now reads its plan on a separate descriptor.

Each check narrows its question. Other storage kinds and flush timing (H1), reconnect from a separate process, duplicate registrations and retired callbacks (H4), worker restart and extension storage (H3), large uploads, downloads, certificates and proxies (H6), and logging, retention, expiry and BYOS (H7) remain open. Handoff was observed for one navigation by one operator; a handoff that ends with the operator still in control, or a Live View that expires mid-handoff, was not exercised.

## Owner-authorized hosted checks, 24 September 2026

The repository owner supplied credentials and authorized paid execution for [#86](https://github.com/mannyc2/effect-agent-browserbase/issues/86). `tools/hosted-run.sh` ran the new `live-capture` check four times, from bootstrapped workspaces. The first three runs failed on the viewport reading, exposing two library defects; the fourth ran at `18bcb5d`, with [#89](https://github.com/mannyc2/effect-agent-browserbase/pull/89) and [#90](https://github.com/mannyc2/effect-agent-browserbase/pull/90) merged, and exited 0.

Between runs 3 and 4 there were two further sessions:

- a diagnostic run with timing added to the read path, from a modified tree rather than a registered source;
- the livestream example, run once as an uncommitted probe.

Ten sessions were allocated in total. The nine with cleanup records released with `remote: "confirmed"`, provider status `COMPLETED` and no issues. The probe keeps no record, and the provider listed no running session afterwards. No model provider was called: the probe's agent and narrator were scripted. Account, project and session identifiers are omitted, as above.

**Capture pacing and still pages.** Each run scrolled a Wikipedia article at 1280×720 in three cycles. Each cycle was three 500 px wheel steps 120 ms apart, then 1.5 s still. Across the 12 cycles:

- 5 to 12 frames arrived per cycle, with the median gap between frames 13–171 ms and the 95th percentile 152–241 ms;
- every cycle delivered every frame it received, with `discarded` and `late` both 0 and `nativeStop: "confirmed"`;
- 1 or 2 frames arrived after the last input, and the last one 88–256 ms after it;
- the last frame matched a screenshot taken once the page was still, to within JPEG noise (mean absolute difference at most 1.52 of 255).

So at hosted round trips the picture a viewer is left with is the settled page. Frames are coarse and uneven, though, not a constant rate.

**Viewport reading under a pass-through container.** CoinGecko's home page was read at 908×602.

| Run  | Viewport reading                    | Cause                                                  | Fix                                         |
| ---- | ----------------------------------- | ------------------------------------------------------ | ------------------------------------------- |
| 1, 2 | Failed `Stale`                      | Child-frame churn retired the whole page's observation | #89 scopes retirement to the observed frame |
| 3    | Failed `Timeout` (15 s)             | See the diagnostic run below                           | #90                                         |
| 4    | 1.35 s: 558 text bytes, 19 controls | —                                                      | —                                           |

The diagnostic run measured 7.6 s for the same viewport reading, 6.1 s of it spent fetching the 19 control handles one property at a time, at about 320 ms per call. #90 fetches them, and the data, in a fixed number of calls.

In run 4 the viewport reading reported 2 clipped text runs, 0 covered, 1 uncertain and 3 unreachable controls. In the diagnostic run, the browser's own hit test resolved the page's 47 pending points to a single node in about 0.5 s. A document reading of the same page took 0.53 s (5.5 s before #90) and returned 6,000 bytes, its limit.

**The livestream example.** The example ran on a Browserbase session with a 3,000 ms delay. It opened `https://example.com/`, read it and followed its link:

- every frame aired 2,998.7–3,000.3 ms after the host received it, 5 frames in all, with a 7.1 s gap while the page was still;
- each of the three captions aired 2,998.7–3,000.8 ms after its step started, and every frame shown under a caption came from that caption's step;
- no caption was skipped;
- the address and title events followed both documents;
- capture delivered 5 of 5 frames with `nativeStop: "confirmed"`.

These are single runs against three public pages from one account and region. They don't measure a real narrator model's latency within the delay, a viewer on a slow link, or pages that repaint continuously for long periods.

## The livestream example with real models, 24 September 2026

The owner supplied Browserbase and OpenRouter credentials and authorized real model calls for the livestream example. A script outside the repository ran the example's `livestream` on Browserbase with a 5,000 ms delay, a real agent and narrator, and a local headless viewer. The task was to search Wikipedia for the Eiffel Tower and report its height. Ten sessions were allocated; the provider listed none running after each, and the script kept no cleanup records. Model spend was under $0.45 in all.

- **Provider.** `@effect/ai-openai` pointed at OpenRouter's Responses endpoint fails on the stream's closing `data: [DONE]`, which arrives in the same chunk as `response.completed`. `@effect/ai-openrouter` 4.0.0-rc.115 uses Chat Completions and handles it without any filter.
- **Agent model.** With `openai/gpt-6-luna-pro` the agent answered "330 metres (1,083 ft)" in 7 model calls. `anthropic/claude-sonnet-5` found the answer but kept re-checking it until `maxTurns: 8` ran out, then answered the forced final turn in prose, which fails the output contract.
- **Narrator.** A narrator that reasons first (`gpt-6-luna-pro` at its default effort) took 4.0–6.8 s per caption, and 2 of 6 captions missed the delay. The narrator Agent, with reasoning off, took 1.9–2.7 s. In the last run it captioned the navigation, the search box fill and the click, and stayed silent for three inspections. Each caption aired 5,001 ms after its step started, over its own step only, and 57 of 57 frames aired 5,000.3–5,001.2 ms after receipt.

These are single runs of one task from one account and region.

## The long-session check, 24 September 2026

The owner authorized Browserbase calls for the action-allowance work. `tools/hosted-run.sh` ran the new `long-session` check once, from a bootstrapped workspace at `c7cdd5c`, and it exited 0 with its claim established. One session was allocated and released with `remote: "confirmed"`, provider status `COMPLETED` and no issues; it ran for about two minutes. No model provider was called. Account, project and session identifiers are omitted, as above.

The session's policy allowed 1,100 actions. On two Wikipedia articles at 1280×720 the check ran a fixed cycle of four 400 px wheel steps down, four up, one viewport reading and one heading read, with a navigation every 250 steps, while one page-lifetime capture interval ran from the first navigation to the end:

- all 1,100 actions succeeded, with no other failure, in 123 s. Wheel steps took 74 ms at the median (95th percentile 100 ms), viewport readings 317 ms (484 ms) and heading reads 75 ms (169 ms);
- `status.actions.used` matched the host's own count at every hundredth action and ended at `{ used: 1100, maximum: 1100 }`;
- the 1,101st action was refused `Limit { dimension: "actions", maximum: 1100, observed: 1100 }`, undispatched, and status still said `open` with no reason. A checkpoint then succeeded on its separate allowance;
- capture delivered 1,584 of 1,586 frames across four documents, between 364 and 428 in each quarter of the run. The 2 it discarded were `late`, `overflow` was 0, the median gap between frames was 61 ms (95th percentile 303 ms, longest 1.2 s) and the native stop was confirmed.

This is one run on public pages from one account and region. It shows that the counter, the refusal and capture hold over more than 1,000 actions at hosted round trips; it does not measure a session of hours, a page that repaints continuously, or memory growth over time.

## The context-crash check, 24 September 2026

The owner authorized Browserbase calls for this work. `tools/hosted-run.sh` ran the new `context-crash` check once, from a bootstrapped workspace at `ba415a1`, and it exited 0 with its claim established. Two sessions were allocated, as budgeted. The context was created for the run and deleted afterwards. No model provider was called. Account, project, context and session identifiers are omitted, as above.

- **Writer.** A child process opened a persisting session on the fresh context. Its bootstrap wrote a cookie and a localStorage marker on `https://example.com/`, and it read both back in that document and reported them.
- **Kill.** The parent then killed the child with SIGKILL, less than a second after the page had written the markers. The process was gone 9 ms after the report. Nothing requested a release, and the child's in-process writer lease never settled.
- **Provider.** 1.2 s after the kill, the provider reported the writer's session `COMPLETED`, well inside its 120 s provider lifetime: it ended the session on its own once the connection dropped.
- **Readback.** After the same 10 s that `context-durability` waits following a release, a non-persisting session on the context read both markers. It released with `remote: "confirmed"`.

So when a host process dies, the remote browser does not die with it. Browserbase ends the session on disconnect and keeps what a persisting session wrote, just as it does after a release. No API change follows from this result. The writer's lease is a different matter: a host that crashed leaves its own lease unsettled, and a distributed lease backend still has to decide when another writer may start. This check shows only that the data is there once the session is terminal. It is one run on one page from one account and region. It does not cover a remote browser that crashes itself, other storage kinds, or a kill that lands while the page is still writing.

## Historical material

Nothing in the tree is needed to reconstruct current source except the tracked packages, `upstream.patch` and the pins; everything historical lives in Git history rather than beside the code.

The preserved transfer checkpoint (`checkpoints/`: the checkpoint-04 archive, its manifest, patches, probe harness, run logs and access records, together with `tools/verify-checkpoint.py`) and the September 2026 design research (`docs/research/browserbase-platform-2026-09-20/`, whose proposals were implemented or superseded by #31–#54) were retired on 22 September 2026. Both are intact at `c2afec83a7b47f96bf0da20b0c01ee94e3ee1d45`:

```sh
git show c2afec83a7b47f96bf0da20b0c01ee94e3ee1d45:checkpoints/README.md
git ls-tree -r c2afec83a7b47f96bf0da20b0c01ee94e3ee1d45 docs/research/
```

The older transfer handoff, canonical-input fetcher and transient development logs were retired earlier and remain at merge commit `e61e3d75c15cbd467e196170fce5c064c13d4bb0`:

```sh
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:docs/handoff.md
git show e61e3d75c15cbd467e196170fce5c064c13d4bb0:tools/fetch-inputs.py
git ls-tree -r e61e3d75c15cbd467e196170fce5c064c13d4bb0 results/
```

Do not follow historical transfer instructions as current contributor requirements. The maintained development entry point is [CONTRIBUTING.md](../CONTRIBUTING.md).
