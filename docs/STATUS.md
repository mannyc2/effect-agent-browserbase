# Status

## 0.3

The `0.3.0-beta.19` release adds browser moments in the agent's thread, with native conversation
compaction and the latest three moments' images retained separately. Foreground stillness compares
all three color channels in newly accepted frames while ignoring animation already present before input; gaps in newly accepted
frame history restart quiet, and without pre-input history all motion counts. Presented typing
follows a same-name focused field replacing the field just
pressed, while secret and guarded actions remain bound to the original field. Paused capture waits
for an uncropped native snapshot of the restored surface, keeping same-aspect-ratio crop pixels out
of screencast frames. Interrupted input retains authority through loading cleanup after its actual
replies arrive, and Stage schedules silence checks from the last paint. Local Chromium and scripted
agent regressions cover these boundaries; hosted behavior and model-specific image budgets still
need consumer qualification.

The `0.3.0-beta.16` release publishes failed-try cleanup on terminal supervisor states, so the
last try and retirement report outcomes without requiring another admission. `Down.released`
and an opening generation's `Closed.released` retain that generation's first `Unconfirmed`,
including retirement winning a late successful acquisition; later admission and acquisition
failure causes stay unchanged. Completed openings drop their local outcome records. Public
fake-provider and randomized lifecycle tests cover this evidence boundary, without establishing
hosted billing or actual provider release confirmation. Input guard and boundary definitions
also share their existing implementation without changing action checkpoints or document binding.

The `0.3.0-beta.15` release extends `Admission.after` to every earlier session that stopped
serving: failed acquisition attempts and older generations still draining are included. Awaiting
`after` waits for all pending releases; the first `Unconfirmed` outcome stays visible to later
attempts. Healthy nonexclusive rotation keeps its serving predecessor until the replacement
opens. The optional `Supervisor.Releasing` service lets adapters report failed-attempt cleanup;
Browserbase uses it for failed connections, builds and lost creates. Completed generations retain
only release outcomes and pending signals, rather than browser and scope references. Native
Chromium, fake-provider and randomized lifecycle tests cover these boundaries; they do not
establish hosted billing or actual provider release confirmation.

The `0.3.0-beta.14` release adds declared generation loss and per-attempt recovery admission:
`lease.lose(detail)` revokes serving work before returning, and `Admission.after` supplies the
preceding generation's actual release once it stops serving. `Browserbase.supervise` exposes
`admit` and `definite`; permanent context-policy refusal stops before provider requests. Completed
terminal plan input returns its receipt without waiting for continuous page updates to settle.
Moment pictures include completed input and account for navigation once. Stage output has its own
nondecreasing `Painted.at` clock, and a released cue refuses reuse without claiming browser loss.
Local Chromium and fake-provider regressions cover these boundaries; they do not establish hosted
billing or provider release behavior.

The `0.3.0-beta.13` release fixes navigation waits retaining input authority after their deadline,
so corrective input, suspension and Stage cuts can proceed after bounded loading cleanup. Actual
mutation acknowledgements remain tracked after cancellation. Plan expectations no longer count
an earlier redirect during preparation as the next step's navigation; saved plans cannot use
absence or unspecified navigation as durable proof for recovering an unknown operation, including
when a caller bypasses decoding. A completed Stage cut remains successful during bounded outgoing
capture cleanup. Native Chromium and plan recovery checks cover these failures. The beta.12 tag
is preserved but was superseded before publication.

The `0.3.0-beta.11` release completes connection identity and the
[compiled composition examples](COMPOSITION.md). `Browser.connection` and required
`Frame.connection` distinguish evidence across reattachment; `(connection, page, document)` names
one tracked document. Separate capture sockets retain their owning browser's identity. Frame
reuse requires the current document even when a calibrated timestamp appears newer. Generation
`hostTime`, frames and browser events use the captured host clock, preserving order when wall time
changes or callers override their own clock.

The watched example retains prepared pages, cues before send/drop events and cuts performance at
step boundaries. The separate operator-assisted runner journals begun steps before input, suspends
library writes during intervention, and requires positive durable read-back to recover unknown
consequential input. Local Chromium covers both workflows and their failure paths. Editorial
policy, account decisions and business journals remain consumer responsibilities.

The [H1/H2/H3 commands](HOSTED_CHECKS.md) are executable, opt-in probes with bounded session
admission and private evidence. Local runs validate the probe mechanisms, including the full
five-minute two-capture schedule and an external operator stand-in. Hosted runs remain unperformed:
included Browserbase allowance has not been verified, and H3 also requires a human operator.
These probes do not make model calls or establish a billing boundary from an environment flag.

