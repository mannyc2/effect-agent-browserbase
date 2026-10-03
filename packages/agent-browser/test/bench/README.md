# Watched-browsing bench

Unpublished tools for measuring agent browsing shown in livestreams and films.
The bench uses the actual browser owner and retained capture, with independent
fixture truth. It starts with a `smoke` scene: a changing page at 1280×720,
five seconds of capture, delivered/discarded counts, FPS and inter-frame gap
p50/p95/max from the host's monotonic receipt clock.

From `packages/agent-browser`, using the pinned workspace:

```sh
vp run bench scenes
vp run bench plan smoke --backend chromium --trials 3
vp run bench run smoke --backend chromium --trials 3 --out ../../.work/bench/runs
vp run bench report ../../.work/bench/runs/<run>
```

Each run owns a new session and output directory. `record.json` records scene,
backend, settings, HEAD and whether source was dirty, events, truth, metrics,
reported model usage, capture metadata and checked cleanup. Source JPEGs remain
in `frames/`. Source state is evidence, rather than an execution prerequisite.
The bounded journal and frame sink report loss rather than hiding it.

Browserbase needs a publicly reachable fixture supplied by `--fixture-origin`,
`EFFECT_AGENT_BROWSERBASE_LIVE=1`, and the account credentials. Its release is
recorded without provider identifiers; uncertain allocation or unconfirmed
release stops further sessions.

Every paid run requires the owner's approval of its printed plan. Model runs
also need `EFFECT_AGENT_BROWSER_BENCH_LIVE=1` and a positive `--max-usd` cap.
The generic model drivers preserve OpenAI Responses, Anthropic and OpenRouter
vendor pinning. They allow images. The cap checks reported spend before the
next request, so a final request can overshoot it; `maxOutputTokens` bounds that
request's output. Missing usage stops further calls. Rates in records are dated
operator inputs and estimates, rather than invoices. Models remain Luna-priced
unless the owner authorizes another comparison.

Capture is change-driven. A still document sends few frames; FPS is a delivered
cadence metric and does not establish transport latency or website audio.
Generated records and media stay ignored under `.work/` or in acceptance artifacts.
The former nine-case evaluation and its pilots remain in Git history at `1ed8259`.
