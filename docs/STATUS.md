# Status

## 0.3, unreleased

0.3 is a rewrite of the 0.2 set on stable Effect 4.0.0 and `effect/ai`:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Tools`, `Agent` and `Moment`.
- `effect-browserbase`: the Browserbase REST client, and sessions as a `Browser`.
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
- An input policy over resolved targets and navigation, with typed denials, independently bounded
  holds and validation before held actions resume: the press point is hit-tested after the
  pointer arrives, typing refuses to start on a control a key could activate, and a multi-key
  action stops at a new document. Guards receive structural facts, never keyword categories, and
  page evidence around the target without field values; text typed into secret fields is redacted
  from requests and recorded events. A 77-control labelled corpus grades the facts in `ready`.
  `Policy` adds judges over `effect/ai` (`reviewer` on a `LanguageModel`, `decider` on a
  `DecisionModel` such as Jev) and `make`, a guard that denies a risk the task does not ask for and
  fails closed on input with facts when its judge fails; `Agent.run` provides the task and ends
  after three refusals in a row. The judges are tested with scripted models; `bun run judges` in
  the bench grades them against the corpus, with paid arms only on opt-in.
- Moments: `Moment.capture` gathers a page's frames, outline and events over a window that can
  start where the previous moment ended, so consecutive moments neither repeat nor miss an event,
  and needs only the page. `Moment.toPrompt` lays a moment out as one message for any `effect/ai`
  call; describing it is the caller's own `generateObject`, `generateText` or `Chat` turn. Pages
  keep the screencast frames of the last 5 seconds (`frameHistory`), a moment's default window.
- Bounded, pipelined typing and shortcut chords, plus one host monotonic clock for events, frame
  arrivals, observations and moments.
- A timed input track with planned glides, submission receipts, button/key phases, wheel and cursor
  events; browser-wide pointer ownership and bounded event replay with explicit expiration.
- Humanized scrolling to off-screen targets, bounded fallback and approval revalidation; typing
  near 75 WPM with overlapping holds, slower word starts and opt-in corrected prose slips.
  Sampled presentation pauses retain the functional navigation wait.
- Browser paint mapped onto the host clock with explicit uncertainty through one browser-wide
  clock mapping, timestamped mouse and raw text-key input, a best-effort startup capture
  calibration for newly owned sessions, and per-page capture counters for filtering, paint gaps
  and observed subscriber loss. Screenshot timing has its own provenance; a reused screencast
  frame must postdate the latest input and be recent; borrowed pages receive no probe input.
- `bench` (private): twelve tasks over canvas games, live charts, dense quote tables, orders,
  navigation and forms, graded against seeded page truth and captured evidence. Trials run with
  separate browsers and bounded concurrency, task-specific reasoning defaults, elapsed-time metrics
  and a shared model admission budget. Every trial is graded, an infrastructure failure, denied
  or unrun, and summaries keep those denominators apart. `--arm` runs the paired experiment's
  arms 1 (an outline with every action), 2 (vision first) and 5 (`Agent.run`) on the same
  seeds; arms 1 and 2 use a bench loop over the public `Tools`. Paid runs remain opt-in.

`effect-agent-browser` and the Effect Agent dependency are gone: the agent loop is `effect/ai`'s
`Chat` with the browser toolkit. The tests run against real local Chromium, a fake Browserbase API
and scripted models. `bun run ready` runs all formatting, lint, type, test and build checks without
paid calls.

## Not rebuilt yet

0.2 did much that 0.3 does not do yet. A capability inventory of the 0.2 code, the plans, the open
PRs and the in-progress work marks each capability as rebuilt, left for later, or the consumer's to
build. Until the owner has agreed it, no 0.2 PR is closed and no branch is deleted.

The larger pieces left for later:

- recording to video files;
- operator handoff, reconnecting to a kept-alive session, extensions and uploads;
- the paid hosted checks;
- an install smoke test of each packed package before a release.

## Releases

The latest release is `0.2.0-beta.9` of `effect-browser`, `effect-browserbase` and
`effect-agent-browser`, published on 2 October 2026 from tag `v0.2.0-beta.9` (`976d316`) on the
`beta` dist-tag. 0.3 is not released. [RELEASING.md](RELEASING.md), `.github/workflows/publish.yml`
and `tools/` still describe the 0.2 release path, and the 0.3 path is undecided.

## History

The 0.2 code, its records and its media are in Git history: `1ed8259`, the last `main` before 0.3,
holds all of it.
