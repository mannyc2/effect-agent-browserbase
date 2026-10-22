# Reading implementation evidence — 21 October 2026

Scope follows PLAN bugs 3, 4, 5, 10 and 12 and its reading minor findings. Bug 1
(`consequence`) is owned by the kernel implementation. Source inspection alone is
not browser-runtime reproduction.

Before implementation, the uncovered observable failures are:

- A guarded point action in a new document can allocate refs below refs already
  returned in an old document. An old ref must stay stale, and must never click a
  new control. Exercise through the shipped, rebundled consumer.
- Native controls in a disabled fieldset must report disabled in found state and
  snapshots, fail enabled waits, and refuse input; the first legend's controls
  remain enabled under the browser's native rule.
- Color and file controls must remain discoverable as controls while reporting no
  textbox role or text editability. Typing into either must fail before dispatch.
- Navigation during an expectation wait must preserve its initial deadline and
  return an unmet verdict, rather than spending a new window in every document.
  Repeated replacement and retry spacing need a controlled protocol failure seam.
- The shipped script must retain typing, select, point input, guarded input and
  change recording after the consumer's bundler transforms it. Existing Bundle
  acceptance covers only a subset, so extend that real boundary.
- Visibility must agree for individually queried roots and whole-document walks:
  visible descendants of zero-size, display:contents and visibility:hidden
  wrappers remain readable, while display:none, aria-hidden and zero opacity
  remain excluded.
- ARIA labels must prefer a valid aria-labelledby over aria-label. Structural
  implicit roles should answer explicit role queries without adding default
  outline scaffolding. Existing field-value disclosure remains explicit: snapshot
  controls show non-secret values; Page.text masks them unless unmask is requested.
- Installing changed script content must replace the existing install, stop old
  observers and retain its ref floor. The version must follow source content.

Public browser acceptance is the preferred proof. Small isolated checks are
reserved for forced navigation/context-loss races that are otherwise nondeterministic.

Results so far:

- Fixed 3, 4, 5, 10 and 12. `Find.test.ts` and `Bundle.test.ts` passed all 24 cases
  in 11.97 s with pinned Node 24.14.1 and Bun 1.4.2. The six bundle cases include
  Workers bundling, changed-source replacement and four esbuild/rolldown consumer
  transforms (keepNames, minification on/off). The consumer exercises the recorder,
  guard, typing, select, point input and refs after navigation.
- The fieldset regression first failed `disabled: false`; the color regression
  next failed `kind: textbox`; the ref regression next returned `clicked` for an
  old-document ref. Each failed through the published, rebundled Chromium path
  before its fix. The replacement-document wait failed `Timeout` at 270 ms before
  its fix, against a real HTTP page that reloads every 30 ms.
- Reading minor findings fixed: context retry spacing, visibility through
  nonpainting wrappers, source-derived page-script versions and old-install
  disposal for the new lifecycle, aria-labelledby precedence, and structural
  implicit roles when a role query asks for them. Structural roles do not add
  default outline scaffolding. `aim` is owned by the kernel/Plan change.
- Unified public `until` uses Find's matching, including selector/enabled-state
  filters. An unmet wait returns `met: false`; malformed CSS fails InvalidRequest.
  The duplicate `waitFor`/`waitUntil` implementation was deleted.
- Kept the documented field-value distinction: the model's control observation
  shows non-secret values so it can verify input and selected options; general
  prose extraction masks them unless the caller explicitly unmasks. Secret fields
  remain masked in both. This is an explicit capability distinction, not an
  accidental matching difference.
- Focused reading, bridge, packaging and test lint passes without suppressions or
  raised size limits. Native element helpers and element-state projection became
  named page factories so their composition is checked by TypeScript.

Mutation evidence is in `.work/evidence/reading-mutations/`. Restoring fieldset,
color-role, color-editability, ref-floor, constant-version, ARIA-label,
structural-role and visibility defects each failed its regression. Restoring the
original wait defect (both restarted windows and unlimited context retries)
failed the navigation regression. Restarting only its window survived because
the independent absolute retry cutoff still preserves the public deadline; this
is not the original defective behavior. Clean sources were restored after every
run.

Limitation: the previous version-20 page script never exposed its recorder stop
operation. Its already-installed opaque observers cannot be removed by the new
API; a consumer upgrading that live document must reload it. Subsequent hashed
installs expose disposal and stop their old observers before replacement.

## TestPage/TestBrowser contracts and decisions