The `0.3.0-beta.10` release adds cued presentation: `Stage.cue` prepares capture, and its
`commit` switches on the event while retaining old-page input authority through the cut.
Prepared cues belong to their calling scopes; committed capture belongs to the stage.
Commits preserve arrival order and report queue and input wait in their latency. `Stage.shown`
reports `Painted`, confirmed `Still`, uncertain `Stalled`, and `Gone` with current-frame checks
across navigation and capture failure. Local Chromium covers these contracts; hosted concurrent
capture capacity remains unproven until the included-hour H1 experiment runs.

The `0.3.0-beta.9` release adds scoped browser input suspension. It drains each
admitted operation through its record and outstanding native replies, refuses later writes as
`Suspended` and leaves reads/capture available. Nested scopes share authority until the last one
closes. Local Chromium also verifies agent batches stop between operations without resending
completed input. The hosted Live View handoff is unrun; provider behavior and included allowance
remain separate from this native evidence.

The `0.3.0-beta.8` release adds leased generations:
`Supervisor<A>.use`, scoped values, transferable retained scopes and a default 30-second
handover. Loss and retirement revoke work immediately; cleanup precedes provider release.
`Browserbase.supervise({ build })` builds each generation's application value. Exclusive
persisted-context rotation drains and releases before acquiring; nonexclusive manual and timed
rotation continue while older generations drain. The consumer owns overlap and billing policy,
and `Unconfirmed` never asserts that a provider session ended. Generation events carry monotonic
`hostTime` alongside wall-clock `at`.

The lifecycle model, scripted provider tests and local Chromium cover admission, cancellation,
revocation, finalizer ordering and rotation. The Browserbase fake covers client sequencing and
persisted-writer refusal. They do not establish hosted save timing, physical session overlap or
billing. [H2](HOSTED_CHECKS.md), persisted rotation with a live hold and storage read-back, is
prepared but unrun until included-hour allowance is verified. Local evidence does not certify
provider persistence, physical session overlap, capture capacity or billing.

Published `0.3.0-beta.7` adds resumable plan steps with receipts, serialized stopping points, durable
expected-effect read-back, bounded arrival and content readiness. A missing receipt after
cancellation or restart stays unknown: the library never automatically repeats unresolved
consequential input. A positive transient notice is not evidence for recovering a lost reply.
Local Chromium proves checkbox convergence, cancellation evidence, durable recovery across a
new page, redirect bounds and content readiness during canvas animation and navigation; these
are browser contracts, not proof of a particular site's durable transaction semantics.

Published `0.3.0-beta.6` fixes recorded presses replaying on the wrong focused field
and insertion typing replacing existing text. Local Chromium regressions reproduce both defects
before the fixes. The Browserbase fake also serves Live View and retains session create settings;
these tests establish the fake/client contract, not hosted behavior.

