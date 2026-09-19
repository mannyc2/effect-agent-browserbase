# effect-agent-browserbase

Working repository for `@effect-agent/platform-browserbase` — an execution-scoped
Browserbase browser-control and browser-artifact package intended for the
[`danieljvdm/effect-agent`](https://github.com/danieljvdm/effect-agent) monorepo.

**This repository is the source of truth.** It replaces the ZIP-and-upload handoff
chain that preceded it. No remote-desktop plugin, no file transfer, and no
"prepared" dependency archive is needed to continue the work — clone this repo and
run `tools/bootstrap.sh`.

## Start here

| If you are | Read |
| --- | --- |
| An agent continuing the implementation | [`AGENTS.md`](AGENTS.md) |
| Looking for current state and next action | [`docs/STATUS.md`](docs/STATUS.md) |
| Looking for the full implementation brief | [`docs/handoff.md`](docs/handoff.md) |

```sh
git clone https://github.com/mannyc2/effect-agent-browserbase
cd effect-agent-browserbase
./tools/bootstrap.sh        # clones pinned upstream, applies patch, installs deps
```

## Layout

```
packages/platform-browserbase/  Current implementation, tests and public examples
docs/handoff.md                 Full implementation brief (authoritative scope)
docs/STATUS.md                  Restart note: objective, results, blockers, next action
checkpoints/                    Preserved checkpoint-04 archive, patches, historical runs
results/                        Execution evidence, one directory per session
tools/bootstrap.sh              Reproduce the real build environment from canonical sources
tools/verify-checkpoint.py      Verify the preserved archive (CRC + 43 manifest entries)
tools/fetch-inputs.py           Standalone canonical-input fetcher (upstream, npm, runtimes)
```

## Implementation and acceptance

The current source has evolved beyond checkpoint 04; the original archive and
historical patches remain unchanged under `checkpoints/`. `tools/bootstrap.sh`
applies the historical patch once, synchronizes this repository's current owned
package, then applies `upstream.patch` for the catalog, lockfile, guide, changeset
and workspace integration. Do not use the historical patch alone as the current
implementation.

Acceptance pins Node **24.14.1**, Bun **1.4.2**, Effect **4.0.0-rc.115**,
effect-agent/testing **0.1.0-beta.102**, and Playwright **1.63.0** against upstream
`ea53ea6671a94eb44b8019e942cc2c9468786723`. Both Actions workflows are read-only and
check out the exact candidate SHA. The implementation workflow retains individual
command exit statuses, unit/native/AgentRuntime tests, emitted external-consumer
checks, decoded local capture videos, full `vp run ready`, release dry-run,
`review.patch`, the candidate archive, and checksums.

See [`docs/STATUS.md`](docs/STATUS.md) for the exact accepted source SHA, run links,
results and hosted-only limitations. A local native browser pass does not establish
Browserbase allocation, Live View authorization, persistent storage or provider
recording behavior. This package is not published and this repository's merge is
not a claim of upstream acceptance.

## Authorization limits

Hosted Browserbase sessions, paid model inference, package publication, deployment,
service provisioning, and changes to surrounding or unrelated projects are **not**
authorized. See the closing sections of [`docs/handoff.md`](docs/handoff.md).
