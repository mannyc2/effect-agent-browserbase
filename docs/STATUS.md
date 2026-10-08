# Status

## 0.3, unreleased

0.3 is a rewrite of the 0.2 set on stable Effect 4.0.0 and `effect/ai`:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Tools`, `Agent` and `Moment`.
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
- Sessions that survive: `Supervisor` keeps a browser open as generations from any provider,
  reopening a lost one on a schedule, rotating ahead of a session's end (make before break, or
  break first for sessions saving to one stored context), and stopping at once on `retire`. A
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
- `Agent.run` and `Tools.batch` run a turn's tool calls in order and halt on the first failure,
  with one outline and screenshot per turn, configurable observations and caller toolkits. A
  response that calls an unknown tool gets a correction rather than ending the run, a browser
  with no page ends it, and the tools follow a newly opened tab without acting on it unseen.
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
  `quietMillis` it also waits for the screen to be still, and a stalled connection is not stillness.
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
  fails closed on input with facts when its judge fails; `Agent.run` provides the task and ends
  after three refusals in a row. The judges are tested with scripted models; `bun run bench judges` in
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
  the window is still made; `Moment.stillness` says how long its page had been still at its end. A
  moment is a window that ends at a picture of the page now, and never fails because its picture,
  its changes or its outline did. `Moment.toPrompt` lays a moment out as one message for any
  `effect/ai` call, leading with what changed, news first, and naming an action only as what a
  change followed or where its effect is drawn, as on a canvas, a failed one only as failed; it
  says what it could not read, and why. Describing it is the caller's own `generateObject`,
  `generateText` or `Chat` turn. Whether a model describes a page better from
  changes than from steps is not yet measured: the paid narration run is phase 4's. The outline is
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
  callers gave up serves the next caller to ask the same until the page's next action, and
  `observe` returns what it could read, with why the rest is missing. `Browser.Options.maxPages`
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
  for a crop or another device pixel ratio; the page script is registered once per page session, so
  a document's first read is two calls and a warm read one, `ready` included however long the page
  takes, and a wait for a still screen two calls while a capture runs; the library's own clipped
  pictures stay out of a running screencast, which keeps the page's own frames where the crop is on
  the page's own session, as over CDP; and focus emulation keeps tabs behind painting. A native
  suite holds these to their call budgets through a counting proxy.
- Tracing: agent steps, tool calls, page operations with their phases and protocol cost, captures,
  page script round trips and opening a browser are Effect spans, with OpenTelemetry's GenAI attributes on the agent
  and its tool calls. No span carries typed text, and the application chooses the exporter. The
  bench exports over OTLP on request, records where each trial's time went (`phases`) and can add
  latency to a local browser's DevTools connection (`--latency`) to measure hosted round trips free;
  there it also traces each DevTools command under the span that was open when it was sent. Hosted
  sessions carry their trial in Browserbase's user metadata, and connect through a relay in the
  bench that traces their commands the same way.
- `bench` (private): nineteen tasks over canvas games, live charts, dense quote tables, orders,
  navigation, forms, a board, menus, a catalogue and a market board whose prices tick, flash and
  scroll out of view, graded against seeded page truth and captured evidence; an understand task's
  page records its changes from before its setup. The six operate tasks' pages vary with the seed,
  and `--split eval` holds a family of seeds out for comparing arms. Trials run with separate
  browsers and bounded concurrency, task-specific reasoning defaults, elapsed-time metrics and a
  shared model admission budget. Every trial is graded, an infrastructure failure, denied or
  unrun, and summaries keep those
  denominators apart. `--arm` runs the paired experiment's arms 1 (an outline with every action),
  2 (vision first) and 5 (`Agent.run`) on the same seeds; arms 1 and 2 use a bench loop over the
  public `Tools`. The bench is an `effect/cli` program (`run`, `report`, `judges`) on `Config` and
  `FileSystem`; its results are versioned Schema records, and a report states its estimand and
  tests arms with exact paired tests. Paid runs remain opt-in.
- `demos` (private): a static site that replays bench runs recorded with `--record`: the
  screencast as video, the planned pointer path, agent turns, a narrator's captions (`--narrate`)
  and the pictures a model was shown, with each run's grade against the page's truth. Agent runs,
  human-versus-raw input and scripted understanding replays are recorded; model comparisons and a
  policy demo are not yet.

`effect-agent-browser` and the Effect Agent dependency are gone: the agent loop is `effect/ai`'s
`Chat` with the browser toolkit. The tests run against real local Chromium, a fake Browserbase API
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
  could measure and narrows it while frames flow, a crop over CDP no longer pauses a running
  capture, and a capture's start has a deadline. So are the replay and readiness fixes: replay
  refuses the review's six drifts rather than act in the wrong place, `ready` waits out a loading
  screen in one call to the page, and a stalled connection no longer reads as a still screen. Its
  beta, `0.3.0-beta.1`, is prepared in the changelog and the package versions, and is not tagged.
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
  create's session is found by its own nonce and ended. Its beta, `0.3.0-beta.2`, is prepared in
  the changelog and the package versions, and is not tagged.
- **Phase 3, concurrency and presentation, is under way.** Per-page admission has landed: the
  browser-wide input lock is gone, reads follow the action in flight and keep their work, a wait
  fails `Busy`, pages have a budget, and guarded typing approves its field once. So have the stage,
  the presenter and the wait after input: `humanize` and its fixed sleeps are gone. And so have
  windows: a page's events, changes and frames over a window that can end in the past, moments as
  windows that end at a picture and record what they could not read rather than fail,
  `stillness`, and `page.state`.
- **Phase 4, contexts and follow-ups, has begun.** Stored contexts are durable across processes:
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
  session, `device-width` media queries with it, while the window stayed 1280×720.

Size against the baseline at `ab326c1`: lines of each package's TypeScript (`wc -l`), with
`src/testing` counted apart, and the `export` statements of its public modules.

| Package                        | Source lines                   | Test lines      | Top-level exports         |
| ------------------------------ | ------------------------------ | --------------- | ------------------------- |
| `effect-browser`               | 8,871 → 15,500                 | 11,064 → 16,881 | 129 → 190                 |
| `effect-browserbase`           | 807 → 1,410, and 595 `testing` | 611 → 1,819     | 32 → 36, and 14 `testing` |
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
`latestFrame` and the browser's own listeners for loads paid for in part. Without them, phase 1
leaves the package at 11,431 source lines, against a soft ceiling of about 11,000 through phase 4.

## Not rebuilt yet

0.2 did much that 0.3 does not do yet. A capability inventory of the 0.2 code, the plans, the open
PRs and the in-progress work marks each capability as rebuilt, left for later, or the consumer's to
build. The 0.2 PRs are closed, except #164, kept open as a reference.

The larger pieces left for later:

- recording to video files;
- operator handoff and uploads;
- the paid hosted checks.

## Releases

The latest release is `0.2.0-beta.9` of `effect-browser`, `effect-browserbase` and
`effect-agent-browser`, published on 2 October 2026 from tag `v0.2.0-beta.9` (`976d316`) on the
`beta` dist-tag. 0.3 is not released. It will be released by plain npm trusted publishing from
`.github/workflows/publish.yml`, as `effect-browser`, `effect-browserbase` and
`effect-browser-human-strokes`; [RELEASING.md](RELEASING.md) has the steps, and
[CHANGELOG.md](../CHANGELOG.md) lists what each release changes.

## History

The 0.2 code, its records and its media are in Git history: `1ed8259`, the last `main` before 0.3,
holds all of it.
