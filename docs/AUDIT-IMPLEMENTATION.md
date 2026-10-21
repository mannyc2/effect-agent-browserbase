# Browser replacement implementation ledger

Started 21 October 2026 on `codex/browser-audit-fixes-v2`, isolated from the dirty primary
checkout. `git ls-remote origin refs/heads/main` returned
`473222529715f67709493def4c30d2419e1f4742`. Routine writes and Git reads succeeded.
The dirty primary hosted work, survey probes and release journals were preserved.
No hosted sessions, paid model calls, tags, publishing, deployment or merging were performed.

Requirements come from the combined 21 October report, sections 6 and 9. Source inspection and
old probes are historical evidence. Current test and mutation evidence is recorded separately.
Results use **fixed**, **already-fixed**, **rejected-with-evidence**, or **pending-decision**.
A fixed row records implemented behavior with focused proof; it does not imply the final
repository gate passed. Outstanding integration gates are listed at the end.

## Correctness ledger

| Report bug | Result | Current proof |
| --- | --- | --- |
| 1 Dispatched error consequences | fixed | Property/corpus tests require `check` for every dispatched error; agent receipts retain uncertainty. Original consequence mutant fails. |
| 2 Focus dispatch | fixed | Native press/type focus-handler failures report dispatched before focus evaluation. Focus mutant fails. |
| 3 Cross-document refs | fixed | Host ref floor travels with every page-script answer, including guarded lookups; published rebundle regression and floor mutant. |
| 4 Disabled fieldset | fixed | Native disabled inheritance, including the first legend exemption; Find and rebundled input regression/mutant. |
| 5 Published page script | fixed | Frozen named factories exercised through four consumer transformations, including minification, plus Workers bundling. |
| 6 Presenter acquisition | fixed | Policy approval precedes hand acquisition; bounded owner-clock wait, failFast and cancellation regressions. |
| 7 Presentation duration | fixed | Planned typing/wheel schedules over ten seconds fail before focus or pointer dispatch. Public custom styles validate bounded ordered schedules. Cap/validation mutants fail. |
| 8 Owning clock | fixed | Public `page.clock`; Stage, Presentation, waits and stillness use it. Caller TestClock regressions. |
| 9 Recorder idle lifetime | fixed | One host deadline across document replacements; removes init registration and stops observers. Lifetime/registration mutants fail. |
| 10 Until deadline | fixed | One absolute owner-clock deadline, bounded spaced retries; native repeated reload regression returns unmet. Original deadline mutant fails. |
| 11 Typed feature failures | fixed | Invalid Stage holds fail InvalidRequest; Presentation accepts a complete wrapped public Page. Ordinary constructor identity throws removed. |
| 12 Color/file semantics | fixed | Discoverable controls without textbox role or text editability; rebundled control and input regressions/mutants. |
| 13 Retirement cancellation | fixed | Retirement runs in its owned scope; state stream ends after cleanup. Independent 5,000-history model and cancellation runtime mutant. |
| 14 Failed-attempt outcomes | fixed | Failed acquisition retains its own typed cleanup evidence before a successful retry; omitted event mutant fails. |
| 15 Stale unconfirmed outcome | fixed | Per-attempt evidence, with no sticky lifetime result; sticky outcome mutant fails. |
| 16 Consistent release outcomes | fixed | Release defects and scope-close defects both report Unconfirmed; ignored scope failure mutant fails. |

Detailed proofs and retained coverage are in [reading](audit-reading.md),
[input/pictures](audit-input-pictures.md) and [supervisor](audit-supervisor.md).
Local mutation logs are retained under `.work/evidence/` and `.work/recovery/`; these are
execution evidence, not shipped fixtures or source-runtime proof by themselves.

## Architecture and testing ledger

