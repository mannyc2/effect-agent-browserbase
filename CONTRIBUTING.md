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

Release tooling is separately pinned in `tools/release/package.json` and `bun.lock`: ts-release core/npm 0.4.1 and Effect 4.0.0-rc.115. From that directory run `bun install --frozen-lockfile --ignore-scripts`, `bun run check`, `bun test`, and `bun run build`. The package separates `src/`, `test/`, and build-only `scripts/`. Its TypeScript application uses Effect schemas for configuration, named operations, and scoped Git resources; the shipped ts-release CLI owns execution, interruption, reports, and exit codes. Native Bundle and Plan data are the retained authority, with no parallel metadata document. The tests use synthetic registry responses and local Git repositories; they need no credentials and do not publish. `Native release recovery` also extracts the packaged host and checks its imports and native CLI with Node 22.22.2, independently of the library's Node 24.14.1 pin. Keep release dependencies out of both public packages and the upstream compatibility patch.

Bootstrap and every acceptance profile assert the pinned Node and Bun. On a host that ships different versions, install them first:

```sh
toolchain_env="$(bash tools/pinned-toolchain.sh)" && eval "$toolchain_env"
```

The assignment preserves installer failure; do not wrap the command substitution directly in `eval`, which would hide a failed download. Publisher access is required for a first install.

It verifies each published release against a pinned digest, installs into the ignored `.work/toolchain`, and reuses an existing install that already reports the pinned version.

```sh
# Fast repository-tooling checks; no third-party installs or network required.
npm_config_offline=true node --test tools/test/*.test.mjs

# Run once into a fresh destination. Both dependency installs are frozen.
bash tools/bootstrap.sh

cd .work/upstream/tree
./node_modules/.bin/vp run -F effect-agent-browserbase check
cd packages/agent-browserbase
# Canonical formatting, from the Oxfmt that Vite+ carries. `check` enforces it;
# hand-formatting to satisfy that gate does not reproduce this output.
../../node_modules/.bin/vp fmt
../../node_modules/.bin/vp test --run
../../node_modules/.bin/vp run install:test-browser
../../node_modules/.bin/vp run test:native
../../node_modules/.bin/vp pack
```

`node tools/verify-launch-contract.mjs` re-derives the committed session-create inventory from both authorities `Contract.ts` cites: the pinned SDK revision, checked against the digest that records the bytes it was read from, and the published OpenAPI specification, which is unpinned so that a field Browserbase adds fails the check instead of passing as a silent gap. It also reports whether a newer SDK release exists; `--require-current` turns a stale pin into a failure. It needs network access and is therefore run deliberately rather than from acceptance, which stays offline. The offline tooling tests cover its parsing rules against synthetic sources.

Native video tests need caller-installed FFmpeg/ffprobe. They use real local Chromium and loopback fixtures, not Browserbase sessions. They require no API keys or paid inference. Production imports remain lazy and browser-artifact-only consumers do not need Playwright.

Make edits in this repository's `packages/browserbase` and `packages/agent-browserbase`, not just the disposable upstream worktree. Stage new files before bootstrapping: only Git-tracked paths are copied, with their current working-copy contents. Use a new bootstrap destination after edits; an existing destination is refused rather than silently mixed with new source.

## Acceptance profiles

Commit the candidate before running acceptance in Ubuntu 24.04:

```sh
# Routine package feedback; all owned native tests run against the actual tarballs.
bash tools/run-acceptance.sh library

# Full pinned-upstream integration, also the default with no argument.
bash tools/run-acceptance.sh full
```

Every profile rejects dirty source and reused output directories, asserts the same Node/Bun pins, records the source SHA, and retains raw command exits and monotonic stage durations. The profile is written to `acceptance-profile.txt` and the Actions summary. A focused pass is not a full-integration pass.

| Profile | Required checks | Selection |
| --- | --- | --- |
| `docs` | Tooling tests, source-bound diff revalidation, whitespace and clean source | Only regular root documentation and `docs/**/*.md`; no package/runtime validation is claimed |
| `library` | Tooling, Node/Bun boundary harness, frozen bootstrap, early canonical format/lint and both package types, both unit suites/builds, exports/purity, both candidate tarballs, all three strict consumers and every generic/Agent native test from those tarballs, release identity and the two-package dry-run | Owned package, tooling, workflow and media changes |
| `full` | All library checks plus separate source-native suites, the pinned upstream workspace's whole `check` and `build`, its `test` for the workspaces the patch reaches (both owned packages and `@effect-agent/testing`, whose toolchain audit reads every manifest), and the upstream release dry-run | Integration/pin/bootstrap changes, unknown paths, unavailable/empty diff, scheduled integration, default manual and reusable release calls |