0.3 is a rewrite of the 0.2 set on stable Effect 4.0.0 and `effect/ai`, with agents on Yielded
Agent, the renamed Effect Agent:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Moment`. It has no agent code.
- `effect-browserbase`: the Browserbase REST client, and sessions as a `Browser`. Stored contexts
  and uploaded extensions are managed through the client. A persisting `open` holds its context
  through a `ContextLease` from before its create until its save settles: `ContextLease.layer`
  excludes writers in the process, and an application provides its own, such as an advisory lock
  in its database, to exclude them across processes. A release confirms the session ended and says
  so, `Settled` or `Unconfirmed`. An unconfirmed release, a create whose answer was lost, or a
  session kept past its scope leaves the context unsettled, through the lease: the next writer
  ends the context's sessions, which `open` labels in their user metadata, before it writes, and
  fails `ContextHeld` while they cannot be confirmed ended, so no context is held with no way out
  and no two sessions write to one. `Browserbase.reconcile` does the same without opening a
  session, and `Browserbase.verifyContext` reads a context back, as a login, from a session that
  saves nothing, under the same hold: on Browserbase it read back the cookie and local storage a
  writer had saved (8 October). `Browserbase.attach` is resume: on Browserbase a second process
  attached to a running session by its id, found its page by its target id and changed it.
  Each create carries a nonce of its own, so a session that a create whose answer was lost made is
  found and ended, whether it persists a context or not, rather than billing until its timeout.
  `effect-browserbase/testing` holds the Browserbase API in memory, with scripted faults and
  Browserbase's own answer to each id shape, and the contract checks it passes. Pages' screencasts
  run on a capture connection of their own, a second, read-only connection to the session, so a
  frame never waits behind a large message on the one that drives the page; a provider supplies
  one through `Cdp.Options.capture`.
- Sessions that survive: `Supervisor` keeps a browser open as leased generations from any provider,
  with scoped application values, `use` work and transferable `retain` scopes. It reopens a lost
  one on a schedule, rotates ahead of a session's end (overlap, or drain and release first for
  sessions saving to one stored context), and revokes at once on `retire`. A
  failure the provider deems definite, such as a refused key, is `Down` at once with its cause,
  rather than hidden behind the schedule. Each generation's changes stream as `states`, with its
  release outcome last, a loss with its cause. `Browserbase.supervise` supervises hosted sessions,
  and with `keep`, a name, leaves its session running past its scope, `Kept`, for the next
  supervisor under that name to adopt with its pages: opt-in, since a kept session bills until it
  is adopted and released, or its timeout ends it.
- Pages with durable names and a life story. A page's id is its CDP target id, so a new connection
  to the same browser finds it again with `browser.page(id)`. The timeline tells each page's
  documents and moves within them (`Navigated` with `document` and `sameDocument`), its loads
  (`PageLoaded`) and its close or crash, and the browser's end as one `Disconnected` with its
  cause, `connection`, `session` or `released`, also `browser.disconnected`; frames carry their
  document and address. A failure on a page that is gone is `Closed` with its cause, calls in
  flight fail at once with a lost browser or a crashed page, and `BrowserError.consequence` says
  what any failure leaves and whether to repeat it. Every reported address, the outline's links
  among them, loses its userinfo and its credentials' values and keeps what it is about, such as
  `?code=BTC`, and init scripts run where their `match` allows, a popup's first document
  included. Chromium announces a title change only with the next address change, so titles are
  read on demand.
- `effect-browser-human-strokes`: an optional pointer planner, `HumanStrokes.motion`, over 32,130
  recorded, attributed CC BY 4.0 pointer strokes, retaining their original sample coordinates and
  times. The core planner, `Motion.lognormal`, uses the tuned two-stroke sigma-lognormal model; a
  presenter takes either as a value. Complete bounded plans are validated and admitted before
  publication and input.
- `effect-agent-browser`: pages as Yielded Agent's browser ports, `BrowserActions` and
  `BrowserControl`, pinned to one page or following a browser's tabs without taking the screen,
  and the tools an agent drives them by: Yielded's own, and pointer tools for what has no ref, such
  as a canvas game or a chart. An observation is the page's outline with its controls as values,
  and one after an action begins with what followed it: a dialog and how the browser answered it, a
  navigation, a tab it opened and what its input visibly changed. Every action result says whether
  its input reached the browser, and nothing is retried. Before each turn the model sees a
  screenshot of the current tab, as context the run never keeps; with `vision: "moments"` its
  thread holds instead, after each turn's tool results, a moment of the tab since the turn before,
  immutable accounts that Yielded can prune and summarize with the conversation. The latest three
  moments' frames remain as turn-labeled references outside compaction coverage, and older image
  bytes are released. Lost pages and moments without usable pictures stop preparation before
  another model call; queued zoom crops only accompany their original tab. Bounded model contexts
  need a model-aware image-token estimator, composed
  with the tools' preparation as the package README shows. `wait_still` waits for
  foreground stillness. Yielded runs the agent: its loop,
  policy and budgets, approval, context and run events. Its browser interface is on Yielded's
  `main` but not yet on npm: the package pins `@yielded/agent` `0.1.0-beta.168`, which upstream's
  pending release publishes. Until then the repository's `overrides` install a commit-pinned pack
  of upstream's release candidate from this repository's `vendor/yielded-agent` branch, and
  consumers install the same pack as a dependency and an override, by the address and integrity
  the package's README gives. The packed check installs it that way with npm and with Bun's
  isolated linker, and holds each to that integrity and to one copy of each runtime package.
- Viewport zoom crops and pixel-click receipts with resolved element metadata, including on
  displays whose device pixel ratio differs from one.
- Structured reads in one call to the page. `Page.find` returns the elements that a query of role,
  name, text and context matches, each with a ref the actions take, its subject, box and state.
  `Page.text` returns what the viewport, or one element, shows, with what fields hold masked unless
  asked for and secret fields masked always. A subject's context binds a table cell to its row and
  its column's header, and every `Action` records it. Reading the viewport, the outline, `find` and
  `text` skip subtrees out of view, keeping what is pinned in view: locally, the outline of a
  28,021-element table takes 7 ms instead of 95.
- Plans and readiness. `Plan.fromEvents` records a page's walk from its events, and `Plan.replay`
  replays it on a fresh page by subject, with no model call: it waits for `Page.ready` before each
  step that acts, finds the one element each step names by role and name among those that repeat
  all its recorded context, types a secret only into a secret field, and stops at the first step it
  cannot take with a typed reason. On the drift site, plan 016's four walks and the phase 1
  review's three, under eleven drift operators, five seeds each, ended in the wrong place 0 times
  in 420 replays. `Page.ready` says, in one call to the page, whether a page is ready to be shown,
  from the page's own evidence, so a blank canvas or a spinner alone is still loading; with
  `quietMillis` it also waits for the screen to be still, and a stalled connection is not stillness;
  `still: "foreground"` lets what was moving in the 1.5 s before the page's latest input, such as a
  game's idle animation, go on moving. Brief foreground motion between polls still restarts the
  quiet interval; missing frame history cannot establish stillness.
- Expectations: `Expect.attempt` names what an action is for, something that appears, goes or
  changes as `Page.find` finds it, or a navigation, and each `run` checks before it acts, so an
  action whose input went before it failed is sent again only where its effect did not come:
  `Done`, `AlreadyDone` or `NotDone`. A check is one call, and so is the wait for an effect.
- An input policy over resolved targets and navigation, with typed denials, independently bounded
  holds and validation before held actions resume: the press point is hit-tested after the
  pointer arrives, typing refuses to start on a control a key could activate, and a multi-key
  action stops at a new document. Typing approves its field once: plain text goes into it in one
  insertion, so a guarded 2,000-character paste takes half a second at a 70 ms round trip, where
  each key used to wait for the keys before it and a focus check, and keys a presenter's view
  types check focus before each space and after the last key. Guards receive structural facts, never keyword categories, and
  page evidence around the target without field values; text typed into secret fields is redacted
  from requests and recorded events. A 77-control labelled corpus grades the facts in `ready`.
  `Policy` adds judges over `effect/ai` (`reviewer` on a `LanguageModel`, `decider` on a
  `DecisionModel` such as Jev) and `make`, a guard that denies a risk the task does not ask for and
  fails closed on input with facts when its judge fails; `effect-agent-browser`'s tools give it
  the run's task. The judges are tested with scripted models; `bun run bench judges` in
  the bench grades them against the corpus, with paid arms only on opt-in.
- What changed on a page: `Page.changes({ since, until })` reads, in one call, what visibly
  changed over a window, element by element: text that changed, appeared, disappeared or came
  and went, fields' values (masked unless asked) and the title, each with what it showed at
  either end, how often it changed, a number's range, its row, column, label and heading, and the
  input it followed where it was that input's doing. A page records once something reads its
  changes, from the start of each later document, and a page nobody reads records nothing and
  costs nothing; on a 2,000-cell table rewritten every 50 ms, recording takes the page's busy time
  from about 100 ms per 3 s to about 230, where an empty observer costs about 180. The record keeps
  news over what keeps changing, counts what it lets go and never claims to be whole where it is
  not, and a window can continue exactly where the last read ended or end at a frame's paint.
  `Page.ready({ quietMillis })` also waits for nothing in view to change where a page records.
- Windows and moments: `page.window({ since, until })` reads a page's three tracks, its events, what
  changed and its frames, over one window of the host clock, which can end in the past, at a frame
  a delayed consumer airs late, and go on exactly where the last window ended; its events and
  frames cost no call and its changes one. A part that cannot be read is missing, with why, and
  the window is still made; `Moment.account` says what was still changing at its end, what had
  settled, and how long its page had been still. A
  moment is a window that ends at a picture of the page now, and never fails because its picture,
  its changes or its outline did. `Moment.toPrompt` lays a moment out as one message for any
  `effect/ai` call, leading with what changed, news and what settled first, telling what kept
  changing as still changing or settled since when, and naming an action only as what a
  change followed or where its effect is drawn, as on a canvas, a failed one only as failed; it
  says what it could not read, and why. Describing it is the caller's own `generateObject`,
  `generateText` or `Chat` turn. In the paid narration run, without the account a model told which
  of two ticking prices still moved and which had stopped for both in 18 of 32 moments, and with it
  in 29 (phase 4 below). The outline is
  opt-in (`snapshot: true`): in the first paired run, moments with and without it scored 61/80
  each on every task but `navigated`, where the outline's reused refs misled the model, and it
  doubled the tokens on `quote-dense`. Pages keep the screencast frames of the last 5 seconds
  (`frameHistory`), a moment's default window.
- Bounded, pipelined typing and shortcut chords, plus one host monotonic clock for events, frame
  arrivals, observations and moments.
- Per-page admission: a page waits only for itself. Its operations take turns in one lane, where an
  action has the page to itself, in the order actions were asked, and reads share it after the
  action in flight and every action asked before them, so a read describes the page an action
  left. A wait for a turn fails `Busy`, never `Timeout`, and `Page.failFast` fails it at once. A
  click on one page no longer waits for typing at a person's pace on another, which held an on-air
  click for about 9.5 s in the release review. Identical reads in flight share one call, a read whose
  callers gave up serves the next caller to ask the same until the page's next action.
  `Browser.Options.maxPages`
  bounds the open pages, failing `Limit`. `page.state` says what the library already knows of a
  page at no call and with no wait: its address, document and load, its newest frame, and the
  viewport's text and title as last read, each with when it was learned.
- A timed input track with planned glides, submission receipts, button/key phases, wheel and cursor
  events; a pointer per page, a presenter's one drawn pointer across its views, and bounded event
  replay with explicit expiration.
- Input performed for viewers as an explicit view: `Presentation.make({ pacing, motion })` owns one
  drawn pointer, and `presenter.view(page)` performs a page's actions while the page stays plain.
  A view waits before each action as a person reacts (280 ms after an expected change, 600 ms
  after a new document, 1 s on another page), glides from where viewers last saw the pointer,
  clicks a field before typing near 70 WPM with overlapping holds, and scrolls in notches and
  bursts, also to off-screen targets, with a bounded fallback and approval revalidation. One view
  acts at a time, its presentation time is outside `actionTimeout`, and `view.aim` starts a glide
  as soon as a target is known. The motion planner is a value: `Motion.lognormal`, or recorded
  strokes from `HumanStrokes.motion`.
- A stage for live output: `Stage.make` and `stage.present(page, { at })` switch an output's frames
  between pages, in one session or across two, with the captures overlapping, and stamp when each
  switch took effect on the frame clock. On Browserbase two captures in one session ran at the
  frame rate of one, where stopping first left 250 to 295 ms dark. A late first frame fails typed
  and leaves the old page on the stage, and a capture that fails restarts on its page.
- After input, one call waits a task and a frame in the page, spanning any navigation the input
  asked for, and a committed document is waited for until parsed: no fixed sleep. Ten clicks that
  navigate nowhere took 1.65 s locally and 3.75 s at a 70 ms round trip, and take 0.5 s and 3.25 s.
- Browser paint mapped onto the host clock with explicit uncertainty, wider as its estimate ages,
  through one browser-wide clock mapping that the first capture measures, never the opening of a
  browser, and that a capture measures again while its frames flow, so a busy page's wide first
  estimate narrows; timestamped mouse and raw text-key input once it exists; and per-page capture
  counters, over a page's life or a window of the latest minute, for filtering, paint gaps, late
  frames apart from lost ones and the acknowledgement backlog. Screenshot timing has its own
  provenance; a frame read states how old it may be, and whether it must follow the latest input,
  which a screenshot always must, and never shows a document the page has left.
- Pictures and reads on each page's own protocol session, counted: a picture is one call, or two
  for a crop or another device pixel ratio, and a page's pictures go one at a time; a page's first
  clipped picture also holds a copy of the screen the page reads, in two more calls, so a crop leaves
  a screen another session emulates as it was; the page script is registered once per page session, so
  a document's first read is two calls and a warm read one, `ready` included however long the page
  takes, and a wait for a still screen two calls while a capture runs; the library's own clipped
  pictures stay out of the screencast by pausing native capture through actual picture restoration,
  retaining readers and settings. Forced pictures with capture running add stop, an uncropped
  restoration snapshot, viewport refresh and restart calls; cached frame reuse remains free, and readiness requires fresh frame evidence
  after a pause. Focus emulation keeps tabs behind painting. A native
  suite holds these to their call budgets through a counting proxy.
- Tracing: page operations with their phases and protocol cost, captures, page script round trips
  and opening a browser are Effect spans, and Yielded traces the agent's turns and tool calls with
  OpenTelemetry's GenAI attributes. No page span carries typed text, and the application chooses the exporter. The
  bench exports over OTLP on request, records where each trial's time went (`phases`) and can add
  latency to a local browser's DevTools connection (`--latency`) to measure hosted round trips free;
  there it also traces each DevTools command under the span that was open when it was sent. Hosted
  sessions carry their trial in Browserbase's user metadata, and connect through a relay in the
  bench that traces their commands the same way.
- `bench` (private): twenty-one tasks over canvas games, live charts, dense quote tables, orders,
  navigation, forms, a board, menus, a catalogue and a market board whose prices tick, flash,
  scroll out of view and keep ticking or stop, graded against seeded page truth and captured evidence; an understand task's
  page records its changes from before its setup. The six operate tasks' pages vary with the seed,
  and `--split eval` holds a family of seeds out for comparing arms. Trials run with separate
  browsers and bounded concurrency, task-specific reasoning defaults, elapsed-time metrics and a
  shared model admission budget. Every trial is graded, an infrastructure failure, denied or
  unrun, and summaries keep those
  denominators apart. `--arm` runs the paired experiment's arms 1 (Yielded's tools alone),
  2 (vision first), 5 (the default tools) and 6 (the default tools with moments in the thread) on
  the same seeds, each a Yielded agent on the task's
  page, whose streamed model requests are sent and charged as single completions. The bench is an `effect/cli` program (`run`, `report`, `judges`) on `Config` and
  `FileSystem`; its results are versioned Schema records, and a report states its estimand and
  tests arms with exact paired tests. Paid runs remain opt-in.
- `site` (private): the docs site, a Foldkit app on Cloudflare deployed with Alchemy. Its pages are
  markdown with replays placed in the prose, and each is also served as markdown for agents, with
  `llms.txt`, `llms-full.txt` and a JSON index. Its demos are recorded takes of an agent that speaks
  for itself: what it writes beside its tool calls, from the moments in its thread, is spoken by a
  voice model. One explores Polymarket, its markets checked against Polymarket's API; one plays six
  spins of a canvas slot in a made-up casino, dealt from a fresh seed, its report checked against
  the game server's record. The player shows the screencast with the speech as audio and captions,
  the planned pointer path, what the agent was doing when, its steps and the grade. `bun run dev`
  serves a local runner, so a visitor records their own take with their key and cap. The site is
  deployed to Cloudflare.

`effect-agent-browser` is rebuilt on Yielded Agent in place of the 0.2 adapter on Effect Agent,
and 0.3's own loop on `effect/ai`'s `Chat` went with the move. The tests run against real local Chromium, a fake Browserbase API
and scripted models. `bun run ready` runs all formatting, lint, type, test and build checks without
paid calls.

## Phases

0.3 is built in four phases, each ending with a pass that deletes what the phase made redundant,
and each becoming the next beta.

- **Phase 1, cost and replay, is built, with its review's fixes.** Pictures and reads
  go on each page's own counted protocol session, the clock is measured on first need, and
  `Page.find`, `Page.text`, `Plan` and `Page.ready` are in. The review found frames of the previous
  page served after a navigation, replays that act in the wrong place, and a busy page's first
  capture failing or widening the clock's estimate. The pictures and clock fixes are in: reads show
  the document a navigation reached, a busy page's first capture starts with what its clock probes
  could measure and narrows it while frames flow, and a capture's start has a deadline. The current
  release pauses native capture through actual screenshot restoration to keep all crop pixels private. So are the replay and readiness fixes: replay
  refuses the review's six drifts rather than act in the wrong place, `ready` waits out a loading
  screen in one call to the page, and a stalled connection no longer reads as a still screen. Its
  beta, `0.3.0-beta.1`, was never published; `0.3.0-beta.5` carries it.
- **Phase 2, identity and lifetime, is built, with its review's fixes (#241, #242).**
  `Supervisor`, the Browserbase release outcomes and `effect-browserbase/testing` have landed, with
  the review's follow-up: a context whose session may still be saving to it is cleared by the next
  writer rather than held with no way out, a definite failure goes `Down` at once, and the fake
  answers each id shape as Browserbase does. Pages keep their target ids across connections, and
  their lifecycle, the browser's loss with its cause, `consequence`, redacted addresses and
  per-origin init scripts are in. So is the capture connection: on Browserbase, pages' screencasts
  run on a second, read-only connection to the session, and on a hosted session the on-air page's
  longest wait between frames, while another tab read and uploaded, fell from 1,802 ms to 352 ms.
  And the change record is: the page records what visibly changes on it from the first read of its
  changes, at the start of each later document, and moments lead with it. The phase's simplify pass
  shared what its parts wrote twice, made a screencast's readers on a dropped connection fail as
  every other call does, by the connection rather than as the page's close, and killed the five of
  its eleven planted bugs that the suite let through. Of its review's fixes, the change record's
  are in: a change names an input only if it was not in flux before it, and, out of the input's
  reach, only on a page that was still, so an inert click beside boards ticking every 0.25 to 6 s
  was credited with none of 401 ticks and 96 chat lines, where it had been with about half the
  slower boards' ticks and every line; a moment tells an action that changes followed but none
  names as a step, and claims nothing of a window its record did not see. So are its fixes for
  identity and lifetime: a capture's reader is told the browser's loss whichever connection hears
  it first, and a release as released; a wait for a still screen holds through a stall on the
  capture connection; an address withholds each credential's value and keeps what it is about, the
  outline's links too, and replay goes to an address it withheld only where told; and a lost
  create's session is found by its own nonce and ended. Its beta, `0.3.0-beta.2`, was never
  published; `0.3.0-beta.5` carries it.
- **Phase 3, concurrency and presentation, is built.** Per-page admission has landed: the
  browser-wide input lock is gone, reads follow the action in flight and keep their work, a wait
  fails `Busy`, pages have a budget, and guarded typing approves its field once. So have the stage,
  the presenter and the wait after input: `humanize` and its fixed sleeps are gone. And so have
  windows: a page's events, changes and frames over a window that can end in the past, moments as
  windows that end at a picture and record what they could not read rather than fail,
  `stillness`, and `page.state`. The agent then moved onto Yielded Agent: `effect-agent-browser`
  implements its browser ports over pages, with the tab following and the receipts of what an
  action caused that the phase built for its own tools, and the bench's arms are Yielded agents.
  The phase's own agent loop, its tools, their page operation contracts and RPC group went. The
  phase's simplify pass took out `Page.waitForText`, which `waitFor` replaced, with its page-side
  wait, and killed the two of its fifteen planted bugs that the suite let through: a switch that
  turned on the stage while input on the old page was still under way, and a failure after an
  action's input went reported to a model as not dispatched. It had no adversarial review of its
  own. Its beta, `0.3.0-beta.3`, was never published; `0.3.0-beta.5` carries it.
- **Phase 4, contexts and follow-ups, is built.** Stored contexts are durable across processes:
  `ContextLease` replaces the process-wide record of writers, `verifyContext` reads a login back,
  `attach` resumes a session from another process, and `supervise({ keep })` leaves a session
  running past its scope for the next supervisor to adopt. Its hosted checks, on 8 October, used 3
  browser minutes by the project's usage, 503 to 506, over three sessions one at a time that ran
  75 s by Browserbase's own clock, all released and confirmed. They also found that a malformed
  context id is refused as invalid (400), as a malformed session id is, which the fake now does;
  that a search by user metadata with no status lists a new session within one search of its
  create, 104 to 170 ms, and an ended one by its end; and that Browserbase cut a timed-out
  session's connection 4.4 s after its `expiresAt`, its own `endedAt` 4.3 s after, so the browser
  reported the session's end. A context's `updatedAt` did not move when a session saved to it, so
  nothing in the API tells when a save has landed, and `contextSettle` stays a fixed wait. And a
  raw crop changed what the page reads as its screen from 1280×720 to 800×600 for the rest of the
  session, `device-width` media queries with it, while the window stayed 1280×720. A crop now
  leaves the screen as it was, in a local repro of that finding: from a page's first clipped
  picture on, the page's own session holds a copy of the screen the page reads, which every later
  picture restores. A page's pictures also go one at a time, since two crops at once left the
  page's view at the first one's size. Expectations have landed: an attempt checks what an action
  is for before it acts, and after an action that failed once its input went, so a repeat after a
  `Timeout` or a reconnect sends nothing where the effect came. `Moment.account` has landed,
  after the paid narration run on 8 October showed what moments left out. On a market board where
  two prices ticked and the seed stopped either, both or neither 3 s before the moment, the bench's
  `board-flux` asks `openai/gpt-6-luna` which still moves and at what the others settled, and
  `board-caption` asks for a narrator's caption, graded in code. Without the account the model
  had both prices' states right in 18 of 32 moments, and named 19 of 64 states wrongly; with it,
  29 of 32 and 1 of 64. Captions told a still-moving price as moving for 1 of 39 such prices
  without it and 15 of 39 with it, and quoted the rest as a settled figure, as the bench's
  narrator, asked for numbers, does; with the outline, the alternative, the states got worse, 13
  of 32 wrong in 16 moments. The run's 160 calls cost $0.084. The release hygiene left from
  earlier is done too:
  - `effect` is now a `~4.0.0` peer, while the packages rely on modules that Effect marks unstable;
    [RELEASING.md](RELEASING.md) has the policy.
  - The docs now say that `attach` resumes only a session created with `keepAlive`, and that closing
    `open`'s scope waits for its release.
  - They also say that an action reads its subject when it resolves its target, not as its input is
    sent.
  - The model is told when a confirm dialog was dismissed; `effect-agent-browser`'s tests hold it.
  - The packed check now runs on every PR and push to main, after `ready`, as well as before a
    release.

  The phase's simplify pass found nothing its parts had made redundant to delete. It planted nine
  bugs in the lease, `verifyContext`, `attach`, `keep` and a crop's screen. Eight failed the suite
  at once. The ninth, every generation of a keeping supervisor adopting the session it kept, which
  made a rotation reopen the session it meant to leave, now fails a new test. Expectations had
  their own eleven, all failing. No adversarial review of the phase was run. Its beta,
  `0.3.0-beta.4`, was tagged and not published: `0.3.0-beta.5` carries it, with a fix to
  `Page.waitFor`.

Size against the baseline at `ab326c1`: lines of each package's TypeScript (`wc -l`), with
`src/testing` counted apart, and the `export` statements of its public modules.

| Package                        | Source lines                   | Test lines      | Top-level exports         |
| ------------------------------ | ------------------------------ | --------------- | ------------------------- |
| `effect-browser`               | 8,871 → 14,978                 | 11,064 → 15,909 | 129 → 169                 |
| `effect-agent-browser`         | 935                            | 725             | 14                        |
| `effect-browserbase`           | 807 → 1,704, and 622 `testing` | 611 → 2,391     | 32 → 41, and 14 `testing` |
| `effect-browser-human-strokes` | 309 → 298                      | 261 → 247       | 4 → 3                     |

`effect-browser`'s figures include phase 2, as each part landed: the supervisor, 602 source lines,
506 test lines and 7 exports; pages' identity and lifecycle, 398 source lines, 542 test lines and 9
exports; the capture connection's port and transport, 324 source lines, 43 test lines and 1 export;
and the change record, 1,423 source lines, 728 test lines and 6 exports. The phase's simplify pass
took 118 source lines back out, and its review's fixes for the change record's causes and moments
added 95 source lines and 78 test lines, and those for captures, readiness, addresses and replay
98 source lines and 149 test lines. The figures include phase 3's per-page admission too,
508 source lines, 411 test lines and 3 exports, most of it the lane, which deleting the
browser-wide input lock paid for only in part; and the stage, the presenter and the wait after
input, 525 source lines, 359 test lines and 9 exports, which deleting `humanize`, its prose slips
and the fixed sleeps paid for in part; and windows, moments as windows, `stillness` and the page's
state, 214 source lines, 393 test lines and 4 exports, which deleting `Moment`'s own window,
`latestFrame` and the browser's own listeners for loads paid for in part. Moving the agent onto
Yielded took 949 source lines, 1,764 test lines and 30 exports out of the package, its loop and
tools, against the reads Yielded's ports need: controls as values, a selector's scope, condition
waits, a key on a ref and PNG pictures; the rebuilt `effect-agent-browser` is 935 source lines and 700
test lines, so the two together are smaller than the package was. The phase's simplify pass took
66 source lines out, `waitForText` and its page-side wait. Phase 4's contexts,
resume and keep added 32 source lines and 73 test lines there, the supervisor's `keep`, and the
rest to `effect-browserbase`: 294 source lines, 27 in `testing`, 557 test lines and 5 exports, the
new `ContextLease` and `verifyContext`. Phase 4's release hygiene added 38 source lines and 119
test lines, most of them tests of promises that planted bugs broke, and `waitForText` as one call,
which phase 3's simplify pass then took out with `waitForText` itself. Expectations added 310
source lines, 258 test lines and 9 exports: `Expect`, and the wait it asks the page for.
Without them, phase 1 leaves the package at 11,431 source lines, against a soft ceiling of about
11,000 through phase 4. `Moment.account` then added 48 source lines, 100 test lines and 1 export,
net of `stillness`, which it took in. The cuts left to reach 11,000 would each drop a feature, so
the ceiling is now 15,000 and checked by `ready` (`bun run size`): from here, a change that adds
source deletes as much. The wait for each tab an input opens to finish its registration,
which reached `main` first, added 131 source lines and 108 test lines in place of this phase's own
wait for the tab, 22 lines; sharing what the input actions, the judges' risks and failures built
by hand wrote twice paid for it, with 106 source lines.

## Not rebuilt yet

0.2 did much that 0.3 does not do yet. A capability inventory of the 0.2 code, the plans, the open
PRs and the in-progress work marks each capability as rebuilt, left for later, or the consumer's to
build. The 0.2 PRs are closed, except #164, kept open as a reference.

The larger pieces left for later:

- recording to video files;
- operator handoff and uploads;
- the paid hosted checks.

## Releases

`0.3.0-beta.5` of `effect-browser`, `effect-browserbase` and `effect-agent-browser` was published
on 10 October 2026 from tag `v0.3.0-beta.5` (`3af967f`) on the `beta` dist-tag, by
`.github/workflows/publish.yml` through npm trusted publishing, with provenance. Each archive npm
serves has the integrity of the one the workflow checked. `effect-agent-browser` takes
`@yielded/agent` from the archive above until `0.1.0-beta.168` is on npm. Installed from npm as its
README says, in an npm project and in a Bun workspace with the isolated linker, the three held one
copy of each runtime package, locked the archive's integrity, and loaded all 27 of their entry
points.

`effect-browser-human-strokes` `0.3.0-beta.5` is published with provenance too. Its first publish
failed with `ENEEDAUTH`; rerunning the publish job reused the checked archives and completed it.

`v0.3.0-beta.4` (`312ecf8`) was tagged but not published: a fix to `Page.waitFor` came after it,
and release tags cannot move. `0.2.0-beta.9` was the release before, on 2 October 2026.
[CHANGELOG.md](../CHANGELOG.md) lists what each release changes. Before it publishes, the workflow
runs `tools/check-packed.sh`, which CI runs on every PR and which runs locally too.

## History

The 0.2 code, its records and its media are in Git history: `1ed8259`, the last `main` before 0.3,
holds all of it.