| Work | Result | Implementation and proof |
| --- | --- | --- |
| Stage 1 Vocabulary/errors | fixed | Public BrowserError constructors/translation, Window/cursor, Geometry, Clock and Style. Reply ownership belongs to page; lane receives effects rather than a gate implementation. |
| Stage 2 Folders/boundaries | fixed | Root exports kernel only. Feature/provider folders use public contracts. Runtime and package-test imports plus physical feature deletion/typecheck run in `ready`; planted forbidden root and sibling-private test imports are rejected. |
| Stage 3 Public kernel parity | fixed | Public clock/capture/afterInput/until/style/matching. Deleted internalsOf, Built, viewOf, Internals, waitFor and aim. |
| Stage 4 Minor correctness | fixed | Inventory below. Current source-derived script version and real browser regressions replace source-only probes. |
| Stage 5 Actions | fixed | One Action schema through page.perform, policy requests, required action-event values, Plan, adapter receipts and typed run events. Scripts retain no code/arguments in events. |
| Stage 6 Consumer primitives | fixed | Main-world read/act, fixed registration viewport, scoped request policy, cookie-presence query. Current isolated consumer migrated and checked against fresh archives; all 55 browser tests and local Workers/CDP execute those same archives. |
| Stage 7 Features | fixed | Generic supervisor core only; Expect folded into Plan; capture and Stage feed tagged states with independent history tests. |
| T1 TestModel | fixed | Prompt-aware finite scripts, typed exhaustion, tool fingerprint, custom streamed delivery; bench copies replaced. |
| T2 Browserbase states | fixed | Schema starting states, PENDING writers, seeded identities and notification-based waitUntil; pending/listing mutants fail. |
| T3 CDP fault seam | fixed | Owned scoped protocol port and TestCdp rules by method/channel/operation/script; native default remains direct. Live-object patches and expression-text fault selection removed. Seventeen reviewed elapsed bounds become causal/virtual assertions or opt-in latency checks; the eighteenth was already virtual. See the exact [inventory](audit-latency.md) and its retained timing limits. |
| T4 TestPage/TestBrowser | fixed | Public data services share ownership algorithms and canonical Actions/matching/folds. Contract scenario runs on seeded data, native Chromium and CDP. Selectors, scoped snapshot/text, window queries, captureStats, frame.after/selected capture options, zoom, cookie queries, scripts, layout and automatic paint are explicitly unsupported rather than simulated. |
| T5 Seeded agent state | fixed | Schema adapter state and conversation seeds; pure tabs/moment placement and typed events. |
| T6 HTTP recording | fixed | HTTP request-keyed codec cassette, exact live opt-in/reservation cap, complete provider payloads/moments/raw grading truth and offline regrading. Eighteen focused tests; omitted-moment/truth/payload mutants fail. |
| T7 Suspended-port stories | fixed | Deterministic held-port agent stories and end checks; mutants fail for lost/late/incorrectly attributed work. |

The testing service has an explicit four-module private plumbing allowance for the lane,
input gate, event timeline and change fold. It reuses those ownership algorithms rather than
claiming an independently reimplemented fake is equivalent. Runtime features have no private
kernel allowance. Tests can import their own pure internals; no private package subpath ships.

The broader section 7.4 supervisor stand-in proposal is **rejected-with-evidence** after the
generic cutover: the five original fake Browser.Service helpers are gone. Core tests use typed
Opened values and controlled open/loss/release ports; the bench uses TestBrowser. No current
caller requires a published wrapper. A public named fixture-site service was not added: named
bench routes and package-local native HTTP fixtures remain. T4 claims the explicit data-service
contract above, rather than every proposed convenience service in section 7.4.

## Public cutover

New browser subpaths are Action, ActionPort, Clock, Geometry, Matching, Released, Stillness,
Style, Url, Window and testing. The agent adapter adds AdapterState and testing. Existing feature
and provider subpath names remain; their implementations now live in owned folders. The portable
root has one export list shared by Node and Workers. Provider/feature namespaces Cdp, Chromium,
Moment, Motion, Plan, Policy, Presentation, Stage and Supervisor leave the root and remain at their
explicit subpaths; Expect is deleted.

Removed public contracts are Expect, Page.playwright, Browser.Service.context, Page.waitFor,
Page.aim and the old browser-specific supervisor extensions (Admission and Releasing). Stage,
Presentation and Plan remain optional subpaths. Plan recordings now use version 3 only; no
persisted old-format caller was found. Page.perform is the canonical Action entry, while its
named methods use that same path. New public Page contracts include clock, read, act, afterInput,
until and capture evidence. Browser adds viewport/request settings and cookie-presence queries;
Browserbase.generations/GenerationOptions replace Browserbase.supervise/SuperviseOptions, with
OpenFailed cleanup evidence and a refused classifier for retry decisions. No compatibility facade was
retained for deleted raw access or internal feature back doors.

## Minor and latent findings

