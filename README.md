# Effect Agent Browserbase

Execution-scoped Browserbase integration built on Effect v4 and Playwright-over-CDP for trusted Node and Bun hosts, in two packages.

`effect-browserbase` owns Browserbase: account identity, session and context resources, one owned browser, live capture, page holds, recordings, replays and downloads. It does not depend on [Effect Agent](https://github.com/danieljvdm/effect-agent). `effect-agent-browserbase` is the adapter: it presents that browser to an `AgentRuntime` and supplies the fixed Tool set, and it has no Playwright peer.

One scope owns the browser. Agent tools borrow that session across turns. Recording, replay and download access have independent lifetimes; live capture supplies bounded JPEG frames from selected or explicitly pinned pages without owning an encoder or an audio source.

**Release status:** this repository has not published either package. Publication requires control of both npm names. Local native and framework acceptance is distinct from hosted Browserbase validation; see the status record for the exact scope of separately reported provider evidence.

## API

| Import | Purpose |
| --- | --- |
| `effect-browserbase/client` | One immutable account, transport and approved artifact origins |
| `effect-browserbase/sessions` | Passive inspection and explicit release |
| `effect-browserbase/contexts` | Context resources, with writer settlement in `context-coordination` |
| `effect-browserbase/browser` | Browser ownership, pages, frames, handoff and explicit reconnect |
| `effect-browserbase/capture` | Target-pinned video frame streams with source timestamps |
| `effect-browserbase/page-control` | Opt-in host-owned stage holds and receipt-based resume |
| `effect-browserbase/recordings` | Provider MP4 assembly, status and bounded retrieval |
| `effect-browserbase/replays` | Validated replay playlists and media access |
| `effect-browserbase/downloads` | Website download identity and bounded streams |
| `effect-browserbase/launch` and the data modules | Credential-free schemas and typed errors |
| `effect-agent-browserbase/adapter` | The Effect Agent `InteractiveBrowser` implementation |
| `effect-agent-browserbase/tools` | Bounded navigation, observation and exact-node actions |

Both root entry points are also public. Production distributions contain ESM JavaScript and `.d.mts` declarations, not test fixtures, recovery archives or development dependencies. Playwright is an optional peer of the generic package only, loaded when a browser connects; install `playwright-core@1.63.0` when using that capability.

Read the [Browserbase guide](packages/browserbase/README.md) for ownership, outcomes, bounds and examples, and the [adapter guide](packages/agent-browserbase/README.md) for the framework integration. The [agent example](packages/agent-browserbase/examples/agent.ts) uses the real `AgentRuntime` and scripted model; the [hosted examples](packages/browserbase/examples/workflows.ts) show application composition but require separately authorized hosted access.

### Demo

The demo recording published under [`docs/media/`](docs/media/README.md) is one real hosted session navigating and scrolling under Effect Agent control, encoded by the caller from the same live frame stream `packages/browserbase/examples/record-video.ts` demonstrates. The MP4 is caller-encoded capture output; the GIF is a derived, downsampled preview, not lossless frame or timing evidence.

![A hosted Browserbase session navigating and scrolling under Effect Agent control](docs/media/hosted-demo.gif)

[Higher-quality MP4](docs/media/hosted-demo.mp4)

For footage meant to be watched rather than audited, [`examples/realistic-footage`](packages/browserbase/examples/realistic-footage/README.md) films a storyboard with a drawn pointer, paced typing, eased scrolling and a constant-frame-rate encode, using only the session's ordinary bounded actions. This one was filmed against a local Chromium, not a hosted session:

![A drawn pointer types a destination, follows a route, scrolls its stops and holds a berth on a fictional sleeper-train site](docs/media/realistic-footage.gif)

[Higher-quality MP4](docs/media/realistic-footage.mp4)

Ordinary CI cannot allocate a session, so a recording only ever comes from a deliberate maintainer run. The exact source commit, session id, runtime and capture summary behind the committed file are recorded in [docs/media/README.md](docs/media/README.md) and [status](docs/STATUS.md). A recording shows that a session ran. It is not a substitute for the hosted acceptance checks listed in [status](docs/STATUS.md).

### Important boundaries

Only trusted-host `Unrestricted` network policy is supported. `ExactHosts` and `PublicWeb` fail before allocation rather than claiming containment the provider cannot prove. A timed-out mutation after dispatch has an unknown outcome and is not automatically retried. Credentials and Live View bearer URLs must stay outside model inputs and durable records. Live capture is video-only. `src/internal/` is private: there is no consumer CDP seam and no lower-level binding Layer, and host controls above core's provider-neutral handle are deliberately per-adapter rather than portable across adapters.

## Development

```sh
git clone https://github.com/mannyc2/effect-agent-browserbase.git
cd effect-agent-browserbase
# Install Node 24.14.1 and Bun 1.4.2 first.
bash tools/bootstrap.sh
cd .work/upstream/tree
./node_modules/.bin/vp run -F effect-browserbase check
./node_modules/.bin/vp run -F effect-agent-browserbase check
```

These remain integration packages for the pinned upstream workspace, not a second copy of the framework. `bootstrap.sh` applies one current integration patch to clean upstream and copies only tracked package files. It does not execute or apply historical checkpoint code.

[Contributing](CONTRIBUTING.md) covers local commands and the complete Ubuntu acceptance run. [Releasing](docs/RELEASING.md) describes the manual, default-off npm trusted-publishing workflow. [Security](SECURITY.md) documents the host trust boundary.

## CI and maintenance

`Library CI` reports **Unpaid acceptance** on every pull request, including forks and stacked PRs, and on `main` and merge groups. Routine library feedback checks both packages, all three strict Node/Bun consumers and the complete native suites against the real candidate tarballs. Documentation-only changes receive explicitly labelled documentation/tooling checks. Full pinned-upstream `vp run ready` and upstream release dry-runs run for integration changes, daily integration, deliberate full requests and reusable release validation; a focused pass is not a full pass. Every profile retains source identity, raw exits, stage timings and failure evidence. See [acceptance profiles](CONTRIBUTING.md#acceptance-profiles). CI remains read-only, without hosted/model credentials.

`Hosted Browserbase` is the only workflow intended to allocate provider sessions. It is manual and default-off; configure its branch-restricted protected environment before enabling it. It never runs on a pull request, so fork contributors are never blocked on a credential they cannot have. See [hosted runs](docs/HOSTED.md).

The npm job is separate: it receives OIDC permission only after fresh acceptance and an explicit maintainer opt-in. An isolated [ts-release 0.4.0 application](tools/release/) publishes the two tested tarballs through native npm trusted publishing and provenance. It retains the signed bundle and plan in Git and uses a durable dispatch journal to resume partial releases without blindly resending an uncertain upload. The publishing job installs nothing and runs no package lifecycle scripts; its tested tooling arrives as a hashed build artifact.

Historical acceptance is linked from [status](docs/STATUS.md). Checkpoints are immutable provenance under `checkpoints/`, not build inputs. Obsolete recovery scripts and transient run logs remain accessible in Git history, not on the active maintenance path.

MIT licensed. No hosted sessions, paid inference, publication, deployment or provisioning are part of ordinary CI.
