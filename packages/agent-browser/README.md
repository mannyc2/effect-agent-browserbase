# Browser tools for Effect Agent

`effect-agent-browser` connects [`effect-browser`](../browser/README.md) to Effect Agent. One adapter, maintained Toolkit and host callback implementation support both self-managed Chromium and Browserbase. It depends on the common browser runtime and Effect Agent; it does not install Browserbase or own a Playwright peer.

## Public entry points

`adapter` exports `fromSession`, preserving the exact concrete session, and `interactiveLayer`, which presents a host-selected opener as Effect Agent's `InteractiveBrowser`. `tools` exports the maintained toolkit/handlers, optional native input tools and scoped host callbacks. The root exports those two namespaces.

## One session, chosen by the host

Acquire a session once, adapt it, and let every model turn borrow it:

```ts
import { Effect } from "effect";
import * as Adapter from "effect-agent-browser/adapter";
import * as BrowserTools from "effect-agent-browser/tools";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

const program = Effect.scoped(
  Effect.gen(function* () {
    const browser = yield* (yield* Chromium).launch(BrowserPolicy.unrestricted());
    const session = Adapter.fromSession(browser);
    const host = yield* BrowserTools.makeHost(session, { observationScope: "viewport" });
    // Run AgentRuntime with host.handlers inside this scope and supervise with host.failure.
    // Capture.start(session.browser) uses this same exact browser object.
    return yield* browser.observe();
  }),
).pipe(Effect.provide(Chromium.layer()));
```

For Browserbase, acquire with `BrowserbaseBrowser.open` from `effect-browserbase/browser`, supplying its account and launch configuration, then pass that session to the same `Adapter.fromSession` and `BrowserTools` functions. Nothing in the tool implementation branches on the provider. The model does not choose the account, browser source, credentials, endpoint, launch options or capture settings.

[`examples/chromium.ts`](examples/chromium.ts) and [`examples/agent.ts`](examples/agent.ts) use the same [`BrowserAgent.ts`](examples/BrowserAgent.ts) definition. The hosted example also shows human handoff and typed page-to-host callbacks. Both leave the model choice to the caller.

`fromSession<S>(browser)` returns an `AdaptedSession<S>` retaining that exact object, callback errors, diagnostics, native connection and action budget. Tools accept the common `AgentSession<E>`. A concrete provider reference is available on `session.browser.reference`; the adapter does not copy identity into a competing owner.

The session provides `implementation` and `closeChecked`. Closing the framework handle delegates to that operation. Chromium confirms its own connection/process cleanup; Browserbase confirms its own release or borrowed disconnection. A borrowed handle never terminates the externally owned browser. Detailed cleanup receipts remain on the concrete browser.

## Provide InteractiveBrowser directly

A host can configure framework acquisition without introducing separate provider adapters:

```ts
import { Effect, Layer } from "effect";
import { interactiveLayer } from "effect-agent-browser/adapter";
import { Chromium } from "effect-browser/chromium";

const browserLayer = interactiveLayer({
  implementation: "chromium-playwright-cdp",
  open: (policy) => Effect.flatMap(Chromium, (browser) => browser.launch(policy)),
}).pipe(Layer.provide(Chromium.layer()));
```

The opener's services are captured when the Layer is built; each `open` still uses its caller's execution Scope. Building the Layer allocates nothing. The common policy is validated before calling the opener, and unsupported containment fails before acquisition. Expected acquisition failures are sanitized into the framework's error contract. For original acquisition and callback error types, acquire through the concrete owner and use `fromSession` inside its `withBrowser` supervisor.

## Host observation and exact-control policy

`handlers(session, options)` keeps document inspection and the original five Tools by default. The host can select `observationScope: "viewport"` and pass `admission: ElementAdmission`. The same options apply to `nativeHandlers` and `makeHost`:

