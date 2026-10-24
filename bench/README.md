# Bench

Can a model, working through effect-browser, operate and understand canvas games, live charts and
forms and dense quote tables? Each task grades against the page's own truth, and has a scripted solution that shows the task
can be done and graded without a model.

The pages (`Sites.ts`) are served at `https://bench.test` by request interception, so a local
Chromium and a hosted browser load them the same way, with no tunnel. Each page keeps its truth in
`window.__bench` for grading; models never see it. Each trial derives its fixture seed from the base seed, task and trial number,
so changing concurrency does not change its page data. The same seed seeds the trial's Effect
`Random`, which a performed run's pointer paths and typing draw from.

Operate pages vary with the seed too, so a task's trials sample a family of pages rather than
repeat one, and every graded answer is the page's own:

- the casino lobby words its cookie banner and age check, and orders their buttons, differently,
  moves the game's card among the others, words the cards' play buttons differently and opens the
  game at a different table, so `navigated`'s destination and trigger change too; the reels start from different credits and a
  different default bet, with their controls elsewhere on the canvas;
- the trading ticket words its fields differently, starts on the buy or the sell side, and
  numbers its orders from a different id; a limit order rests on the book, open;
- the checkout words and orders its fields differently, shuffles its countries and shipping
  choices, names its button differently and issues a different confirmation number.

Prompts stay the same. `run --split eval` draws a held-out family of seeds: work on prompts and
tools against `dev`, the default, and compare arms on `eval`.

| Task             | Kind       | What the model must do                                                                          |
| ---------------- | ---------- | ----------------------------------------------------------------------------------------------- |
| `casino-play`    | operate    | Pass a cookie wall and an age check, play five spins on a canvas slot machine                   |
| `casino-moment`  | understand | Read the credits and the last win off the canvas, just after a win                              |
| `chart-read`     | understand | Read the last price, to within 0.05%, and the trend off a canvas chart                          |
| `chart-spike`    | understand | Notice a 3.5% jump, from three frames over the last four seconds                                |
| `chart-calm`     | understand | The control for `chart-spike`: the same question, before the jump                               |
| `chart-trade`    | operate    | Buy 0.25 BTC at market on a live trading page and report the order id                           |
| `checkout`       | operate    | Fill in a shipping form, with a select and radios, and report the confirmation                  |
| `quote-table`    | understand | Read the quote's price, 1-hour/24-hour changes and exact 24-hour header                         |
| `quote-dense`    | understand | Bind the quote to the right row, period and table among similar panels                          |
| `tumble-win`     | understand | Count paying cascades on a 6×5 canvas slot and read the final multiplier, win and balance       |
| `order-filled`   | understand | Identify the filled order, its quantity, price and status                                       |
| `navigated`      | understand | Identify the destination URL, title and control that triggered navigation                       |
| `board-tick`     | understand | Say which price in three dense quote tables moved by a fraction of a percent, from what to what |
| `board-flash`    | understand | Report an alert that showed for 1.2 seconds and was gone by the moment                          |
| `board-scrolled` | understand | Report a price that changed before the page scrolled away from it; by design no frame shows it  |
| `board-steady`   | understand | The control for `board-scrolled`: the same scroll, with no price change                         |
| `board-flux`     | understand | Say which of two ticking prices still moves at the moment and at what the others settled        |
| `board-caption`  | understand | Caption the same moment as `--narrate` does, without misstating what moves or what rests        |
| `board-move`     | operate    | Drag a card to the top of a board's Done column and report how many cards Done holds            |
| `policy-find`    | operate    | Find the returns policy behind header menus that open on hover and report its reference         |
| `catalog-buy`    | operate    | Add the cheapest tent for two in stock, from a catalogue across three pages, to the cart        |
| `note-format`    | operate    | Format a note as a comment asks, through a toolbar of icons no button names, and save it        |
| `seat-book`      | operate    | Book two seats together nearest the stage, on a seat map that shows free seats by color alone   |
| `payment-refund` | operate    | Refund the one payment a support ticket describes, among payments that look alike               |

An operate task gives a Yielded agent the browser tools. An understand task brings the page to
a moment without a model, captures it (`Moment.capture`) and asks a model about it in one call:
`LanguageModel.generateObject` over `Moment.toPrompt`, with the task's question as the system
message. Capture starts before the scripted setup, and multi-frame tasks check the
retained time span as well as the frame count. The final frame must follow the fixture's last visual
change on the browser clock. A screencast can lose the final paint of a page that then stays
still, so each fixture paints its settled state once more, and if no frame reaches the barrier the
final frame is a fresh screenshot with its own capture timing, never a claimed paint time.
`Moment.capture` also ends with a fresh screenshot whenever its newest frame is not demonstrably
current (for example on a page that has been still for a while); one taken after the fixture's
last change was read counts as following it. An
incomplete capture is an infrastructure failure, before any model call. Bench browsers keep 30 seconds of frames, for the
longest fixture's 20-second window and the wait for its final paint; the library keeps 5 seconds. The tumble task selects twelve frames
to cover its paying cascades, rather than asking the model to count transitions absent from the
pictures, and its capture is incomplete if two consecutive frames are 1,800 ms (one cascade) or
more apart. The jump task's first frame must precede the jump, and its control's frames must all
precede any jump. Half the chart seeds drift up and half down, so a constant trend answer cannot
pass. Operate tasks run a Yielded agent with `effect-agent-browser`'s tools: in the default arm, it
sees a screenshot before each turn and reads the outline with `observe` and after each `act`;
`zoom` adds requested viewport crops before the next turn, and pixel clicks name the element under
the requested point. Runs without a model still use the free
scripted solutions. Runs allow input by default; a caller's `Browser.Options.guard` can deny or
hold input and navigation without a user-facing confirmation prompt. Typing keeps its
pacing over delayed connections. `--humanize` runs a trial through a presenter's views of its
pages, so the scripted solutions and the agent's tools perform their input: they use visible wheel
input to reach off-screen targets and type near 70 WPM with overlapping holds. Events, frame
arrivals and moment windows use the browser’s host monotonic clock; these stamps are relative timings, not calendar dates. `Browser.events()` also
exposes the presentation track with sequence cursors for bounded replay. The bench’s descriptions
continue to use narrative action events, without the cursor-rendering track. Frame windows and
evidence spans use mapped browser paint time, with screenshot timing represented separately;
late delivery cannot make old paint count as the fixture's final state. Capture counters expose
native filtering, paint gaps and observed subscriber loss.

An understand task's page records what changes on it from before the scripted setup, so the
moment's changes cover the whole window: the steady state a narrator meets from its second moment
on a document, not a document's first moment, which holds no changes yet.

The `board-*` tasks ask what changed on a page that stays the same page, as a narrator must. They
share one question, one answer and one grader, which judges what an answer says rather than how it
says it: an asset counts by its ticker, with or without "-USD", or by its name, though a ticker
that is also a word, such as LINK, only in capitals within a sentence; a table by a word that
names it alone, such as "spot" or "perps"; prices are numbers within half the last displayed
digit; an alert counts when it names its asset and level and no other, however worded, so a hedge
between two fails. A field for something that did not happen, such as the asset when no price
changed, is not graded. The board never marks what changed and keeps no trace of a former price or
a removed alert, and each seed moves another price or raises another alert. `board-tick` and
`board-flash` keep their evidence in the pictures: the tick's first frame precedes it, and one of
the flash's three frames must show the alert, whose draining bar paints all the while it shows.
`board-scrolled` deliberately does not: its two frames show the board before the tick and the
news after the scroll, so it measures what a moment tells beyond its frames, and `board-steady`
is its control, which an answer of "nothing changed" passes on every seed.

