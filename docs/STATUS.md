# Status

What the code on `main` does, how it has been checked and what is known not to work, as of 26
November 2026. [CHANGELOG.md](../CHANGELOG.md) lists what each release changed.

## Releases

The latest release is `0.3.0-beta.24`, published on 25 November 2026 to npm's `beta` dist-tag as
`effect-browser`, `effect-browserbase`, `effect-browser-human-strokes` and `effect-agent-browser`.

`main` holds the next release, which is breaking and not yet published; the changelog's
"Unreleased" entry describes it. It moves the packages into the `@effect-browser` scope, adds
`@effect-browser/chromium`, makes the core's features subpaths of their own and moves the agent's
tools into `effect-browser/ai`. None of the scoped names is on npm yet, so until that release the
READMEs' and the docs site's install commands fail for them. The owner reserves the names before
the release ([RELEASING.md](RELEASING.md)).

Every package peers on `effect` `~4.1.2`. `effect-browser`, `@effect-browser/chromium` and
`@effect-browser/browserbase` peer on `playwright-core` `^1.63.0`, and `@effect-browser/yielded` on
`@yielded/agent` `0.1.0-beta.191` exactly.

## Packages

### `effect-browser`

Browsers and pages over the Chrome DevTools Protocol, through `playwright-core`. It depends on
`effect` and `playwright-core` only. The root, `effect-browser`, loads only `effect` at runtime, and
each of its modules also has a path of its own, such as `effect-browser/Page`:

- `Browser`: the service. Its pages, which keep their CDP target ids, so a new connection to the
  same browser finds one again with `browser.page(id)`; its events, read from a cursor, with an
  explicit failure for a reader that falls behind the kept history; input suspended across every
  tab (`suspend`); and its end, one `Disconnected` with its cause. Its options bound the open pages
  (`maxPages`), guard input and navigation (`guard`), answer requests (`requests`), run init
  scripts where their `match` allows and hold pages' time (`pageTime`).
- `Page`: one tab. Its operations take turns in a lane of its own: an action has the page to
  itself, in the order it was admitted, and reads take their turn after it, so a read describes
  the page an action left. A wait for a turn fails `Busy`, or at once under `Page.failFast`.
  Navigation, input (`click`, `hover`, `drag`, `type`, `press`, `scroll`, `select`), a typed
  `Action` through `perform`, the caller's own code in the page through `read` and `act`, and
  `ready`, which waits for the page's own evidence that it is ready to be shown. `state` says what
  the library already knows of the page, at no call. The text the viewport shows is read with
  field values masked unless asked for, and secret fields' always.
- `Snapshot`: the outline a model reads, whose controls carry refs the actions take; the elements a
  query of role, name, text and context finds, each with its subject; and a wait, in the page,
  until a query is met.
- `Frame`: pictures with their timing. Screencast frames, screenshots and crops, each placed on the
  host clock with an explicit uncertainty, and a page's capture counters.
- `Change` and `Window`: what visibly changed on a page over a window, element by element, recorded
  in the page from the first read on; and a page's events, changes and frames over one window of
  its browser's clock.
- `Layout`, `Overlay`, `Pose` and `PageTime`, for filming: where picked things and their words are,
  as data; a layer over the page that draws a caller's SVG and that no reader reads; the page's own
  elements moved, turned and scaled; and the page's own time, held and stepped.
- `BrowserEvent`, `BrowserError`, `Action` and `InputStyle`: the events; typed failures, each with
  a reason, whether its input was dispatched and what it leaves (`consequence`); typed actions,
  shared by input, guards, event records and walks; and how input is sent, plainly or performed for
  viewers.

The subpaths:

- `effect-browser/Cdp`: any DevTools endpoint as a `Browser`. On Node it connects through
  Playwright's `connectOverCDP`; under the `workerd` condition the entry imports no Node transport,
  and the caller passes a `connect` of its own.
- `effect-browser/Site`: the readers, the change record, the overlay and poses, for a site to run in
  its own bundle on its own page, with no protocol and no runtime `effect`.
- `effect-browser/timeline`: `Moment`, a window that ends at a picture of the page now, with what
  was still changing at its end and what had settled (`Moment.account`), laid out as one message
  for any `effect/ai` call (`Moment.toPrompt`); and `Stillness.wait`, for a page's screen, content
  or foreground to stay still.
- `effect-browser/presentation`: `Presentation`, input performed for viewers through a view of a
  page, with one drawn pointer, a person's reaction times and typing near 70 WPM; `Stage`, the
  source of a live output, switched between pages with their captures overlapping; `Motion`, the
  pointer planner, a value; and `Film`, a page filmed on its own held time with each input on its
  frame, which is experimental.
- `effect-browser/walk`: `Walk`, a page's walk recorded from its events and replayed on a fresh page
  by subject, with no model call. It never resends consequential input whose effect is unknown.