```ts
const handlers = BrowserTools.handlers(session, {
  observationScope: "viewport",
  maxTextBytes: 8192,
  maxControls: 16,
  admission: {
    admit: (facts) =>
      facts.inputType !== "password" &&
      facts.autocomplete !== "current-password" &&
      facts.formMethod === undefined,
  },
});
```

Viewport observations retain the generic reading's geometry budgets and its clipped, covered, uncertain and exhausted qualifications. Choosing viewport scope does not turn hit-testing into pixel-level visibility proof. Scout consumers can still explicitly use document scope.

The policy runs for maintained `browser_click`, `browser_fill` and `browser_hover` on fresh facts from the exact observed node. The owner first rejects replaced or changed controls, independently of that policy. `admit` is synchronous under the owner's permit; it returns a boolean. False, a thrown exception or a non-boolean result fails `denied/undispatched`, without projecting the exception to the model. Policy and destination/type/autocomplete/form facts are host-only and are never Tool parameters. Asynchronous application checks belong before dispatch and retain their own Effect errors, services and cancellation; they do not replace this final synchronous policy. Native input is still not atomic with DOM validation: page script can run after validation and before input arrives.

Passive `checkpoint` does not replace the observation used by Tools. After a page hold/resume, call `revalidateElement` on the retained exact reference before dispatch; unchanged, admissible controls remain usable, while replacements and changed control facts fail without substitution. The native AgentRuntime regression exercises this composition on the same owner.

## Optional native input

`nativeToolkit` adds `browser_pointer_move`, `browser_hover` and `browser_wheel`. Merge it with `toolkit` using Effect's `Toolkit.merge`, and provide both `handlers(session, options)` and `nativeHandlers(session, options)`. Merely installing these handlers does not expose new Tools to an agent whose declared toolkit still contains only the original five.

Pointer requests use the generic `PointerMoveRequest` and wheel requests use `WheelRequest`: CSS pixels in the main-frame viewport. Hover takes an `ObservedElement` and applies the same exact-node admission as click/fill. It never scrolls an off-screen element into view. A wheel event reaches the nested container or page the browser hit-tests under the pointer. `browser_scroll` remains an instantaneous scripted scroll with no wheel event.

Native model results contain only `{ dispatched: true }`. They do not claim scrolling has settled or that a website action succeeded. Observe again for the result. `makeHost`'s `onInput` receives the unmodified `InputReceipt` and optional tool-call ID, including target, commanded position/delta and host-monotonic interval. Receipt times, private capabilities and callback output never enter the model result. The host owns pacing, easing and drawing; these Tools add none and never replay failed input.

## Scoped navigation and receipt callbacks

`makeHost(session, options)` acquires a scoped host composition without opening another browser. It returns `handlers`, `nativeHandlers` and `failure`. Its `HostOptions<E, R>` accepts these optional host callbacks:

`onNavigation` receives `{ operation: NavigationOperation, toolCallId: string | undefined }`; `onInput` receives `{ receipt: InputReceipt, toolCallId: string | undefined }`. Each returns `Effect<void, E, R | Scope.Scope>`.

The callback service requirements are captured at `makeHost` acquisition; each callback gets its own invocation scope. `failure: Effect<never, E | BrowserError>` retains the first original callback or cleanup cause for the host, including private consumer errors. Run the agent with the returned handler Layers, and race the agent execution with `host.failure` when callback failure should supervise the whole agent run. The host refuses later calls after a callback failure. The model receives only a bounded `BrowserToolFailure`, never the callback cause, its service values or raw operation object.

This scoped path deliberately uses `startNavigation` once for `browser_navigate`. `onNavigation` starts once with that exact operation before completion is raced, including for an already-settled navigation. Returning from the callback does not finish navigation; the Tool still waits for DOMContentLoaded. The callback may checkpoint/capture while the page loads or wait for an application cancellation signal and call `operation.stop`. Waiting on `operation.completed` and cancelling that waiter alone stops nothing. A callback that needs to inspect a failed completion can use `Effect.result` or `Effect.exit` rather than raising it as a callback failure.

