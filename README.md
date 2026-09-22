# Effect browser automation

Three packages share one scoped browser owner:

| Package                | Folder                                                       | Responsibility                                                                                                                                                                                |
| ---------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `effect-browser`       | [`packages/browser`](packages/browser/README.md)             | Provider-independent browser operations, typed bindings, live capture, page holds and the shared Playwright/CDP runtime. `effect-browser/chromium` launches or borrows self-managed Chromium. |
| `effect-browserbase`   | [`packages/browserbase`](packages/browserbase/README.md)     | Browserbase accounts/resources and hosted acquisition, cleanup, contexts, uploads, recordings and replays. Depends on the shared runtime.                                                     |
| `effect-agent-browser` | [`packages/agent-browser`](packages/agent-browser/README.md) | One Effect Agent adapter and maintained Toolkit for either browser source. Depends on the shared runtime and framework, not Browserbase.                                                      |

This branch prepares the breaking `0.2.0-beta.0` package set. The earlier `0.1.0-beta.103` release used `effect-browserbase` and `effect-agent-browserbase`; it does not establish publication or ownership of the new package names. Publication is a separate maintainer action.

## Start a browser

```ts
import { Effect } from "effect";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

const program = Effect.gen(function* () {
  const browser = yield* Chromium;
  return yield* browser.withBrowser(BrowserPolicy.unrestricted(), {}, (session) =>
    Effect.gen(function* () {
      yield* session.bind().navigate({ url: "https://example.com" });
      return yield* session.observe({ scope: "viewport" });
    }),
  );
}).pipe(Effect.provide(Chromium.layer()));
```

For hosted acquisition, use `BrowserbaseBrowser` with a Browserbase account and launch recipe. Both return the same modeled browser surface; provider references and cleanup facts stay with their concrete owner. The [Browserbase workflow examples](packages/browserbase/examples/workflows.ts) show account/resource composition.

## Use the same tools with either source

```ts
import * as Adapter from "effect-agent-browser/adapter";
import * as BrowserTools from "effect-agent-browser/tools";

// The host acquired browser through Chromium or Browserbase, in the active execution scope.
const session = Adapter.fromSession(browser);
const handlers = BrowserTools.handlers(session, { observationScope: "viewport" });
```

Every agent turn borrows that session. The adapter creates no browser, copies no capture authority and delegates checked closure to the owner. The complete [Chromium example](packages/agent-browser/examples/chromium.ts) and [Browserbase example](packages/agent-browser/examples/agent.ts) use one shared agent definition. The host supplies its selected LanguageModel.

## Ownership and boundaries

A browser belongs to its Effect Scope, with one connection, action budget and capture/page-control registry. Hosted release/status checks and local process termination are different cleanup facts; both owners provide `closeChecked`, and both retain their full receipts. Borrowed closure disconnects only the borrowed connection.

Actions retain exact observed-node identity and distinguish `undispatched`, `rejected` and `unknown` outcomes. An uncertain mutation is never replayed. Callback errors and services remain typed. Credentials, endpoints, control facts and native diagnostics stay with the host.

Live capture supplies bounded JPEG frames and metadata from the same owner. A caller owns encoding and presentation. Browserbase recording and replay services have independent resource lifetimes. No second debugger connection or raw driver is exposed.

The implementation targets trusted Node/Bun hosts and supports only explicit `Unrestricted` network policy. Chromium launch supports Linux/macOS; borrowed attachment currently accepts concrete loopback CDP WebSockets. Native local validation and hosted-provider evidence are distinct; see [Status](docs/STATUS.md).

### Demo

A real hosted session navigating and scrolling under Effect Agent control, encoded by the caller from the live frame stream ([provenance](docs/media/README.md)):

![A hosted Browserbase session navigating and scrolling under Effect Agent control](docs/media/hosted-demo.gif)

[Higher-quality MP4](docs/media/hosted-demo.mp4)

And footage meant to be watched: a storyboard performed with a drawn pointer, paced typing and eased scrolling by [`examples/realistic-footage`](packages/browserbase/examples/realistic-footage/README.md), filmed against a local Chromium:

![A drawn pointer types a destination, follows a route, scrolls its stops and holds a berth on a fictional sleeper-train site](docs/media/realistic-footage.gif)

[Higher-quality MP4](docs/media/realistic-footage.mp4)

## Development

Read [Contributing](CONTRIBUTING.md), the applicable package guide and [AGENTS.md](AGENTS.md). The repository builds into a pinned upstream Effect Agent compatibility workspace. All three owned packages use one coordinated candidate version; the upstream framework pins remain separate.

```sh
# Use pinned Node 24.14.1 and Bun 1.4.2.
bash tools/bootstrap.sh
cd .work/upstream/tree
./node_modules/.bin/vp run -F effect-browser check
./node_modules/.bin/vp run -F effect-browserbase check
./node_modules/.bin/vp run -F effect-agent-browser check
./node_modules/.bin/vp run check:integration
```

Package unit tests stay with their owners. Source-only regressions that combine private provider and browser boundaries live in `test/integration`; they use the same Vite+ runner and do not create public testing APIs. Installed-package consumers cover resources, Chromium, hosted browser integration, Chromium agents and hosted agents on both Node and Bun. Production import checks keep framework/provider dependencies out of the common runtime and Chromium process code out of its root.

Ordinary CI is unpaid and read-only. [Hosted checks](docs/HOSTED.md) and [publication](docs/RELEASING.md) require separate authorization. [Security](SECURITY.md) describes the host trust boundary. Historical releases and media evidence retain their original source identity in [Status](docs/STATUS.md).

MIT licensed.