- `effect-browser/policy`: `Policy`, judges over `effect/ai` (`reviewer` on a `LanguageModel`,
  `decider` on a `DecisionModel`) and `make`, a guard that denies a risk the task does not ask for
  and fails closed when its judge fails.
- `effect-browser/supervisor`: `Supervisor`, a resource such as a browser kept serving through
  failed opens, losses and rotation, as generations with scoped `use` work; and `Release`, what a
  provider said of a release, `Confirmed` or `Unconfirmed`.
- `effect-browser/ai`: an agent's browser tools for any `effect/ai` loop (`BrowserTools`), the
  controller they act through (`PageControl`), the tabs they follow (`Tabs`), the failure a tool
  answers the model with (`ToolError`) and an HTTP client layer that keeps OpenRouter's prompt cache
  across turns with pictures (`PromptCache`).
- `effect-browser/testing`: a seeded browser and pages (`TestBrowser`, `TestPage`), scripted models
  (`TestModel`), recorded HTTP exchanges (`HttpCassette`) and ports released in a scripted order
  (`Story`).

`bun run boundaries` checks that the root loads only `effect`, that each feature uses only the
core's public modules and a short list of shared internals, and that the rest still typechecks with
each feature folder deleted, together with the features that import it.

### `@effect-browser/chromium`

`Chromium.layer` and `Chromium.open` launch a local Chromium through `playwright-core`, as a
`Browser`. Chromium runs without its sandbox unless given `sandbox: true`, as in Playwright; the
package's README says what that risks.

### `@effect-browser/browserbase`

- `BrowserbaseClient`: Browserbase's REST API: sessions, Live View, stored contexts, extensions,
  search and fetch.
- `Browserbase`: sessions as a `Browser`. Closing a session's scope releases it and confirms that
  Browserbase reports it ended, `Confirmed`, or says `Unconfirmed` when it could not by the
  deadline, which can mean the session bills until its timeout. Each create carries a nonce of its
  own, so a session whose create lost its answer is found and ended. `attach` resumes a running
  session from another process, its pages found again by their ids, and `generations` supplies
  sessions to `Supervisor.make`. Pages' screencasts run on a second, read-only connection to the
  session, so a frame never waits behind a large message on the connection that drives the page.
- `ContextLease`: one writer per stored context. A session that saves to a context holds it from
  before its create until its save has settled. A writer that may have left such a session running
  leaves the context unsettled, and the next writer ends the context's sessions first, failing
  `ContextHeld` while it cannot confirm they ended. `Browserbase.reconcile` does that without
  opening a session, and `Browserbase.verifyContext` reads a context back from a session that saves
  nothing. `ContextLease.layer` excludes writers within one process; an application excludes them
  across processes with a lease of its own, such as a lock in its database.
- `BrowserbaseError`: the client's failures.
- `@effect-browser/browserbase/testing`: `TestBrowserbase`, the API in memory with scripted faults,
  and `BrowserbaseContract.checks`, what the package relies on Browserbase to do, which the fake
  passes and `bun run bench contract` runs against Browserbase.

### `@effect-browser/yielded`

`YieldedTools.make` gives `effect-browser/ai`'s tools to a Yielded Agent run. Its layer adds the
pictures for each turn as run context the run never keeps (`vision` `true`, `"ask"` or `"page"`),
or, with `vision: "moments"`, places a moment of the tab since the turn before in the thread after
each turn's tool results (`Moments`), which Yielded compacts with the conversation. It is the only
package that depends on `@yielded/agent`, and the boundary check holds it so.

### `@effect-browser/human-strokes`

`motion`, a pointer planner over 32,130 recorded human strokes, for a presenter in place of
`Motion.lognormal`. Its code is MIT and its stroke data CC BY 4.0, with attribution in its README.

### `@effect-browser/tradingview` (private)

A TradingView chart's state, bars, studies and values, and the screen points of times and prices,
read from the chart's own model (`Chart`); changes made with the chart's own toolbar, keys and
dialogs, which the chart's API corrects or completes (`ChartInput`); and both as an agent's tools or
a Code Mode program's methods (`ChartTools`). It is never published; the bench uses it.

### `bench` and `site` (private)

The bench grades agents on seeded tasks over canvas games, live charts, dense quote tables, forms
and everyday pages, by the page's own truth, in arms that differ in how a model sees and acts. It
also grades the input policy's judges against a corpus of 77 labelled controls, runs the hosted
probes and the Browserbase contract, and runs agents on TradingView. Scripted runs are free; model
and hosted runs are opt-in ([bench/README.md](../bench/README.md)).

The site is the docs, a Foldkit app that deploys to Cloudflare with Alchemy. Each page is also
served as markdown, with `llms.txt`, `llms-full.txt` and a JSON index. Its two demos are recorded
takes of an agent that speaks for itself, one on Polymarket and one at a canvas slot in a made-up
casino, and `bun run dev` serves a local runner that records a take with the visitor's own key and
spending cap.

## How it is checked

### On every pull request