T4 is a data simulator, not a DOM or JavaScript engine. It must be explicit about
its claimed behavior and fail unsupported scripts with a typed failure.

- Seeded elements must obey the public role/name/text/context matcher, disabled
  state and ref lifetime. An old ref cannot name a replacement document's element.
- Actions must enter the same FIFO lane, record typed action values and preserve
  dispatched failures. A held action must expose its admission and release;
  cancellation must free the lane and failFast must report Busy immediately.
- Waits use the captured clock, can observe later seeded state, and answer unmet
  at one deadline. A caller's other clock must not change their owner.
- Frames/events/changes are data supplied by the test. Capture readers receive
  those frames and stop with scope. Ownership rejects foreign pages, sessions and
  connections; earlier documents remain history, and never count as current evidence.
- Browser pages preserve registration order, lookup/close semantics, first-page
  identity and loss. Suspension blocks writes while reads continue.
- A shared contract scenario must run on local Chromium, local CDP and the
  simulator for every supported claim; deterministic TestClock cases cover held
  actions and deliberately seeded mid-story state.

T4 implemented through the public `effect-browser/testing` export. TestPage is a
full public Page; TestBrowser is a full public Browser.Service. They share the
production FIFO lane, input gate, event timeline, matching and change fold. The
private implementation modules have no importable package subpaths. Named input
methods and Plan replay now enter the same canonical typed Action path as native
pages, using the public ActionPort assembly functions. Action recording uses the
same value normalization and redaction.

- Six deterministic TestPage cases exercise mid-story seeding, monotone refs,
  admission/cancellation, explicit failure evidence, captured clocks, browser page
  order/suspension/loss, supplied frame streams and seeded change histories.
- One reusable Page/Browser scenario runs on seeded data, local Chromium and local
  CDP. It covers normalized matching, disabled refusal before dispatch, opaque
  comparison marks, typed action events, stale refs, idempotent close and ordered
  page lookup. It is evidence for these shared claims, not proof of a DOM engine.
- Unsupported scripts, CSS selection, cookies, layout/encoding controls, automatic
  change recording, after-input picture synthesis and native telemetry fail with
  InvalidRequest. Back/Select require an explicit queued result. Ready requires
  explicit seeded readiness. Actions do not infer DOM consequences; tests update
  the seed or replace the document deliberately.
- A wait releases its read admission while observing subsequent seeded state, as
  native Page.until does. A failFast click during the wait proves it does not
  monopolize the lane. A caller clock that defects on sleep proves the page uses
  the captured owner clock.
- Six current-snapshot mutants fail in isolated temporary copies: retained wait
  admission, caller clock use, capture subscription deferred until stream reading,
  old-document frame currentness, inconsistent event dispatch evidence and reset
  document refs. Logs and results are under
  `.work/evidence/testpage-mutations/`. No mutation touches the shared checkout.

Latest packaged reading/T4 batch: 34/34 tests passed in 13.89 s with the pinned
runtimes. It includes four real consumer rebundles, a Workers bundle, source-hash
replacement, Find acceptance and seeded/Chromium/CDP contracts. The rebundled
consumer imports the published testing entry too. Focused Plan/T4 batch: 53/53
passed in 26.73 s after typed Action migration. Neither result claims the full
repository gate.

Plan hard cutover: steps carry execution's Action variants, excluding script Act.
Deleted the string action vocabulary, duplicated input options and rendered event
parsing. Replay rebinds ephemeral refs from subjects, replaces caller input slots,
and dispatches through page.perform. Unknown consequential input still requires
positive durable read-back; malformed actions fail before dispatch. Bench callers
use Plan.take/restore, so Plan remains; its independent deadline bounds read-back
even if a port does not answer. A focused native regression proved that removing
normalization of focused typing's effective replace behavior loses the existing
prefix; the mutant fails and the clean source passes.

A further real-runtime failure was reproduced in content stillness: after two
commits, a new document with no mutation samples reported only 65.9 ms of quiet
against a 250 ms request. The history's begun timestamp now counts as activity.
The existing repeated-commit regression fails before that one-line change and
passes afterward, including its original overall timeout. Evidence is in
`.work/evidence/history-document-quiet-{before,after}.log`.

Seeded elements now carry the public Subject and ElementState records instead of
a second flat role/name/context/state vocabulary. Native and seeded queries use
the same serializable Matching.request normalization. The focused seeded/real
contract and Plan-step batch passes 27/27 in 2.59 s after this consolidation.
Capture acquisition begins bounded retention immediately, even if its stream is
consumed later; the deterministic contract plants a frame in that interval.

