# Status

The latest release is `0.3.0-beta.24`. [CHANGELOG.md](../CHANGELOG.md) lists what each release
changed and how it was checked.

## 0.3

0.3 is a rewrite of the 0.2 set on stable Effect 4 and `effect/ai`, currently pinned to `4.1.2`,
with agents on Yielded Agent, the renamed Effect Agent:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Moment`. It has no agent code.
- `effect-browserbase`: the Browserbase REST client, and sessions as a `Browser`. Stored contexts
  and uploaded extensions are managed through the client. A persisting `make` holds its context
  through a `ContextLease` from before its create until its save settles: the default lease
  excludes writers in the process, and an application provides its own, such as an advisory lock
  in its database, to exclude them across processes. A release confirms the session ended and says
  so, `Settled` or `Unconfirmed`. An unconfirmed release, a create whose answer was lost, or a
  session kept past its scope leaves the context unsettled, through the lease: the next writer
  ends the context's sessions, which `make` labels in their user metadata, before it writes, and
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
  release outcome last, a loss with its cause. `Browserbase.generations` supplies hosted sessions
  to `Supervisor.make`, and `Browserbase.attach` resumes a session another process left running.
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
- `effect-agent-browser`: pages as a Yielded agent's browser tools, through a controller pinned to
  one page or following a browser's tabs without taking the screen: the ref and control tools
  Yielded Agent defined until `0.1.0-beta.174`, and pointer tools for what has no ref, such as a
  canvas game or a chart. An observation is the page's outline with its controls as values,
  and one after an action begins with what followed it: a dialog and how the browser answered it, a
  navigation, a tab it opened and what its input visibly changed. Every action result says whether
  its input reached the browser, and nothing is retried. Before each turn the model sees a
  screenshot of the current tab, as context the run never keeps; with `vision: "moments"` its
  thread holds instead, after each turn's tool results, a moment of the tab since the turn before,
  immutable accounts that Yielded can prune and summarize with the conversation. The latest three
  moments' frames remain as turn-labeled references outside compaction coverage, and older image
  bytes are released. Lost pages and moments without usable pictures stop preparation before
  another model call; queued zoom crops only accompany their original tab. Bounded model contexts
  can compose a model-aware image-token estimator with the tools' preparation, as the package
  README shows. `wait_still` waits for
  foreground stillness. Yielded runs the agent: its loop,
  policy and budgets, approval, context and run events. The package pins the published npm
  artifact of `@yielded/agent` `0.1.0-beta.191`. The packed
  check installs it from the registry with npm and with Bun's isolated linker, holding each to
  the registry integrity and to one copy of each runtime package. Earlier releases used a
  commit-pinned release-candidate archive from `vendor/yielded-agent`; it remains available for
  their consumers, as [RELEASING.md](RELEASING.md) records. Its layer also provides the run's
  controller as `BrowserTools.Controller`, so an application's own tools act on the tab the model
  sees, with the run's task.
- `effect-browser-tradingview` (unpublished): a TradingView chart's state, studies, bars and study
  values, and the viewport points of times and prices, read from the chart's model. `ChartInput`
  changes the chart as a person does, with its toolbar, hotkeys, searches and dialogs, and the API
  corrects or completes a change. `ChartTools` serves both as a Yielded agent's tools and as a Code
  Mode program's methods. It is checked live on the Advanced Charts demo only; tradingview.com
  refuses drawings when signed out.
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
  in 29 (`0.3.0-beta.4` in the changelog). The outline is
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
- `bench` (private): twenty-four tasks over canvas games, live charts, dense quote tables, orders,
  navigation, forms, a board, menus, a catalogue, an icon toolbar, a seat map, look-alike payments
  and a market board whose prices tick, flash,
  scroll out of view and keep ticking or stop, graded against seeded page truth and captured evidence; an understand task's
  page records its changes from before its setup. The nine operate tasks' pages vary with the seed,
  and `--split eval` holds a family of seeds out for comparing arms. Trials run with separate
  browsers and bounded concurrency, task-specific reasoning defaults, elapsed-time metrics and a
  shared model admission budget. Every trial is graded, an infrastructure failure, denied or
  unrun, and summaries keep those
  denominators apart. `--arm` runs the paired experiment's arms 1 (Yielded's tools alone),
  2 (vision first), 5 (the default tools), 6 (the default tools with moments in the thread), 7 and
  8 (Code Mode programs), and 9 and 10 (pictures by page or on request) on the same seeds, each a
  Yielded agent on the task's
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

## Not rebuilt yet

0.2 did much that 0.3 does not do yet. A capability inventory of the 0.2 code, the plans, the open
PRs and the in-progress work marks each capability as rebuilt, left for later, or the consumer's to
build. The 0.2 PRs are closed, except #164, kept open as a reference.

The larger pieces left for later:

- recording to video files;
- operator handoff and uploads;
- the paid hosted checks.