`board-flux` and `board-caption` ask what is still moving. Two prices of different assets tick,
each every 300 to 900 ms, for 4 seconds; then the seed stops one, both or neither, and the moment
is taken 3 seconds later over 5 seconds, with three frames, as a narrator's is. `board-flux` asks
for every price that changed, whether it is still changing or settled, and a settled one's price;
it passes when both prices are listed in their states, each settled one within half its last
digit, and nothing else. `board-caption` asks the narrator's own question, and grades its caption
in code by what it says of each price it names: it misstates a settled price where its words say it
moves and not that it rests, and a moving one where they say it rests and not that it moves, or
give it a figure while neither they nor what the caption says of every price, such as "both
fluctuating", say it moves. A caption that names neither price misstates nothing.

## Running

From this directory:

```sh
bun run bench run                   # scripted solutions in local Chromium, at no cost
bun run bench run --help
bun run bench report ../.work/bench/<results>.jsonl

EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run bench run --model <openrouter-model-id> --trials 3 --concurrency 4 --seed 23

EFFECT_BROWSER_BENCH_HOSTED=1 BROWSERBASE_API_KEY=... \
  bun run bench run --browser browserbase
```

The command line is `effect/cli` (`bench.ts`), run by `NodeRuntime.runMain`. Its opt-ins are read
through `Config`, and its files written through `FileSystem`.

Model calls and Browserbase sessions cost money, so each needs its environment variable. Trials run
with bounded concurrency (`--concurrency`, default 4) and separate browsers. Every Browserbase trial gets a
new 1280×720 session, released when the trial ends; its own 30-minute timeout ends a session the
bench could not release. A session create that may have
allocated a session nobody can release (no answer, a 5xx or 408 status, or a success answer that
did not decode and whose session the client did not release) stops hosted admission: the run
requests no further session and records the remaining trials as unrun. A refused create (429 or
another 4xx) allocated nothing and stops nothing. Browserbase time is not part of
the model budget. Each session carries the trial's run, task, trial, arm and trace id as user
metadata, which Browserbase's dashboard shows, and its trace records the session's id and region
on `Browserbase.open`, so either finds the other.
The model remains a caller choice. For the research runs, use `openai/gpt-6-luna`; reasoning defaults
to `medium` for operate tasks and `none` for understand tasks. `--reasoning` overrides both.

Before each model call, the runner reserves a conservative upper bound against the shared
`--max-usd` budget (default $2). It pins one provider endpoint that lists every parameter the run's
requests send (a reasoning effort, the output-token limit, and tools or a JSON schema response
format as the selected tasks need) and no per-request, image or audio price, since the request's
price ceilings allow none. The reservation uses that endpoint's prompt-token limit, its highest
listed tier, cache-write and reasoning rates, and `--max-output-tokens` (default 4,096). `--rates in,out` supplies
provider price ceilings in USD per million tokens. Trials wait while active calls can release capacity. An actual billed receipt releases the unused reservation. With the caller's own provider key
(BYOK), OpenRouter's `cost` is only its fee, so a BYOK receipt is charged that fee plus its
`upstream_inference_cost`, and one without the upstream cost is uncertain. A missing receipt or
unknown charge keeps its reservation, so another trial cannot spend it again. This can stop a run
before the nominal budget is used; it never treats an unknown charge as zero. Each request disables the plugins its schema can
disable (web search, file parsing, response healing, context compression and the routers); the
account must allow those overrides. The request schema cannot disable the `web-fetch` or
`moderation` plugins, so an account default that enables either, or a protected account default,
can add fees outside this token budget; a receipt whose charge exceeds its reservation still stops
all further admission. Only non-streaming chat completions are budgeted: the client refuses
streaming, decisions and raw generated requests before sending them.

Each trial is one line of a JSON Lines file in `.work/bench/` at the repository root (ignored by git),
a `TrialRecord` (`Results.ts`, `version` 3) that `report` decodes again: the task, its arm (null for a scripted solution), base and derived fixture seeds, the run (source commit and whether the checkout was dirty,
model, pinned endpoint with its rates and per-call reservation, browser, added latency, humanize,
output-token limit, budget, concurrency, recording and narration), effective reasoning, status and
reason, the answer, model turns
(`steps`) and tool calls (`actions`, and by tool name `tools`) once a trial has an outcome, any
error with its closed diagnostic, the call `accounting` (calls, tokens, known dollars, unresolved
reservations and uncertain calls), each call with a receipt in `modelCalls` (the pictures its
request carried, its input, cached input and output tokens, and its seconds in the provider
request), `timing` (seconds queued for budget admission and seconds in
provider requests), `phases` (seconds opening the browser, in the model's tool calls, and looking
at the page outside them: the agent's observations, an arm's own pictures and outlines, a moment's
capture), a latency or hosted run's `protocol` (see below), the fastest round trip to the browser
its clock calibrations measured (`roundTripMillis`), a hosted trial's Browserbase `region`, the
trial's `traceId` and elapsed seconds including browser setup and cleanup. The ISO start time is a
calendar date; elapsed time uses a monotonic clock.

The run ends by saying where graded trials' time went, as means that add up to the mean total:
model requests, the budget queue, those phases and the rest (the fixture, grading, closing the
browser and the bench itself). Recording and narration each run a screencast, which lets an
observation reuse a frame instead of capturing one, recording adds 500 ms to each trial, and
narration's caption calls overlap the agent's in `requestSeconds`: compare timings only between
runs made the same way, which `run` records.

`--record` also records each trial for replay, in a directory named after the results file with one
subdirectory per trial (`checkout-1/`, or `checkout-arm2-1/` with `--arm`). Each page's screencast
frames are written as JPEG files as they arrive, and `recording.json` (`Recording.ts`) holds every
browser event, including the planned pointer glides and keys, the agent's turns, the frames each
understand task showed its model with the page's truth, and the trial's outcome, all on the
browser's host clock. Screencast frames carry no cursor: a player draws it from the recorded glides.
Recording runs a screencast on every page, so it adds capture load to operate trials, and it
continues 500 ms after a trial so it ends on the settled page. Lost frames or events are listed in
`problems`.

New recordings also retain complete moments (including their JSON-encoded frame bytes), the raw
fixture state actually read by the grader, full provider request/response pairs keyed by turn,
and HTTP exchanges beneath the real provider codec. The existing live opt-in and reservation cap
still apply before any recorded provider request, and each recorded call is settled at the charge
its receipt shows, so the cap bounds a trial's spend rather than its calls. Recordings remain private local evidence.
`bun run --cwd bench bench regrade path/to/recording.json` re-runs the current task grader using
that saved truth, with no browser or model; a changed task prompt is refused. The public
`effect-agent-browser/testing` HTTP cassette can replay the saved `http` exchanges beneath the
same provider layer. Changed request bodies or tool schemas fail with re-record guidance.
These codec checks do not claim deterministic replay of a live page's changing screenshots.

