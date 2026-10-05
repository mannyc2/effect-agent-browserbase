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

## Paired quote comparison

`bun run understand` runs a free rehearsal through the pinned OpenRouter adapter using an
in-memory response derived from visible table cells. Its results are marked `dry-run`; they test
the harness and make no model-accuracy claim.

The comparison prepares one captured moment for each seeded quote fixture and reuses it across
three arms. A uses the shipping `Moment.describe` prompt, frames, outline and timeline. B uses
the historical on-air representation: the latest image resized to 640×360 plus the first 4,000
UTF-8 bytes of visible body text, with no outline or timeline. The `facts` arm uses the identical
A moment and question, adding conclusions computed from visible table cells through the existing
instructions option. The library's prompt and API stay unchanged.

A native paint barrier and stable visible evidence bracket the shared capture. All arms identify
the focused asset from the visible page heading. The question names the desired
table, without supplying the expected ticker or numeric answers. Fact provenance binds the page,
URL, observation time, table caption, row ticker and exact column headers to the displayed cells.
The hidden fixture state is used only for grading. Ambiguous or changed evidence fails before a
model call; there is no automatic validator retry. Image resizing uses Chromium's high-quality
canvas filter, so B reproduces the old payload dimensions and text limit rather than claiming
bit-for-bit equivalence with the research prototype's Lanczos filter.

The default manifest has 20 dense fixtures and 10 easy controls, with all three arms per case:
90 calls in a paid run. Arm order varies deterministically by seed. Cases run concurrently, with
one browser per case and the same captured evidence for its arms. A shared admission ledger bounds
all model calls. An infrastructure failure stops new admissions; already dispatched requests still
settle, and every unrun arm receives a record. A wrong graded answer remains a comparison result.

A paid run requires an explicit model and the existing live opt-in, separately from this free
rehearsal:

```sh
EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run understand -- --model <openrouter-model-id> --max-usd 1 --concurrency 4 --seed 1
```

The results distinguish graded mistakes from infrastructure failures and retain paired outcomes,
latency, token usage and confirmed or unresolved charges, reported separately for dense fixtures
and easy controls. Each case also saves its shared image, resized baseline and visible evidence
for inspecting a result without another model call. First establish that B makes binding
mistakes on the dense fixture, then compare A with `facts`. Beating B alone cannot establish that
facts improve the shipping implementation; an already-perfect A supplies no evidence to add an
API. Keep the original quality, cost and latency targets in view and report the limits of this
small sample. No public facts input is added without a measured benefit.

Both runners retain only closed failure categories and safe response-shape counts for provider
errors. They omit response text, arbitrary descriptions and provider identifiers. These categories
separate response conversion from missing text, invalid JSON and a mismatched answer schema while
preserving charges that arrived before a failure.

## Paired browser experiment

`bun run paired` writes a free preview manifest and one unrun row for every planned trial.
The full matrix contains 330 local runs and 132 hosted runs: six local arms and four hosted
arms over seven primary tasks and four separate understanding extensions. The same task/trial
seed is used across arms and providers; arm order is shuffled deterministically. `quote-dense`
belongs to the separate quote comparison.

| Arm | Operating representation                                       | Understanding representation                                          |
| --- | -------------------------------------------------------------- | --------------------------------------------------------------------- |
| 1   | Per-action outline, explicit screenshots                       | Shipping Moment                                                       |
| 2   | Screenshots, pixel actions and zoom; no outline or refs        | Timed frames and timeline, no outline                                 |
| 3   | Numbered OCR and icon descriptions, text only                  | A parsed list for every retained frame                                |
| 4   | Outline and images, with a local description-to-click grounder | Shipping Moment                                                       |
| 5   | Shipping batched Agent                                         | Shipping Moment                                                       |
| 6   | Native Responses computer actions                              | Original timed images and timeline, no actions on historical evidence |

Arm 1 uses the current public toolkit with current guard and halt behavior. It is a same-runtime
control, not a replay of the old commit; its comparison with arm 5 also includes automatic pictures.
Understanding arms 1, 4 and 5 deliberately have identical representations. Their repeated rows
are controls, and cannot establish an understanding benefit from batching or grounding.
The first approved native probe returned no usable computer contract. Arm 6 stays explicitly
prerequisite-blocked unless the exact route is independently confirmed with `--native-confirmed`.
This flag is an operator assertion, not an automatic provider capability test.

Free fixture verification uses real isolated browser processes, without a model or hosted session:

```sh
bun run paired -- --provider local --scripted --local-trials 1 --arms 5
```

Scripted rows validate fixtures and transport measurements only. They are not arm-performance
results. Paid runs require a clean committed checkout, an explicit model and live opt-in. A new
output directory is required, either ignored inside this checkout or outside it; the runner
never resumes or replays an uncertain trial.

