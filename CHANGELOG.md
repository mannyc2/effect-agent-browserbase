# Changelog

Each release lists what changed since the release before it. From 0.3 on, `effect-browser`,
`effect-browserbase` and `effect-browser-human-strokes` are released together at one version.

## Unreleased

### Added

- Per-page admission. Each page admits its operations in one lane of its own: an action, which
  sends input or navigates, has the page to itself, in the order actions were asked, and reads
  share it, after the action in flight and every action asked before them, so a read describes the
  page an action left. A wait for a turn ends at the operation's deadline as the new reason `Busy`,
  with `waitedMillis` and how many operations were `ahead`; `consequence` says to repeat it.
  `Page.failFast` runs operations that fail `Busy` at once instead of waiting.
- Reads keep their work. An identical read asked while one is in flight on the page, with no action
  between them, joins it, so they cost one call between them. A read runs in the page's scope under
  the action timeout whoever gives up, and one that ends after all its callers gave up serves the
  next caller to ask the same within an action timeout, until the page's next action or document.
  An action stops the reads nobody awaits rather than wait for them.
- Receipts. Each browser tool answers with a `Tools.Receipt`: what it did and, for an action, what
  followed on its page while it ran, from the page's events at no call and its changes in one: the
  `Action` it recorded, the dialogs that opened and how each was answered, where the page went, the
  tabs it opened and what visibly changed, with what could not be read in `missing`. A model is told
  it as text, what the call did and then what followed, up to three of the changes its input
  caused; a caller reads the value, in `Agent.Step.results` or `generateText`'s tool results, and it
  crosses a process boundary as JSON. A failure is the call's `BrowserError`, told to a model with
  what to do about it, `Busy` included.
- One contract per page operation: its parameters, its receipt and `BrowserError` as schemas, and
  one handler over a page. The tools (`Tools.PageToolkit`), the operations bound to a page
  (`Tools.on(page)`) and an RPC group (`Tools.PageRpcs`) are its projections, so
  `PageRpcs.toLayer(Tools.on(page))` serves a page's operations to another process, where they
  answer with the same receipts and failures.
- Tools take what they act on as a value. `Tools.make({ page })` pins them to one page, with no
  `browser_tabs`. `Tools.make({ browser, follow })` acts on the tab the model last saw, offers
  `browser_tabs`, and shows a tab that opened at the next look as `follow` says: `"select"`, the
  default, makes it current without bringing it to front, so the page on air and an operator's view
  stay where they are; `"front"` also brings it to front; `"never"` keeps the current tab.
- `Agent.run(task, { page | browser, follow, observe, tools, system })`. `observe` is what the model
  sees of the page, a function of it; `Agent.observe("outline" | "screenshot" | "both")` are the
  default's three, which read what they can and name what they could not. `tools` makes the run's
  tools from the default ones, its own definitions and handlers, to remove, rename, wrap or add
  them; `done` and `give_up` stay the agent's. `system` makes the system prompt from the standard
  one.
- `AgentError` keeps the run's `usage` and its `history`: a failed run is the one worth reading.
- `Page.correlate(id)` gives the actions an effect performs a caller's id, which each `Action`
  records as `correlation`; the tools give each call's actions the model's call id.
- `PageOpened.opener`, the page that opened a tab, whose own events and windows now hold the tab's
  opening; and `DialogShown.answer`, how a dialog was answered.
- `Browser.Options.maxPages`, with the new reason `Limit`: at that many open pages, those a site
  opened included, `newPage` waits within the action timeout for one to close, then fails `Limit`,
  or fails at once under `Page.failFast`.
- `Stage`: the source of a live output. `Stage.make({ quality, size })` is scoped, one per output;
  `stage.present(page, { at })` switches it to a page, in the same browser session or another, at
  `at` or at once, and returns `Presented { page, at, latency }`, stamped with when the switch took
  effect on the frame clock. It starts the new page's capture ahead, turns on its first frame once
  `at` has come and input under way on the old page has ended, then stops the old capture: the
  captures overlap, so a switch shows no dark spell. On Browserbase, two captures in one session ran
  together at the frame rate of one, where stopping first left 250 to 295 ms dark. A first frame
  that does not come in time fails `present` with `Timeout`, and the old page stays; a capture that
  fails restarts on its page while the page and browser stand. `stage.frames`, `stage.current` and
  `stage.stats({ window })`, the presented page's capture counts.
- `Presentation`: input performed for viewers, as an explicit view. `Presentation.make({ pacing,
  motion })` is scoped and owns one drawn pointer; `presenter.view(page)` is the page with its
  actions performed, while the page itself stays plain. Each action first waits as a person reacts,
  by `Presentation.human`'s medians: 280 ms after an expected change, 600 ms after a new document
  and 1 second on another page. The pointer glides from where viewers last saw it, on whichever
  page; a field is clicked before typing; keys go at 70 words a minute; the wheel turns in 100 px
  notches, in bursts. One view acts at a time, and presentation time, its glides and typing, has a
  budget of its own outside `actionTimeout`, so a drag may glide twice for 5 seconds.
  `view.aim(target)` starts the glide as soon as a target is known, as in a model's streamed tool
  call, and the action on that target completes it.
