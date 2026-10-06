# Status

## 0.3, unreleased

0.3 is a rewrite of the 0.2 set as two packages on stable Effect 4.0.0 and `effect/ai`:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Tools`, `Agent` and `Moment`.
- `effect-browserbase`: the Browserbase REST client, and sessions as a `Browser`.
- `Agent.run` batches tool calls with halt-on-failure, one outline and screenshot per turn,
  configurable observations and caller toolkits.
- Viewport zoom crops and pixel-click receipts with resolved element metadata, including on
  displays whose device pixel ratio differs from one.
- An input policy over resolved targets and navigation, with typed denials, independently bounded
  holds and validation before held actions resume.
- Bounded, pipelined typing and shortcut chords, plus one host monotonic clock for events, frame
  arrivals, observations and moments.
- A timed input track with planned glides, submission receipts, button/key phases, wheel and cursor
  events; browser-wide pointer ownership and bounded event replay with explicit expiration.
- Humanized scrolling to off-screen targets, bounded fallback and approval revalidation; typing
  near 75 WPM with overlapping holds, slower word starts and opt-in corrected prose slips.
  Sampled presentation pauses retain the functional navigation wait.
- `bench` (private): twelve tasks over canvas games, live charts, dense quote tables, orders,
  navigation and forms, graded against seeded page truth and captured evidence. Trials run with
  separate browsers and bounded concurrency, task-specific reasoning defaults, elapsed-time metrics
  and a shared model admission budget. Paid runs remain opt-in.

`effect-agent-browser` and the Effect Agent dependency are gone: the agent loop is `effect/ai`'s
`Chat` with the browser toolkit. The tests run against real local Chromium, a fake Browserbase API
and scripted models. `bun run ready` runs all formatting, lint, type, test and build checks without
paid calls.

## Not rebuilt yet

0.2 did much that 0.3 does not do yet. A capability inventory of the 0.2 code, the plans, the open
PRs and the in-progress work marks each capability as rebuilt, left for later, or the consumer's to
build. Until the owner has agreed it, no 0.2 PR is closed and no branch is deleted.

The larger pieces left for later:

- recording to video files, and capture-rate measurement;
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