```sh
EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run paired -- --provider local --model <openrouter-model-id> --max-usd 8
```

For hosted runs, also provide `EFFECT_BROWSER_BENCH_HOSTED=1`, the Browserbase key,
`--hosted-concurrency` and `--browser-hourly-usd`. Verify the account's available concurrency,
included hours and maximum overage rate first. The hourly value is a positive ceiling, not a
guess that remaining included time makes the rate zero. Hosted admission reserves a full
600-second session before creation against both `--max-browser-hours` (default 5) and
`--max-browser-usd` (default 1). Release acknowledgments are followed by bounded read-only terminal-state checks. Confirmed
termination settles conservative elapsed bounds; unknown create or release outcomes retain the
full lifetime reservation and stop admissions.
These bounds and terminal confirmations are not billing invoices.

One parent owns the model budget, provider keys and session lifetimes. Trial workers receive
only temporary loopback model capabilities and, for hosted trials, a private CDP endpoint.
Workers block external HTTP, WebSockets and service workers; fixture routing cannot remove that
boundary. An unused model reservation is held before hosted allocation; chat requests use the pinned OpenRouter SDK and native requests use the parent-owned Responses
transport. Both settle through the same admission account before a reply reaches the worker. Unknown charges keep
their reservation and stop later calls. Interruptions close owned workers and browsers and
settle active requests; no automatic retry is made. Default model caps for a separately approved
combined research run can be allocated as $1 for quote comparison, $1 for Moment confirmation
and $8 for this paired experiment. Separate invocations do not share a persistent ledger.

Local trials precede hosted trials. Workers run with bounded concurrency; a single permit
serializes trials that use local perception. Missing parser or grounder prerequisites produce
unrun rows before a model call or browser allocation. Arm 4's understanding control needs no
grounder. Grade failures continue the experiment; infrastructure failures stop later admissions.

Each record keeps model calls, reported tokens (image and reasoning counts stay null when
unreported), admitted image bytes and dimensions, action attempts approved by the guard,
perception calls and elapsed time, and worker/process outcomes. Resource wall time starts at
model-budget admission and includes browser setup and release; admission wait and total wall
time are separate. Worker phase timings separate preparation, the task and grading.

Native Playwright protocol output is reduced in memory to counts, serialized JSON bytes and
command/reply durations. Payloads, URLs and provider identifiers are never saved. These are
observed protocol exchanges, not wire bytes or the number of awaited round trips. The pinned
Playwright logger omits one shutdown command; that gap, unmatched traffic, overflow and other
measurement limits are explicit. Summaries separate primary/extension and operate/understand
strata, retain failed and unrun denominators, and show incomplete pairs. The small sample cannot
establish five-point noninferiority.

### Local perception

`Perception.ts` calls an explicitly started loopback service. `perception.py` runs real
Tesseract OCR, the MIT `icon_detect_v3` detector and Florence icon captioner, or the
Apache-2.0 Holo2-4B grounder. Model, processor, code and OCR-data revisions are pinned and included
in response provenance. Grounded coordinates are mapped back through the actual resize; stale
page/image identities, malformed points and unsupported output are rejected.

Use an isolated Python 3.12 environment with `perception-requirements.txt` for parsing.
The grounder requires the versions checked by the service (Transformers 5.9 and Torch 2.11).
Preparation explicitly downloads weights; serving is offline and does not install or fetch
anything. Keep weights and environments outside tracked source. Use separate model roots if
both services run together; each root has an exclusive owner.

```sh
python bench/perception.py prepare --models-root /tmp/browser-parse-models --mode parse
python bench/perception.py serve --models-root /tmp/browser-parse-models --mode parse --device cuda --port 8789

python bench/perception.py prepare --models-root /tmp/browser-ground-models --mode ground
python bench/perception.py serve --models-root /tmp/browser-ground-models --mode ground --device cuda --port 8790
```

Add `--preflight-only` to a serve command to inspect readiness without loading models.
Pass `--parse-origin http://127.0.0.1:8789` and/or `--ground-origin http://127.0.0.1:8790`
to the paired runner. CPU parsing is an explicit `--device cpu` alternative and its provenance
must remain distinct from GPU results. Grounding has no CPU or substitute-model fallback.
The service refuses insufficient GPU capacity; it never evicts another process.

Run the dependency-free Python contract tests with
`python -m unittest discover -s bench/test -p 'perception_test.py'`.
The TypeScript suite validates real Chromium, the real SDK over local HTTP fixtures, protocol
aggregation, model/session admission and cancellation without paid services.

## Tests

`bun run test` runs every scripted solution, grades answers from models scripted to be wrong or
blindly sure, verifies seeded fixture data and captured evidence, and checks concurrent browser
ownership and budget admission. No model or hosted browser is called.

A new task is an `operate` or `understand` entry in `Tasks.ts`; the tests pick it up.
