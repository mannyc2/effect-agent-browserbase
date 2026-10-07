# Changelog

Each release lists what changed since the release before it. From 0.3 on, `effect-browser`,
`effect-browserbase` and `effect-browser-human-strokes` are released together at one version.

## Unreleased

### Added

- `Page.find(query)`: in one call to the page, the elements that a query of `role`, `name` (a
  string or a `RegExp`), `text` and `near` (words of an element's context) matches, in the viewport
  or the whole document. Each is a `Found` with a ref the actions take, its `Subject`, its box,
  whether it is in view, and its state. It replaces 0.2's structured controls.
- `Page.text({ scope, maxChars, unmask })`: in one call to the page, the text the viewport, or one
  element, shows. What fields hold reads `••••` unless `unmask` is set; secret fields always do.
- `BrowserEvent.SubjectContext`, `Page.ElementState`, `Page.FindQuery`, `Page.Found`, `Page.Text`
  and `Page.TextOptions`.
- `Page.frame({ maxAge, after })` and `Page.FrameOptions`: a frame states how old it may be. The
  newest screencast frame serves when it was painted at most `maxAge` ago (250 ms by default; 0
  always takes a new screenshot), and with `after: "input"` only when painted after the page's
  latest input. `Page.screenshot` takes the same options.
- `CaptureStats.duringPictures`: frames left out because they may have been painted while the
  library took a clipped or scaled picture of the page.
- Every page span reports its protocol cost on the page's own session: `calls`, `bytesOut`,
  `bytesIn` and `waitedMillis`. A picture's `source` is `frame` or `screenshot`.

### Changed

- A picture is taken on the page's own session: one `Page.captureScreenshot` where a device pixel is
  a CSS pixel and nothing is cropped, and two, with Playwright's clip over the page's layout metrics,
  for a crop or another device pixel ratio. Over CDP, Browserbase included, the first picture of a
  document no longer sends Playwright's 335 KB injected script, which took up to a few seconds on
  Browserbase while screencast frames waited behind it. Where Playwright emulates the viewport, as
  `Chromium.layer` does, crops are still Playwright's own screenshot, on its own session.
- The page script is registered once per page session, at the library's first read of the page, so
  each new document runs it from its start: a document's first read is two calls without the
  46 KB install, and a warm read one. The clock probe runs in a world of its own.
- The library's own clipped pictures, such as a zoom, keep their frames out of a running
  screencast, crops with the viewport's own proportions included.
- Each page's own session holds focus emulation, so a tab behind another keeps painting whatever
  else is attached. A capture starts once the browser has confirmed it.

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
- `Page.currentFrame` is removed: `Page.frame({ after: "input" })` is the nearest, and its 250 ms
  bound is now the frame's age from its paint, not from its delivery, so frames that arrive late
  stand in less often.
- `ScreenshotOptions.fresh` is removed: `maxAge: 0` takes a new picture. Without
  `after: "input"`, `Page.screenshot` can serve a frame painted before the page's latest input;
  `Page.observe` and `Moment.capture` ask for one painted after it.
- `CaptureStats` has the required count `duringPictures`.

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
