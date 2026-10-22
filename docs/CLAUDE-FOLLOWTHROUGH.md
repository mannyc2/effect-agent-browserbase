# Claude review follow-through

The requested Claude review examined PR #308 at
`1d6d7c735c55cc8d96ca2a06fe54dbd0032be187`. The implementation below was developed in a
separate worktree while that source remained frozen. Findings were checked against source and
public runtime behavior before edits. Local regressions fail on the original behavior; planted
restorations of the defects fail after the fix. The review's proposed changes are not accepted
merely because its probes or the existing suite pass.

## Accepted changes

| Area | Failure and resulting behavior | Regression evidence |
| --- | --- | --- |
| R1 — Existing-target request policy | Documents committed before policy installation could bypass interception; existing workers were rejected. Existing owned page, iframe and service-worker targets are refreshed under browser-level Fetch; existing shared workers remain explicitly unsupported. | Native preexisting page/OOPIF/nested-frame and worker POST regressions require no server hit. |
| R2, R9 — Request retirement | Closing targets and detaching could release paused POSTs and close borrowed pages. Retirement now cuts new pauses with empty Fetch patterns, drains one held-request ledger, and detaches without closing targets. Owned decisions recheck authority at native dispatch, so a late Allow/Fulfill becomes refusal after loss or retirement. | Native timeout/loss, held decisions and retirement regressions retain borrowed pages and prove no blocked POST reaches HTTP. |
| R5–R7 — Request lifetime and ownership | Canceled replies, ordinary bursts and same-site frames inside OOPIFs could revoke authority. Canceled interception IDs settle; eight workers drain every recorded pause; bounded cached ownership includes iframe trees and re-proves unstable parent attribution. | Native abort/navigation/close, 150-owned/150-foreign bursts and nested-frame cases. |
| R8 — Binary request bodies | Non-UTF-8 body evidence revoked the whole connection. That request is refused without giving the policy partial/garbled text or losing the browser. | Native body cases preserve authority after refusal. |
| R23, R34 (request half) — Private failure diagnostics | Policy failures retained only a generic disconnect and cleanup timeout evidence used the wrong bound. Refusal events now preserve a structured failure tag and applied timeout without exposing arbitrary error text or request bodies. | Event-level failure/timeout/privacy assertions and request cleanup tests. |
| R10 — Script reads/acts | A document replacement was sanitized into a script exception before retry could recognize it. Reads now wait for the bridge's next main-document commit and retry once within the original deadline. Acts retain sent evidence and report a replaced context as NotActionable. | Native `Scripts.test.ts` uses an explicit entry signal and a real navigation. |
| R12 — Clock mapping | A cached estimate waited behind another page's renewal. Readers use the existing estimate while renewal remains serialized. | `Calibration.test.ts`; native Clock/Input suites. |
| R11 — Recorder expiry (narrowed) | Idle cleanup could lose navigation-lane admission and permanently poison subsequent reads with Busy. Admission now waits in the recorder scope; actual native cleanup retains its bound and failure evidence. | Native `Change.lifetime.test.ts`, including a cleanup-error mutant. |
| R25–R26 — Supervisor ownership | Parallel caller finalizers could close workers before retirement/release; captured constructor spans also overwrote live generation parents. One ordered finalizer owns retirement and worker-scope closure, and later spans retain the constructor only as a link. | `Supervisor.runtime.test.ts` and the existing lifecycle model. |
| R27 — Supervisor causes | A typed acquisition failure discarded a sibling defect and was retried. Complete causes now reach Effect's retry rule and terminal diagnostics. | Mixed acquisition/cleanup cause regressions; six focused supervisor mutants. |
| R28 — Browserbase build resources | Build finalizers ran after the hosted connection had been released. Their child scope now closes before provider release, and cleanup defects remain Unconfirmed. | `Browserbase.test.ts`, including native-browser availability during build cleanup. |
| R19–R20, R29 — Seeded pages (Back proposal rejected) | Refused input consumed scripted outcomes; false dispatch logs, missing refusal events and untyped capture closure misrepresented production behavior. Outcomes are consumed at dispatch, event/dispatch evidence is derived from the actual result, capture terminals are typed, and focus refuses after disconnect. | Twelve `TestPage.contract.test.ts` cases and five focused mutants. |
| R31 — HTTP cassette | Recording/replaying 204, 205 or 304 constructed an invalid Fetch Response body. One response constructor handles null-body statuses for both paths. | `HttpCassette.test.ts` records and replays all three statuses. |
| R4, R17 — Plan | Target resolution could await an earlier redirect, then wrongly credit that navigation to the current step. The baseline is captured after resolution, immediately before perform. Public locate retries use the page clock. | Native `Plan.navigation.test.ts` and suspended-caller-clock `Plan.steps.test.ts`. |
| R15 — Repeated press | Malformed gaps were checked after a key had already been sent, and total pacing was unbounded. Gaps are drawn and validated before focus/input; the complete sequence is bounded before dispatch. | Native `Press.budget.test.ts` asserts no keydown and undispatched InvalidRequest. |
| R18 — Policy configuration | Invalid thresholds could allow secret input. The existing probability schema now validates the threshold in (0, 1] before judging consequential input. | `Judge.test.ts` covers invalid values and the valid upper endpoint. |
| R13 — Presentation | Waiting for the shared hand was uninterruptible. The semaphore owns acquisition/release; a Deferred marks admission so its wait budget cannot time out already-admitted input. | Native cancellation and admitted-input regressions in `Input.regressions.test.ts`. |
| R16 — Stage | Same-page present bypassed serialized commits and the page clock. It now enters the existing FIFO and shares the public entry's chosen clock. | `Stage.model.test.ts` and `Stage.clock.test.ts`. |
| R14, R24, R33 — Stillness | Capture failures were discarded, invalid quiet/timeout options were accepted, and foreground masking could use an old document's animation history. Capture and observation share a first-completion race; options are validated; masking uses current document identity. | Native/model `Ready.test.ts`, including withheld new-document paint and real animation. |
| R21, R34 — Browser-local failures | Cookie deadlines reported Failed, and dialog-answer failure revoked sibling pages. Cookie errors now report Timeout with the applied bound. An unanswered dialog publishes failed and closes only its affected page. | Native `Browser.cookies.test.ts` and dialog regression in `Browser.test.ts`. |
| R22 — Page registration | A burst beyond 40 pending registrations revoked browser authority. One Deferred result per native page and browser-owned fibers behind eight permits replace the overflow queue and per-page locks. Canceled callers do not poison shared registration; page closure evicts its completed cell so retained native handles do not retain frames. | Native `Browser.test.ts`, `Browser.registration.test.ts`, closed-page frame retention and Budget coverage. |
| R32 — Action diagnostics | Decode failures hid the action and malformed field behind a generic perform error. The canonical tag selects the operation; structural Schema issues supply curated field/type guidance without rejected values or secret text. | `ActionPort.test.ts`, including malicious payloads and original-decoder/privacy mutants. |
| R36 — Page-script packaging | The build transformer still matched the old private URL module path. It now matches the canonical `/Url.ts` module used by the bridge. | Required build and packed-consumer runtime checks. |
| R35 — Fault-seam identity | A browser-session ownership query inherited the queried target's page label, accidentally selecting page-specific fault rules. Only page sessions acquire that label. | `TestCdp.test.ts`. |