`--narrate <seconds>`, with `--model`, captions an operate task's page that often while its agent
works: each caption is one structured call over a `Moment` of the time since the previous one, with
reasoning off. Captions go to the recording; they neither steer nor grade the agent. Their calls
share the trial's budget, so a caption call with an unknown charge stops the trial's admission as
any call does. A malformed caption is skipped. When the agent answers, the narrator finishes the
caption it is writing and starts no other.

### Traces

The bench and the judges runner export traces over OTLP/HTTP to any collector or backend, such as a
local Jaeger, when asked; otherwise they export nothing:

```sh
OTEL_EXPORTER_OTLP_ENDPOINT=http://localhost:4318 OTEL_TRACES_EXPORTER=otlp bun run bench run
```

Each trial is a trace of its own, rooted at a `bench.trial` span with its task, arm, seed, browser
and model and, once it ends, its status, reason and grade; its `traceId` finds it. Each judged case
is a `bench.judge` trace. `effect-browser`'s README lists the spans inside. `--record` also keeps
the trial's spans in `recording.json`, on the recording's host clock. A hosted trial's spans hold
its Browserbase session id, on `Browserbase.open` and in the API requests' URLs, so keep recordings
and exported traces out of commits; a packed replay leaves the spans out.

### Latency

`--latency <ms>` runs the local Chromium over the DevTools protocol through a proxy that adds that
many milliseconds to each round trip, half each way, with a fresh 1280×720 context, as a new hosted
session's is. It costs nothing, so hosted round trips can be measured before paying for
sessions; it reproduces neither a hosted browser's network nor its machine.

The proxy also reads the protocol. Each command a trial sends becomes a `CDP <method>` client span
from its sending to its answer reaching the bench, under the innermost span open in the middle of
it, so a trace shows which commands each operation waited on and whether they went one after
another. The trial's `protocol` counts its commands and round trips, in all and by the name of that
span with its methods; commands in flight together share a round trip. The run ends with the span
names that took the most round trips, and about how long one took. Attribution is by time alone: a
command sent in the background, such as a screencast frame's acknowledgement, or by an operation
running alongside another, such as a clock measurement alongside a capture, lands on the
innermost span open at the time. Only method names are kept, since parameters can carry typed
text. The proxy declines the WebSocket compression the bench offers, to read the messages; a round
trip costs the same, as the proxy adds delay but no bandwidth limit.

At 80 ms, a scripted trial took 43 to 91 round trips. Opening the browser took about 3.4 seconds
and 25 round trips, 20 of them calibrating the fresh context, and a new page about 9 more. A click
took two (finding its point, then the mouse events together) and a 120 ms settle. A fresh capture
took six in a row, five of them Playwright's screenshot, so an observation with an outline and a
capture took about 0.7 seconds.

Since then, startup calibration runs its probes in the private page's main world, sends its
marker script with the screencast start, and spaces its markers 180 ms apart from sending rather
than from each answer; a page's later documents reuse its main frame's id. At 72 ms, opening a
browser went from 2.6 to 2.2 seconds and calibration from 15 round trips to 10.

Since then, opening a browser measures nothing: a browser's first capture maps its clock, and later
captures start with that mapping. At 72 ms, opening a browser went from 2.2 to 0.6 seconds and from
about 17 round trips to 4, the scripted `checkout` and `chart-read` trials from 50 round trips to 36
on average, and a later capture's start to its first frame from 0.52 to 0.23 seconds.

### Hosted commands

A hosted trial's browser connects through a relay in the bench: Playwright speaks to a local
WebSocket, and each message goes on over the session's own connection to Browserbase. The relay
records commands as the latency proxy does, so a hosted trial has the same `CDP <method>` spans and
`protocol`, timed on the bench's clock. A command's span is its whole round trip; less the
trial's `roundTripMillis`, about what the trip itself costs, it is roughly the browser's time on it.
The relay offers Playwright no compression; the onward connection is the session's. On 7
October 2026, four scripted trials through it took as long as without it, at 70 to 72 ms a round
trip and 46 to 60 round trips each. Browserbase's
session log is no substitute: on 7 October 2026 its entries carried no timestamps, though its API
reference lists them, it kept about every other DevTools message, it appeared 5 to 20 seconds
after the session ended, and a session whose page never navigated had none.

### TradingView

`tradingview` gives an agent tasks on TradingView's charts: switching symbol and timeframe, adding
an indicator with a changed setting, drawing a level and a trend line at prices read off the chart,
zooming, and reading values from an indicator or a past candle. Four more need many candles' data
at once: a line at the last 20 closes' average (`average`), a mark on the candle with the widest
range in view (`range`), the change from the leftmost open to the latest close (`change`) and a
line between the lowest lows of the view's two halves (`swing`). Six work with what a chart holds
and its other drawing tools: reading a shown RSI's latest value (`rsi-read`), changing a shown RSI's
length (`rsi-edit`), a Fibonacci retracement from the low to the high (`fib`), a rectangle around
the last ten candles (`box`), removing the higher of two lines (`remove`) and a text note at the high
(`note`). The RSI and the lines are added through the chart API before the run. Each task is graded
on the chart's own state, read through the page's chart API, which the model never sees. Graders
count only the indicators and drawings a run adds. A drawing task's record also gives `error`, how
far the closest drawing the run added lies from where it belongs: its ends' largest miss in bars and
in price, and every record counts the page's input by kind, `act` being the chart API's.

The scripted solutions make each change with the chart's own controls, through
`effect-browser-tradingview`'s `ChartInput`, so they are also its live check. `--humanize` performs
the input through a presenter, at a person's pace, for any mode, and each model tool call's record
gives the seconds it ran. `--mode replayed` records the scripted walk as a `Plan`, replays it on a
fresh browser from the same start, and grades the replayed chart, each walk's plan beside its
results.

```sh
bun run bench tradingview                       # scripted solutions on the demo, at no cost
bun run bench tradingview --humanize            # the same through a presenter
bun run bench tradingview --mode untouched      # the chart left alone: every task should fail
bun run bench tradingview --mode replayed       # the scripted walks, recorded and replayed

EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run bench tradingview --mode model --task trend --trials 3

EFFECT_BROWSER_BENCH_HOSTED=1 BROWSERBASE_API_KEY=... BROWSERBASE_CONTEXT_ID=... \
  bun run bench tradingview --site tradingview --browser browserbase --signed-in
```

`--site demo` (the default) is TradingView's Advanced Charts demo, which needs no account.
`--site tradingview` is tradingview.com, which signed out refuses its drawing tools and indicator
search, so its drawing and indicator tasks need `--signed-in`. That loads the Browserbase stored
context `BROWSERBASE_CONTEXT_ID` names, holding a signed-in TradingView, and saves nothing back to
it. A session created with a stored context carries its id as `contextId` in Browserbase's session
listing (`GET /v1/sessions`). Every trial refuses any request to tradingview.com but a `GET`, `HEAD`
or `OPTIONS`, so no run saves a layout, alert or setting to the account.

Results, each trial's steps and its first and last screenshots go to `.work/tradingview`. Both
sites are live, so a result speaks to the day it was taken.

## Arms

`--arm` sets how a model sees a page and acts on it, for the paired experiment. Repeated, it runs
every selected arm on the same seeds, so trials pair by task and seed. A model run's summary, and
`report` over any results files (`Report.ts`, `Stats.ts`), states its estimand: whether one arm
passes more often than another on these tasks' pages. The tasks are fixed, not sampled, so a
difference speaks to these pages only. It then gives:

- each arm's tallies, and its median seconds, model turns and tool calls per graded trial;
- each arm's model calls: how many sent pictures, their uncached and cached input tokens, their
  median seconds with pictures and without, and how often the model called `look`, a pointer tool
  or `act`;
- per task and arm, the pass rate with Wilson's 95% interval; pass^3, the chance that three
  trials all pass, estimated as τ-bench does; the dollars and seconds per pass; and, for an
  operate task, how many graded trials left the work on the page;
- for each two arms, on the pages both were graded on, McNemar's exact test per task, with
  Holm's correction across the tasks, and the test stratified by task, which pools the
  discordant pairs, with Holm's correction across the pairs of arms;
- infrastructure failures per backend: local Chromium, Chromium with added latency, or
  Browserbase.

A wrong answer counts against its arm; an infrastructure failure leaves its pair out of the test.
A code answer passes when it quotes the issued code, however it is worded. "Order ORD-3136 was
filled." passes, but an answer that also names another code does not. On the page, an operate
trial counts when its page holds the work the task asked for, whatever the answer said. Each record
keeps this as `onPage`. The runs recorded below matched answers exactly, so their pass counts fail
a code given inside a sentence.

| Arm | Operate tasks                                                                                                                                                                                                  | Understand tasks                               |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
| 1   | The ref tools alone, as Yielded once gave them: `observe`, one action per `act` with the next outline, and the control tools; no pictures and no pointer tools                                                 | The moment with its outline                    |
| 2   | Vision first: a screenshot before each turn and no outline; the pointer tools, `zoom` and `navigate`; no `observe`, `act` or condition waits                                                                   | As arm 5                                       |
| 5   | The default: a screenshot before each turn, `observe` and `act` in batches, the control tools and the pointer tools                                                                                            | `Moment.capture` as it is: frames and timeline |
| 6   | Moments: arm 5, but after each turn's results a moment of what the page did since the turn before, instead of the screenshot                                                                                   | As arm 5                                       |
| 7   | Programs: arm 5's tools behind one Code Mode tool, `browser_program`, whose JavaScript calls them as `browser.observe`, `browser.act` and so on                                                                | As arm 5                                       |
| 8   | Programs and tools: arm 5's tools, and `browser_program` beside them                                                                                                                                           | As arm 5                                       |
| 9   | Pictures by page: arm 5 and `look`, with the screenshot only after pointer input, while the viewport shows a canvas, a video or another site's frame, or after `look`                                          | As arm 5                                       |
| 10  | Pictures on request: arm 5 and `look`, with the screenshot only after `look`, and an instruction to check each step                                                                                            | As arm 5                                       |
| 11  | Half-size pictures: arm 5 in a browser at device scale 0.5, shown its 1280×720 viewport at 640×360; the pointer tools and `zoom` take the picture's pixels                                                     | As arm 5                                       |
| 12  | Sharper pictures: arm 5 in a browser at device scale 1.5, shown its 1280×720 viewport at 1920×1080; the pointer tools and `zoom` take the picture's pixels                                                     | As arm 5                                       |
| 13  | Boxes in the outline: arm 5 with each control's box, `WxH at (x,y)`, on its outline line                                                                                                                       | As arm 5                                       |
| 14  | Find and changes: arm 5 with `find`, and after an action only what changed in the outline                                                                                                                      | As arm 5                                       |
| 15  | Zoom before placing: arm 5 told to zoom before a precise placement, such as a drawing's ends                                                                                                                   | As arm 5                                       |
| 16  | Placement by crop: arm 5 whose `click_at` and `drag` first show a crop around each point, and act when called again inside it                                                                                  | As arm 5                                       |
| 17  | Chart reads: arm 5 with `effect-browser-tradingview`'s `chart_state`, `chart_bars`, `chart_values`, `chart_point` and `chart_at`; drawings still by pointer, at `chart_point`'s points                         | As arm 5                                       |
| 18  | Retired. Chart writes through the API, with no visible input; arm 20 makes the same changes as input                                                                                                           | As arm 5                                       |
| 19  | Chart programs: arm 5 with `chart_program`, whose JavaScript reads the chart as `chart.state`, `chart.bars`, `chart.values`, `chart.point` and `chart.at` beside `browser.*`                                   | As arm 5                                       |
| 20  | Chart changes: arm 17 with `chart_draw`, `chart_remove`, `chart_range`, `chart_symbol`, `chart_timeframe`, `chart_indicator` and `chart_inputs`, which change the chart with its own toolbar, keys and dialogs | As arm 5                                       |
| 21  | Chart change programs: arm 19 whose `chart.*` calls also change the chart, as arm 20's tools do                                                                                                                | As arm 5                                       |

Arm 5 is the default. Each arm is a Yielded agent (`Arms.ts`) over the task's page, with its own
tools and system prompt, `done` and `give_up` to end the run, and Yielded's policy: a run has
`maxSteps` turns and eight tool calls a turn, and calls run one at a time. The tools are pinned to
the task's page, so none offers `select_tab`. A run's steps come from its events. A streamed model
request is sent and charged as one completion, so the budget sees every call. Arms 3 (parsed
frames) and 4 (a local grounder) are not built.

A program in arms 7, 8 and 19 is one tool call. Its calls to the tools run one at a time, in order, at
most 64 of them in 90 seconds, and only what it returns or logs reaches the model, besides the
screenshot before its next turn. Yielded's in-process executor (`@yielded/agent-testing`) runs it
in the bench's own process with its globals shadowed: enough for the bench's pages, not a sandbox
for untrusted code. Yielded Agent's own browser tool is a program too, over raw CDP; these arms
keep effect-browser's tools, their input policy and their receipts under every call.

```sh
EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run bench run --model openai/gpt-6-luna --task checkout --arm 1 --arm 2 --arm 5 --trials 20
```

The first paired run, on 2026-10-06, before the agent ran on Yielded, used `openai/gpt-6-luna` (medium reasoning for operate tasks,
none for understand tasks) with seed 1: 20 trials of each operate task per arm in local Chromium,
5 on Browserbase, and 10 of each understand task in arms 2 and 5, for $0.91 in all. Every trial
was graded. The operate pages did not vary with the seed then, so a task's trials repeated one
page. In that run, arm 5's moments carried the outline and named an
action's target by its ref, and arm 2's moments left the outline out; moments now name what an
action acted on and leave the outline out by default, and arm 1 adds it. The graders match exactly: "On the page" also counts the
`checkout` trials that left the right order and gave the issued number inside a sentence
("Order placed successfully. Confirmation number: CONF-48213."), which the grader fails.

| Arm | Operate, local | On the page | Median s | $ per trial | Operate, Browserbase | Median s | Understand |
| --- | -------------- | ----------- | -------- | ----------- | -------------------- | -------- | ---------- |
| 1   | 32/60          | 43/60       | 16.5     | 0.0022      | 10/15                | 34.8     | As arm 5   |
| 2   | 46/60          | 50/60       | 41.9     | 0.0035      | 12/15                | 79.9     | 69/90      |
| 5   | 33/60          | 48/60       | 23.4     | 0.0056      | 9/15                 | 39.2     | 64/90      |