- `Motion.lognormal`, the tuned two-stroke planner, as a value, and `HumanStrokes.motion`, which
  loads the recorded strokes as a planner, for `Presentation.make`.
- `Frame.session`: every frame names its browser session, as `Browser.Service.id` gives it.
- `Moment.Window` and `Page.window({ since, until })`: a page's events, changes and frames over one
  window of the browser's host clock. A window can end in the past, at a frame a delayed consumer
  airs seconds after it was painted, so that what it writes now tells what its viewers will see; it
  can go on exactly where a previous one ended. Its events and frames cost no call and its changes
  one. A part that cannot be read is in `missing`, with why, and the window is still made.
- `Moment.stillness(window)`: how long a window's page had been still at its end, by the last
  change in view its record shows or the last paint among its screencast frames, and nothing where
  neither could see.
- `Page.state`: what the library already knows of a page, at no call and with no wait for its turn:
  its address, its document and when it was committed, how far it has loaded, its newest frame,
  and the viewport's text and title as last read, each with when it was learned.
- `ContextLease`, a new `effect-browserbase` module: who may write a stored context, as a service
  the application provides. `hold(context)` holds a context for a scope, waiting while another
  holds it, and passes on how the writer before left it, `unsettled` while a session that saves to
  it may still run. `ContextLease.layer` holds contexts within the process that builds it, as
  `Browserbase.open` did before; an application whose writers run in several processes provides
  its own, such as an advisory lock in its database, which reads a holder that never said, as one
  whose process was killed, as unsettled. `open`, `reconcile` and `verifyContext` hold contexts
  through it, from before a persisting create until its save has settled.
- `Browserbase.verifyContext(contextId, check)` reads a stored context back, as a login: a session
  that loads the context and saves nothing runs `check` on its browser and is released. It holds
  the context meanwhile, so it reads what the last writer saved, once that save settled, never
  beside a writer, and ends first a session a writer before may have left saving to it.
- Keeping a session past its scope: `Browserbase.supervise({ keep })`, a name, leaves the current
  session running as the supervisor's scope closes, rather than releasing it, and the first
  generation of the next `supervise` under that name adopts it, with its pages and their ids, so a
  deploy or a restart keeps prepared pages and a signed-in state. Its sessions are created with
  `keepAlive` and labelled `keptAs` in their user metadata; other sessions kept under the name are
  ended as one is adopted. It is off by default, since a kept session bills until adopted and
  released or until its timeout, and `retire` always releases. A kept session that saves to a
  stored context leaves the context unsettled, so any writer but the adopting supervisor ends it
  first. Underneath, `Supervisor.Options.keep` closes the serving generation's scope without
  asking its provider to release it, published as the new state `Kept`.
- `Browserbase.attach` is resume: from another process too, a page is found again by its id. It
  refuses a session that has ended, failing `Closed` by the session before it connects.
- `TestBrowserbase`'s sessions tell whether each was kept alive, and the stored context it loaded
  and whether it saves to it.

### Changed

- `Chromium.layer` leaves signals to the program. Playwright's handlers closed every browser on
  SIGINT, SIGTERM and SIGHUP, and on SIGINT then exited the process, so no finalizer ran. Under
  `NodeRuntime.runMain`, an interrupt closes the browser with its scope.
- A page waits only for itself: the browser-wide input lock is gone. A click on one page no longer
  waits for typing at a person's pace on another, which held an on-air click for about 9.5 s in the
  release review, and failed it undispatched at 10 s with 100 characters.
- Guarded typing approves a field once. Plain text goes into the approved field in one insertion,
  so a guarded 2,000-character paste takes 15 ms locally and half a second at a 70 ms round trip,
  where each key used to wait for the keys before it and a focus check: 6.3 s locally and
  4.8 minutes at 70 ms. Typing key by key, as a presenter's view does, checks that the field still
  has focus before each space, which could press a button, and after its last key, rather than
  before every key.
- `viewport` reads in the page's turn, within the action timeout. `title` is the browser's record
  of the document's title, in one call that a page busy with a script cannot hold up, and empty for
  an untitled page; it used to wait for a busy page without bound, and a connection that dropped
  meanwhile made it empty rather than fail.
- `Agent.run` does not observe the turn that ends the run, so an answer costs no picture after it.
- The agent shows at most 8 crops after a batch, and says how many it left out; `browser_zoom` no
  longer refuses a ninth.