Focused regression and mutation checks precede the integrated acceptance run below. The
package build and packed-consumer runtime checks exercise the resulting page-script artifact.

The cut and refresh have been verified on local Chromium. Hosted Browserbase's Chromium,
extension workers and hosted latency have not been qualified. Enforcement ends when the owned
connection is detached; it is not a persistent firewall. Request admission retains the native
in-flight ledger with bounded processing concurrency, rather than revoking authority at an
arbitrary queue length.

## Simplifications that preserve the behavior

- Browser-level Fetch's empty-pattern cut and per-target refresh replace target-closing cleanup,
  uncertainty flags, duplicate loss state and overflow refusal workers. One held-request ledger
  owns answers. A bounded ownership cache shares stable proofs and rechecks child attribution.
- One Deferred result per native page replaces the registration queue and per-page semaphore
  map. Browser-owned fibers retain cancellation ownership while one semaphore bounds concurrency.
- Action values are explicit arguments through execution and policy preparation. The ambient
  `Action.Current` service, missing-context branch, duplicate action-name setup and duplicate
  input/secret flags are removed. Policy/event display data that has different privacy semantics
  remains explicit.
- `Window` is the single continuation value. The unused public `Window.Cursor` representation,
  constructor and union arm are removed; the agent already continues with Window.
- The supervisor's existing Retire-to-Stop transition launches the owned stop fiber. Its duplicate
  `stopping` flag is removed; state-machine idempotence is the sole decision.
- Effect's complete Cause/retry behavior replaces manual first-error narrowing. Semaphore
  acquisition owns presenter release, `raceFirst` owns Stillness failure, and typed Take values
  retain capture closure through the already-acquired seeded subscription.
- The recorder and Browserbase fixes make existing ownership boundaries precise; they do not add
  a second lifecycle or release protocol.

## Rejected or narrowed recommendations