The library profile runs the **same complete native test files** in clean installed-package consumers rather than repeating them against source, packed output and the unrelated upstream task graph on every PR. All maintained examples are still compiled, all public exports are checked, Node and Bun both execute the resource, generic and actual AgentRuntime workflows, and every declaration command must return raw zero with `skipLibCheck:false`. No test is retried or skipped to obtain a pass. Native worker concurrency and assertions are unchanged.

Format/lint/types are checked before browser installation. Focused profiles stop after prerequisite failures while retaining partial evidence; full acceptance continues independent checks as before. Browser installation explicitly disables task-result caching because an old success cannot restore an external browser installation. FFmpeg/ffprobe are installed only when absent and their versions are always recorded. These scripts install Linux native dependencies, not a portable macOS/Windows toolchain.

`tools/ci-plan.mjs` classifies the complete local Git diff, not a truncated API filename list. PRs compare against the merge base; pushes and merge groups use their event's base. Renames include both old and new paths. Mode changes, unknown paths and unavailable bases fail toward more validation. The docs profile additionally recomputes its recorded diff and exact source SHA before accepting it.

## CI feedback, evidence and release

`Library CI` reports the same **Unpaid acceptance** check for every PR, including stacked PRs and documentation-only changes. It also runs on `main`, merge groups, manual requests and daily full integration. There is no workflow-level path filter that leaves a required check pending. Superseded PR/main runs are cancelled; release calls and deliberate full runs are not cancelled by a different event's feedback run. No repository settings are changed by the workflow.

Routine library feedback targets a few minutes. Use `timings.tsv` and the job summary to measure actual stage cost; distinguish queue delay, runner setup, verification and artifact upload. Long full integration is explicitly separate, not labelled a fast PR test. Manual callers can choose `library` or `full`; the CLI and reusable release validation default to `full`. Only successful **full** runs emit the reusable `artifact_id` and `release_set_sha256`, after checking the exact required stage inventory and raw exits. Focused artifacts cannot authorize the publisher.

Successful evidence retains the two immutable tarballs, source/review archives, logs, video, receipts, checksums, consumer configs and exact lockfiles. Tested consumer fixtures are archived with their modes; installed `node_modules` are left outside the upload instead of repeatedly transferring hundreds of megabytes of reproducible inputs. Failed or interrupted runs retain their complete installed consumer workspaces, including broken dependency declarations. No existing failure artifacts are pruned. Artifact compression is low, and all files named by the checksum inventory, including hidden diagnostic files, are retained.

Results, downloaded videos, build directories and archives remain ignored and belong in Actions artifacts, not commits. The exception is declared-budget demo media under `docs/media/`, checked by the tooling suite.

This design avoids parallel browser workers and never caches browser binaries: Playwright [does not generally recommend it](https://playwright.dev/docs/ci#caching-browsers), and an old success cannot restore an external installation. Removing unrelated work and duplicate executions came first.

The full profile does transfer upstream's Vite Task cache, for the three upstream stages and the release dry-run only, because Vite+ [asks for a measured restore/save cost and stable fingerprints](https://viteplus.dev/guide/github-actions-cache) and this one has both. It is seeded only after every stage with effects outside the workspace (browser and media installation, both native suites and the packed consumers), so those always execute for real on the candidate, and Vite Task replays a result only when that task's own inputs match. Upstream's complete `ready` measured about 16 seconds warm against about 15 minutes cold. Every full run records its seed, export and hit/miss counts in `task-cache.txt`, so the gain stays measured instead of assumed. The scheduled run discards what it restored and runs cold, and it alone runs every upstream suite (`BROWSERBASE_UPSTREAM_TESTS=all`, recorded in `upstream-tests.txt`): the daily integration result is always a real execution of the whole workspace on that day's runner image, and it refreshes the cache. Candidates do not pay for suites of upstream code the patch cannot reach, whose timing assertions have failed on a shared runner for reasons no change here can cause. Focused profiles use no cache.

Repository settings are separate from files in this PR. Require PRs and the acceptance check on `main`, prevent force pushes/deletion, and protect `v*` tags from unauthorized creation or updates. Set review requirements appropriate to your maintainer team; CODEOWNERS alone does not enforce reviews. Dependency-update PRs are review-only and not auto-merged.

Publishing and hosted checks require separate authorization. Hosted runs have their own manual, default-off workflow and protected environment; see [hosted runs](docs/HOSTED.md), [releasing](docs/RELEASING.md) and [security](SECURITY.md). Do not add a hosted credential to `Library CI` or to any trigger a pull request can reach.
