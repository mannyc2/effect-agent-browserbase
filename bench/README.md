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
change on the browser clock; an incomplete capture fails before any model call. Bench browsers retain up to 1,200 frames for the
longest fixture; this does not change the library default. The tumble task selects twelve frames
to cover its paying cascades, rather than asking the model to count transitions absent from the
pictures. Operate tasks receive an outline and screenshot once per turn; calls within a
turn halt on the first failure. `browser_zoom` adds requested viewport crops to that observation;
pixel clicks return the element under the requested point. Runs without a model still use the free
scripted solutions. Runs allow input by default; a caller's `Browser.Options.guard` can deny or
hold classified input and navigation without a user-facing confirmation prompt. Typing keeps its
pacing over delayed connections. Events, frame arrivals and moment windows use the browser’s host
monotonic clock; these stamps are relative timings, not calendar dates. `Browser.events()` also
exposes the presentation track with sequence cursors for bounded replay. The bench’s descriptions
continue to use narrative action events, without the cursor-rendering track.

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
new 1280×720 session, released when the trial ends. Browserbase time is not part of the model budget.
The model remains a caller choice. For the research runs, use `openai/gpt-6-luna`; reasoning defaults
to `medium` for operate tasks and `none` for understand tasks. `--reasoning` overrides both.

Before each model call, the runner reserves a conservative upper bound against the shared
`--max-usd` budget (default $2). It pins a compatible provider endpoint and uses its prompt-token limit, the highest
listed tier/cache-write rates and `--max-output-tokens` (default 4,096). `--rates in,out` supplies
provider price ceilings in USD per million tokens. Trials wait while active calls can release capacity. An actual billed receipt releases the unused reservation. A missing receipt or
unknown charge keeps its reservation, so another trial cannot spend it again. This can stop a run
before the nominal budget is used; it never treats an unknown charge as zero. Billable plugins are disabled in each request; the account
must allow those overrides, since protected account defaults can add fees outside this token budget.

Each trial is one line of a JSON Lines file in `.work/bench/` at the repository root (ignored by git):
the task, base and derived fixture seeds, effective reasoning, completion/failure/skip status and reason, the answer, model calls, tokens,
known dollars, unresolved reservations, elapsed seconds including browser setup and cleanup, and
any error. Budget-skipped trials have records with zero calls and do not start a browser.
`usd` is null when a trial's charge is uncertain; `knownUsd`, `reservedUsd` and
`uncertainCalls` retain the available accounting facts. The ISO start time is a calendar date;
elapsed time uses a monotonic clock.

## Tests

`bun run test` runs every scripted solution, grades answers from models scripted to be wrong or
blindly sure, verifies seeded fixture data and captured evidence, and checks concurrent browser
ownership and budget admission. No model or hosted browser is called.

A new task is an `operate` or `understand` entry in `Tasks.ts`; the tests pick it up.