## Stage feed lifecycle

The three-state feed has one pure transition writer (Warming, Ready, Stopped).
One thousand seeded histories compare it with prefix facts: retirement is
terminal, Reset never rewinds a warmed feed, and the latest paint belongs after
the last Reset. The runtime scenario uses full seeded Pages and bounded captures.

An active feed previously published a late frame from an older document; the new
runtime regression failed before the change. Acceptance now checks the public
page/connection/document state before publication. It deliberately preserves
queued frames from the same document, even if capture.current has since advanced,
and rejects frames from a retired feed after switching pages. The consumer still
owns delay, repeated-frame and redaction choices.

Stage model/failure/cue/native tests pass 26/26 in 10.59 s. Four current-snapshot
mutants fail assertions in isolated temporary copies: retirement no longer
absorbs input, Reset returns to Warming, old-document acceptance, and dropping
queued same-document paint merely because a later capture exists. Evidence is in
`.work/evidence/stage-feed-mutations/`; no mutant touches shared source.

Plan wire format is now version 3 for all typed-Action steps. Versions 1/2 carried
string actions and are rejected; their expectation-dependent version branch was
removed. No persisted-plan compatibility caller was found. README, composition
notes, public module documentation and schema tests state the hard cutover.

The dependency gate parses TypeScript syntax, including bare side-effect imports,
dynamic imports and import-equals declarations. A sibling feature or workspace
package module is public only when its package actually exports it. Runtime
imports must name declared runtime dependencies; relative paths cannot leave their
package. The browser admits only Effect/Playwright dependencies and restricts Node
builtins to its Node providers. The latest check covers all 126 source modules
across the four libraries.

Ten isolated fixtures cover private imports, unpublished sibling modules,
computed dependencies, cross-package relative paths, undeclared or forbidden
dependencies, alternate JavaScript/TypeScript module extensions, and Node code
in the portable kernel. Eight isolated checker mutants each fail their regression
assertions. The ordinary boundaries command
runs these fixtures, then physically deletes all features/providers and
typechecks the kernel. Evidence: `.work/evidence/boundaries-workspace-current.log`
and `.work/evidence/boundary-mutations/results-current.json`.

Positive wait bounds also reject negative, NaN and infinite milliseconds with
InvalidRequest before dispatch. A negative wait previously returned successful
unmet evidence. Restoring the missing guard fails the new native regression;
current type-replace normalization and wait-bound mutants both fail in isolated
copies (`.work/evidence/plan-action-mutations/results-current.json`).

Native and seeded captures now share `Frame.sameCapture`: copied images preserve
currency only with the same page/session/connection/document and capture
generation/sequence. Untagged pictures require object identity. Native capture
still checks its active generation and current transport document; seeded capture
still checks current document ownership. The new common contract failed against
the old simulator object-identity check. Page/TestPage/Stage/Capture contracts
pass 20/20 in 3.57 s, and restoring that old check fails in an isolated copy
(`.work/evidence/frame-lineage-final.log`,
`.work/evidence/frame-lineage-mutations/results-current.json`).

Current README examples use the provider subpath and Plan v3. Removed Expect
examples now use public observation/Plan contracts; document readiness, content
stillness, policy admission order, recorder expiry, frame currency and the
250 ms abandoned-read retention describe the implemented contracts.

The common Page contract also checks an explicit checked checkbox in snapshots.
The old seeded projection returned no checked state; its new assertion failed.
Projection now retains ElementState.checked. All ten seeded/Chromium/CDP Page and
Browser contract tests pass in 1.15 s, and an isolated omission mutant fails
(`.work/evidence/seeded-checked-{before,after}.log`,
`.work/evidence/seeded-checked-mutations/results-current.json`). The latest browser
package typecheck exits 0 (`.work/evidence/reading-current-check7.log`).

## Source-size assessment

Using the gate's exact oxlint max-lines counting rule (skip blank/comment lines),
the reviewed 4732225 source measured exactly 12,000 code lines. A current working
snapshot measured 13,805: public/kernel source 10,249, features/providers/seeded
services 3,540, and Workers entrypoints 16. These are measurements, not a passing
size gate; concurrent implementation can change the final count. Evidence is
`.work/evidence/source-count-{baseline,current}.json`.

