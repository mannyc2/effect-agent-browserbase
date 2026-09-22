# Browserbase adapter for Effect Agent

`effect-agent-browserbase` connects [`effect-browserbase`](../browserbase/README.md) to Effect Agent. It contains only the two things that need the framework: the `InteractiveBrowser` implementation and the fixed browser Toolkit an `AgentRuntime` can call.

Everything else — allocation, the Playwright/CDP connection, live capture, page holds, recordings, replays and downloads — belongs to the generic package. This one has no Playwright peer at all.

## Public entry points

- `adapter` — `BrowserbaseInteractiveHost`, which acquires one owned browser per execution scope and presents it as an Effect Agent `BrowserHandle`; `fromSession`, which adapts an already-owned generic session without allocating or connecting again; and `browserbaseInteractiveLayer` for providing `InteractiveBrowser` directly.
- `tools` — bounded model-facing navigation, inspection, exact observed-node click/fill, and scroll.

## One session per execution, borrowed by every turn

```ts
import {
  BrowserbaseInteractiveHost,
  browserbaseInteractiveLayer,
} from "effect-agent-browserbase/adapter";
import * as BrowserTools from "effect-agent-browserbase/tools";
import { BrowserbaseClient } from "effect-browserbase/client";
import { BrowserbaseSessions } from "effect-browserbase/sessions";
import { Effect, Layer, Redacted } from "effect";
import { InteractiveBrowserPolicy } from "effect-agent/interactive-browser";

const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      apiKey: Redacted.make(process.env.BROWSERBASE_API_KEY!),
    }),
  ),
);

const host = BrowserbaseInteractiveHost.layer({
  launch: {
    remoteTimeoutSeconds: 600,
    viewport: { _tag: "Fixed", width: 1280, height: 720 },
    provider: {},
  },
}).pipe(Layer.provide(account));

const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

    // Every interpreter turn borrows this same session; no Tool opens or closes a browser.
    return BrowserTools.handlers(session);
  }),
).pipe(Effect.provide(host));
```

`examples/agent.ts` shows the complete `AgentRuntime` wiring. Provider credentials, CDP URLs, context choices, Live View controls and recording configuration are host decisions and are never Tool parameters.

`BrowserbaseAgentSession` carries three things: the durable `reference`, the framework `handle`, and `browser`, which is the generic package's session. Capture and page control read authority from that exact object, so pass `session.browser` to `Capture.start` and `PageControl.suspend` rather than a copy.

For typed bootstrap callbacks, acquire through `BrowserbaseBrowser` and pass the result to `fromSession`. The returned `BrowserbaseAgentSession<E>` retains that exact `BrowserbaseSession<E>`: its typed failure signal, callback diagnostics, connection, target selection, action budget and capture reservations are shared. `BrowserTools.handlers(fromSession(session))` installs the same fixed Toolkit; no Tool can select callback code or create another browser. Keep the actual `AgentRuntime.run` inside `browser.withBrowser(policy, { bootstrap }, use)` when fail-session callback errors should supervise the whole agent execution. The maintained packed Agent consumer exercises this composition rather than merely checking its exports.

## Know what authority this grants

`browser_click` and `browser_fill` accept only an exact node from the most recent observation, so a model cannot name a target of its own, and a replaced or detached reference fails rather than resolving to something else. `browser_navigate` is different: the URL comes from the model, bounded only by the session's network policy, and the only policy this adapter accepts is `Unrestricted` (see [Network policy](#network-policy)). There is deliberately no per-tool host allowlist, because none is enforceable on this provider: a URL check on the first request says nothing about where it redirects or what the page then loads. A host that needs navigation confined to known hosts must enforce that beneath the browser, at an egress proxy it operates.

## Network policy

`Unrestricted` is supported only when selected by trusted host policy. `ExactHosts` fails before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers. `PublicWeb` also fails before allocation because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

The generic guide's [Network policy](../browserbase/README.md#network-policy) section says why this package has no request-admission hook, and which boundary can enforce containment instead: a proxy the host operates, selected for the whole session at launch. A host that uses one still selects `Unrestricted` here, and the containment claim stays the host's own. The model-facing Tools take no admission policy. `controlFacts` and `admit` belong to a host that drives the generic session itself.

## Error translation

The generic package's `BrowserError` carries a reason and a dispatch outcome. The adapter maps it onto the framework's provider-neutral `InteractiveBrowserError` shapes, and the Toolkit maps it onto a declared `BrowserbaseToolFailure` that keeps `undispatched`, `rejected` and `unknown` distinct. The framework contract does not preserve dispatch classification, so the adapter never guesses it from a message or a raw SDK cause; the observed-element Tools keep it explicitly.

This package intentionally exposes Effect AI Tools over a long-lived, execution-owned Browserbase session. The pinned upstream browser guide describes its own interactive pass as a different, bounded construct and says it cannot become an agent Tool. The generic package's ownership and fencing model explains this extension; it should not be presented as upstream approval of it.

Host controls above core's provider-neutral handle are deliberately per-adapter and are not portable. Two-phase allocation, detach, reconnect, Live View, handoff, viewport and cleanup outcomes are named and typed for Browserbase; the sibling Cloudflare adapter names and types its own. Shapes converged, types did not, and a shared vocabulary would have to be promoted into core first. No upstream proposal is filed, so an application that must move between adapters owns that translation itself.

## Development and evidence

Repository commands use Vite+: `vp run check`, `vp test`, `vp run install:test-browser`, `vp run test:native`, `vp pack`. This package's native suite runs the actual public `AgentRuntime`, Effect AI Toolkit and `@effect-agent/testing/ScriptedModel` against a real local Chromium over CDP, with only provider allocation and status scripted. It never allocates Browserbase and never invokes a paid model. A local CDP pass proves native integration, not provider allocation, Live View authorization or Browserbase network behavior.

This package owns its live-browser fixture rather than borrowing the generic package's: each package is installed on its own, and the workspace's export check rejects any relative import that resolves outside the owning package.
