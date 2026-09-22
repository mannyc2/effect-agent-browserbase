# Effect Agent Browserbase

[Browserbase](https://www.browserbase.com) for [Effect](https://effect.website) v4, in two packages that share one owned browser.

| Package | Folder | What it is |
| --- | --- | --- |
| `effect-browserbase` | [`packages/browserbase`](packages/browserbase/README.md) | The whole Browserbase surface for an Effect application: one account, session and context resources, one owned browser over Playwright/CDP, real pointer and key input, bounded live capture, page holds, typed page→host bindings, the provider's recordings, replays, uploads and downloads, and the platform APIs outside a session. No Effect Agent dependency. Playwright is an optional peer, loaded only when a browser connects. |
| `effect-agent-browserbase` | [`packages/agent-browserbase`](packages/agent-browserbase/README.md) | The [Effect Agent](https://github.com/danieljvdm/effect-agent) adapter: the `InteractiveBrowser` implementation and the fixed browser Toolkit an `AgentRuntime` calls. It borrows the generic package's session rather than opening its own, and has no Playwright peer. |

Neither package is published yet; see [Status](#status).

## A first look

One account, one owned browser, bounded actions with typed outcomes:

```ts
import * as Account from "effect-browserbase/account";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { BrowserPolicy, NavigateRequest } from "effect-browserbase/browser-data";
import { recipe } from "effect-browserbase/launch";
import { Effect, Layer } from "effect";

// BROWSERBASE_PROJECT_ID and BROWSERBASE_API_KEY are read from the ConfigProvider.
const browser = BrowserbaseBrowser.layer({ launch: recipe() }).pipe(
  Layer.provide(Account.layerConfig()),
);

const program = Effect.scoped(
  Effect.gen(function* () {
    // The scope owns the session. Leaving it releases the browser and reports how that went.
    const session = yield* (yield* BrowserbaseBrowser).open(BrowserPolicy.unrestricted());

    yield* session.bind().navigate(NavigateRequest.make({ url: "https://example.com" }));

    return yield* session.observe({ scope: "viewport" });
  }),
).pipe(Effect.provide(browser));
```

Hand the same kind of session to an agent and every model turn borrows it:

```ts
import { BrowserbaseInteractiveHost } from "effect-agent-browserbase/adapter";
import * as BrowserTools from "effect-agent-browserbase/tools";
import * as AgentRuntime from "effect-agent/agent-runtime";

const run = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

    // The Tools navigate, inspect, click, fill and scroll this session; none opens or closes one.
    return yield* AgentRuntime.run(agent, "find the pricing page").pipe(
      Effect.provide(Layer.merge(BrowserTools.handlers(session), InMemory.layer)),
    );
  }),
);
```

[`packages/agent-browserbase/examples/agent.ts`](packages/agent-browserbase/examples/agent.ts) is the complete version, including an operator taking the session over through Live View between two agent runs, and a typed page→host binding whose failure ends the run. [`packages/browserbase/examples/`](packages/browserbase/examples/README.md) covers the generic side: caller-encoded video from live capture, and a storyboard filmed with a drawn pointer and real keys.

## What the packages promise

- **One owner.** A `BrowserbaseSession` belongs to the Effect `Scope` that opened it and owns the single CDP connection; nothing else drives that browser. A `SessionReference` is the durable, credential-free identity that outlives the scope and names recordings, replays and cleanup afterwards.
- **Bounded work, typed outcomes.** Every operation is charged against a policy of actions, elapsed time and returned bytes. Every failure says which operation, why, and whether it was sent: `undispatched` is safe to retry, `rejected` was refused, `unknown` may have happened and is never replayed for you.
- **Exact targets.** Actions name the exact node an observation returned. A replaced, detached or changed node fails instead of resolving to something similar; nothing is ever re-found by selector or label.
- **Host authority stays with the host.** Credentials, CDP addresses, Live View URLs, control facts and callback diagnostics never reach a model. Page→host bindings are admitted by the calling document's execution-context identity, not by a URL the page reports.
- **Evidence a recorder can trust.** Pointer, wheel and key input are the events hardware would send, with receipts on the same monotonic clock as captured frames. Capture reports every dropped frame and every document boundary, and claims no audio, because the screencast has none.
- **A local browser, the same way.** `effect-browserbase/local-browser` owns a scoped local Chromium or borrows a loopback attachment, driven by the same modeled owner, driver, capture and page-control implementation as a hosted session, without a Browserbase account. Local identity and cleanup distinguish connection teardown from owned-process termination; a borrowed browser is never terminated. Provider resources and provider cleanup remain hosted capabilities.
- **Hosts choose what the tools may do.** The maintained Toolkit accepts host-selected observation scope and fresh exact-control admission. Hosts can opt into native pointer, hover and wheel tools, or scoped navigation and input callbacks, while model responses stay bounded. A running capture exposes a passive metadata snapshot, so a host reads document boundaries and loss accounting without stopping capture or waking a held page.
- **What it refuses.** Only the trusted-host `Unrestricted` network policy is supported; `ExactHosts` and `PublicWeb` fail before allocation rather than claiming a containment the provider cannot prove. There is no second CDP client, no raw protocol seam, and no recording enabled after the fact.

The [Browserbase guide](packages/browserbase/README.md) is the reference for all of this; the [adapter guide](packages/agent-browserbase/README.md) covers the framework contract, error translation and what authority each Tool grants.

## Status

**Not yet on npm.** Both packages are built and tested from this repository; publication is a separate, manual, tag-scoped workflow ([RELEASING.md](docs/RELEASING.md)).

**Unpaid acceptance on every pull request.** `Library CI` runs the maintenance tooling tests, both packages' unit suites, the native suites against a local Chromium over real CDP, and three clean consumers installed from the packed tarballs on both Node and Bun. The full profile adds the pinned upstream workspace's own `check` and `build`, and its tests for the workspaces the integration patch reaches. Nothing in it allocates a hosted session or calls a paid model; see [CONTRIBUTING.md](CONTRIBUTING.md#acceptance-profiles).

**Hosted evidence is separate and recorded.** Every paid question is a registered check in [`packages/browserbase/hosted/`](packages/browserbase/hosted/checks.ts), run only through a manual, default-off workflow ([HOSTED.md](docs/HOSTED.md)). [STATUS.md](docs/STATUS.md) records which claims have a run behind them — allocation, capture, Live View, confirmed release, recording and replay delivery, persistent contexts, keep-alive reconnect, extension identity, uploads and one operator handoff — and which remain open. A local pass is never presented as hosted evidence.

### Demo

A real hosted session navigating and scrolling under Effect Agent control, encoded by the caller from the live frame stream ([provenance](docs/media/README.md)):

![A hosted Browserbase session navigating and scrolling under Effect Agent control](docs/media/hosted-demo.gif)

[Higher-quality MP4](docs/media/hosted-demo.mp4)

And footage meant to be watched: a storyboard performed with a drawn pointer, paced typing and eased scrolling by [`examples/realistic-footage`](packages/browserbase/examples/realistic-footage/README.md), filmed against a local Chromium:

![A drawn pointer types a destination, follows a route, scrolls its stops and holds a berth on a fictional sleeper-train site](docs/media/realistic-footage.gif)

[Higher-quality MP4](docs/media/realistic-footage.mp4)

## Development

```sh
git clone https://github.com/mannyc2/effect-agent-browserbase.git
cd effect-agent-browserbase
toolchain_env="$(bash tools/pinned-toolchain.sh)" && eval "$toolchain_env"   # Node 24.14.1, Bun 1.4.2
bash tools/bootstrap.sh                          # clean pinned upstream + upstream.patch + these packages
cd .work/upstream/tree
./node_modules/.bin/vp run -F effect-browserbase check
./node_modules/.bin/vp run -F effect-agent-browserbase check
```

The packages are developed inside a pinned [effect-agent](https://github.com/danieljvdm/effect-agent) workspace that `tools/bootstrap.sh` reproduces; edit `packages/` here, not the disposable tree. [CONTRIBUTING.md](CONTRIBUTING.md) has the toolchain pins, the local loop and the acceptance profiles; [AGENTS.md](AGENTS.md) the rules for automated maintenance; [SECURITY.md](SECURITY.md) the trust boundary.

| Document | Holds |
| --- | --- |
| [`docs/STATUS.md`](docs/STATUS.md) | Current state and every hosted run record |
| [`docs/HOSTED.md`](docs/HOSTED.md) | The registered paid checks and how to run them |
| [`docs/RELEASING.md`](docs/RELEASING.md) | The manual npm trusted-publishing workflow |
| [`docs/media/`](docs/media/README.md) | The committed recordings and their provenance |

MIT licensed. Ordinary CI never allocates a hosted session, performs paid inference, publishes or deploys.
