# Effect Agent Browserbase

Execution-scoped Browserbase integration for [Effect Agent](https://github.com/danieljvdm/effect-agent), built on Effect v4 and Playwright-over-CDP for trusted Node and Bun hosts.

One scope owns the browser. Agent tools borrow that session across turns. Recording, replay and download access have independent lifetimes; live capture supplies bounded JPEG frames from the same page without owning an encoder or an audio source.

**Release status:** this repository has not published the package. The npm name remains `@effect-agent/platform-browserbase`; publication requires control of that package/scope. Local native and framework acceptance is distinct from hosted Browserbase validation, which has not been performed.

## API

| Import | Purpose |
| --- | --- |
| `@effect-agent/platform-browserbase/interactive-browser` | Browser ownership, pages, frames, handoff and explicit reconnect |
| `@effect-agent/platform-browserbase/tools` | Bounded navigation, observation and exact-node actions |
| `@effect-agent/platform-browserbase/recordings` | Provider MP4 assembly, status and bounded retrieval |
| `@effect-agent/platform-browserbase/replays` | Validated replay playlists and media access |
| `@effect-agent/platform-browserbase/downloads` | Website download identity and bounded streams |
| `@effect-agent/platform-browserbase/capture` | Same-page video frame stream with source timestamps |
| `@effect-agent/platform-browserbase/types` | Credential-free schemas and typed errors |

The root entry point is also public. Production distributions contain ESM JavaScript and `.d.mts` declarations, not test fixtures, recovery archives or development dependencies. Playwright is an optional peer and is loaded only when interactive control connects; install `playwright-core@1.63.0` when using that capability.

Read the [package guide](packages/platform-browserbase/README.md) for ownership, outcomes, bounds and examples. The [agent example](packages/platform-browserbase/examples/agent.ts) uses the real `AgentRuntime` and scripted model; the [hosted examples](packages/platform-browserbase/examples/hosted.ts) show application composition but require separately authorized hosted access.

### Important boundaries

Only trusted-host `Unrestricted` network policy is supported. `ExactHosts` and `PublicWeb` fail before allocation rather than claiming containment the provider cannot prove. A timed-out mutation after dispatch has an unknown outcome and is not automatically retried. Credentials and Live View bearer URLs must stay outside model inputs and durable records. Live capture is video-only.

## Development

```sh
git clone https://github.com/mannyc2/effect-agent-browserbase.git
cd effect-agent-browserbase
# Install Node 24.14.1 and Bun 1.4.2 first.
bash tools/bootstrap.sh
cd .work/upstream/tree
./node_modules/.bin/vp run -F @effect-agent/platform-browserbase check
```

This remains an integration package for the pinned upstream workspace, not a second copy of the framework. `bootstrap.sh` applies one current integration patch to clean upstream and copies only tracked package files. It does not execute or apply historical checkpoint code.

[Contributing](CONTRIBUTING.md) covers local commands and the complete Ubuntu acceptance run. [Releasing](docs/RELEASING.md) describes the manual, default-off npm trusted-publishing workflow. [Security](SECURITY.md) documents the host trust boundary.

## CI and maintenance

`Library CI` runs on every pull request (including forks), pushes to `main`, merge groups and manual requests. It has read-only permissions and no hosted/model credentials. The gate retains unit and native tests, real AgentRuntime/CDP behavior, decoded moving video, NodeNext external-consumer checks, exports/purity, full upstream `vp run ready`, release dry-runs, exact source archives and checksums.

The npm job is separate: it receives OIDC permission only after fresh acceptance and an explicit maintainer opt-in. It verifies and publishes the same immutable tarball the external consumer tested, without installing dependencies or executing package lifecycle scripts in the publishing job.

Historical acceptance is linked from [status](docs/STATUS.md). Checkpoints are immutable provenance under `checkpoints/`, not build inputs. Obsolete recovery scripts and transient run logs remain accessible in Git history, not on the active maintenance path.

MIT licensed. No hosted sessions, paid inference, publication, deployment or provisioning are part of ordinary CI.