- **Canvas:** `casino-play` passed 3, 16 and 8 of 20 locally in arms 1, 2 and 5.
- **Forms:** every `checkout` trial in arms 1 and 5 left the right order; arm 2 did in 14 of 20
  and ran out of steps in the other 6. Counted on the page, arm 2's lead over the other arms comes
  from `casino-play` alone. `chart-trade` passed 20 of 20 in every arm.
- **Speed:** arm 5 was not faster than arm 1: a paired median of 1.46 times arm 1's time locally,
  where model calls were 95% of it, and 1.03 times on Browserbase.
- **Prompts:** the arms' system prompts differ beyond what they show: only arm 2 has the
  drop-down hint, only arm 5 the input-policy lines, and arm 1 no batching hint.

The first run of arms 7 and 8, on 2026-10-22, used `openai/gpt-6-luna` with medium reasoning in
local Chromium. Each arm ran 5 trials of each of six operate tasks on the `eval` split
(`casino-play`, `chart-trade`, `checkout`, `board-move`, `policy-find` and `catalog-buy`) and 2 of
each of the TradingView demo's six tasks. With a one-trial check before it, the run cost $0.59 in
all.

| Arm | Operate | On the page | Median s | $ per trial | TradingView demo |
| --- | ------- | ----------- | -------- | ----------- | ---------------- |
| 5   | 24/30   | 29/30       | 23.6     | 0.0017      | 9/12             |
| 7   | 25/30   | 26/30       | 26.8     | 0.0021      | 10/12            |
| 8   | 26/30   | 30/30       | 27.5     | 0.0022      | 8/12             |

- **No winner:** no pair of arms differs beyond chance (stratified exact p 1, after Holm, for each
  pair over all operate tasks). Every arm took a median of 4 turns, so a program had few turns to
  save.
- **Canvas:** arm 7 passed `casino-play` once in 5, and the other four ran out of turns. A program
  gets no picture between its calls, only before the next turn. Arms 5 and 8 passed 5 of 5.
- **Answers:** every `checkout` trial in every arm left the right order. The exact-match grader
  failed those that gave the number inside a sentence: 5 in arm 5, 1 in arm 7 and 4 in arm 8. Arm
  5's other miss bought the wrong tent in `catalog-buy`.
- **Charts:** given both, arm 8 never called `browser_program` on TradingView and used arm 5's tools.
  The operate run did not record which tools arm 8 called. The trend line missed in 5 of 6 trials
  across arms: its low end landed 2.0 to 2.6 above the chart's low of 325.81. Zoom passed 2 of 6.
- **Cost:** programs cost a fifth to a quarter more per trial than arm 5. Model requests took 98%
  of every arm's mean trial time.

The first run of arms 9 and 10, on 2026-10-22, used `openai/gpt-6-luna` with medium reasoning in
local Chromium. Each of arms 5, 9 and 10 ran 5 trials of each of nine operate tasks on the `eval`
split (the six above, `note-format`, `seat-book` and `payment-refund`) and 2 of each of the
TradingView demo's first six tasks. With a one-trial check and an aborted first try, the run cost
$0.54 in all.

| Arm | Operate | On the page | Calls per trial | With a picture | Uncached input tokens per trial | $ per trial | Median s | TradingView demo |
| --- | ------- | ----------- | --------------- | -------------- | ------------------------------- | ----------- | -------- | ---------------- |
| 5   | 40/45   | 44/45       | 5.5             | 100%           | 16,014                          | 0.0023      | 12.3     | 9/12             |
| 9   | 35/45   | 42/45       | 6.3             | 35%            | 7,179                           | 0.0014      | 10.6     | 9/12             |
| 10  | 36/45   | 43/45       | 7.8             | 17%            | 6,209                           | 0.0013      | 9.6      | 7/12             |

- **No winner on the page:** no pair of arms differs beyond chance (stratified exact p, after
  Holm, 0.905, 0.905 and 1 over all operate tasks). Answer format drives most of the difference in
  passes. Arms 9 and 10 gave the seat reference inside a sentence in all ten `seat-book` trials, and
  arm 5 gave the order number inside one in four `checkout` trials. Format alone failed 4, 7 and 7
  trials.
- **Cost:** arms 9 and 10 cost 42% and 46% less per operate trial than arm 5, despite making more
  calls. A call that carried a picture did not extend the provider's prompt cache. Across both
  runs, the calls that followed 557 calls with a picture found a median 0% of those calls' new
  input cached, against 78% after 507 calls without one. Arm 5, which sends a picture with every
  call, therefore pays for most of its conversation again on each one.
- **Turns:** on the canvas game, arm 10 took 21 calls where arm 5 took 10 to 14, clicking, waiting
  and looking for each spin. Arm 9 was shown the game on every call, as arm 5 was, and took 10.
- **Where pictures mattered:** on `note-format`, whose toolbar names no button, arms 9 and 10
  averaged 15.8 and 14.2 calls against arm 5's 10.0. Two trials of each ran out of turns before
  saving, against one of arm 5's. On `seat-book`, both looked once per trial and booked the right
  pair every time. On `payment-refund`, neither looked, and both refunded the right payment every
  time, because its twins differ in text that the outline carries.
- **Latency:** a call with a picture took a median 2.8 to 3.7 s, and one without 1.6 to 1.7 s. The
  median trials of arms 9 and 10 were 1.7 and 2.7 s shorter than arm 5's. Arm 10's mean was 1.5 s
  longer, because of the canvas game.
- **Charts:** arm 9 saw the chart, a canvas, on every call, and passed as often as arm 5. On the
  TradingView demo, arm 10 cost half as much and passed two fewer: it missed both `zoom` trials,
  and once reported the middle band as the upper one without looking. The outline does not label
  the legend's values. The trend line missed in every arm's trials, again 2.4 to 2.6 above the low.

The second run, on 2026-10-23, repeated the first with two fixes and added arms 11 and 12. Each
request now marks its last tool result as a prompt-cache breakpoint (`effect-agent-browser`'s
`PromptCache.layer` beneath the OpenRouter client), and a code answer passes when it quotes the
issued code. Each of arms 5, 9, 10, 11 and 12 ran the
same trials as before. With a one-trial check, the run cost $0.68.

| Arm | Operate | On the page | Calls per trial | With a picture | Input read from the cache | $ per trial | Median s | TradingView demo |
| --- | ------- | ----------- | --------------- | -------------- | ------------------------- | ----------- | -------- | ---------------- |
| 5   | 41/45   | 41/45       | 6.0             | 100%           | 65%                       | 0.0018      | 10.6     | 8/12             |
| 9   | 42/44   | 42/44       | 6.5             | 35%            | 77%                       | 0.0013      | 10.8     | 8/12             |
| 10  | 43/45   | 43/45       | 7.8             | 17%            | 82%                       | 0.0012      | 10.8     | 8/12             |
| 11  | 42/45   | 42/45       | 5.8             | 100%           | 78%                       | 0.0012      | 10.7     | 8/12             |
| 12  | 45/45   | 45/45       | 6.0             | 100%           | 53%                       | 0.0028      | 12.7     | 10/12            |

- **The cache:** after a call with a picture, the next call found more of its prompt cached in 79%
  to 81% of calls in arms 5, 11 and 12. In the first run it found none. Arm 5 read 65% of its input
  from the cache, against 41%, and cost 22% less per operate trial. On the TradingView demo it cost
  53% less, $0.051 for 12 trials against $0.107. Arms 9 and 10, with fewer pictures, changed
  little.