- The wait after input has no fixed sleep. After a click, a key, a submit or a scroll, the page gets
  a task and a frame, in one call, which also spans any navigation the input asked for, as a link,
  a form or a handler's timer does; a document that committed meanwhile is waited for until it is
  parsed. A click used to sleep 120 ms (250 ms humanized) and a scroll 150 ms: ten clicks on a page
  that navigates nowhere took 1.65 s locally and 3.75 s at a 70 ms round trip, and take 0.5 s and
  3.25 s. `pushState` and a 204 answer wait for nothing, and a navigation a handler starts once a
  fetch answers is the next look's to see, as it was.
- A moment never fails because a part of it did. A picture, a read of changes or an outline that
  cannot be had is in its `missing`, with why, and `Moment.toPrompt` says what it could not read
  and why, and shows no older frame as the moment. A failed read of changes used to be dropped, so
  a moment of a page whose connection was lost said only that changes were not recorded, and a
  failed picture failed the moment.
- `Moment.toPrompt` tells a failed action only as failed: its error, which may name a ref or advise
  the caller that acted, is left out.
- `PageLoaded` comes from the page's own session, as `Navigated` does, so a document's load always
  follows its commit.
- A crop leaves the page's screen as it was. Chromium takes a clipped picture through the device
  emulation of the session that asks for it, then restores what that session emulated, so a crop on
  the page's own session, as over CDP and on Browserbase, cleared a screen another session
  emulates: on Browserbase, `screen` went from the session's 1280×720 to Chromium's default
  800×600, `device-width` media queries with it, until the page next navigated to another site. The
  page's own session now holds a copy of the screen the page reads from the page's first clipped
  picture on, which costs that picture two more calls, and every later picture restores it.
- A page's pictures go one at a time. Each restores the view's size it found, so two crops asked
  together left the page's view at the first one's size: in ten tries of two zooms at once,
  another session's whole picture of each page then showed only the first region.
- `Page.waitForText` is one call, which the page answers as the text comes, looking every 250 ms,
  or at the deadline, where it was a `find` every 250 ms: a text that came 600 ms on took four
  calls. It follows the action in flight but holds no later one back while it waits, and waits on
  in a document that replaces the one it began in.

### Breaking

- A wait behind other operations on the page fails `Busy`, not `Timeout`, and `Reason` has `Busy`
  and `Limit` beside the rest, so a caller that handles reasons by tag has two more to handle.
- Reads wait for the action in flight on their page: a snapshot, `find`, `text`, `changes`, a
  picture or a zoom no longer runs while an action is changing the page, and an action waits for
  the reads before it.
- `Page.observe`, `Page.Observation` and `Page.ObservationMode` are gone: what the agent shows a
  model is a function of the page, `Agent.observe(mode)` by default.
- `Tools.make` and `Agent.run` take a page or a browser, and no longer read the `Browser` service.
  `Agent.Options`' `instructions`, `observation`, `additionalTools` and `tools` as `Tools.Options`
  are gone, as is `Tools.Options`: `system`, `observe` and `tools` replace them.
- The tools answer with a `Tools.Receipt`, and fail with a `BrowserError`, rather than text; the
  definitions `Tools.Navigate` to `Tools.Tabs` are `Tools.PageToolkit.tools.browser_navigate` and
  the rest, and `Tools.BrowserToolkit.tools.browser_tabs`. `Tools.Tools` has no `takeZooms` or
  `refusals`: a crop is in its receipt and a refusal in its failure.
- Tools that follow tabs act on the tab the model last saw until it looks again, so actions in a
  batch no longer refuse after a tab opens; after `browser_tabs` switches, actions wait for a look.
  Neither `browser_tabs` nor a new tab brings a tab to front unless `follow` is `"front"`.
- `DialogShown` has `answer`, and `AgentError` `usage` and `history`, which a program that builds
  them must give.
- Under a guard, plain typing sends no key events: the text arrives in one insertion once its field
  is approved, so a page listening for key events sees none.
- Each page has its own pointer, where its own last move left it; a glide on a page starts there,
  or mid-viewport, not where input on another tab left the pointer. A presenter's views share its
  one drawn pointer instead.
- `Browser.Options.humanize`, `TypeOptions.prose`, the `prose` parameter of `browser_type` and the
  `prose` action option are gone: input is plain, and a presenter's view performs it. Corrected
  slips go with `prose`. Plain input never glides, holds a press or types key by key at a person's
  pace, whatever presents its page.
- `Motion.Motion` is gone, and with it `HumanStrokes.layer` and `HumanStrokes.provideTo`: a planner
  is a value given to `Presentation.make`, so a misplaced layer can no longer be ignored in silence.
- `Page.Settings` is internal.
- `Frame` has a `session`, which a program that builds frames must give.
- `Moment` is a `Window`: its `from` and `at` are `since` and `until`, and it has `missing`, which a
  program that builds moments must give. `Moment.capture`'s `since` is a window's: a previous window
  or moment, a frame, a host time, or a `Duration` back, so a number is a host time now, not
  milliseconds back, and a duration is a `Duration`. A moment whose picture could not be taken ends
  when it was read.