| Finding | Result | Evidence or rationale |
| --- | --- | --- |
| firstPage check/open race | fixed | Twelve concurrent calls open one tab; removing the lock fails. |
| Global registration lock | fixed | Per-native-page locks plus eight registration workers; held native session creation no longer stalls other tabs. Queue capacity is 32; overflow revokes authority. Both serial-worker and unbounded-queue mutants fail. |
| Same Chromium version gives same id | fixed | Two real launches have distinct identities; substituting the same version string fails the regression. |
| Dialog success published before answer; failed answer dropped | fixed | Scoped bounded response worker publishes actual answer. Native failed response yields `failed`, loses authority and makes the action fail Closed. False-answer mutant fails. |
| Event history array copy per event | fixed | Fixed capacity circular storage, ordered replay/recent projection and expired-cursor failure; 100 seeded repeated-wrap histories and original laws. Head-advance mutant fails. |
| Concurrent first clock probes | fixed | Shared measurement lock rechecks the current estimate; two simultaneous first callers cause one probe. Mutant fails. |
| Workers Buffer assumption | rejected-with-evidence | Portable encoding replaces Buffer in neutral code. Actual local Worker/CDP succeeds both with and without nodejs_compat. Consumer dependencies retain their own runtime requirements. |
| Unspaced lost-context retries | fixed | Spaced bounded retries share the one original deadline. |
| Split visibility rules | fixed | Canonical visibility helpers allow visible descendants of nonpainting wrappers; Find/bundle mutants fail. |
| Manual script version | fixed | Hash covers named factories and composition. Changed-source replacement disposes observers and preserves the ref floor. |
| aim fallback marks input unknown | fixed | aim API deleted. Plan dispatches canonical values; durable read-back rules retained. |
| Missing ARIA structural roles/names | fixed | Explicit structural role queries work without default outline scaffolding; aria-labelledby takes precedence. |
| settle swallows protocol errors | fixed | Native failure propagates; only cleanup finalizers ignore cleanup failures. |
| Nested suspension deadline undocumented | fixed | First claim owns shared drain deadline; subsequent claims join it. README documents expiry and individual cancellation. |
| Duplicate Box–Muller | fixed | Geometry.normal is the one seeded Effect implementation used by planners/styles. |
| Viewport growth scales every frame | fixed | Uncropped captures restart for larger geometry; explicit size/restore regressions and mutants. |
| Resize/resume drops real frames | fixed | Paused capture lifecycle owns restoration; ACK/drop/currency coverage retained. |
| Disjoint clock estimate moves delivered frame time backwards | fixed | Capture keeps delivered frame.hostTime ordered and widens uncertainty when mapping changes; Clock.mapping itself may adopt a disjoint estimate. Clock mutation regression. |
| Apart transport concurrent attach | fixed | Separate attach lock; dedicated connection retained. |
| Same-session capture frames undecoded | fixed | Schema validates dimensions/timestamps and frame identity at ingress. |
| Ended supervisor span parent | fixed | Attempt/runtime work is scoped under its current owner, without a captured ended span. |
| rotateBefore validation, dropped timed rotation, sticky lease ending | fixed | Unused timer/extensions removed with their states; core rotation/loss and stale generation tests retained. |
| ready polling documentation | fixed | Current README says 50 ms. |
| STATUS retained-read bound | fixed | Current state documents 250 ms and distinguishes historical release entries. |
| Page action order documentation | fixed | Policy approvals precede FIFO page write admission; documented accordingly. |
| Policy names nonexistent Agent.run | fixed | Current adapter task source documented; policy failures fail closed for all inputs. |
| Abandoned completed read stays stale for 10 seconds | fixed | Completed orphan retention shortened to 250 ms; shared in-flight ownership retained. Owner-clock regression fails with old bound. |
| Failed input drain masks original native loss | fixed | Closed failures retain actual native reply ownership without awaiting an unanswerable drain again. Other failures still drain cleanup releases. Native loss and unconditional-drain mutants fail the Closed-reason regression; lost-key cleanup coverage remains green. |
| New document can report quiet before its beginning | fixed | History beginning counts as activity; native repeated-document quiet regression failed before change. |
| Active Stage feed publishes old-document frame | fixed | Public page identity/document/connection check rejects old evidence; same-document queued frames preserve order. Seeded runtime regression and history model. |
| Capture acquisition/reader release cancellation deadlocks | fixed | Lock acquisition remains interruptible; nonlast reader release avoids camera lock. TestClock/native regression and both mutants fail. |

Additional implementation-time findings have independent regressions:

