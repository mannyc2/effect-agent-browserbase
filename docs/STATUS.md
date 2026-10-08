# Status

## 0.3, unreleased

0.3 is a rewrite of the 0.2 set on stable Effect 4.0.0 and `effect/ai`:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Tools`, `Agent` and `Moment`.
- `effect-browserbase`: the Browserbase REST client, and sessions as a `Browser`. Stored contexts
  and uploaded extensions are managed through the client; `Browserbase.open` lets one persisting
  session at a time write to each context in a process and holds it until the save settles. A
  release confirms the session ended and says so, `Settled` or `Unconfirmed`. An unconfirmed
  release, or a create whose answer was lost, marks the context: the next `open` on it ends the
  context's sessions, which `open` labels in their user metadata, before it writes, and fails
  `ContextHeld` while they cannot be confirmed ended, so no context is held with no way out and no
  two sessions write to one. `Browserbase.reconcile` does the same without opening a session.
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
  release outcome last, a loss with its cause. `Browserbase.supervise` supervises hosted sessions.
- Pages with durable names and a life story. A page's id is its CDP target id, so a new connection
  to the same browser finds it again with `browser.page(id)`. The timeline tells each page's
  documents and moves within them (`Navigated` with `document` and `sameDocument`), its loads
  (`PageLoaded`) and its close or crash, and the browser's end as one `Disconnected` with its
  cause, `connection`, `session` or `released`, also `browser.disconnected`; frames carry their
  document and address. A failure on a page that is gone is `Closed` with its cause, calls in
  flight fail at once with a lost browser or a crashed page, and `BrowserError.consequence` says
  what any failure leaves and whether to repeat it. Every reported address loses its userinfo and
  credential parameters, and init scripts run where their `match` allows, a popup's first document
  included. Chromium announces a title change only with the next address change, so titles are
  read on demand.
- `effect-browser-human-strokes`: an optional layer with 32,130 recorded, attributed CC BY 4.0
  pointer strokes, retaining their original sample coordinates and times. The core pointer planner
  uses the tuned two-stroke sigma-lognormal model; browsers capture the motion service once.
  Complete bounded plans are validated and admitted before publication and input.
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
  each key used to wait for the keys before it and a focus check, and humanized keys check focus
  before each space and after the last key. Guards receive structural facts, never keyword categories, and
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
- Moments: `Moment.capture` gathers a page's frames, events and changes over a window that can
  start where the previous moment ended, so consecutive moments neither repeat nor miss an event
  or a change, and needs only the page. `Moment.toPrompt` lays a moment out as one message for any
  `effect/ai` call, leading with what changed, news first, and naming an action only as what a
  change followed or where its effect is drawn, as on a canvas; describing it is the caller's own
  `generateObject`, `generateText` or `Chat` turn. Whether a model describes a page better from
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
  click on one page no longer waits for humanized typing on another, which held an on-air click
  for about 9.5 s in the release review. Identical reads in flight share one call, a read whose
  callers gave up serves the next caller to ask the same until the page's next action, and
  `observe` returns what it could read, with why the rest is missing. `Browser.Options.maxPages`
  bounds the open pages, failing `Limit`.
- A timed input track with planned glides, submission receipts, button/key phases, wheel and cursor
  events; a pointer per page, and bounded event replay with explicit expiration.
- Humanized scrolling to off-screen targets, bounded fallback and approval revalidation; typing
  near 75 WPM with overlapping holds, slower word starts and opt-in corrected prose slips.
  Sampled presentation pauses retain the functional navigation wait.
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
- **Phase 2, identity and lifetime, is built, and its adversarial review is under way.**
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
  its eleven planted bugs that the suite let through. Its beta, `0.3.0-beta.2`, is prepared in the
  changelog and the package versions, and is not tagged.
- **Phase 3, concurrency and presentation, has begun.** Per-page admission is in: the browser-wide
  input lock is gone, reads follow the action in flight and keep their work, a wait fails `Busy`,
  pages have a budget, and guarded typing approves its field once.

Size against the baseline at `ab326c1`: lines of each package's TypeScript (`wc -l`), with
`src/testing` counted apart, and the `export` statements of its public modules.

| Package                        | Source lines                   | Test lines      | Top-level exports         |
| ------------------------------ | ------------------------------ | --------------- | ------------------------- |
| `effect-browser`               | 8,871 → 14,563                 | 11,064 → 15,902 | 129 → 177                 |
| `effect-browserbase`           | 807 → 1,297, and 588 `testing` | 611 → 1,643     | 32 → 36, and 14 `testing` |
| `effect-browser-human-strokes` | 309 → 309                      | 261 → 261       | 4 → 4                     |

`effect-browser`'s figures include phase 2, as each part landed: the supervisor, 602 source lines,
506 test lines and 7 exports; pages' identity and lifecycle, 398 source lines, 542 test lines and 9
exports; the capture connection's port and transport, 324 source lines, 43 test lines and 1 export;
and the change record, 1,423 source lines, 728 test lines and 6 exports. The phase's simplify pass
took 123 source lines back out. The figures include phase 3's per-page admission too, 508 source
lines, 411 test lines and 3 exports, most of it the lane, which deleting the browser-wide input lock
paid for only in part. Without them, phase 1 leaves the package at 11,431 source lines, against a
soft ceiling of about 11,000 through phase 4.

## Not rebuilt yet

0.2 did much that 0.3 does not do yet. A capability inventory of the 0.2 code, the plans, the open
PRs and the in-progress work marks each capability as rebuilt, left for later, or the consumer's to
build. The 0.2 PRs are closed, except #164, kept open as a reference.

The larger pieces left for later:

- recording to video files;
- operator handoff, reconnecting to a kept-alive session, and uploads;
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