- `Page.latestFrame` is gone: `page.state` has the newest frame.
- `Browserbase.open`, `layer`, `supervise`, `reconcile` and `verifyContext` need a `ContextLease`:
  provide `ContextLease.layer` for one writer per stored context in the process, as before. The
  process-wide record of writers is gone, so no layer or test inherits a context another left
  unsettled. `reconcile` can fail with `ContextHeld` when a lease cannot be taken.
- `Browserbase.ContextHeld` is `ContextLease.ContextHeld`, beside the lease that can fail with it.
- `Supervisor` asks a generation's `release` before it closes the generation's scope, so what the
  scope holds, such as a stored context's lease, goes only once the release has reported.
- `Supervisor.GenerationState` has `Kept`, so a program that switches over it has one more case.

## 0.3.0-beta.2 (unreleased)

Identity and lifetime: pages named by their target ids, with a typed life story, the browser's
loss and its cause, `consequence` and redacted addresses; `Supervisor`, with Browserbase releases
that confirm the end and `reconcile`; the capture connection; and the change record, which moments
lead with.

### Added

- `Supervisor`, a new module: a browser kept open across losses and session ends, as generations
  from a provider's `open`. `browser` waits, bounded by `waitTimeout`, for the current generation,
  and every caller shares one open, which runs in the supervisor's scope. A loss is published at
  once and the next generation opens on the `reopen` schedule, which also retries a failed open
  unless the provider deems that failure `definite`: such a generation is `Down` at once, carrying
  its cause, which `Unavailable` also gives anyone waiting. `rotate`, or the time `rotateBefore`
  ahead of a generation's `expiresAt`, makes the next generation before it breaks the current one,
  or breaks first when generations are `exclusive`; `retire` stops at once and releases what is
  open. `states` streams each generation's `Opening`, `Reopening`, `Open`, `Lost`, `Down` and
  `Closed`, the last with the release outcome, `Settled` or `Unconfirmed`, as `Generation` values.
  Pages don't carry over between generations.
- `Browserbase.supervise`: Browserbase sessions as `Supervisor` generations. Sessions that persist
  to a stored context are exclusive. An open that Browserbase refused, as for a bad key or an
  invalid request, is `Down` at once, rather than reopening on a schedule for five minutes; a
  context held is not refused, since each try ends its sessions again.
- `Browserbase.reconcile(contextId)` ends a stored context's running sessions, found by the
  `persistsContext` label `open` puts in their user metadata, confirms they ended, and lets the
  context go after `contextSettle`: the way to end sessions another process left running, without
  opening one.
- `Browserbase.ContextHeld`, its own error beside `BrowserbaseError`: a session that saves to the
  stored context may still run, so `open` did not write to it. A context whose writer's release was
  left `Unconfirmed`, or whose create's answer was lost, is no longer held with no way out: the
  next `open` on it ends the context's sessions first and goes on, or fails `ContextHeld` while
  they cannot be confirmed ended, so each try is a way out and two writers are never let in.
- `effect-browserbase/testing`: `TestBrowserbase`, the Browserbase API in memory as an `HttpClient`,
  whose sessions run until released or until their timeout on the Effect `Clock`, with a `Script`
  of lost creates, listed at once or `listedAfter` a while, pending or refused releases and failed
  status reads; and
  `BrowserbaseContract.checks`, what the package relies on Browserbase to do, which the fake
  passes. Its ids are UUIDs, as Browserbase's are, and it answers each id shape as Browserbase
  does: a malformed session id is refused, where an unknown well-formed one is not found.
- `browser.page(id)` finds an open page by its id, which is now its CDP target id: a new connection
  to the same browser, as after a dropped one, finds each page under the id it had.
- A page's life on the browser's timeline: `PageLoaded` as a document finishes parsing and loading;
  `Navigated` with `sameDocument` for a move within the document, such as `pushState`, and
  `document`, counting the page's documents from 0 within one `Browser`; and `PageUntracked`, a tab
  the site opened that the library could not track, which used to go unreported.