| Finding | Result | Current proof |
| --- | --- | --- |
| Explicit secret text reaches policy before an unmarked field is refused | fixed | Action.recorded honors Type.secret regardless of structural disclosure; policy text derives that same safe Action. Native guard/events/field regression passes; omitted-flag mutant fails. |
| Foreign-page frame with matching counters is accepted | fixed | Currency includes page and session, as well as connection/document/generation/sequence. Foreign-page mutant fails; copied evidence keeps its lineage. |
| Browser-global request policy intercepts sibling contexts | fixed | Context ownership is proved before policy invocation, fulfillment, refusal or overflow handling. Native tests cover both simultaneous-controller orders, delayed owners, foreign contexts, first popup requests, nested frames, service workers and redirect hops. Bypassing ownership fails both order regressions. |
| Policy failures become successful refusals | fixed | Explicit Refused remains a decision; typed failure, defect and timeout retain a failed worker and revoke authority after refusing the request. All three old failure-fold mutants fail. |
| Retiring a borrowed connection releases pending requests | fixed | Native page and service-worker regressions hold decisions or ownership queries while closing the tracking scope. Successful cleanup settles tracked requests before detaching; uncertain ownership closes only owned targets. A sibling context and the external browser survive. Failed cleanup remains observable, but detachment can release unresolved traffic; connection loss removes enforcement. Omitting retirement makes all four requests reach HTTP. |
| Existing workers bypass newly installed request controls | fixed | Installation rejects preexisting dedicated/shared/service workers with typed InvalidRequest after enabling interception. Native tests include a worker created during held installation; omitted and early checks fail. No worker is silently restarted. |
| Missing or partial upload evidence is presented as a complete body | fixed | Policy receives only complete lossless UTF-8 evidence. Five malformed/incomplete variants fail before policy; native text and multipart remain supported. The old null/text projection fails all five regressions. |
| Logical connection loss still permits browser operations | fixed | Browser native operations check and race the shared loss signal. Typed policy failure, defect and timeout now prevent cookie queries and new-page allocation; the old native wrapper fails all three assertions. |
| Workers root omits a portable public contract | fixed | Both root export conditions resolve the same portable module. Explicit kernel export-key and entry-map assertions pass; a mismatched Workers export target fails. No facade or duplicated export list remains. |
| Type-only imports and the Workers facade bypass dependency enforcement | fixed | Twenty-seven adversarial fixtures include TSImportType, Workers feature reexports and sibling-private test imports. Feature deletion now typechecks both portable roots. Package tests share one repository-only CDP proxy; its own imports and normalized shared-helper paths are checked. Omitted checker branches and a naive shared-path prefix fail their fixtures. |
| Seeded firstPage hides the native allocation race | fixed | Shared native/CDP/seeded contract forces cooperative scheduling across twelve callers. The simulator uses the same first-page lock; omitting it creates twelve pages and fails the contract. |
| Recorder expiry crosses navigation | fixed | A bounded page read turn precedes the recorder lock, preserving the existing lane-to-recorder lock order. Held native removal blocks navigation; cancellation and page closure release correctly. Omitting the turn fails both ordering assertions. The earlier rare Chromium Script-not-found failure was not reproduced independently, so this does not claim its cause was established. |
| A random over-budget typing plan strands a concurrency test | fixed | Seventy-eight of 256 default 58-key plans exceeded the duration cap. A fixed public 9.42-second schedule retains the cross-page concurrency assertions; the first-key rendezvous also observes child failure. The original full-run sample did not capture the child failure. |
| Local relay Chromium starts incidental extension workers | fixed | The local launcher disables extensions, matching the ordinary Playwright fixture. Native worker discovery confirms their absence; removing those flags reproduces typed request-capability refusal. No request-control bypass was added. |
| Remote iframe ownership is lost despite a known context | fixed | Out-of-process iframe targets use their proved browserContextId even when the parent frame tree omits them. Native site-isolated denial retains authority and emits no invented parent page; restoring the iframe exclusion fails. Final packed consumer and Workers checks exercise the same path. |
| Mapped protocol input time can follow its synchronous mutation | fixed | The recorder stamps trusted inputs when observed, on the same clock as mutations. A native asymmetric calibration-delay regression preserves menu/dialog causes; restoring event.timeStamp loses the cause and fails. |
| Relay handover hides a failed acquisition behind an entry signal | fixed | The rendezvous races entry against the child result, preserving the typed provider failure immediately. Restoring the unobserved wait fails the focused refusal regression. |
| Context.route skips a redirect destination | rejected-with-evidence | Free native redirect probe proved this replacement unsafe. Per-hop Fetch with context ownership remains required. |

