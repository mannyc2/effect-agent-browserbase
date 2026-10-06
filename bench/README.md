# Bench

Can a model, working through effect-browser, operate and understand canvas games, live charts and
forms? Each task grades against the page's own truth, and has a scripted solution that shows the task
can be done and graded without a model.

The pages (`Sites.ts`) are served at `https://bench.test` by request interception, so a local
Chromium and a hosted browser load them the same way, with no tunnel. Each page keeps its truth in
`window.__bench` for grading; models never see it.

| Task            | Kind       | What the model must do                                                         |
| --------------- | ---------- | ------------------------------------------------------------------------------ |
| `casino-play`   | operate    | Pass a cookie wall and an age check, play five spins on a canvas slot machine  |
| `casino-moment` | understand | Read the credits and the last win off the canvas, just after a win             |
| `chart-read`    | understand | Read the last price, to within 0.05%, and the trend off a canvas chart         |
| `chart-spike`   | understand | Notice a 3.5% jump, from three frames over the last four seconds               |
| `chart-calm`    | understand | The control for `chart-spike`: the same question, before the jump              |
| `chart-trade`   | operate    | Buy 0.25 BTC at market on a live trading page and report the order id          |
| `checkout`      | operate    | Fill in a shipping form, with a select and radios, and report the confirmation |

An operate task gives a model the browser tools (`Agent.run`). An understand task brings the page to
a moment without a model, captures it (`Moment.capture`) and asks a model about it in one call
(`Moment.describe`). Operate tasks receive an outline and screenshot once per turn; calls within a
turn halt on the first failure. Runs without a model still use the free scripted solutions.

## Running

From this directory:

```sh
bun run bench                       # the scripted solutions in a local Chromium, at no cost
bun run bench -- --help

EFFECT_BROWSER_BENCH_LIVE=1 OPENROUTER_API_KEY=... \
  bun run bench -- --model <openrouter-model-id> --trials 3

EFFECT_BROWSER_BENCH_HOSTED=1 BROWSERBASE_API_KEY=... \
  bun run bench -- --browser browserbase
```

Model calls and Browserbase sessions cost money, so each needs its environment variable. Model runs
are priced from OpenRouter's public model list, or from `--rates in,out` in USD per million tokens,
and stop at the model call that reaches `--max-usd` (default $2). Browserbase time is not counted.
Every Browserbase trial gets a new 1280x720 session, released when the trial ends.

Each trial is one line of a JSON Lines file in `.work/bench/` at the repository root (ignored by git):
the task, whether it passed and why, the answer, model calls, tokens, cost, seconds and any error.

## Tests

`bun run test` runs every scripted solution, grades answers from models scripted to be wrong or
blindly sure, and checks that the ledger stops a run at its budget. No model is called.

A new task is an `operate` or `understand` entry in `Tasks.ts`; the tests pick it up.