- The browser's end: one `Disconnected` event, and `browser.disconnected`, which completes with its
  `DisconnectCause`: `connection`, `session` (at or after the provider's `expiresAt`) or
  `released`. `browser.expiresAt` and the `SessionEnding` event carry the session's end, which
  `Browserbase` passes on through the new `Cdp.Options.expiresAt`.
- `Frame.document` and `Frame.url`: the document each frame followed and the page's address then.
- `BrowserError.consequence(error)`: what a failure leaves, `lost` (`nothing`, the `page` or the
  `session`) and whether to `repeat` it (`safe`, `check` first, `pointless` as it is, or `resume`
  from a newer cursor), from its reason and `dispatched` alone.
- `Browser.InitScript`: an init script runs only in documents whose address its `match` finds.
- A Browserbase create whose answer named its session but did not decode is `Decode` with
  `released`, whether the client then released the session.
- The capture connection: on Browserbase, pages' screencasts run on a second connection to the
  session that carries nothing else, so a frame and its acknowledgement never wait behind a large
  message, such as an upload or a read's answer, on the connection that drives the page. On a
  hosted session, with another tab reading and uploading, the on-air page's longest wait between
  frames was 352 ms, against 1,802 ms on the old path. `Browserbase.Options.captureConnection:
  false` turns it off. It is read-only: a page's session on it sends only the screencast's
  commands, the Page domain and the frame tree, and frames carry the document their own
  connection saw commit, numbered as `Navigated` numbers them. A failure of the connection alone
  ends the capture with `Failed`, two seconds on, leaving the page and its own session as they
  were, and the next capture opens another. When the browser is lost too, the capture's readers
  are told the browser's loss, whichever connection hears the end first.
- `Browser.CaptureSource` and `Cdp.Options.capture`: the port a provider supplies its capture
  connection through. Without one, a capture runs on the page's own session, as before.
- `Change`, a new module, and `Page.changes({ since, until, unmask })`: what visibly changed on a
  page over a window, in one call to the page, element by element. Each `Change` is text that
  changed, appeared, disappeared or came and went (`brief`), a field's value or the title, with
  its `subject` and structured context (row, column, label, heading), what it showed at the
  window's start and end, how often it changed, the lowest and highest of a number that changed
  more than once, when it last changed before the window, and the trusted input it followed where
  it was that input's doing (`cause`). A cause needs a change that was not in flux, neither
  changing nor gaining or losing a sibling in the 10 s before the input, so a ticker's tick or a
  feed's line names no click; and out of the input's reach, its row, form, dialog or controlled
  element, it needs a page that was still for the 2 s before, so a portal's menu keeps its click
  and a chat line beside a ticking board does not. A page records once something reads its
  changes, and then from the start of each later document, until nobody has read it for two
  minutes; a page nobody reads records nothing and costs nothing. The record keeps 256 elements
  with their last 32 changes for a minute; an element that keeps changing gives way before news,
  and `Changes.dropped` counts what gave way, with `Changes.from` past it. A window can start at
  the previous read's `cursor`, exactly, or at a frame's paint, and end at a frame's paint. Field
  values read `••••` unless unmasked.
- `Moment.changes`, and `Moment.CaptureOptions.unmask`: a moment reads what changed up to its last
  frame's paint, from where the previous moment's changes ended; a page that cannot say, as while
  it navigates, still has its moment.

### Changed

- `Page.ready({ quietMillis })` also waits, where the page's changes are recorded, until nothing in
  view has changed for the spell, so frames a browser holds back cannot pass for a still page.
  Where the capture runs on a capture connection, the spell also ends with one round trip there,
  `Page.getFrameTree`, whose answer comes behind any frame still on its way, so a stall on that
  connection is not stillness either. The control connection's cost is unchanged.
- Every address the library reports, in events, frames, reads, errors, a guard's request and the
  outline's links, loses its userinfo, and each credential's value reads `Page.redacted`. A
  credential is a query, fragment or path parameter named for a token, secret, password,
  signature, assertion, session id or one-time code, or for a code or key that signs someone in,
  such as `verification_code` or `api_key`. `code`, `key`, `session`, `sid` and `ticket` as often
  name what a page shows, so under them only a value that looks generated, of at least 16
  characters with letters and digits, is one. The rest keeps its identity, such as a chart's
  `?ticker=ETH` or `?code=BTC`.
- `Plan.fromEvents` makes a navigation to an address with a credential withheld an input slot,
  `address`, so replay goes where the caller says, and never to the address without its credential.
- A crashed page is closed, so its calls fail at once, `Closed` as crashed, instead of at their
  deadline; and a lost browser fails the calls in flight on its pages, and its screencasts'
  readers, `Closed` by its loss's cause.
- A Browserbase create whose answer was lost, or answered 5xx or 408, ends the session it may have
  made, persisting or not, found by the nonce its create carried. Browserbase can list a session
  late, so it is looked for, more and more seldom, for up to 30 seconds, before a persisting
  context's `contextSettle`; a failed open takes that much longer. Before, only a persisting
  session was looked for, once, and any other ran and billed until its timeout.
- A page's registration sends its target id, focus emulation and the Page domain in one round trip,
  and the first read and the first capture no longer send the target id or the Page domain. Opening
  over CDP costs 33 calls: these two, and focus emulation, which the old count of 30 missed as it
  went out after `open` returned. A first read costs 3 calls, from 5, and a first capture 8, from 10.
- `BrowserError.message` is a sentence for operators; the browser tools add what a model should do,
  such as taking a new snapshot after a stale ref. A crop's caption names its tab by number.
- The tools say when a tab's title could not be read, rather than calling the tab untitled.
- A Browserbase answer of 400 is the reason `InvalidRequest`, not `Status`, so a request Browserbase
  refuses as malformed, such as a session id that is not a UUID, reads the same as one this client
  refuses before sending.

### Breaking

- `Browserbase.open` and `attach` give a `Hosted`, `{ browser, session, release }`, instead of the
  `Browser`. `release` disconnects the browser, which is lost as `released`, then ends the
  session, confirms it ended, and gives the outcome; for `open`, the scope's close runs it too,
  once.
- A Browserbase release confirms the session ended: it reads the session, trying again a second
  apart for up to a minute, including after a failed read. A session still running then is
  `Unconfirmed`, and its context is left for the next writer to clear. Before, a failed release was
  a logged warning, and the context was let go after a minute whatever the session did.
- `Browserbase.open`, `layer` and `supervise` can fail with `ContextHeld`, so a caller that handles
  their errors by tag has one more to handle.
- A session `open` creates carries `createNonce`, its create's own, in its user metadata, and a
  persisting one `persistsContext: <context id>` too, beside the caller's own.
- `page.id` is the page's CDP target id, not `p<n>`, and `browser.pages` lists pages in the order
  the browser began tracking them.
- `browser.page` finds a page by id; the first open page, opening one when there is none, is
  `browser.firstPage`.
- `Closed` carries its `cause`: `page`, `crashed`, `connection`, `session` or `released`.
- `PageClosed` carries its `cause`, `page` or `crashed`, and a page lost with its browser has none:
  `Disconnected` stands for them all.
- `Navigated` comes from the page's own protocol session and carries `document` and `sameDocument`;
  `Frame` carries `document` and `url`.
- `Page.close` fails with a `BrowserError` when the page could not be closed, and succeeds once it
  has.
- `Browser.Options.initScripts` takes `{ match, source }` objects, not strings.
- `Supervisor`'s `Lost` carries its `cause`, and `Opened` no longer takes `expiresAt`: the
  supervisor reads the browser's.
- `Moment.toPrompt` leads with what changed, news before what keeps changing and cells of a column
  that changed together as one line, and names an action as what a change followed, or as a step
  where changes followed it but none names it, where its effect is drawn, such as a click on a
  canvas, or where it came before the record began. Hovers, scrolls and attempts that nothing
  followed are left out. A moment whose record saw none of its window, as a page's first, or that
  has no record of changes lists every step, as before, and says what changed was not recorded;
  one whose record began within the window claims nothing before. The prompt's wording changed
  with it.
- `Page` has a `changes` member, so a hand-made `Page` needs one.

## 0.3.0-beta.1 (unreleased)

Cheaper pictures and reads, and replay: pictures and reads on each page's own counted protocol
session, a clock measured on first need, `Page.find`, `Page.text`, `Plan` and `Page.ready`.

### Added

- `Page.find(query)`: in one call to the page, the elements that a query of `role`, `name` (a
  string or a `RegExp`), `text` and `near` (words of an element's context) matches, in the viewport
  or the whole document. Each is a `Found` with a ref the actions take, its `Subject`, its box,
  whether it is in view, and its state. It replaces 0.2's structured controls.
- `Page.text({ scope, maxChars, unmask })`: in one call to the page, the text the viewport, or one
  element, shows. What fields hold reads `••••` unless `unmask` is set; secret fields always do.
- `BrowserEvent.SubjectContext`, `Page.ElementState`, `Page.FindQuery`, `Page.Found`, `Page.Text`
  and `Page.TextOptions`.
- `Plan`, a new module: a walk recorded once from a page's events and replayed on a fresh page, by
  subject, with no model call. `Plan.fromEvents` keeps a page's completed actions with their
  subjects and options, its navigations with the address asked for and the one reached, and typed
  text as named input slots, never the text. `Plan.replay(page, plan, { settle, inputs })` waits
  for `Page.ready` before each step that acts, finds the one element the step's subject names with
  `Plan.locate`, by role and name among the elements that repeat all of its recorded context, and
  acts on it. Text typed into focus is typed again into the field it went into, and a slot first
  typed into a secret field (`Step.secret`) only into a secret field. It stops at the first step it
  cannot take with a `Plan.ReplayError`: `Missing`, `Ambiguous` (there is no ordinal), `Drifted`,
  or the step's `BrowserError`. A plan is version 1, so a plan 0.2 stored does not decode.
- `Page.ready({ quietMillis, timeout })`: in one call that checks in the page until it is ready or
  the time is up, whether it is ready to be shown: its document parsed and painted since, nothing
  that ends animating in view, its fonts and the images in view loaded, nothing in view marked
  `aria-busy`, and something shown: text, a canvas drawn on, a picture or drawing larger than an
  icon, a video or a frame. With `quietMillis`, the screen must also stay still, counted from the
  first frame of a capture the wait starts and only while every frame's acknowledgement is
  answered, and the spell ends with one more call to the page, so a connection that stalls is not
  taken for a still screen.
- `TypeOptions.secret`: `type` refuses, before any input, a field the page does not mark secret.
- `FindQuery.at`: what a point action at a viewport point would reach.
- `BrowserEvent.ActionOptions` and `Action.options`, the rest of what an action was asked, such as a
  click's count or `submit` on `type`; `BrowserEvent.Box`, with `Action.box` and
  `ResolvedTarget.box` for what an action at a point found there.
- `Page.frame({ maxAge, after })` and `Page.FrameOptions`: a frame states how old it may be. The
  newest screencast frame serves when it was painted at most `maxAge` ago (250 ms by default; 0
  always takes a new screenshot), and with `after: "input"` only when painted after the page's
  latest input. `Page.screenshot` takes `maxAge` and serves only a frame painted after that input.
  No read serves a frame painted before the page's current document began, so a page that keeps
  painting while the next one loads is not what a read shows once the navigation returns.
- `CaptureStats.duringPictures`: frames left out because they may have been painted, or arrived,
  while the library took a clipped or scaled picture of the page.
- `Page.captureStats({ window })` counts over a window of up to the latest minute, gap statistics
  included; `captureStats()` still counts over the page's life. `CaptureStats.ackBacklog` is the
  acknowledgements of frames not yet answered, which slow a screencast over a slow connection.
- Every page span reports its protocol cost on the page's own session: `calls`, `bytesOut`,
  `bytesIn` and `waitedMillis`. A picture's `source` is `frame` or `screenshot`.

### Changed

- A picture is taken on the page's own session: one `Page.captureScreenshot` where a device pixel is
  a CSS pixel and nothing is cropped, and two, with Playwright's clip over the page's layout metrics,
  for a crop or another device pixel ratio. In a context without a viewport, such as the default
  context `Cdp.open` and Browserbase use, the first picture of a document no longer sends
  Playwright's 335 KB injected script, which took up to a few seconds on Browserbase while
  screencast frames waited behind it. Where Playwright emulates the viewport, as `Chromium.layer`
  does, crops are still Playwright's own screenshot, on its own session.
- The page script is registered once per page session, at the library's first read of the page, so
  each new document runs it from its start: a document's first read is two calls, sending no
  script, and a warm read one. The clock probe runs in a world of its own.
- The library's own clipped pictures, such as a zoom, keep their frames out of a running
  screencast, crops with the viewport's own proportions included. A crop on the page's own session,
  as over CDP and on Browserbase, has frames of the crop's own size, so only those are left out and
  the page's own keep flowing; where Playwright emulates the viewport, every frame from the
  picture's call until 50 ms after its reply is.
- Each page's own session holds focus emulation, so a tab behind another keeps painting whatever
  else is attached. A capture starts once the browser has confirmed it, and fails with `Timeout` at
  the action timeout if a renderer stuck in a script never does.
- Opening a browser measures nothing, where a fresh one used to measure its clock and its paint
  delay on a private page first. The browser's first capture maps its clock and waits for that one
  estimate; a later capture starts with the browser's estimate. At 72 ms a round trip, opening a
  browser went from 2.2 to 0.6 seconds, and a later capture's start to its first frame from 0.52 to
  0.23 seconds.
- A busy page answers the clock's probes late, behind its own work: the probes it answered within
  two seconds serve, and the capture fails, undispatched, only if it answered none.
- While frames flow, a capture measures the clock again once the estimate is ten seconds old, and
  every frame is timed by the browser's newest estimate. A wide first estimate narrows once a probe
  finds the page idle, and a capture on air for hours keeps reusable frames.
- Input never waits for the clock: until a capture has mapped it, Chromium stamps input as it
  receives it.
- An estimate of the clock says less as it ages, by up to 100 parts per million of its age. A frame
  carries its estimate's uncertainty at its paint, and a newer measurement replaces an estimate
  that its age has made less certain.
- A clock probe that runs past its two seconds fails with `Timeout`, as every other deadline does,
  not `Failed`.
- Typing and pressing keys no longer send `Page.enable` again on a page the library has read.
- A table row is named by its header, or else its first cell with letters, so a rank or a price
  never names it.
- Typing into focus records the focused field as the action's `subject`.
- Reading the viewport keeps, inside a subtree out of view, what a style attribute pins in view,
  and what is painted at the viewport's probe points beneath a transparent layer.
- A field whose style shows dots for what it holds, as a PIN field's may, is secret.

### Breaking

- `Subject` has a `context`: a table cell's `row` and `column`, the `label` just before an element,
  and the `heading` above it. Every `Action` records it, and `ResolvedTarget` carries it.
- `Snapshot.above` and `below` count the parts of the page skipped because they lie out of view,
  each an element with all it holds, not the outline lines those would have made.
- The outline masks what every secret field holds, not only passwords: one-time codes and card
  fields too.
- A field stays secret once the library has seen it marked secret, so text typed into a password
  its page then reveals is still redacted, and never read back.
- `Page.hasText` is removed: `find({ text, scope: "document" })` answers it, within the action
  timeout. `Page.waitForText` waits for the same match.
- `Page.waitForStill` is removed: `Page.ready({ quietMillis })` waits for the same stillness, after
  the page's own evidence. Without `quietMillis`, `ready` does not wait for the screen to be still.
- `Page.currentFrame` is removed: `Page.frame({ after: "input" })` is the nearest, and its 250 ms
  bound is now the frame's age from its paint, not from its delivery, so frames that arrive late
  stand in less often.
- `ScreenshotOptions.fresh` is removed: `maxAge: 0` takes a new picture.
- `Page.screenshot` serves only a frame painted after the page's latest input, so a caller that acts
  and then looks sees what its action did. `ScreenshotOptions` no longer extends `FrameOptions` and
  has no `after`; `Page.frame({ maxAge })` reads a frame of a stated age whatever came before it.
- `CaptureStats` has the required counts `duringPictures` and `ackBacklog`. `outOfOrder` is `late`
  and `subscriberMissed` is `lost`, so frames that came late read apart from frames a reader lost.
- `Page.captureStats` is a function: `captureStats()` for the page's life, `captureStats({ window })`
  for up to the latest minute, which fails with `InvalidRequest` for a longer or empty window.
- `Browser.captureCalibration`, `CaptureCalibration` with its `delayFor`, and
  `Browser.ContextOrigin` are removed, with the private startup page that measured them. Nothing in
  the library, the bench or the demos read them. `Browser.make` takes no `contextOrigin`, and
  `Cdp.open` no second argument.

## 0.3.0-beta.0

0.3 replaces the 0.2 set with a rewrite on Effect 4.0.0 and `effect/ai`. No 0.2 API carries over,
and nothing translates 0.2 calls into 0.3 ones. [STATUS.md](docs/STATUS.md) says what 0.3 does, and
each package's README documents its API.

### Packages

- `effect-browser` and `effect-browserbase` are rewritten. Both peer on `effect` `^4.0.0` and
  `playwright-core` `^1.63.0`.
- `effect-browser-human-strokes` is new: an optional pointer planner over 32,130 recorded human
  strokes. Its code is MIT and its stroke data CC BY 4.0.
- `effect-agent-browser` and the Effect Agent dependency are discontinued. The agent loop is now
  `effect/ai`'s `Chat` with the browser toolkit, `Agent` and `Tools` in `effect-browser`. The last
  `effect-agent-browser` release, `0.2.0-beta.9`, stays on npm.

### Not in 0.3

- Plans and replay.
- The test kits, `effect-browser/testing` and `effect-browserbase/testing`.
- Structured controls in reads. A read is the text outline (`Snapshot`) and a JPEG; there are no
  PNG pictures.
- Admission queues, per-page permits and page limits.
- Byte, frame and duration bounds on capture. Each `Page.screencast` reader has a queue of 16
  frames that drops the oldest.
- Init scripts scoped to origins. `initScripts` run in every page and frame.
- Writer leases on stored contexts. `Browserbase.open` lets one persisting session at a time write
  to each context within one process; writers in other processes are the application's to exclude.
- Operator handoff beyond Live View URLs, file uploads to a session, and recording to video files.

### Defaults that differ from 0.2

- Local Chromium runs without its sandbox unless `Chromium.layer({ sandbox: true })`. 0.2 ran it
  by default.
- Browserbase sessions take Browserbase's default for every setting left unset: they are recorded,
  keep their logs, solve captchas and open at Browserbase's default viewport, which was 2560×1440
  on 7 October 2026. 0.2 turned recording, logs and captcha solving off. `browserSettings` sets
  each of them.
- One input lock and one `humanize` setting cover the whole browser, so input on one page waits
  while another page's input runs, including all of a humanized `type`.

### Known limitations

- Over CDP, Browserbase included, the first picture of each new document sends Playwright's 335 KB
  injected script. On Browserbase such an upload has taken up to a few seconds, and screencast
  frames wait behind it.
- `Page.title`, `Page.hasText` and the `browser_tabs` tool's list have no deadline, so a page whose
  script never yields holds them, and an `Agent.run` that calls them.
- A browser this package opens fresh measures its clock and capture delay on a private page first,
  and every capture start measures the clock again before its first frame. Over a remote
  connection, each costs round trips.
- In a browser Playwright launches, a clipped screenshot with the viewport's own proportions can
  put about one frame of the crop into a running screencast.
- The packages import `effect/ai` and `effect/http`, which Effect 4 marks unstable. CI tests them
  with Effect 4.0.0; a later Effect 4 release may change those modules.
