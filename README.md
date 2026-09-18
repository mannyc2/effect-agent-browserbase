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
packages/platform-browserbase/  Live source — checkpoint 04, byte-exact (33 files)
docs/handoff.md                 Full implementation brief (authoritative scope)
docs/STATUS.md                  Restart note: objective, results, blockers, next action
checkpoints/                    Preserved checkpoint-04 archive, patches, historical runs
results/                        Execution evidence, one directory per session
tools/bootstrap.sh              Reproduce the real build environment from canonical sources
tools/verify-checkpoint.py      Verify the preserved archive (CRC + 43 manifest entries)
tools/fetch-inputs.py           Standalone canonical-input fetcher (upstream, npm, runtimes)
```

## State in one paragraph

Checkpoint 04 is preserved byte-exact and verified. Its `review.patch` applies
cleanly to the pinned upstream revision `ea53ea66` and reproduces the package tree
exactly. The monorepo installs, and TypeScript 7.0.2 compiles the package against
the real framework with two unused-import errors and no contract errors. The
66-case boundary suite passes on both Node and Bun against real `effect@4.0.0-rc.115`.
Native browser control, provider recordings, live capture, public examples, and
hosted acceptance remain unimplemented or unverified. See [`docs/STATUS.md`](docs/STATUS.md)
for the exact evidence and the next concrete action.

## Authorization limits

Hosted Browserbase sessions, paid model inference, package publication, deployment,
service provisioning, and changes to surrounding or unrelated projects are **not**
authorized. See the closing sections of [`docs/handoff.md`](docs/handoff.md).
