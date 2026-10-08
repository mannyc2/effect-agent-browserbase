# Changelog

Each release lists what changed since the release before it. From 0.3 on, `effect-browser`,
`effect-browserbase` and `effect-browser-human-strokes` are released together at one version.

## Unreleased

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
  of lost creates, pending or refused releases and failed status reads; and
  `BrowserbaseContract.checks`, what the package relies on Browserbase to do, which the fake
  passes. Its ids are UUIDs, as Browserbase's are, and it answers each id shape as Browserbase
  does: a malformed session id is refused, where an unknown well-formed one is not found.

### Changed

- A Browserbase answer of 400 is the reason `InvalidRequest`, not `Status`, so a request Browserbase
  refuses as malformed, such as a session id that is not a UUID, reads the same as one this client
  refuses before sending.
- `Chromium.layer` leaves signals to the program. Playwright's handlers closed every browser on
  SIGINT, SIGTERM and SIGHUP, and on SIGINT then exited the process, so no finalizer ran. Under
  `NodeRuntime.runMain`, an interrupt closes the browser with its scope.

### Breaking

- `Browserbase.open` and `attach` give a `Hosted`, `{ browser, session, release }`, instead of the
  `Browser`. `release` ends the session, confirms it ended, and gives the outcome; for `open`, the
  scope's close runs it too, once.
- A Browserbase release confirms the session ended: it reads the session, trying again a second
  apart for up to a minute, including after a failed read. A session still running then is
  `Unconfirmed`, and its context is left for the next writer to clear. Before, a failed release was
  a logged warning, and the context was let go after a minute whatever the session did.
- `Browserbase.open`, `layer` and `supervise` can fail with `ContextHeld`, so a caller that handles
  their errors by tag has one more to handle.
- A persisting session carries `persistsContext: <context id>` in its user metadata, beside the
  caller's own.

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
  for `Page.ready` before each step that acts, finds the one element the step's subject names by
  role, name and context with `Plan.locate`, and acts on it. It stops at the first step it cannot
  take with a `Plan.ReplayError`: `Missing`, `Ambiguous` (there is no ordinal), `Drifted`, or the
  step's `BrowserError`. A plan is version 1, so a plan 0.2 stored does not decode.
- `Page.ready({ quietMillis, timeout })`: in one call to the page, repeated, whether it is ready to
  be shown: its document parsed and painted since, nothing that ends animating in view, its fonts
  and the images in view loaded, and something shown. With `quietMillis`, the screen must also
  stay still, counted from the first frame of a capture the wait starts.
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