## Decisions from PLAN section 8

Routine recommendations were resolved from caller evidence and the authorized hard cutover.
They were not converted into approval prompts.

| # | Result | Decision and rationale |
| --- | --- | --- |
| 1 | fixed | Kernel-only root; optional features remain public subpaths. |
| 2 | fixed | Removed public Playwright page/context after migrated consumer and Worker/CDP proof. Native fixtures use the owned private test seam. |
| 3 | fixed | One until/find matcher; unmet waits return false. |
| 4 | fixed | Context.Reference styles reach followed tabs. |
| 5 | fixed | Deleted aim and its speculative state. |
| 6 | fixed | Browser owner clock governs feature stamps and sleeps. |
| 7 | fixed | Stillness is optional; ready keeps document evidence only. |
| 8 | fixed | Focus is dispatched because page handlers may run. |
| 9 | fixed | Undispatched Limit/Suspended/PolicyTimeout permit a later retry; dispatched always requires checking. |
| 10 | fixed | One BrowserError reason union; operation generics add no needed caller distinction. |
| 11 | fixed | Completed orphan retention is 250 ms; current live-chart evidence rules out a ten-second cache. Writes/documents invalidate it, and in-flight sharing is preserved. |
| 12 | fixed | Host-owned monotone ref floor keeps short model refs without collisions. |
| 13 | fixed | Structural implicit roles answer explicit queries; outlines omit structural scaffolding. |
| 14 | fixed | Retain nonsecret values in control observations for verification; general prose masks unless explicitly unmasked. Secret masking remains mandatory. |
| 15 | fixed | Deleted Expect; Plan uses one expectation model and durable evidence for uncertain consequential input. |
| 16 | fixed | Acquire presenter hand after policy approval, bounded with failFast. No speculative approval/display hook. |
| 17 | fixed | Ten-second planned typing/wheel cap; malformed custom schedules fail before dispatch. |
| 18 | fixed | Two-minute host idle lifetime across documents with registration removal. |
| 19 | fixed | Small Window.cursor continuation avoids retaining pictures/events. |
| 20 | fixed | Ship supervisor core alone; no unused keep/grace/meter/admission/rotation extensions. |
| 21 | fixed | Policy judges remain optional policy feature, using public kernel contracts. |
| 22 | fixed | Fail closed even without structural facts; no unsafe bypass retained. |
| 23 | fixed | Retain Stage and Plan: current bench workflows exercise them and Stage feed modeling is an explicit acceptance requirement. They cost no kernel dependency. Consumer has no direct caller today. |
| 24 | fixed | Publish contract-tested data simulator, with explicit unsupported capabilities. |
| 25 | fixed | Keep pinned Yielded beta.168. Current consumer migration/tests work without an adapter upgrade; TestModel/HTTP/run-event seams are version-independent. |
| 26 | fixed | Dependency/deletion check is in ready, therefore ordinary CI. |
| 27 | rejected-with-evidence | Browser entry does not require nodejs_compat: actual no-flag Worker/CDP execution passed. |
| 28 | rejected-with-evidence | Reject recommendation to bypass scripts: act is opaque/scripted policy input and fails closed. No source or argument disclosure. |
| 29 | fixed | Script exceptions use typed Threw; response-schema failure remains Failed with correct dispatch evidence. |
| 30 | fixed | Functions plus typed arg/result; docs explain bundler constraints, and public script tests exercise transformed consumers. |
| 31 | fixed | Fixed positive integer viewport at registration, before consumers can use each page. |
| 32 | fixed | Consumer facts/delay/liveness/redaction/repeated-frame choices remain consumer-owned. No unused moments track added. |
| 33 | fixed | Browser owns narrow request interception with bounded decisions and redacted refusal events. |
| 34 | fixed | Retirement awaits every started acquisition and release; abandoned waiter does not abandon ownership. |

## Acceptance and remaining gates

Pinned runtimes are Node 24.14.1 and Bun 1.4.2. Installation used
`bun install --frozen-lockfile --ignore-scripts` and `bun run patch:tsgo`.
Origin/main was reobserved at the original `473222529715f67709493def4c30d2419e1f4742`.
The dirty primary checkout and detached survey probes remain unchanged.