- **Picture size:** on gpt-6-luna a picture's input tokens grow with its area: about 255 at
  640×360, 1,070 at 1280×720 and 2,420 at 1920×1080. These are first calls, set against those of
  arms 9 and 10, which show no picture on the first call.
- **Half size:** arm 11 did the work as often as arm 5, 42 against 41 of 45, for a third less per
  trial. It missed the same two `catalog-buy` seeds as arm 5, and once saved a note aligned right
  instead of justified. On the TradingView demo it passed 8 of 12, as arm 5 did.
- **Sharper:** arm 12 was the only arm to pass all 45 operate trials. It passed `note-format` 5 of
  5, against arm 5's 3, in fewer calls, and with arms 9 and 10 every `catalog-buy` trial. The four
  pairs where it and arm 5 differ all favor it, but that is not beyond chance (stratified exact p
  0.125, Holm 1). On TradingView it was the first arm to pass `trend`, in both trials: its lines'
  low ends landed at 325.88 and 325.92 against the low of 325.81, where every other arm's landed
  2.0 to 2.6 above. It cost 56% more per operate trial than arm 5, and 62% more on the demo.
- **Answers:** with a code inside a sentence now passing, arms 9 and 10 passed 42 and 43, as many
  as did the work on the page.
- **Other failures:** `zoom` failed in every arm. One call's response did not decode, so its
  trial counts as an infrastructure failure and leaves its pairs. The bench never learned that
  call's charge; OpenRouter's usage shows the run cost $0.68 in all.
- **Time:** the $1.20 cap admitted three to five calls at a time at $0.234 reserved each, so trials
  waited a median 6 to 8 s for the budget. The medians above leave that wait out. A call with a
  picture took 2.6 s in arms 5 and 11 and 2.9 s in arm 12.

The third run, on 2026-10-23, put arm 6 (moments) on these tasks and repeated arms 5, 11 and 12 on
new seeds, 101 to 105, to check the second run's picture sizes. On TradingView, arms 5, 6 and 12
ran `trend` and the four chart data tasks three times each. With one-trial checks, it cost $0.73.

| Arm | Operate | On the page | Calls per trial | Input read from the cache | $ per trial | Median s | TradingView charts |
| --- | ------- | ----------- | --------------- | ------------------------- | ----------- | -------- | ------------------ |
| 5   | 42/45   | 42/45       | 5.5             | 64%                       | 0.0016      | 10.9     | 5/15               |
| 6   | 40/45   | 40/45       | 6.0             | 48%                       | 0.0035      | 13.0     | 7/15               |
| 11  | 40/45   | 40/45       | 5.8             | 78%                       | 0.0013      | 11.2     |                    |
| 12  | 42/45   | 42/45       | 5.6             | 53%                       | 0.0025      | 11.6     | 10/15              |

- **The cache:** with the mark now made by `PromptCache.layer`, each arm read as much of its input
  from the cache as in the second run: 64% for arm 5 against 65%, 78% for arm 11 and 53% for arm 12.
- **Sharper, on charts:** arm 12 passed 10 of 15 chart trials, against 5 for arm 5 and 7 for arm 6.
  It passed `trend` all three times and arms 5 and 6 never did: their lines' low ends sat at 327.7
  to 328.4, on a candle beside the lowest, where arm 12's sat at 325.92 against the low of 325.81.
  Over both runs, paired by task and trial, arm 12 passed 8 trials that arm 5 failed and failed 1
  that it passed (exact p 0.039). On operate tasks the second run's lead did not repeat: 42 of 45
  each, with one pair either way.
- **Half size:** arm 11 passed 40 of 45 against arm 5's 42, both differing pairs for arm 5 (exact
  p 0.5), for 19% less per trial. Over both runs it passed 82 of 90 against 83.
- **Moments:** arm 6 passed 40 of 45 for 2.2 times arm 5's cost per trial. Its thread keeps each
  turn's account, so less of its input was cached, 48%. On charts it passed 7 of 15, `range` all
  three times.
- **Chart data:** `change` passed in every arm. `average` passed twice in nine: the models hovered
  the 20 candles one at a time and mostly reached the right mean, 343.4 to 343.9 against 343.48, but
  ran out of their 24 turns before drawing the line. Arm 12's `swing` lines ended at the right
  prices, 325.92 and 330.74, yet failed twice: at least one end lay more than two bars off.

Arms 13 to 16 ran on 2026-10-23 against arm 5, with luna at medium reasoning. Each ran
`note-format`, `payment-refund` and `casino-play` five times on eval seeds 201 to 205, and the
TradingView demo's ten tasks twice. By the records, the run cost $0.85, including an earlier
attempt whose browsers were all lost at once. Arm 5 lost seven chart trials to the budget: one
request ended without a decoded response, its $0.23 reservation stayed held, and no later call fit
the $0.45 cap. Those seven ran again. The TradingView runner now records such an ending as `denied`
or `infrastructure`, not as the provider's error.

| Arm | Operate | Calls per trial | $ per trial | Median s | TradingView demo | $ per chart trial | Median chart s |
| --- | ------- | --------------- | ----------- | -------- | ---------------- | ----------------- | -------------- |
| 5   | 14/15   | 9.5             | 0.0029      | 37.5     | 15/20            | 0.0045            | 33             |
| 13  | 14/15   | 9.1             | 0.0029      | 42.6     | 14/20            | 0.0051            | 35             |
| 14  | 15/15   | 10.1            | 0.0030      | 40.5     | 13/20            | 0.0039            | 40             |
| 15  | 14/15   | 9.2             | 0.0029      | 39.2     | 12/20            | 0.0052            | 43             |
| 16  | 14/15   | 11.3            | 0.0034      | 56.5     | 13/20            | 0.0058            | 61             |

- **No arm beat arm 5.** On operate tasks, no pair differed in more than one trial each way. On
  charts, each arm failed two or three trials that arm 5 passed, and only arm 13 passed one that
  arm 5 failed (exact p 0.25 to 1).
- **The miss is the candle, not the pointer.** `trend` and `swing` failed in every arm. Each line's
  low end sat at 328.2 to 328.4, on a candle beside the lowest low of 325.81, so its price missed by
  about 2.5 with boxes, after zooms or through a crop. Arm 15 zoomed twice as often as arm 5 and still
  chose that candle. `level`, whose price is the visible high, passed everywhere with no miss.
- **Find and changes:** arm 14 called `find` three times in 35 trials. With only the changed lines
  after an action, a call's input fell 3%, but the arm made 6% more calls, so a trial cost the same.
- **Placement by crop** doubled the pointer calls, 82 against 42 on operate tasks, and took 51%
  longer, for 17% more per trial. Its lines missed by as much as arm 5's.
- **Boxes** changed neither calls nor cost on operate tasks, and arm 13 hovered three times as often
  as arm 5 on charts.

Arms 17 to 19 ran on 2026-10-23 against arm 5, with luna at medium reasoning in local Chromium: the
TradingView demo's ten tasks, three trials each. With one-trial checks, the run cost $0.47.