- **R3: do not drop native reply tracking for timed-out act.** A real Chromium probe of the proposed
  one-line bypass allowed a second act to set a new title, then the first timed-out async script
  overwrote it later. A timeout does not cancel arbitrary page JavaScript. Pending mutations
  continue to exclude later input. Closing that page and opening a replacement was independently
  verified as recovery for a never-settling script and is now documented.
- **R11 (part): do not discard genuine recorder cleanup failures.** Busy lane admission is
  repaired before cleanup begins. A real failed native unregister remains observable instead of
  claiming that a fresh recorder is safely installed. Separate regressions prove both outcomes.
- **S4: do not substitute RcRef for recorder lifetime as a drop-in.** Its TTL begins after the last
  borrowing scope releases; recorder expiry is based on the last host read. It also clears its
  cached value before asynchronous scope close, whereas recorder reads must retain a real native
  cleanup failure. Lane-before-recorder admission and read-time rechecking would remain, leaving
  more mechanisms rather than fewer.
- **S5 (part): do not delete the supervisor's began evidence.** Retired.opening records a scheduled opening,
  not whether Try published Opening. Retirement may win before Try; removing began would emit a
  false Closed event for an opening that never began.
- **R29 (part): do not infer a new document for every seeded Back.** Native history may move within the same
  document. The test service must use supplied evidence rather than invent a navigation.
- **R30: do not require one immutable tool schema across scripted model turns.** Tools may legitimately
  change. TestModel records fingerprints; HTTP cassette replay checks its exact keyed requests.
  The inaccurate global schema-rejection claim was corrected.
- **Keep Stage's FIFO.** Replacing it with a semaphore changes fairness; always cueing the currently
  shown page adds a lease and can cut a page to itself.
- Optional count limits on custom typing/wheel arrays, an additional Config-layer test and broad
  API rewrites were not treated as reproduced defects. Existing bounded time schedules and
  required consumer behavior remain.

## Acceptance

Integrated acceptance passes with Node 24.14.1 and Bun 1.4.2.

| Check | Result |
| --- | --- |
| `bun run ready` | Passed in 216.044 seconds: formatting, lint, 27 boundary regressions and physical feature deletion, typechecks, 956 tests and build. Browser 587 (including all 41 request cases), Browserbase 71, agent 34, human-strokes 8, bench 169, site 87. |
| Local opt-in latency | 14/14 passed in 34.227 seconds. |
| Packed entrypoints | All 40 load/typecheck in clean npm and isolated Bun consumers. The checker separately filters 198 existing upstream Yielded declaration diagnostics per install; no package-owned diagnostic remains. |
| Isolated consumer | Full check passed in 31.146 seconds: 941 tests, formatting, types, build and lint over 167 + 95 files. All 55 scripted browser cases passed in 294.004 seconds. |
| Local Workers/CDP | Both nodejs_compat and portable modes passed native input/read, owned main/same-process/OOPIF request blocking, foreign-context continuation, 800×600 capture, screencast, navigation and scripted-agent tool checks. |

The candidate input fingerprint is
`de5e1a5fe464dfc9c5b0f1d04c71adb24481cd3af680499d5997cf7f626c562a`.
The browser archive is
`95b5fcda9d9d2ea81b6eb3c3d8f247409eabd5491a82be4a90f19cb649f792ae`.
The manifest hashes the source/test/build inputs and all four archives; installed source/dist
bytes were checked at the consumer's root and workspace resolution locations.

Receipts are under `.work/evidence/claude-packed-20261022T010726Z-a0753bfa/` and
`claude-ready.json` / `claude-latency.json`. The copied consumer initially omitted one untracked
login helper and inherited the outer worktree's ignore rule. Restoring that source file and
initializing only the disposable consumer's Git root corrected the fixture. The failed full
check was rerun; the 55 scripted cases and 40-entrypoint checks were retained only after proving
all four archives byte-identical and all previously tested consumer source unchanged.
`claude-consumer-helper-correction.json` records the helper's provenance and source comparison.
Original receipts remain intact. Workers' owned processes/process groups ended and all four
fixture ports closed; unrelated services were left alone.

Historical evidence at `1d6d7c7` remains in [the implementation ledger](AUDIT-IMPLEMENTATION.md).
No hosted sessions, paid provider benchmarks, merge, release or deployment were performed.

The aggregate 12,000-source-line gate is removed as authorized. The review found useful small
deletions and stronger ownership primitives, but no justified deletion of roughly 2,000 lines
that preserved the required behavior. Correctness fixes also require code. Module/function
limits, downward exceptions, boundary checks, typechecking, tests and packed-package checks
remain in force. The old measurement and failed gate are retained as historical evidence in
[the superseded size assessment](audit-size-assessment.md).