Canonical ActionPort execution, Matching requests, Subject/ElementState seeds,
Plan v3 and Frame.sameCapture remove peer representations. A remaining concrete
candidate is native Perform.Call: its name/target/text/secret/input metadata
duplicates decoded Action. Replacing it with one projection would likely save
50–80 code lines after unavoidable rendering logic, with redaction/recording risk.
That candidate does not close the 1,805-line gap. The inspected lane/native-reply
ownership, capture/read lifetimes, supervisor releases and DOM-versus-seeded
projection paths preserve distinct required semantics; no evidence supports
deleting them or forecasting a 1,700-line behavior-preserving consolidation.
The unchanged size ceiling therefore remains unresolved by this work; no source
was excluded or relocated to claim compliance.

## Final boundary and first-page follow-up

Fixed: the dependency scanner now recognizes TypeScript import-type expressions.
Workers provider facades inherit the ownership of their public provider entry;
the Workers kernel root and its ordinary dependencies receive kernel restrictions.
Feature-deletion checks retain and typecheck every conditional kernel root,
including the Workers root. Fifteen adversarial fixtures and the 127-module scan
pass. Omitting import-type scanning, restoring the blanket Workers exemption, or
omitting the Workers deletion typecheck makes the corresponding fixture fail;
all three planted omissions were restored afterward.

Fixed: TestBrowser.firstPage now shares one allocation permit per browser, as the
native browser does. The common Browser contract runs twelve simultaneous initial
reads with Effect's operation budget set to 32 so normal cooperative interleaving
occurs. The original seeded implementation created twelve pages; the corrected
seeded, Chromium and CDP Page/Browser contracts pass all ten tests in 1.20 s.
Removing allocation exclusion reproduces the twelve-page failure, and the clean
implementation was restored. This check preserves the browser-owned scope, lane,
gate and timeline of every page.

The conditional-entry deletion check now resolves the package export map instead
of requiring a separate Workers root facade. Its adversarial copy introduces a
distinct conditional entry to preserve the Workers regressions if one is added
again. All fifteen fixtures and the resulting 126-module scan pass.

Fixed test failure propagation: Admission's cross-page typing regression now races
its first-key event wait against the typing fiber. A refusal before any key used
to leave an unbounded event poll after the typing fiber ended. A planted invalid
target now reports its typed InvalidRequest in 112 ms; the planted input was
restored. The clean focused case passed twice, and all eighteen Admission tests
passed in 18.57 s. The reported full-suite timeout was not reproduced; no
production behavior or test timeout was changed.

Confirmed test-input cause: planning fifty-eight repeated `x` keys through the
default 70-wpm performed style refused seventy-eight of 256 seeds before input
(seeds 0, 5 and 6 already fail); accepted schedules ranged from 8,990.52 to
9,995.79 ms. That legitimate plan-budget refusal could leave the old first-key
poll waiting forever. The concurrency regression now uses the public Style
service with a fixed, shown schedule spanning 9,420 ms. Its original click bound
and assertion that typing remains in progress are unchanged. The focused native
case passes in 1.10 s, including interruption of the remaining typing schedule.

Fixed Stage test scheduling: the native cut/input-drain regression now creates its
browser with an owning TestClock and explicitly advances its 30/30/50-ms waits.
Its two-second action/first-frame limits are unchanged; native navigation, frames
and held protocol replies still determine progress. The focused case passes in
1.09 s, and all twelve Stage failure tests pass in 2.17 s. Bypassing the old page's
public afterInput ownership makes the original exclusion assertion fail (two key
submissions instead of one); the bypass was restored. No production source was
changed. The parallel run's timeout was not reproduced in the focused live-clock
case, which passed in 1.06 s.

## Reviewed timing migration

The final test-only timing pass replaces the earlier Admission click envelope
with a stronger held-receipt exclusion check and owning TestClock. All seventeen
real wall-clock sites from the report's eighteen-location list now use causal or
virtual evidence in normal tests, or retain the machine envelope in an explicit
local latency suite. ContextLease's listed location was already virtual in the
reviewed commit. [The per-site inventory](audit-latency.md) records both the
replacement evidence and the remaining noninventory timing checks.

After these changes, Admission, Page, Policy, Cdp, Budget, Find and Ready pass all
162 tests in 39.09 s. The initial eight optional core latency cases pass in
7.34 s; their config selects only `*.latency.ts`, runs files serially and is
excluded from `ready`. Browser source, tests and config typecheck; strict targeted
lint passes. No production source, published package manifest, ordinary timeout,
retry count or correctness assertion was weakened.