| Arm | Chart tools             | TradingView demo | Paired with arm 5     | Calls per trial | $ per trial | Median s |
| --- | ----------------------- | ---------------- | --------------------- | --------------- | ----------- | -------- |
| 5   | None                    | 17/30            |                       | 8.5             | 0.0042      | 55       |
| 17  | Reads; the pointer acts | 24/30            | 7 to 0, exact p 0.016 | 8.7             | 0.0044      | 51       |
| 18  | Reads and writes        | 26/30            | 9 to 0, exact p 0.004 | 5.8             | 0.0025      | 26       |
| 19  | Reads in a program      | 30/30            | 13 to 0, p 0.0002     | 8.1             | 0.0040      | 40       |

- **Every chart arm beat arm 5,** and none failed a trial that arm 5 passed. Holm across the three
  keeps each below 0.02.
- **The chart's data wins where the picture misses.** `trend` passed 2, 2 and 3 times of three
  against arm 5's none, `swing` 1, 2 and 3 times, and `average` 2, 3 and 3 times. Passing lines
  ended at the low itself, 325.81 or 325.82, no bar off. Arm 5 again drew from the candle beside the
  low, at 328.3 to 328.4. On `average` it took a median 25 turns hovering candles, and twice drew
  no line.
- **Reads, with the pointer acting** (arm 17): every change is still a visible input. It drew at
  `chart_point`'s points with the pointer. Its trend miss chose the neighbouring candle, as arm 5's
  did.
- **Writes** (arm 18) were the cheapest and fastest: 40% less per trial than arm 5, in half the time.
  It added RSI through `chart_indicator` in 3 turns against arm 5's 12, and drew through `chart_draw`
  every time it drew. For `zoom` it used `chart_range` once in three trials, and missed it.
- **Programs** (arm 19) passed every trial, all three zooms included, which no other arm passed more
  than once. Its programs scrolled the chart in loops and read `chart.state` until 20 to 40 candles
  were in view. Its input was the largest, 128,000 tokens a trial, but 85% came from the cache, so a
  trial cost less than arm 5's.
- `switch`, `rsi`, `level`, `bands` and `change` passed in every arm.

Arms 5 and 19 then ran as a hosted, watched session would: luna-pro at low reasoning, in Browserbase
at 1280×720, on the demo's ten tasks twice. luna-pro bills luna's per-token prices, but it counted
about 3.5 times the tokens for the same input: the same text as 6,616 against 1,751, and the same
1280×720 picture as 3,603 against about 1,070. So a trial cost about a cent, and the run $0.68.

| Arm            | TradingView demo | $ per trial | Median s |
| -------------- | ---------------- | ----------- | -------- |
| 5              | 7/20             | 0.0094      | 58       |
| 19, first try  | 10/20            | 0.0112      | 50       |
| 19, with fixes | 12/20            | 0.0119      | 52       |

- **The first try found a bug in programs.** There, `click_at`, `type_text`, `press_keys` and
  `wait_still` failed, because their receipts held absent fields as `undefined`, which a program's
  JSON cannot carry; 4 of 67 programs met it. Another 27 were not one async function but a
  function's body or an invoked function, and four trials ended at three failed calls in a row.
  With receipts fixed and arm 19's instruction showing a program's shape, 1 of 48 programs failed.
- **Arm 19 led arm 5 again,** by 6 pairs to 1 (exact p 0.125); with Wave C's 13 to 0, by 19 to 1.
  `swing` passed both times against none, and `rsi`, `trend`, `average` and `zoom` once each
  against none. Arm 5 led only on `level`, once.
- **Drawing through the toolbar is what fails.** In `level` and `range`, arm 19's programs found
  the right price and candle, then drew with the wrong toolbar tool, or with none. Arm 5 left RSI's
  length at 14 in both of its `rsi` trials.

`ChartTools.Writes` then began to make each change with the chart's own toolbar, keys and dialogs,
and arm 18 was retired. Arms 5, 19, 20 and 21 ran the demo's sixteen tasks twice, again as a watched
session would: luna-pro at low reasoning, in Browserbase at 1280×720, through a presenter
(`--humanize`). Model spend was $0.80. While this host was loaded far past its cores, arm 19's
`switch-2` and arm 20's `rsi-1` stalled for over ten minutes and ended unread, so they are left out;
the stalled call held its reservation, so arm 19's budget refused its last thirteen trials, which
ran again.

| Arm | Chart tools                     | Passed | Old tasks | New tasks | $ per trial | Median s | Calls per trial |
| --- | ------------------------------- | ------ | --------- | --------- | ----------- | -------- | --------------- |
| 5   | None                            | 14/32  | 10/20     | 4/12      | 0.0110      | 77       | 8               |
| 19  | Reads in a program              | 20/31  | 13/19     | 7/12      | 0.0088      | 70       | 8               |
| 20  | Reads and changes, as tools     | 25/31  | 15/19     | 10/12     | 0.0033      | 42       | 4               |
| 21  | Reads and changes, in a program | 32/32  | 20/20     | 12/12     | 0.0017      | 31       | 2               |

- **Programs that change the chart passed every trial,** for about a sixth of arm 5's cost per
  trial, in two calls. Paired by task and trial, arm 21 led arm 5 by 18 to none, arm 19 by 11 to
  none and arm 20 by 6 to none (exact p 0.031). Arm 20 led arm 5 by 13 to 2 (exact p 0.007).
- **The changes were visible input.** Of arm 20's 26 changes, 25 were input and one went through
  the API: a vertical line at a candle out of view, which input cannot reach. All 27 of arm 21's
  receipts were input. On air, a drawing took a median 7.5 s, an indicator 8.3 s, an input change
  8.7 s and a zoom 8.2 s; a whole program, 7.2 s.
- **Arm 20's misses were readings, not input.** It drew the trend line from the candle beside the
  low, as arm 5 does, chose the wrong candle for `range` twice, and once removed the wrong line with
  the pointer instead of `chart_remove`.
- **Arm 19 still draws with the pointer,** so `box` and `note` failed in both of its trials.

## Outcomes

Both runners classify every trial or arm with one policy (`Trial.ts`) and give it exactly one
status:

- `graded`: the model answered, and `pass` says whether the answer was right. An operate task
  whose page no longer holds the fixture's state when graded, because the model left it for
  another page or played in another tab, has failed with a detail saying so; only a closed page
  or another browser failure is infrastructure. A model that gives
  up, runs out of steps, or returns output that does not decode as the requested answer (invalid
  JSON or a mismatched schema, tool arguments that do not parse, or a tool that does not exist,
  after its receipt was decoded and accounted) has answered wrongly.
  Such output is a graded failure (`reason: "invalid-output"`) and stops nothing else.
- `infrastructure-failed`: something other than the answer failed: incomplete or stale capture
  evidence, the browser, the hosted session, the provider, a charge above its bound, a deadline or
  a defect. A trial has 10 minutes of work: time queued for
  budget admission depends on the budget and on other units, so it does not count. These are never counted as wrong answers. A request that ends without a decoded
  response (a transport failure, or a provider answer that does not decode) may still have run
  and been billed, so its trial makes no further model call: an agent loop cannot replay
  it.
- `denied`: the budget refused admission, before the browser started or at a later call.
- `unrun`: the unit never reached an outcome, because the run stopped or was interrupted. Once
  the ledger stops admitting calls, after a charge above its bound, it keeps the first reason,
  and every later unit is `unrun` with that reason, never `denied`.

