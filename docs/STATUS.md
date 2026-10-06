# Status

## 0.3, unreleased

0.3 is a rewrite of the 0.2 set as two packages on stable Effect 4.0.0 and `effect/ai`:

- `effect-browser`: the `Browser` service with Chromium and CDP providers; `Page`, `Snapshot`,
  `Frame`, `BrowserEvent` and `BrowserError`; `Tools`, `Agent` and `Moment`.
- `effect-browserbase`: the Browserbase REST client, and sessions as a `Browser`.
- `bench` (private): seven tasks over canvas games, live charts and forms, graded against the
  pages' own truth. Paid runs are opt-in and capped.

`effect-agent-browser` and the Effect Agent dependency are gone: the agent loop is `effect/ai`'s
`Chat` with the browser toolkit. The source is about 4,100 lines in 20 files, down from about
43,500 in 139. The tests were rewritten from scratch: 34 tests in about 1,200 lines replace about
62,000 lines in 203 files. They run against a real local Chromium, a fake Browserbase API and
scripted models, and `bun run ready` runs them all.

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
