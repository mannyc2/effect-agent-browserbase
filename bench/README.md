# Bench

Can a model, working through effect-browser, operate and understand canvas games, live charts and
forms and dense quote tables? Each task grades against the page's own truth, and has a scripted solution that shows the task
can be done and graded without a model.

The pages (`Sites.ts`) are served at `https://bench.test` by request interception, so a local
Chromium and a hosted browser load them the same way, with no tunnel. Each page keeps its truth in
`window.__bench` for grading; models never see it. Each trial derives its fixture seed from the base seed, task and trial number,
so changing concurrency does not change its page data.

| Task            | Kind       | What the model must do                                                                    |
| --------------- | ---------- | ----------------------------------------------------------------------------------------- |
| `casino-play`   | operate    | Pass a cookie wall and an age check, play five spins on a canvas slot machine             |
| `casino-moment` | understand | Read the credits and the last win off the canvas, just after a win                        |
| `chart-read`    | understand | Read the last price, to within 0.05%, and the trend off a canvas chart                    |
| `chart-spike`   | understand | Notice a 3.5% jump, from three frames over the last four seconds                          |
| `chart-calm`    | understand | The control for `chart-spike`: the same question, before the jump                         |
| `chart-trade`   | operate    | Buy 0.25 BTC at market on a live trading page and report the order id                     |
| `checkout`      | operate    | Fill in a shipping form, with a select and radios, and report the confirmation            |
| `quote-table`   | understand | Read the quote's price, 1-hour/24-hour changes and exact 24-hour header                   |
| `quote-dense`   | understand | Bind the quote to the right row, period and table among similar panels                    |
| `tumble-win`    | understand | Count paying cascades on a 6×5 canvas slot and read the final multiplier, win and balance |
| `order-filled`  | understand | Identify the filled order, its quantity, price and status                                 |
| `navigated`     | understand | Identify the destination URL, title and control that triggered navigation                 |

An operate task gives a model the browser tools (`Agent.run`). An understand task brings the page to
a moment without a model, captures it (`Moment.capture`) and asks a model about it in one call
(`Moment.describe`). Capture starts before the scripted setup, and multi-frame tasks check the
retained time span as well as the frame count. The final frame must follow the fixture's last visual
change on the browser clock. A screencast can lose the final paint of a page that then stays
still, so each fixture paints its settled state once more, and if no frame reaches the barrier the
final frame is a fresh screenshot with its own capture timing, never a claimed paint time. An
incomplete capture is an infrastructure failure, before any model call. Bench browsers retain up to 1,200 frames for the
longest fixture; this does not change the library default. The tumble task selects twelve frames
to cover its paying cascades, rather than asking the model to count transitions absent from the
pictures. Operate tasks receive an outline and screenshot once per turn; calls within a
turn halt on the first failure. `browser_zoom` adds requested viewport crops to that observation;
pixel clicks return the element under the requested point. Runs without a model still use the free
scripted solutions. Runs allow input by default; a caller's `Browser.Options.guard` can deny or
hold classified input and navigation without a user-facing confirmation prompt. Typing keeps its
pacing over delayed connections. Humanized runs use visible wheel input to reach off-screen
targets and type near 75 WPM with overlapping holds; the optional prose flag permits corrected
slips only in eligible fields. Presentation pauses preserve the navigation wait. Events, frame
arrivals and moment windows use the browser’s host monotonic clock; these stamps are relative timings, not calendar dates. `Browser.events()` also
exposes the presentation track with sequence cursors for bounded replay. The bench’s descriptions
continue to use narrative action events, without the cursor-rendering track. Frame windows and
evidence spans use mapped browser paint time, with screenshot timing represented separately;
late delivery cannot make old paint count as the fixture's final state. Capture counters expose
native filtering, paint gaps and observed subscriber loss.

## Running

From this directory:

```sh
bun run bench                       # scripted solutions in local Chromium, at no cost
bun run bench -- --help

EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run bench -- --model <openrouter-model-id> --trials 3 --concurrency 4 --seed 23

EFFECT_BROWSER_BENCH_HOSTED=1 BROWSERBASE_API_KEY=... \
  bun run bench -- --browser browserbase
```

Model calls and Browserbase sessions cost money, so each needs its environment variable. Trials run
with bounded concurrency (`--concurrency`, default 4) and separate browsers. Every Browserbase trial gets a
new 1280×720 session, released when the trial ends; its own 15-minute timeout, longer than the
10-minute trial deadline, ends a session the bench could not release. A session create that was
sent without a usable answer may have allocated a session, so after one the run requests no
further hosted session and records the remaining trials as unrun. Browserbase time is not part of
the model budget.
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

Each trial is one line of a JSON Lines file in `.work/bench/` at the repository root (ignored by git):
the task, base and derived fixture seeds, the run (source commit and whether the checkout was dirty,
model, pinned endpoint with its rates and per-call reservation, browser, humanize, output-token
limit, budget and concurrency), effective reasoning, status and reason, the answer, any
error with its closed diagnostic, the call `accounting` (calls, tokens, known dollars, unresolved
reservations and uncertain calls), `timing` (seconds queued for budget admission and seconds in
provider requests) and elapsed seconds including browser setup and cleanup. The ISO
start time is a calendar date; elapsed time uses a monotonic clock.