The final production source fingerprint is
`29e01f309f38dee998fe206f73fea45dce148c8b83fc25248aa5ff51593df126`.
The manifest hashes each package source/manifest and all four archives. The browser archive is
`c2f3940234c17c74f6b0163e8acd43019394258df11ee551c2da276e4287b8ea`.
Rechecking those hashes found no changed production source. Test-only follow-ups do not alter
those archives. Detailed local commands, exit codes and timing live under `.work/evidence/`.

| Check | Result |
| --- | --- |
| Full workspace tests against final production source | 896/896 passed, 195.611 seconds; browser 530, browserbase 69, agent 33, human-strokes 8, bench 169, site 87. |
| Full source/test type checks and package build | Passed; final full type check took 4.057 seconds and full package build 2.308 seconds. Source-only declarations retain the tested payload. |
| Packed consumption | All 40 entries typecheck/load in clean npm and Bun consumers, 10.080 seconds. Existing upstream Yielded declarations produce 198 filtered diagnostics; none belongs to these packages. |
| Current isolated consumer | Reobserved `c47d62e7`; fresh archive install, preparation, format, type/lint/build and 941 tests passed; check took 35.005 seconds. |
| Consumer browser parity | Focused request controls 2/2 passed, 6.529 seconds; full seven-file suite 55/55 passed, 292.907 seconds. |
| Workers/CDP | Actual local workerd passed with and without nodejs_compat, using the consumer connector and the same archives: read/act, input, navigation, viewport, frame/screencast and a scripted Yielded turn. Both denied same-process and proved out-of-process iframe traffic; a foreign context reached HTTP. Only owned local fixture processes were stopped. |
| Dependency boundaries | Passed 27 adversarial fixtures and physical deletion/typecheck: 126 source, 91 package-test and one shared-test modules, 10.248 seconds. |
| Required source-size gate | Failed: 14,024 browser code lines against 12,000; no ceiling or counting-rule change. |

This evidence also includes 5,000 supervisor histories, 1,000 Stage feed histories, seeded
capture/lane/gate histories and failure-restoring mutations documented in the detailed ledgers.
Earlier failed runs remain recorded. In particular, the old packed consumer's 54/55 failure
exposed the remote-iframe ownership defect; it is not dismissed as an environment issue.
No hosted-browser or paid-model verification is claimed.

Before changes the same Oxlint rule measured exactly **12,000 browser code lines**. It excludes
blank/comment-only lines and includes declarations and published testing services. Current
measurements cover all four packages without path exclusions:

| Package | Source before → after | Tests before → after |
| --- | --- | --- |
| browser | 12,000 → 14,024 | 18,775 → 21,352 |
| browserbase | 1,781 → 1,795 | 2,595 → 2,366 |
| agent-browser | 876 → 1,385 | 806 → 1,200 |
| human-strokes | 227 → 227 | 214 → 222 |

The final pinned `bun run ready` exited **1** in **4.812 seconds**: formatting and lint passed,
then the unchanged source gate failed. Its later steps were each run independently as recorded
above; this is not a green aggregate gate.

**Pending-decision — not acceptance-complete:** the unchanged source gate is exceeded by
**2,024 code lines**. The inspected consolidations in [the size assessment](audit-size-assessment.md)
do not demonstrate recovery of that gap while retaining all required capabilities. No measured
size reduction or green `bun run ready` is claimed. The work remains a draft; the current
implementation is reviewable but cannot pass the repository's required gate.

Test-only follow-ups passed 162 affected native tests, six frame/input cases and all fourteen
serial opt-in latency cases (33.73 seconds). The reviewed timing inventory and retained limits
are documented in [the latency ledger](audit-latency.md). Import enforcement covers 27 adversarial
fixtures, package tests and the shared repository helper, with omitted-checker mutants failing.
The byte-identical CDP proxy moved out of the browser's private test tree: its 270 code lines
remain in `tools/testing/cdp-proxy.ts`, in addition to the package-test totals above. No runtime
source was moved outside its count. Package declarations now build source alone; a rebuilt
browser emitted no helper declaration and all 109 dist files matched the tested archive byte
for byte.

The package diff adds 7,197 and removes 4,467 physical source lines; it adds 14,642 and removes
11,765 physical test lines. The shared helper relocates 357 physical lines without deleting its
behavior. These Git diff counts differ from the code-only source gate above. Five preexisting
function-size exceptions were lowered (capture 256→253, perform 186→184, guard 389→357,
outline 170→168 and names 221→212); none was raised.