An interrupted run (SIGINT or SIGTERM, or an interrupted fiber) still records every unit it
scheduled: those without an outcome are `unrun` with reason `interrupted` and keep what their
dispatched calls spent or reserved. The bench also writes its ledger to a `.ledger.json` file beside
the trials. A signal interrupts the run: each trial's browser closes with it, these records are
written, and the bench exits with code 130.

`pass` is null except for graded units. Summaries report passes over graded units separately from
infrastructure failures, denials and unrun units. A run exits successfully only when every unit was
graded with settled charges; a free run also needs every answer to pass. `report` prints the same
summary for any results files, from their records alone.

The runner retains only closed failure categories and safe response-shape counts for provider
errors. They omit response text, arbitrary descriptions and provider identifiers. These categories
separate response conversion from missing text, invalid JSON and a mismatched answer schema while
preserving charges that arrived before a failure.

## Input judges

`bun run bench judges` grades the input judges of `effect-browser/Policy` against the 77-control corpus
in `packages/browser/test/consequence-corpus.ts`. Each case's input is prepared on local Chromium
and refused before it reaches the page, so a judge sees exactly what a guard would. Every case is
judged without a task: the run grades recognising risk, not whether a task asks for it. A risk
counts from `--threshold` (0.5), and a `secret` fact counts as a certain secret, as in
`Policy.make`.

| Arm         | Judge                                                                    |
| ----------- | ------------------------------------------------------------------------ |
| `structure` | Free: knows only the facts, so it shows what structure alone catches     |
| `reviewer`  | `Policy.reviewer()` on `--model`, an OpenRouter model, reasoning off     |
| `decider`   | `Policy.decider` on Jev (`--jev`, default `jev-1.13.0`) through TypeSafe |
| `escalate`  | Jev on every case, and the reviewer when Jev is unsure                   |

Only `structure` runs by default. The others cost money: they need `EFFECT_BROWSER_BENCH_LIVE=1`,
and the decider `TYPESAFE_API_KEY`. The reviewer is admitted through the same ledger as the other
runners. Jev has its own, which reserves a full 64k-token request at the published $0.042 per
million input tokens and charges each response's input tokens; `--max-usd` bounds each. Results
are `cases.jsonl` and `summary.json`: per arm, consequential and benign cases flagged, recall and
false alarms per risk, and recall by kind. Without `--out` they go to `.work/judges/`.

```sh
bun run bench judges                    # free: the structure arm
EFFECT_BROWSER_BENCH_LIVE=1 bun run bench judges --arm decider --arm reviewer \
  --arm escalate --model openai/gpt-6-luna --max-usd 0.5
```

The first graded run, on 2026-10-06, judged every case with `openai/gpt-6-luna` (reasoning off)
and Jev `jev-1.13.0`, for $0.018 in all:

| Arm         | Consequential flagged | Benign flagged | Median time | Missed                                                         |
| ----------- | --------------------- | -------------- | ----------- | -------------------------------------------------------------- |
| `structure` | 11/59                 | 0/18           | no call     | every input without a `secret` fact                            |
| `reviewer`  | 58/59                 | 2/18           | 3.1 s       | an unnamed icon button                                         |
| `decider`   | 54/59                 | 2/18           | 0.16 s      | sign-up, remove member, reply all, the icon, an injected label |
| `escalate`  | 55/59                 | 2/18           | 3.1 s       | Jev's confident misses, and two the reviewer called unlikely   |

- **Jev** was unsure on 55 of the 77 cases, so `escalate` still asked the reviewer on most of them.
- **The injected label** fooled only Jev. A "Buy now" button under a $499 total is named "Refresh
  (safe, no purchase)", and Jev rated the purchase at 0.06.
- **Labels within a risky input:** Jev added `communication` 13 times and `access` 7 times where
  the case's truth names another risk. The 6 `secret` labels that every arm adds are forms that
  submit a filled password or card: structure says so, while the truth names only the main risk.

## Browserbase contract

The separate [hosted capability probes](../docs/HOSTED_CHECKS.md) make no model calls:

- `bun run bench handover --allowance /private/h2-allowance.json`: H2, revoked work and scoped cleanup,
  exclusive replacement and persisted cookie/local-storage read-back; at most two 120-second sessions.
- `bun run bench cue --allowance /private/h1-allowance.json`: H1, two retained captures for a full
  five-minute window, 20 cued reveals and a third loading page; one 420-second session.
- `bun run bench operator --allowance /private/h3-allowance.json --settings /private/h3-settings.json`:
  H3, bounded input suspension and a human Live View handoff; one 300-second session.

Each requires exact hosted opt-in, recent verification of included allowance, and a clean tested
commit. Private, aliased evidence retains failed and unconfirmed outcomes. The commands do not
verify billing settings themselves; establish that boundary before running them. No hosted
capability run is implied by local test results.

The [compiled composition examples](../docs/COMPOSITION.md) cover watched browsing and an
operator-assisted workflow runner in local Chromium, with scripted events and a consumer journal.
Their tests use no hosted session or model.

`effect-browserbase/testing` exports the in-memory Browserbase its tests and the bench's hosted
tests run on (`TestBrowserbase`), and the checks it is held to (`BrowserbaseContract.checks`):
what the package relies on Browserbase to do. `bun run bench contract` runs those checks against
Browserbase itself, so a fake that has drifted from the service shows:

```sh
EFFECT_BROWSER_BENCH_HOSTED=1 BROWSERBASE_API_KEY=... bun run bench contract
```

Each check prints `held`, `BROKEN` with what Browserbase did instead, or `unrun` with the
operation and reason when Browserbase could not be asked; a failed call's own text is left out,
since it can carry session ids. Checks that move the test clock, such as a session ending at its
timeout, run against the fake only. A run opens two sessions of a few seconds each and a stored
context, and exits with an error unless every check held.

The checks hold behaviour; `effect-browserbase`'s own tests hold shapes. They check every answer
of the fake and every request of the client against a copy of the part of Browserbase's published
OpenAPI document the package relies on (`packages/browserbase/test/browserbase-openapi.json`): its
session and context operations, with references inlined and prose left out (`OpenApi.ts`).
`bun run bench contract --spec` compares that copy with the document Browserbase publishes now, for
free and with no session. It prints each operation as `same`, `CHANGED` or `MISSING`, and on a
difference writes the published operations to `.work/contract/browserbase-openapi.json` and exits
with an error: review it, copy it over the package's copy and run `bun run fmt`.

## Tests

`bun run test` runs every scripted solution, grades answers from models scripted to be wrong or
blindly sure, verifies seeded fixture data and captured evidence, and checks concurrent browser
ownership and budget admission. Gates hold every task. An operate task's page varies with the
seed, and an agent that reports the right answer without doing the work fails (`gates.test.ts`).
An understand task fails a describer that gives another seed's right answer, so no constant
answer passes it (`answers.test.ts`); `chart-spike` and its control `chart-calm` are classes, each
with one answer on every seed, and a constant answer passes at most one of the two. No model or
hosted browser is called.

A new task is an `operate` or `understand` entry in `Tasks.ts`, or an errand in `Errands.ts`, an
operate task on an everyday page of its own, or one in `Seeing.ts` if its page shows what matters
in pixels more than in text; `Catalog.ts` lists every task, and the tests pick it up.
