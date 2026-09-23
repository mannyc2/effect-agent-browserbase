# Repository guide

This repository owns three packages, `packages/browser` (`effect-browser`), `packages/browserbase` (`effect-browserbase`) and `packages/agent-browser` (`effect-agent-browser`), and ships them into a pinned upstream Effect Agent workspace. Upstream is a compatibility harness, not something to change. Read `README.md`, `CONTRIBUTING.md`, the package guide and the neighbouring tests before editing; `docs/STATUS.md` is the current state.

## Contracts

- Preserve Effect `E`/`R`, scoped resource ownership, bounded work and typed outcomes.
- Keep the actual Effect, AgentRuntime and Playwright integration. Do not substitute contracts or native engines to satisfy tests.
- Keep public exports deliberate. Provider credentials and native SDK values are not durable or model-facing values.
- Never replay an unresolved mutation, and never weaken the unsupported network policies to make them appear supported.
- Use the coordinated pins in `.node-version`, `package.json`, `upstream.patch` and `CONTRIBUTING.md`. A version upgrade needs source review and fresh acceptance.

## Package boundaries

- `effect-browser` owns the shared runtime, browser data, bindings, capture and page control. Its root must not import the Chromium process implementation; launch and borrowed loopback attachment live at `/chromium`.
- Browserbase supplies provider lifetimes through the supported `/browser-runtime` constructor. Provider resources, receipt authorization and release/status facts remain in `effect-browserbase`.
- `effect-agent-browser` adapts either exact session through the same tools. It calls the owner's checked cleanup and keeps typed errors and references on the original browser; it never parses provider receipts or opens another connection.
- Every test stays in its owning package's `test/`, including a regression that needs both sides: it reaches the other package only through public exports and the public testing entries (`effect-browser/testing`, `effect-browserbase/testing`). There is no repository-level test tree. Tests are never exports or published files.

## Working

- A session often starts on a host whose Node and Bun differ from the pins, where bootstrap and acceptance refuse to run. Install the pinned runtimes first: `toolchain_env="$(bash tools/pinned-toolchain.sh)" && eval "$toolchain_env"`. Never relax a version assertion or accept the host's versions.
- `bash tools/bootstrap.sh <new directory>` builds the pinned workspace from clean upstream, `upstream.patch` and the tracked package files; stage new files first, because only tracked paths are copied. Work in that workspace with Vite+ commands, follow its `AGENTS.md` and `docs/TOOLCHAIN.md`, and read `node_modules/effect/AGENTS.md` completely before writing Effect code. Edit this repository's `packages/`, never only the disposable tree.
- Formatting comes from the workspace's own Oxfmt: `vp fmt` for whitespace, and `oxlint -c lint/.oxlintrc.json --fix <file>` for the stylistic rules that `fmt` leaves alone. Scope `--fix` to the files you touched. Do not hand-write formatting to satisfy a gate.
- Owned code follows the strict policy in `lint/.oxlintrc.json` and the owned tsconfigs; `CONTRIBUTING.md` describes it. Fix a lint finding or Effect diagnostic rather than suppress it. A genuine exception states its reason, and acceptance rejects an Oxlint directive that no longer suppresses anything.
- The maintenance tools are dependency-free Node scripts: `npm_config_offline=true node --test tools/test/*.test.mjs`. `tools/release` is an isolated ts-release application: `bun install --frozen-lockfile --ignore-scripts`, then `bun test`. Both are host-only tools, not public runtime APIs.
- Commit the candidate, then `bash tools/run-acceptance.sh library` (or `full`); acceptance rejects dirty source and reused output directories. Read the actual exit records and the current Actions results; a saved result is historical evidence, not a new execution. The documentation, library and full profiles are distinct evidence, never interchangeable passes. Keep the classifier, the stage inventory, failure artifacts and `timings.tsv`, and never cache a browser installation as though a task result restored it.
- The paid hosted checks live in `packages/browserbase/hosted/` and run only through `tools/hosted-run.sh` behind an explicit opt-in. Ordinary CI cannot reach them, and no maintenance request authorizes a hosted session, paid inference, deployment, provisioning or publication.
- Generated output stays ignored and in Actions artifacts; `docs/media/` is the one budgeted exception. Rationale and results belong in PRs, not in committed planning documents or transient logs. Historical material lives in Git history, and `docs/STATUS.md` records where to find it.
- Ordinary CI is the fixed acceptance program, not a scratchpad: no disposable workflow to run an experiment or to back up, restore or delete a branch. Use `git` for ordinary changes rather than whole-file replacements. When a host cannot reach GitHub or the publishers, report that prerequisite failure; do not generalize another host's connectivity or silently change the workflow.
- Keep the branch list short. Delete a branch once its work is merged or abandoned, and do not leave a pull request in draft over a formatting-only failure that one `vp fmt` resolves.

## Safety and release

Ordinary CI is read-only: no `pull_request_target`, no auto-writing formatters, no hosted browser or model credentials, no publication.

`docs/RELEASING.md` describes a separately enabled, tag-scoped npm OIDC workflow. Preparing or testing it does not authorize running its publishing job, registering a package, changing account permissions or creating release tags. Preserve commit history; use normal commits, never force-push or rewrite accepted history.

Retain `ts-release-prepared/*` and `ts-release-journal/*` branches for release recovery. Prepared branches are immutable; journal branches append history. Never delete or replace them to retry an uncertain publication. Their guarded create/append operations are release storage, not permission to rewrite source branches.
