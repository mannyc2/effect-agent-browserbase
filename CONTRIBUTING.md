# Contributing

Open a focused PR against `main`. Explain behavior changes and test evidence in the PR; preserve the established ownership, error, security and dependency-direction contracts. Do not bundle runtime refactors into packaging or CI maintenance.

## Toolchain

| Input | Pin |
| --- | --- |
| Node | 24.14.1 (`.node-version`) |
| Bun | 1.4.2 |
| Upstream | `danieljvdm/effect-agent@ea53ea6671a94eb44b8019e942cc2c9468786723` |
| Effect family | 4.0.0-rc.115 |
| effect-agent / testing | 0.1.0-beta.102 |
| Playwright | playwright-core 1.63.0 |
| TypeScript / Vite+ | 7.0.2 / 0.3.2 |

These are the verified acceptance targets, not a promise that every version allowed by the inherited engine/peer ranges has been tested. Dependency changes belong in a coordinated catalog/lockfile update, not an unreviewed install-time re-resolution.

## Working locally

The root `package.json` is private and prevents accidental root publication. It is not a standalone replacement for upstream's development workspace.

Bootstrap and full acceptance assert the pinned Node and Bun. On a host that ships different versions, install them first:

```sh
toolchain_env="$(bash tools/pinned-toolchain.sh)" && eval "$toolchain_env"
```

The assignment preserves installer failure; do not wrap the command substitution directly in `eval`, which would hide a failed download. Publisher access is required for a first install.

It verifies each published release against a pinned digest, installs into the ignored `.work/toolchain`, and reuses an existing install that already reports the pinned version.

For the ordinary edit-and-check loop, one command does all of the below:

```sh
bash tools/verify.sh           # add --fresh to rebuild the workspace from clean upstream
```

It installs the pinned runtimes if the host lacks them, bootstraps or reuses `.work/upstream`, copies your tracked package files in, then runs formatting, typecheck, unit and native suites and the pack. It needs no root: it fetches the browser without the system-dependency step and only warns if FFmpeg is absent. Formatting the workspace produces canonical output, so any change it makes is copied back for you to review and stage.

It is a fast loop, not acceptance. It stops at the first failure and mints no evidence bundle; `tools/run-acceptance.sh` remains the program whose record CI and the release workflow consume.

The individual commands, if you want them separately:

```sh
# Fast repository-tooling checks; no third-party installs or network required.
npm_config_offline=true node --test tools/test/*.test.mjs

# Run once into a fresh destination. Both dependency installs are frozen.
bash tools/bootstrap.sh

cd .work/upstream/tree
./node_modules/.bin/vp run -F @effect-agent/platform-browserbase check
cd packages/platform-browserbase
# Canonical formatting, from the Oxfmt that Vite+ carries. `check` enforces it;
# hand-formatting to satisfy that gate does not reproduce this output.
../../node_modules/.bin/vp fmt
../../node_modules/.bin/vp test --run
../../node_modules/.bin/vp run install:test-browser
../../node_modules/.bin/vp run test:native
../../node_modules/.bin/vp pack
```

Native video tests need caller-installed FFmpeg/ffprobe. They use real local Chromium and loopback fixtures, not Browserbase sessions. They require no API keys or paid inference. Production imports remain lazy and browser-artifact-only consumers do not need Playwright.

Make edits in this repository's `packages/platform-browserbase`, not just the disposable upstream worktree. Stage new files before bootstrapping: only Git-tracked paths are copied, with their current working-copy contents. Use a new bootstrap destination after edits; an existing destination is refused rather than silently mixed with new source.

## Full acceptance

Commit the candidate, then run the following in Ubuntu 24.04 (or use PR CI):

```sh
bash tools/run-acceptance.sh
```

It creates a fresh temporary workspace and prints the results directory. On the CI runner it installs local Chromium dependencies and FFmpeg with `sudo`; the full script is not advertised as a portable macOS/Windows setup command.

Every command retains its arguments, log and exit status. The gate includes the independent boundary runner on Node and Bun, package tests, native AgentRuntime/CDP/video suites, an emitted external consumer, declaration checks, real emitted-code programs on both runtimes, exports, purity, full `vp run ready` and release dry-runs. Later independent checks still execute after a failure, but any failure keeps the gate red. Old counts are never reused as current results.

Results, downloaded videos, build directories and package archives are ignored; retain them in Actions artifacts, not commits. The single exception is `docs/media/`, which holds the published demo recording under a declared size budget enforced by `tools/test/hosted.test.mjs`; see [docs/media/README.md](docs/media/README.md). `checkpoints/` stays immutable. The historical checkpoint verifier remains a separate integrity check, never a bootstrap dependency.

## CI review and repository settings

The new workflow is not restricted to a particular agent branch. No path filter hides a required check on documentation-only changes, and fork PRs receive no credentials or write privileges. The stable required check is **Unpaid acceptance**. Prefer a merge queue's combined-tree check when coordinating simultaneous changes.

Repository settings are separate from files in this PR. Require PRs and the acceptance check on `main`, prevent force pushes/deletion, and protect `v*` tags from unauthorized creation or updates. Set review requirements appropriate to your maintainer team; CODEOWNERS alone does not enforce reviews. Dependency-update PRs are review-only and not auto-merged.

Publishing and hosted checks require separate authorization. Hosted runs have their own manual, default-off workflow and protected environment; see [hosted runs](docs/HOSTED.md), [releasing](docs/RELEASING.md) and [security](SECURITY.md). Do not add a hosted credential to `Library CI` or to any trigger a pull request can reach.