Navigation completion cancels remaining callback work and joins its scoped cleanup before returning. Callback failure or interruption of the Tool/host scope asks that same pending operation to stop before its operation scope closes. A failed stop preserves the native error and owner fencing; it is not treated as confirmed termination. Confirmed stop produces the generic `interrupted` completion and keeps a healthy session usable, without undoing page effects. The existing generic failure schema still reports that completion's `outcome: "unknown"`; acknowledgement of stop does not establish what the page did before it stopped. Default `handlers`, without `makeHost`, retain their earlier navigation/abandonment semantics.

`onInput` runs after input dispatch. Its failure is therefore not an undispatched input: the model receives `failed/unknown`, and the host retains the original error. In contrast, admission refusal and a call refused because its host is already closed/faulted dispatch nothing. Closing the `makeHost` scope interrupts and joins its calls but does not close the borrowed browser. Operation reservations, native fences and browser cleanup remain with the generic owner.

## Know what authority this grants

`browser_click` and `browser_fill` accept only an exact node from the most recent observation, so a model cannot name a target of its own, and a replaced or detached reference fails rather than resolving to something else. `browser_navigate` is different: the URL comes from the model, bounded only by the session's network policy, and the only policy this adapter accepts is `Unrestricted` (see [Network policy](#network-policy)). There is deliberately no per-tool host allowlist, because none is enforceable on this provider: a URL check on the first request says nothing about where it redirects or what the page then loads. A host that needs navigation confined to known hosts must enforce that beneath the browser, at an egress proxy it operates.

## Network policy

`Unrestricted` is supported only when selected by trusted host policy. `ExactHosts` fails before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers. `PublicWeb` also fails before allocation because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

The generic guide's [Network policy](../browser/README.md#network-policy) section says why this package has no request-admission hook, and which boundary can enforce containment instead: a proxy the host operates, selected for the whole session at launch. A host that uses one still selects `Unrestricted` here, and the containment claim stays the host's own. The model-facing Tools take no admission policy. Host `admission` options decide whether an exact control may receive input; they do not establish redirect, subresource or connection-time network containment.

## Error translation

The generic package's `BrowserError` carries a reason and a dispatch outcome. The adapter maps it onto the framework's provider-neutral `InteractiveBrowserError` shapes, and the Toolkit maps it onto a declared `BrowserToolFailure` that keeps `undispatched`, `rejected` and `unknown` distinct. The framework contract does not preserve dispatch classification, so the adapter never guesses it from a message or a raw SDK cause. Observed-element and native-input Tools, and navigation through `makeHost`, use the generic operation's explicit failure facts. Consumer callback causes stay on the host-only failure signal.

This package exposes Effect AI Tools over a long-lived, execution-owned browser session supplied by Chromium or Browserbase. The pinned upstream browser guide describes its own interactive pass as a different, bounded construct and says it cannot become an agent Tool. The generic package's ownership and fencing model explains this extension; it should not be presented as upstream approval of it.

The common adapter and Tools support both self-managed Chromium and Browserbase. `fromSession` retains the exact concrete session type: Browserbase Live View, handoff, reference and remote cleanup remain available on `agent.browser`; Chromium retains its own reference and process cleanup. Those provider capabilities are not added to the model's common handle. Other upstream adapters still require their own composition.

## Development and evidence

Use the frozen Vite+ workspace described in [Contributing](../../CONTRIBUTING.md). Both owners are exercised with the actual public AgentRuntime and Toolkit, using a scripted model and real Chromium. The `agent` installed consumer includes Chromium and the common adapter with no Browserbase installation. The `agent-hosted` consumer adds Browserbase and exercises provider acquisition/cleanup composition through scripted provider HTTP. They preserve typed callback errors, one session identity and capture after agent execution.

Native framework tests prove that the Layer captures configured services while each acquired browser closes with its caller's Scope, even while the Layer remains alive. Existing exact-node, input, viewport, host callback, cancellation and capture regressions run through the same handlers. A local native pass is not hosted Browserbase or paid-model evidence.
