# Status / restart note

Last updated: 2026-09-19.

## Accepted unpaid milestone

The complete authorized unpaid Browserbase milestone is accepted on source
`2965b97d299ebeb6056d36812b31bd844d4dae1f`, against canonical upstream
`ea53ea6671a94eb44b8019e942cc2c9468786723`.

[PR #3](https://github.com/mannyc2/effect-agent-browserbase/pull/3) is the merge
record. This status update and the root README/AGENTS corrections are a
`[skip ci]` documentation-only follow-up to the exact tested candidate. No
production source, tests, examples, workflow, lockfile or integration patch is
changed by that follow-up. The tested SHA remains explicit rather than treating
an untested documentation commit as a fresh CI result.

This repository's milestone is not package publication, upstream acceptance,
Browserbase-hosted validation or deployment. None of those actions was performed.

## Runtime and source pins

| Input | Exact value |
| --- | --- |
| Node | 24.14.1 |
| Bun | 1.4.2 |
| effect-agent / @effect-agent/testing | 0.1.0-beta.102 |
| Effect | 4.0.0-rc.115 |
| Playwright | playwright-core 1.63.0 |
| TypeScript / Vite+ | 7.0.2 / 0.3.2 |
| Owned package | 48 files: 21 production TypeScript modules, 17 test/fixture TypeScript files, 4 examples, and package/configuration/license/docs inputs |

Both Actions workflows are read-only and check out the exact candidate. The
bootstrap applies the preserved historical patch once, replaces only the owned
package with current source, and applies `upstream.patch` for the catalog,
lockfile, guide, changeset and workspace integration. Do not reproduce the
current implementation from the historical patch alone.

## Exact acceptance results

[Implementation run 35430680289](https://github.com/mannyc2/effect-agent-browserbase/actions/runs/35430680289)
and [baseline run 35430680286](https://github.com/mannyc2/effect-agent-browserbase/actions/runs/35430680286)
both succeeded. All 13 implementation command exit records are zero.

| Boundary | Result |
| --- | --- |
| Preserved checkpoint | CRC and all 43 manifest entries verified |
| Independent Effect boundary harness | 66/66 on Node 24.14.1 and 66/66 on Bun 1.4.2 |
| Public-package imports | Passed on both pinned runtimes |
| Package typecheck, build | Passed with the actual upstream workspace |
| Unit | 70/70 in 6 test files |
| Workspace native | 11/11 in 3 files: real CDP, three AgentRuntime integrations and decoded capture video |
| Emitted external consumer | NodeNext declarations, all eight public import subpaths, and the unchanged 11/11 native/AgentRuntime tests passed without workspace aliases |
| Direct emitted native consumer | Passed actual navigation, exact-node mutation, capture, decoding and cleanup on Node 24.14.1 and Bun 1.4.2 |
| Full `vp run ready` | 4,046 passed in 315 files; 3 unchanged upstream opt-in skips |
| Package exports | 12 public packages / 198 entries passed |
| Package purity | 181 production entrypoints; no test-only dependency path |
| Release dry-run | Passed; nothing published or tagged |
| Review patch | Whitespace check and fresh canonical-upstream application passed |

The three upstream skips are the existing Cloudflare local-browser opt-ins in
`interactive-browser-native.test.ts` (one) and `protected-browser-native.test.ts`
(two); they require `BROWSER_TEST_EXECUTABLE`. No Browserbase test was skipped.
The full static lint log retains warnings; the gate passed with zero lint errors.

The full gate preserves every upstream suite and assertion. Its workspace test
task concurrency is one: the former nested limit of four overrode an outer
`ready` limit and an actual run exited 137 in the Node platform suite. The new
package is included in the existing inventory/release-train/dependency-direction
checks, not exempted from them.

## Verified delivery artifact

[Actions artifact 10580468755](https://github.com/mannyc2/effect-agent-browserbase/actions/runs/35430680289/artifacts/10580468755)
contains the candidate archive, complete review patch, emitted npm tarball,
lockfile, exact command/exit logs, four local capture videos, decoded-frame
verification and `SHA256SUMS`.

| File | SHA-256 |
| --- | --- |
| Original Actions ZIP | `13178ddb7fecc5a9a1d22ff979480818826057edac02ec06477c6d8deca5a1b6` |
| candidate.tar.gz | `2686994f0c48ab2e1eea964564127138dbf14889edfd963e9474cdedfc97f3d0` |
| review.patch | `41c088c58fedb759d8299593868d57294f31a510acb7b8215fdaa625bbd449bb` |
| Emitted npm tarball | `461808be1b6eee123badbee2bc273ecd01a0fe5af4049efc5f0c2f3fcf5929bd` |
| bun.lock | `5cabdd93dad1c8dc7e223812f7fa322ef79ce42daa24dae30f216f6e3b6a0a3f` |

The downloaded ZIP matched GitHub's digest and passed CRC. Every inner checksum
was verified. Its 98-file candidate archive reproduced GitHub's exact tree
`bf68f97213f076f1b5880de1c5cfe0e1656844dd`. Applying the complete review.patch to clean pinned upstream
reproduced all 48 owned package files and the lockfile byte-for-byte, including
the new changeset. Generated downloads are excluded from source artifacts.

All four retained MP4s were independently decoded after download; every pixel
hash matched the recorded frame verification. Native tests require changing
pixels, strictly increasing presentation times, source-timing agreement and no
audio stream. This is real loopback Chromium/CDP evidence, not hosted Browserbase
or synthetic-frame evidence.

## Implemented surface and remaining hosted-only checks

The package includes scoped interactive control; tabs, frames, viewport and
full-page screenshots; exact observed-node actions; handoff/resume and explicit
keep-alive reconnect; persistent-writer lease requirements; ordinary downloads;
independent provider recording and replay access; bounded same-page live capture;
Effect Tool/AgentRuntime composition; and public examples.

The remaining unexecuted provider checks are actual Browserbase allocation and
remote cleanup identity; human Live View takeover/release and authorization;
persistent-context persistence/lease behavior; keep-alive reconnection on the
provider; real file/recording/replay downloads and signed-origin/expiry behavior;
and coexistence of Live View, provider recording and live capture. Provider MP4
contents must still be decoded during separately authorized hosted validation.

`ExactHosts` and `PublicWeb` remain explicitly unsupported before allocation:
provider settings/interception do not establish the contracts' required traffic
containment. Only trusted-host `Unrestricted` is supported. Capture is video-only;
no maintained website-audio source is claimed or replaced with silent samples.

`tools/hosted-acceptance.sh <patched-upstream-worktree>` is executable but refuses
allocation unless `EFFECT_AGENT_BROWSERBASE_LIVE=1`, `BROWSERBASE_API_KEY`,
`BROWSERBASE_PROJECT_ID` and exact approved `BROWSERBASE_ARTIFACT_ORIGINS` are
supplied. The prepared command budgets one session, at most 180 seconds of browser
lifetime, ten actions, three seconds of live capture, at most 512 MiB of provider
recording download, and zero model calls. It logs allocation/cleanup identities
before independent recording retrieval. Six disabled/missing/unsafe-origin
preflight cases passed on Node/Bun with zero fetch calls; those are guard checks,
not hosted acceptance.

No unpaid implementation blocker remains. Do not restart a broad refactor or
research cycle; hosted execution, publication and deployment require separate
explicit authorization.

## Preserved history

Checkpoint 04 remains unchanged at
`checkpoints/browserbase-continuation-04.zip`: 133,654 bytes,
SHA-256 `60c9fe450109e100a6483756690462894c9f7e936fb3f0c60b2b0296faf0efed`.
The old 66-case/checkpoint-era results and all historical commits remain intact.
Checkpoint 03's ZIP was never held here and is not a prerequisite. The first fully
green expanded candidate was `1e4545ce324508d0e933db33ed56cf9746013999`, run
35429644790; the final source above was tested again after its preflight fixes.