CI runs `bun run ready`: the format check, lint with its size limits (600 lines of code a module,
150 a function, falling to 100), the boundary checks, the typecheck, every workspace's tests and
the build. Then `tools/check-packed.sh` packs the five published packages and installs them in a
clean npm project and in a Bun workspace with the isolated linker, where every entry point must
typecheck and load. Tests run against a real local Chromium on pages the tests serve, an in-memory
Browserbase and scripted models: none calls a model or a hosted browser. Native suites hold reads,
pictures and opening a browser to their protocol call budgets through a counting proxy.

On `main` at `3708fce`, 26 November 2026, CI passed with 660 tests in `effect-browser`, 72 in
`@effect-browser/browserbase`, 9 each in `@effect-browser/yielded` and
`@effect-browser/tradingview`, 8 in `@effect-browser/human-strokes`, 4 in
`@effect-browser/chromium`, 207 in the bench and 87 in the site, and the packed check's 59 entry
points.

### On Browserbase

Every check below ran on code from before the unreleased restructure, whose pull requests describe
it as changing the API's shape and not its behaviour. None has run on it since.

- **25 November 2026, `0cfee5b`:** the film example on one 1280×720 session, open about 47 s and
  released with its end confirmed, took all 240 frames in 44.0 s with all 11 inputs on their
  frames, and recorded 25 changes after the contacts, each with its box. It is the only hosted check
  of filming.
- **Before `0.3.0-beta.23`, 3 November 2026:** packed archives, in a consumer on Effect 4.1.2, ran a
  Yielded agent with Claude Haiku 5.5 inside local workerd, against local Chromium and against a
  Browserbase session. It read a page, followed a link and answered from both pages.
- **8 October 2026,** three sessions and 3 browser minutes. `verifyContext` read back the cookie and
  local storage a writer had saved, and a second process attached to a running session by its id,
  found its page by its target id and changed it. Browserbase refused a malformed context id with
  a 400, which the fake now does too; a search by user metadata listed a new session within one
  search of its create; Browserbase cut a timed-out session's connection 4.4 s after its
  `expiresAt`; and a context's `updatedAt` did not move when a session saved to it. The same day,
  two captures in one session ran at the frame rate of one, where stopping the first before
  starting the second left 250 to 295 ms dark; and with another tab reading and uploading, the
  page on air waited at most 352 ms between frames on the capture connection, against 1,802 ms
  without it.
- **Agents on Browserbase:** the bench's paid runs of 6, 23 and 24 October 2026 ran trials in
  hosted sessions; [bench/README.md](../bench/README.md) has their results.

### With models

The bench's README records each paid model run with its date, model, arms, results and cost: the
first paired run and the judges' first graded run on 6 October 2026, and the runs of 22 to 24
October 2026 on programs, pictures and the TradingView demo. In the paid narration run of 8 October
2026, a model told which of two ticking prices still moved and which had stopped in 18 of 32
moments without `Moment.account` and in 29 with it. The site's two demos are recorded takes.

## Known not to work, or not yet checked

- **The scoped packages are not on npm.** Their install commands fail until the unreleased release
  is published. The other packages still peer on `effect-browser` `^0.3.0-beta.23`, which lacks the
  subpaths they import; the release raises that range.
- **Not rebuilt from 0.2:** recording to video files, and file uploads into a page.
- **Hosted checks prepared but not run** ([HOSTED_CHECKS.md](HOSTED_CHECKS.md)): two captures held
  for five minutes with cued switches (H1), a supervisor's rotation with a persisted context read
  back in the next session (H2), and a human sign-in through Live View during an input suspension
  (H3). They wait for verified included Browserbase hours, and H3 for an operator. Local Chromium and
  the in-memory Browserbase check their mechanisms, not Browserbase's timing, persistence or
  billing.
- **`effect-browser/Site`** has run on no real site yet.
- **Workers:** the `workerd` run above was local. A Cloudflare-hosted Playwright connector has not
  been checked.
- **Stored contexts:** Browserbase does not tell when a session's save has landed, since a context's
  `updatedAt` does not move, so a writer's hold ends a fixed `contextSettle` after the session
  ends.
- **TradingView:** recorded chart walks do not replay, because a click on the chart's unnamed time
  axis records a subject that replay cannot find. tradingview.com refuses drawings and indicator
  search when signed out, and the package is checked live only on the Advanced Charts demo.
- **The docs site's captured outputs** are from runs before the restructure: get-started's agent
  run is from 11 October 2026, on the earlier release-candidate archive and Effect 4.0.0.
  Recapturing it takes a paid model call, and the install commands the scoped release.
- **Timing tests under load:** some of `effect-browser`'s and the bench's timing tests fail on a
  loaded machine and pass alone. On `main` CI, `Budget.test.ts`'s browser-opening call count, a
  `Ready.test.ts` foreground-motion case and the bench's tumble-interval grading each failed once on
  26 November 2026, and passed on the next run.