## Outcomes

Both runners classify every trial or arm with one policy (`Trial.ts`) and give it exactly one
status:

- `graded`: the model answered, and `pass` says whether the answer was right. A model that gives
  up, runs out of steps, or returns output that does not decode as the requested answer (invalid
  JSON or a mismatched schema, after its receipt was decoded and accounted) has answered wrongly.
  Such output is a graded failure (`reason: "invalid-output"`) and stops nothing else.
- `infrastructure-failed`: something other than the answer failed: incomplete or stale capture
  evidence, the browser, the hosted session, the provider, a charge above its bound, a deadline or
  a defect. These are never counted as wrong answers.
- `denied`: the budget refused admission, before the browser started or at a later call.
- `unrun`: the unit never reached an outcome, because the run stopped or was interrupted.

An interrupted run (SIGINT, or an interrupted fiber) still records every unit it scheduled: those
without an outcome are `unrun` with reason `interrupted` and keep what their dispatched calls
spent or reserved. The bench also writes its ledger to a `.ledger.json` file beside the trials,
and the comparison writes `summary.json` marked `interrupted`. Playwright exits the process on
SIGINT once its browsers close, so these records are written synchronously when the signal
arrives.

`pass` is null except for graded units. Summaries report passes over graded units separately from
infrastructure failures, denials and unrun units. A run exits successfully only when every unit was
graded with settled charges; a free run also needs every answer to pass.

## Paired quote comparison

`bun run understand` runs a free rehearsal through the pinned OpenRouter adapter using an
in-memory response that reads the requested row from the visible facts. Its results are marked `dry-run`; they test
the harness and make no model-accuracy claim.

The comparison prepares one captured moment for each seeded quote fixture and reuses it across
three arms. A uses the shipping `Moment.describe` prompt, frames, outline and timeline. B uses
the historical on-air representation: the latest image resized to 640×360 plus the first 4,000
UTF-8 bytes of visible body text, with no outline or timeline. The `facts` arm uses the identical
A moment and question, adding conclusions computed from every visible quote table through the
existing instructions option: each row's values as numbers keyed by its table caption, row asset
and exact column header. The facts do not pick the requested table, row or period; binding them
remains the model's task, as it would be for a caller who computes page facts without knowing the
question. The library's prompt and API stay unchanged.

A native paint barrier and stable visible evidence bracket the shared capture. All arms identify
the focused asset from the visible page heading. The question names the desired
table, without supplying the expected ticker or numeric answers. Fact provenance binds the page,
URL, observation time, table caption, row ticker and exact column headers to the displayed cells.
The hidden fixture state is used only for grading. Ambiguous or changed evidence fails before a
model call; there is no automatic validator retry. Image resizing uses Chromium's high-quality
canvas filter, so B reproduces the old payload dimensions and text limit rather than claiming
bit-for-bit equivalence with the research prototype's Lanczos filter.

The manifest records the source revision and the pinned endpoint before any call. The default
manifest has 20 dense fixtures and 10 easy controls, with all three arms per case:
90 calls in a paid run. Arm order varies deterministically by seed. Cases run concurrently, with
one browser per case and the same captured evidence for its arms. A shared admission ledger bounds
all model calls. An infrastructure failure or an unresolved charge stops new admissions; already
dispatched requests still settle, and every unrun arm receives a record. A graded answer, including
malformed model output, remains a comparison result and stops nothing.

A paid run requires an explicit model and the existing live opt-in, separately from this free
rehearsal:

```sh
EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run understand -- --model <openrouter-model-id> --max-usd 1 --concurrency 4 --seed 1
```

The results distinguish graded mistakes from infrastructure failures and retain paired outcomes,
provider request latency (reported apart from time queued for budget admission), token usage and confirmed or unresolved charges, reported separately for dense fixtures
and easy controls. Each case also saves its shared image, resized baseline and visible evidence
for inspecting a result without another model call. Every displayed table, row and period has a
distinct value, so each graded answer's numbers are traced to the cells they were read from:
`bindingErrors` counts answers with a value from another table, another row of the requested
table, or another period (1h, 24h or 7d) of the requested row, reported separately, while a
number that matches no cell is a misread (`unsourced`) and a wrong ticker, table or header text is
a label error. The summary evaluates the pre-registered rules on the dense fixtures from these
counts, with `met: null` where there is no graded evidence. First establish that B makes binding
mistakes on the dense fixture, then compare A with `facts`. Beating B alone cannot establish that
facts improve the shipping implementation; an already-perfect A supplies no evidence to add an
API. Keep the original quality, cost and latency targets in view and report the limits of this
small sample. No public facts input is added without a measured benefit.

Both runners retain only closed failure categories and safe response-shape counts for provider
errors. They omit response text, arbitrary descriptions and provider identifiers. These categories
separate response conversion from missing text, invalid JSON and a mismatched answer schema while
preserving charges that arrived before a failure.

## Tests

`bun run test` runs every scripted solution, grades answers from models scripted to be wrong or
blindly sure, verifies seeded fixture data and captured evidence, and checks concurrent browser
ownership and budget admission. No model or hosted browser is called.

A new task is an `operate` or `understand` entry in `Tasks.ts`; the tests pick it up.
