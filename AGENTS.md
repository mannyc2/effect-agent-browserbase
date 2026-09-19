# Instructions for agents working in this repository

You are working on `@effect-agent/platform-browserbase`. Read this file, then
[`docs/STATUS.md`](docs/STATUS.md), then [`docs/handoff.md`](docs/handoff.md).

## This repository replaces the transfer chain

Earlier stages of this work moved state between environments as ZIP archives and
asked for a remote-desktop plugin to be connected. **That is over.** Git is the
transport and this repository is the source of truth.

- **Do not** ask the user to upload, attach or download an archive.
- **Do not** ask for Remote Desktop Commander or any other filesystem plugin.
- **Do not** wait on `browserbase-effect-agent-implementation-inputs.zip`. It does
  not exist, it never did, and nothing needs it. Every input it was supposed to
  carry is fetchable from public sources — verified 2026-09-18, see
  [`results/2026-09-18-github-session/`](results/2026-09-18-github-session/).
- Commit and push your work. An uncommitted result is a lost result.

If you cannot reach `github.com` or `registry.npmjs.org`, that is an environment
problem to report precisely — failing host, exact command, visible error — not a
reason to ask for a file transfer.

## Getting a working environment

```sh
./tools/bootstrap.sh          # clone pinned upstream, apply patch, install deps
./tools/run-boundary-suite.sh # 66-case harness, no monorepo or browser needed
```

`bootstrap.sh` produces a worktree of upstream `ea53ea66…` with this package
applied and dependencies installed. That worktree is where you run repository
commands; this repository holds the package source, evidence and history.

Pinned inputs, from the upstream catalog and `docs/TOOLCHAIN.md`:

| | |
| --- | --- |
| Upstream | `danieljvdm/effect-agent` @ `ea53ea6671a94eb44b8019e942cc2c9468786723` |
| Effect | `4.0.0-rc.115` |
| effect-agent / `@effect-agent/testing` | `0.1.0-beta.102` |
| Playwright | `playwright-core` `1.63.0` |
| TypeScript | `7.0.2` |
| Vite+ | `0.3.2` |
| Bun | `1.4.2` |
| Node acceptance pin | `24.14.1` (upstream engine range remains `^22.18.0 \|\| >=24.11.0`) |

Do not substitute versions. If a newer revision becomes materially necessary, say
so explicitly and re-check the affected APIs.

## Repository command policy

Upstream `AGENTS.md` is binding when you work in that worktree:

- Vite+ (`vp`) is the command authority. `vp check`, `vp test`, `vp fmt`,
  `vp lint`, `vp run ready`.
- **Do not** use `bun run`, `npm run`, `pnpm run` or `yarn run`.
- **Do not** invoke `tsc`, `vitest`, `oxlint` or `oxfmt` directly, except as a
  clearly labelled diagnostic.
- Read `node_modules/effect/AGENTS.md` completely before writing Effect code.

## Evidence discipline

This project has been burned repeatedly by claimed results. The rules are strict
and they are the point:

- **Executed or not claimed.** Reading a saved log is not running a test. Inspecting
  a checkpoint is not compiling it. If you did not observe the exit status, say so.
- **Keep run records separate.** New results go in a new `results/<date>-<label>/`
  directory. Never edit or overwrite `checkpoints/runs/` — those are historical.
- **Name the runtime.** Results on Node 22.22.2 are not results on Node 24.11.1;
  results on Bun 1.3.11 are not results on the pinned Bun 1.4.2.
- **Distinguish the boundaries.** Scripted-provider tests, synthetic frames, real
  local CDP behavior, packed-consumer checks and hosted Browserbase evidence are
  five different things. Synthetic-frame encoding is not remote-browser capture.
  A successful HTTP response is not a completed download. An encoder exit code is
  not a verified video.
- **Preserve unknowns.** An unverified provider guarantee stays unverified.
  Do not weaken a contract, skip a test, add an ambient declaration, copy a
  contract extract or stub the framework to make a check pass.
- **A missing tool response is not a failure.** Do not blindly replay a mutating
  command because you did not see its output.

## Source handling

`packages/platform-browserbase/` is the current implementation, not a byte-for-byte
copy of checkpoint 04. The checkpoint archive and historical patches stay immutable.
`tools/bootstrap.sh` applies the historical patch once, synchronizes the current
owned package and applies the reviewable `upstream.patch` integration delta.
The final Actions `review.patch` represents the complete candidate against pinned
upstream; it is different from `checkpoints/patches/review.patch`.
What must not happen:

- Do not rewrite this source from conversation text, from the research prototype,
  or from memory. Edit the files that are here.
- Do not apply both `review.patch` and `from-checkpoint03.patch`. Use exactly one:
  `review.patch` onto clean upstream, or `from-checkpoint03.patch` onto an existing
  checkpoint-03 overlay.
- Do not modify anything under `checkpoints/`.
- Update [`docs/STATUS.md`](docs/STATUS.md) as state changes. It is the restart note;
  a future session may have nothing else.

## Scope and authorization

In scope: the package source, tests, workspace integration, public examples,
documentation, changeset, local browser work, and repository acceptance checks.

**Not authorized:**

- Hosted Browserbase sessions (anything that allocates a paid remote browser)
- Paid model inference of any kind
- Publishing the package, deploying anything, or provisioning a service
- Changes to surrounding applications or the unrelated Reactor/WebRTC projects
- Broadening host access or exposing credentials as a workaround

Prepare a bounded hosted-acceptance command with an explicit resource budget and
ask for approval when the unpaid work is finished. Do not stall independent work
waiting for that approval.
