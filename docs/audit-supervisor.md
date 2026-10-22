# Supervisor audit implementation — 21 October 2026

This ledger preserves the initial audit implementation and its historical evidence through
`1d6d7c7`. Subsequent Claude findings, changed request/registration contracts and current
acceptance are recorded in [the follow-through ledger](CLAUDE-FOLLOWTHROUGH.md).

## Scope and decisions

Recover the existing prototype selectively. Ship the generic core alone (PLAN decision 20); no keep, grace, admission, meter, or timed-rotation extensions have a non-test caller that requires them. Browserbase owns provider cleanup evidence in `OpenFailed`; the core neither caches nor folds provider outcomes across tries. Every started try finishes before retirement completes (decision 34).

## Failure inventory and verification

The user explicitly requires regression and model tests for all confirmed correctness changes. Existing recovered public-boundary regressions precede implementation integration here. Their provenance is the audited retirement and outcome defects (#13–16), recovered from the prior implementation session. They are historical tests, not newly claimed test-first work.

- An interrupted retirement waiter or retirement inside `use` must leave the owned stop running and publish final Closed evidence before states ends.
- A failed acquisition must retain its own typed error and cleanup evidence even if a retry succeeds; later successful generations cannot inherit earlier uncertainty.
- Provider release defects and generation-scope close defects must both yield Unconfirmed; absent release hooks yield Settled after successful scope close.
- Loss/rotation interrupts work; provider release waits for its scoped cleanup. Exclusive acquisition waits for all earlier releases, including failed cleanup. Stale loss/rotation cannot revoke another generation.
- Admission uses one deadline on the owner clock and cannot cancel the shared opening. The work itself is outside that deadline.
- Opening after retirement is released once. Retry sleeps are interrupted by retirement.
- The pure model independently checks ordering, one release, holds, exclusivity, stale declarations, and remembered in-flight acquisition over 5,000 generated histories.

Browserbase direct open/attach/cancellation/async cleanup coverage remains in Browserbase.test.ts and Connector.test.ts; supervisor-specific replacements are reviewed separately from the deleted extension matrices.

## Results

Current pinned-toolchain checks, after formatting and lint fixes:

- Browser supervisor model/runtime: 14 tests passed, 721 ms; 5,000 generated histories.
- Whole Browserbase package: 68 tests passed across 9 files, 52.72 s. This includes real local Chromium provider/connect/cancellation checks, the existing API contract and new T2 checks.
- Bench composition and H2 native: 7 tests passed, 21.16 s. The native proof uses the fake API and local Chromium; it proves ownership/order, not hosted persistence or billing.
- Watched FIFO boundary: 1 test passed, 314 ms after adapting its capture port to the public kernel.
- Owned-file formatting and Oxlint passed. Full repository ready remains the root integration gate.

Current mutations all exited 1 with observable assertion failures (timeouts are used only to expose abandoned waits): #13 retirement performed on its caller; #14 omitted failed-try event; #15 sticky first Unconfirmed; #16 ignored scope-close defect. The forgotten-opening lifecycle mutant fails the independent model. T2 pending-as-ended and pending-not-listed mutants both fail the seeded pending-writer regression. Clean files were restored after every mutation. Logs are retained locally under `.work/evidence/supervisor/`.

T2 now seeds contexts and session states through Schema data, including PENDING and delayed RUNNING. `waitUntil` observes request/state notifications and the next owned-clock transition; it sends no requests and does no periodic polling. New ids skip seeded identities. Its two public-boundary tests plus the existing Browserbase contract passed (9 tests, 646 ms).

The five legacy supervisor test files were replaced by one independent lifecycle model and one runtime suite. Coverage tied to deleted extensions (admission, retention/grace, keep and timed rotation) was removed with those APIs. Cancellation, provider finalization, typed failures, stale declarations, owner-clock admission and work cleanup failures remain covered. Browserbase's direct async cleanup tests before its former supervise section were preserved; the section itself now exercises generations/build/policy composition. The existing Clock.test generation/frame correlation scenario also migrated to the generic core.

Public additions: generic `Supervisor<A,E>`, `Opened<A>`, independent `Released` outcomes and `Browserbase.generations`/`OpenFailed`. Removed supervisor APIs are listed above and in PLAN section 4. No paid or hosted call was made.


## Adapter and evidence testing (T1, T5–T7)

`effect-agent-browser/testing` now exposes one prompt-aware finite TestModel, serializable finished
adapter seeds, normalized HTTP cassettes and suspended-port stories. The five bench scripted-model
copies use the public model kit. Tab following and moment placement are pure transformations;
seeded refs remain unique, pictures stay bounded, and JSON continuation restores frame bytes.
Model scripts retain per-layer requests and tool-schema fingerprints and reject exhaustion and
unused turns. HTTP cassette identity rejects changed tool schemas; TestModel records fingerprints
for scenario assertions and does not enforce an expected schema on its own. Story end checks reject active ports, unused replies, unexpected calls and unasserted
error logs; an actual Yielded run suspends at a public TestPage port and resumes on its owning clock.

The agent package's final seven-file suite passed 33 tests in 9.07 s after public raw access removal, including picture-byte seed restoration; its typecheck exited 0. Ten original model,
seed, story and HTTP mutants failed and were restored (`.work/evidence/agent/`).

Bench recordings now preserve complete schema-encoded moments, provider request/response payloads,
HTTP codec exchanges and the exact raw fixture truth used by grading. `bench regrade` reuses current
graders without a model or browser, refusing a changed task prompt. Provider receipt accounting
settles before recording its semantic response. HTTP record/live paths retain exact opt-in and a
finite reservation cap; replay has no upstream client and refuses changed request/tool fingerprints.
The real installed OpenRouter codec passes a fake-upstream record/replay scenario; no paid call
was made. This is codec replay evidence, not proof that live screenshot timing is deterministic.
Final Recorder, codec and budget checks passed 18 tests in 30.62 s; bench typecheck exited 0. Three additional mutants (omitted full moment, omitted raw grader truth, omitted provider payload) each fail and are restored. The regrade test also rejects a validly shaped wrong answer and changed task instructions.

## Public request controls and bench migration

Bench fixtures now install scoped public request policies before opening pages. Fulfilled responses
preserve Unicode, content type, optional headers (including CORS), status and body; malformed or
oversized responses are refused. Decisions, installation, response commands, overflow replies and
detachment use bounded owned-clock effects. A full queue has a finite refusal window and loses its
connection if saturated; a stalled native command does the same. Late session acquisition detaches
a session obtained after interruption. All raw bench access moved to public read/act or fixture-owned
native handles. Five focused fixture/grading/composition/budget/handover files passed 45 tests in
50.20 s. Fulfillment/stalled-setup/overflow tests passed 3 tests in 888 ms. Empty-body, native-setup
bound and overflow-window mutants fail (`.work/evidence/request-*-mutant.log`); files were restored.

## Isolated consumer and Workers evidence

The isolated consumer is `.work/consumer-check`, observed at source `c47d62e7`; the real dirty consumer
checkout was never edited. Initial packed candidate checks passed its complete check command
(format, type/lint, 941 unit tests in 58 files, frontend build) and all 55 scripted local Chromium tests.
Evidence is `.work/evidence/consumer-check-final.log` and `consumer-scripted-final.log`. Its browser
source has no Stage or Plan caller, so its compatibility evidence cannot justify deleting those
features needed by other repository callers. A reviewable source patch is retained privately under
`.work/evidence/consumer-migration.patch`.

Actual local workerd used the packed default conditional entry and the consumer's Workers CDP
connector against local Chromium. It exercised request refusal, typed click/type, schema read/act,
viewport, screenshot and streamed capture, new-document navigation and an actual Yielded observe
turn. It passed both with and without `nodejs_compat`: the browser requires the workerd conditional
entry and a runtime-compatible CDP connector, not the Node compatibility flag itself. Evidence:
`consumer-workers-result.json` and `consumer-workers-no-nodejs-result.json`. The capture proof
found and fixed a real named-event portability mismatch before raw public access was removed.
Final candidate repacking is coordinated with the root integration gate; these initial results
must not be mislabeled as proof of later untested edits. No hosted Browserbase or paid model ran.


## Final owned status ledger

| Item | Result | Current evidence |
| --- | --- | --- |
| Supervisor #13–16 | fixed | 5,000 model histories, runtime regressions and four original defect mutants |
| Unused supervisor extensions | rejected with evidence | no evidenced caller needs grace/admission/keep/meter/timed rotation; Watched composes through the generic lease |
| T2 Browserbase starting/PENDING states | fixed | seeded data, notification/owned-clock waiting, contract tests and two PENDING mutants |
| T1 prompt-aware TestModel | fixed | shared public fixture, per-layer state, schema fingerprints, exhaustion/end checks and mutants |
| T5 finished continuation | fixed | pure tab/context transformations, seeded refs, bounded pictures and full JSON frame-byte regression/mutant |
| T6 HTTP and recordings | fixed | real provider codec over fake HTTP record/replay; complete payloads/moments/truth; offline current-task regrade; opt-in/reservation mutants |
| T7 suspended stories | fixed | actual Yielded model/page suspension, deterministic release order and required log/end assertions |
| Native request controls | fixed | three local Chromium bounds/fulfillment regressions, planted bounds/body defects and the owned CDP fault seam |
| Watched FIFO reveal fixture | fixed | public TestPage/TestBrowser now supply document/connection/clock; held custom stream retains deterministic release ordering, 1 test passed in 595 ms |
| Mandatory nodejs_compat assumption | rejected with evidence | actual packed Workers/CDP/capture/agent scenario passes with no compatibility flags |

The latest candidate check at source fingerprint `3b71e04a5ff2bce9c158987250b60649d0b7554fa5c98f4b52e41285f1f14daa`
passed the isolated consumer's full check again (941 unit tests plus format/type/lint/build), and
both Workers probes passed after the owned browser-session fault-seam migration. SHA-named
artifacts and every source-file digest are in `.work/evidence/candidate-final-manifest.json`.
The full scripted run against that candidate passed 54/55; the Guard integration timed out under the full run, then its focused rerun passed in 0.98 seconds. Both outcomes remain recorded. Later capture, policy-secret and request-ownership changes require the coordinated final repack below.

Owned code counts use the gate's exact Oxlint rule (blank/comment-only lines excluded), separately
from test counts: supervisor 642 code lines; agent source 1,385 and tests 1,200; Browserbase source
1,780 and tests 2,341; bench source 7,356 and tests 4,038. Measurements are saved in
`.work/evidence/owned-size-final.json`; none reclassifies shipped test-kit source to bypass the
browser's 12,000-line gate. That aggregate gate failed at the time; the authorized follow-through removes it.


## Final request ownership review

The independent native review reproduced a privacy/correctness defect: browser-level Fetch let the
owned policy fulfill a sibling context's request. The new regression fails on the old source and
when ownership is bypassed. Interception now proves the paused frame's browser context before
calling a policy, including the bounded overflow path. Main pages and workers carry target IDs;
same-process child frames use bounded public CDP frame-tree queries. Unknown ownership fails and
loses authority; it never guesses or exposes that request to a policy. Two simultaneous policies
are tested in both installation orders with a delayed owner, with owned denial and fulfillment
and a later foreign context's native response preserved. Popup first requests, nested frames,
worker egress and each redirect hop run in local Chromium.

Two alternatives were rejected with native evidence: `context.route` skips redirect destinations,
and browser autoattach plus a nonflattened manual session hangs when setup is delayed. Neither is
shipped. Independent browser-level Fetch sessions retain each owner's denial and fulfillment when
a foreign controller continues the same request. This global routing mechanism has a finite queue
and worker budget: pressure or unprovable ownership ends authority. Detaching alone releases paused
traffic, so orderly retirement classifies and settles tracked pauses before detachment; uncertain
or untracked ownership closes only the owned context's targets, repeatedly checking for remaining
targets within the cleanup deadline. The request listener stays active through that drain. Native
regressions cover both pages and service workers with held decisions and held ownership queries,
while a sibling context and external browser survive. Known-owned cleanup preserves the borrowed
page. Cleanup failure remains an observable finalizer defect, and the scoped CDP session always
detaches. Browserbase still attempts remote release after such local failure and retains
`Unconfirmed` evidence. This is scoped request control: physical CDP loss removes interception and
cannot provide a network firewall for an external browser after the connection ends.

Request refusals redact URLs in consumer reason text and cap that text at 2,000 characters. Native
echo-URL regression and redaction omission mutant prove this. Request-policy timeout/failure now
remains a typed failure after refusal; worker and overflow failures lose authority. Three native
regressions require no server hit, a safe refusal event and observable browser loss. The historical
failure-to-Refused mutant fails all three. Ordinary explicit `Refused` is still a domain decision.
The owned combined suite passed 26 tests in 2.79 seconds; workspace type checks passed after these
changes. Logs: `requests-owner-final.log`, `request-context-ownership-{before,mutant}.log`,
`request-refusal-redaction-{clean,mutant}.log`, and `request-policy-failure-mutant.log` under
`.work/evidence/`.

The generic supervisor now returns typed `InvalidWait` for negative/infinite public admission
budgets. Both regressions fail with the recovered RangeError defect restored, and the clean
runtime passes. The public export and Watched failure type include this error; no extension or
new resource policy was added.


Preexisting dedicated, shared and service workers bypass a newly enabled browser Fetch interceptor
in actual Chromium. Installation therefore refuses those contexts with typed `InvalidRequest`;
it never restarts or silently ignores their workers. The worker check runs after enabling Fetch,
closing the worker-created-during-install race. New workers remain covered. All three native worker
types and the deterministic setup race have regressions; omitted-check and early-check mutants fail.
Native probe evidence is `request-existing-workers-probe.log` under `.work/evidence/`.

Request-body evidence now requires every protocol byte entry, valid Base64, fatal UTF-8 decoding
and exact agreement with the protocol text. Missing text/entries/entry bytes, invalid UTF-8 or
mismatched text fails typed `InvalidRequest` before policy evaluation, refuses the request and ends
authority. Native UTF-8 text and multipart text/file bodies remain supported. Refusal events for
child frames identify the containing public page; worker events omit that page identity.

Final owned request validation passed 29 tests in six files in 7.47 seconds, with browser and
Browserbase type checks and owned lint clean. The provider cleanup/release suite passed six tests
in two files in 819 ms. Evidence: `requests-final-clean.log`, `requests-final-check.log`,
`requests-final-lint.log` and `provider-cleanup-final.log` under `.work/evidence/`.

Mutation evidence is explicit: removing orderly retirement leaks each paused page/worker request;
omitting the existing-worker check fails all worker cases; moving it before Fetch enable fails the
installation-race case; folding cleanup failure into success fails the observable-failure case.
These four logs are retained under `.work/recovery/request-*-mutant.log`. Restoring `postData ?? null`
fails five body regressions, restoring raw iframe identity fails the containing-page regression,
and skipping provider end after local failure fails its attempted-end counter. Their logs are
`request-body-evidence-mutant.log`, `request-iframe-page-mutant.log` and
`provider-skip-end-mutant.log` under `.work/evidence/`. Every mutant was restored before the final
clean run. Bootstrap session creation now uses the same owned CDP fault seam, with a native
context-discovery failure regression and temporary-page cleanup. Unknown ownership failure is
recorded immediately, so retirement does not replay a failed ownership query on another deadline.

The unused `Released.Kept` variant was removed with its stale bench annotation and documentation:
there is no surviving producer or consumer after the keep extension was removed. The canonical
release union is `Settled | Unconfirmed`; the unrelated TestBrowserbase session-row type is retained.

A native enable-before-creation probe also verifies new dedicated, shared and service worker egress:
all three requests were intercepted and refused, with no blocked HTTP request reaching the server
(`.work/evidence/request-new-workers-probe.json`). Cleanup-failure wording is explicit: finalizer
failure remains observable, but the required scoped-session detachment can release unresolved
traffic when cleanup could not complete. Ordinary scoped request control cannot promise otherwise.

The full suite exposed a local relay-fixture mismatch: raw-spawned Chromium started two extension
service workers before the request policy. The benchmark launcher now uses Playwright's extension
disabling flags, preserving a clean benchmark browser rather than bypassing the capability refusal.
The relay suite passes 3/3 in 1.95 seconds; removing those flags reproduces its failure. Native
before/after target probes retain only target types and URL schemes. Evidence is
`hosted-relay-workers-{red,clean,mutant}.log` and `latency-workers-{clean-}probe.json` under
`.work/evidence/`. Production provider contexts with preexisting workers still receive the same
typed capability refusal.

The Handover benchmark now races its entry rendezvous against the child lease outcome. A rejected
first generation propagates immediately instead of leaving the benchmark waiting for entry. The
new deterministic fake-provider regression fails with the original wait restored. All six handover
unit tests pass in 1.09 seconds, with bench type check and owned lint clean. The native handover
scenario also passed in 21.18 seconds after the extension-fixture correction. Evidence is
`handover-rendezvous-{red,mutant,clean,check,lint}.log` and `handover-final-focus.log` under
`.work/evidence/`. The mutant is restored.

Final immutable package acceptance uses source fingerprint
`0ae7a5dd13ac2a91790a14e860b06ef9c1f51d92d6e7d0c5de892b5c8147ef55`, with
four SHA-named archives and archive digests in `.work/evidence/candidate-final-manifest.json`. The
isolated consumer baseline is `c47d62e7ac69f6d4aa047d1a82a5ab0b3b8944a6` at
`.work/consumer-check`; its full check passes, including 941 tests, in 32.646 seconds. The consumer
source migration is reviewable in `.work/evidence/consumer-source-migration.patch`; the actual
consumer checkout is untouched. Local Workers acceptance passes with and without `nodejs_compat`,
using the packed candidate and actual consumer CDP connector. Both runs prove typed input, read/act,
request denial, same-process iframe ownership through nested CDP, a foreign context's unchanged
response, an 800×600 image, one screencast frame, navigation and a real Yielded scripted agent turn.
The HTTP fixture received only frame-host and foreign-context paths; neither denied path arrived.
Results and source binding are in `.work/evidence/consumer-workers-acceptance.json`, with per-mode
response/log files and `consumer-workers-native-acceptance.log`. These local services are stopped.
That candidate's full consumer browser suite completed with 54 passes and one 60-second guard
timeout; it is not complete parity evidence. The failed run is preserved in
`consumer-scripted-acceptance-0ae7a5dd13ac2a91.log`.

The consumer timeout reproduced in its cross-site iframe phase. A native `--site-per-process`
regression confirmed that excluding iframe targets from direct browser-context ownership discarded
valid evidence and lost authority while the frame waited. Direct iframe target evidence now proves
context membership; it leaves the optional containing-page identity absent. Same-process frame
queries still provide the containing page when established. The regression proves an actual
`iframe` target, correct refusal, no denied HTTP request and continuing authority. Its omission
mutant fails the authority assertion and is restored. The combined request suite passes 30 tests
in six files in 7.52 seconds (`requests-oopif-final.log`), with `request-oopif-{red,mutant,clean}.log`
preserving the focused evidence. A new packed candidate and complete consumer run are required
before claiming parity.

The rebuilt candidate now has source fingerprint
`29e01f309f38dee998fe206f73fea45dce148c8b83fc25248aa5ff51593df126`, including the
OOPIF ownership and recorder observation-clock fixes. Its browser archive is
`effect-browser-c2f3940234c1.tgz`; the manifest retains full hashes for all four archives. The isolated
consumer's full check passes all 941 tests in 35.005 seconds and its two focused request-guard
scenarios pass in 6.529 seconds. Final Workers checks pass with and without `nodejs_compat`, now
including an actual native `iframe` target and a cross-site child reporting denied egress. The
same-process frame query and foreign-context behavior also pass, alongside typed input, capture,
navigation and the Yielded agent turn. The native server received only frame-host, frame-remote and
foreign-context paths; no denied path arrived. Current source and all archive hashes were verified
afterward. These services are stopped. The complete consumer browser suite passes all 55 tests
in seven files with exit 0 in 292.907 seconds. `.work/evidence/consumer-acceptance.json` records
every command, exit status and timing for this fingerprint; immutable copies use the
`-29e01f309f38dee9` suffix. The earlier failed candidate remains preserved separately.

PLAN §7.4's published supervisor stand-in is rejected with evidence after the generic cutover. At
the reviewed source, five supervisor test files cast two-field literals to `Browser.Service`, with
a sixth copy in the watched bench test. None of those casts survives in the current packages or
bench. The pure supervisor model uses numbers and strings; runtime tests use typed `Opened` values
with Deferred-controlled opening, loss and release, plus explicit lifetime counters. Watched uses
the public `TestBrowser`. There is no current caller requiring a published wrapper around these
already typed generic resource ports, so no unused testing API is added.
