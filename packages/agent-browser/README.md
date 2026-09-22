# Browser tools for Effect Agent

`effect-agent-browser` connects [`effect-browser`](../browser/README.md) to Effect Agent. One adapter, maintained Toolkit and host callback implementation support both self-managed Chromium and Browserbase. The host supplies its required peers explicitly: `effect-browser@0.2.0-beta.0` and `effect-agent@0.1.0-beta.102` for this candidate. These exact prerelease peers express the qualified combination; supply matching versions and keep one runtime instance across the application and adapter. The Effect peer remains `^4.0.0-rc.115`, with only rc.115 qualified. The adapter does not install Browserbase or own a Playwright peer.

## Public entry points

`tools` exports the maintained Toolkit, direct `BrowserSession` handlers, supervised host composition and separate pointer/wheel, keyboard and option-selection opt-ins. `adapter` exports `fromSession` and `interactiveLayer` for code that specifically needs Effect Agent's provider-neutral `InteractiveBrowser` contract. The root exports those two namespaces.

## One session, chosen by the host

Acquire a session once and give that exact browser to the Tools:

```ts
import { Effect } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

const program = Browser.scoped(Chromium.launch(BrowserPolicy.unrestricted()), (browser) =>
  BrowserTools.run(browser, agentProgram, {
    observationScope: "viewport",
  }),
).pipe(Effect.provide(Chromium.layer()));
```

For Browserbase, use `BrowserbaseBrowser.open(...)` from `effect-browserbase/browser`, supplying its account and launch configuration, then pass that session to the same `BrowserTools` functions. Nothing in the tool implementation branches on the provider. The model does not choose the account, browser source, credentials, endpoint, launch options or capture settings.

[`examples/chromium.ts`](examples/chromium.ts) and [`examples/agent.ts`](examples/agent.ts) use the same [`BrowserAgent.ts`](examples/BrowserAgent.ts) definition. The hosted example also shows human handoff and typed page-to-host callbacks. Both leave the model choice to the caller.

The Tools accept `BrowserSession<E>` directly. They retain the owner's dispatch outcome and project its tagged reason into a compact `BrowserToolFailure`; `makeHost` keeps the original error fields in its host-only `toolFailures` snapshot. Concrete provider capabilities remain on the original object. `Browser.scoped(open, use)` owns acquisition and checked cleanup around the application callback; `BrowserTools.run(browser, program, options)` owns only Tool-host lifetime and supervision inside an already-owned browser.

## Provide InteractiveBrowser directly

A host can configure framework acquisition without introducing separate provider adapters:

```ts
import { Effect, Layer } from "effect";
import { interactiveLayer } from "effect-agent-browser/adapter";
import { Chromium } from "effect-browser/chromium";

const browserLayer = interactiveLayer({
  implementation: "chromium-playwright-cdp",
  open: (policy) => Chromium.launch(policy),
}).pipe(Layer.provide(Chromium.layer()));
```

The opener's services are captured when the Layer is built; each `open` still uses its caller's execution Scope. Building the Layer allocates nothing. The common policy is validated before calling the opener, and unsupported containment fails before acquisition. Expected acquisition and retention failures are sanitized into the framework's error contract. This Layer explicitly retains the selection for each framework handle.

`fromSession<S>(browser, { selection })` returns an Effect that keeps the exact concrete `S` beside its framework handle. Choose `"current"` to follow selection when an operation executes, or `"retained"` to check and retain selection when adaptation executes. Neither mode allocates or connects a browser. Inside the existing browser scope:

```ts
import * as Adapter from "effect-agent-browser/adapter";

const current = yield * Adapter.fromSession(browser, { selection: "current" });
const retained = yield * Adapter.fromSession(browser, { selection: "retained" });
const next = yield * browser.createPage;
yield * browser.selectPage(next);
yield * current.handle.navigate({ url: "https://example.com" });
// retained.handle now refuses stale selection, including after moving away and back.
```

There is one `AdaptedSession<S>` type containing `browser` and `handle`. Reacquire explicitly when a new retained selection is intended. `handle.close` checks the same owner's cleanup and returns `void`; concrete cleanup receipts remain available on `adapted.browser`. Use the direct Tools path when original browser and callback error types or dispatch classification matter.

## Host observation and exact-control policy

`handlers(browser, options)` keeps document inspection and the original five Tools by default. The host can select `observationScope: "viewport"` and pass `admission: ElementAdmission`. The same options apply to `nativeHandlers`, `keyboardHandlers`, `selectionHandlers`, `makeHost` and `run`:

```ts
const handlers = BrowserTools.handlers(browser, {
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

`nativeToolkit` adds `browser_pointer_move`, `browser_hover` and `browser_wheel`. `keyboardToolkit` separately adds `browser_press` and `browser_type`; existing native-tool opt-ins therefore do not silently gain keyboard authority. Merge only the Toolkits the agent should see. `host.layer` can provide every handler service at once because an Effect AI agent can call only Tools declared in its own Toolkit.

Pointer requests use the generic `PointerMoveRequest` and wheel requests use `WheelRequest`: CSS pixels in the main-frame viewport. Hover takes an `ObservedElement` and applies the same exact-node admission as click/fill. It never scrolls an off-screen element into view. A wheel event reaches the nested container or page the browser hit-tests under the pointer. `browser_scroll` remains an instantaneous scripted scroll with no wheel event.

Keyboard Tools also take an exact `ObservedElement`. That node must already have focus; the Tool never focuses or searches for a replacement. `browser_press` accepts the generic `KeyStroke`, and `browser_type` uses the browser package's bounded text schema (at most 256 characters, with control characters refused). Both apply the same fresh `admission` policy as click/fill/hover.

Real-input model results contain only `{ dispatched: true }`. They do not claim scrolling, focus-driven page work or a website action has settled. Observe again for the result. `makeHost`'s `onInput` receives the unmodified `InputReceipt` and optional tool-call ID, including target, commanded position/delta and host-monotonic interval. A receipt never includes the key or typed text. Receipt times, private capabilities and callback output never enter the model result. The host owns pacing, easing and drawing; these Tools add none and never replay failed input.

## Optional exact option selection

Merge `selectionToolkit` when an agent may operate native dropdowns:

```ts
import { Toolkit } from "effect/unstable/ai";
import * as BrowserTools from "effect-agent-browser/tools";

const tools = Toolkit.merge(BrowserTools.toolkit, BrowserTools.selectionToolkit);
// Declare tools on the agent; BrowserTools.run provides the matching handler services.
```

`browser_select_option` accepts `{ reference, options }`. `reference` identifies the inspected
native `<select>`; `options` is a nonempty set of at most 64 unique option `elementId`s from that
same observation. Each option's `selectElementId` names its parent control. `multiple` on the
select determines whether several choices are allowed; `optionsTruncated` says some choices did
not fit the shared control budget. A viewport inspection includes choices belonging to a visible
select even while its popup menu is collapsed. This is option metadata, not a claim that every
option row has visible pixels. Increase the host's `maxControls` deliberately when needed, up to
the browser's existing bound of 64 total retained controls and options.

Only options carrying `selectElementId` are eligible. Options whose private submitted values
exceed the native identity bound are left unissued and reported through `optionsTruncated`.
After a host page hold, both the select and each chosen option need explicit revalidation.

Labels can repeat; only issued IDs identify choices. The tool accepts no value, label lookup,
selector or page identifier. The browser rechecks the original select and option nodes, their
membership, enabled/multiple state and private value identity under its existing owner before
one selection dispatch. It never searches for replacement nodes. Fresh host `admission` applies
to the select. Success returns the bounded action result, without submitted values, and retires
that page's observation; inspect again for new references and selected state. Rejections use the
same compact failure vocabulary and host diagnostics as the existing tools.

`host.selectionHandlers` shares the complete-invocation lane with the other host handler Layers.
`selectionHandlers(browser, options)` remains available for caller-managed composition. Neither
the default five-tool toolkit nor the pointer or keyboard toolkits gain selection authority.

## Scoped navigation and receipt callbacks

`makeHost(browser, options)` acquires a scoped host composition without opening another browser. It returns `handlers`, `nativeHandlers`, `keyboardHandlers`, `selectionHandlers`, their merged `layer`, `failure`, `toolFailures`, and `run(effect)`. Its `HostOptions<E, R>` accepts these optional host callbacks:

`onNavigation` receives `{ operation: NavigationOperation, toolCallId: string | undefined }`; `onInput` receives `{ receipt: InputReceipt, toolCallId: string | undefined }`. Each returns `Effect<void, E, R | Scope.Scope>`.

The callback service requirements are captured at `makeHost` acquisition; each callback gets its own invocation scope. `failure` retains the first original host callback/navigation-cleanup cause or the browser's original fail-session cause, including the browser's typed bootstrap error. `host.run(effect)` provides every maintained handler Layer and races the whole program against that failure. `BrowserTools.run(browser, effect, options)` is the scoped convenience form. Program requirements unrelated to Tool handlers stay in `R`; callback requirements also stay visible and are captured before handlers are provided.

The host refuses a run that begins after its browser has already failed. Closing the host scope interrupts and joins `host.run` itself, its in-flight Tool calls and callback scopes. None of those operations closes the browser: ownership and checked cleanup remain with `Browser.scoped` or the caller's enclosing browser scope. The model receives only a bounded `BrowserToolFailure`, never a callback cause, its service values or a raw operation object.

This scoped path deliberately uses `startNavigation` once for `browser_navigate`. `onNavigation` starts once with that exact operation before completion is raced, including for an already-settled navigation. Returning from the callback does not finish navigation; the Tool still waits for DOMContentLoaded. The callback may checkpoint/capture while the page loads or wait for an application cancellation signal and call `operation.stop`. Waiting on `operation.completed` and cancelling that waiter alone stops nothing. A callback that needs to inspect a failed completion can use `Effect.result` or `Effect.exit` rather than raising it as a callback failure.

Navigation completion cancels remaining callback work and joins its scoped cleanup before returning. Callback failure or interruption of the Tool/host scope asks that same pending operation to stop before its operation scope closes. A failed stop preserves the native error and owner fencing; it is not treated as confirmed termination. Confirmed stop produces the generic `interrupted` completion and keeps a healthy session usable, without undoing page effects. The existing generic failure schema still reports that completion's `outcome: "unknown"`; acknowledgement of stop does not establish what the page did before it stopped. Default `handlers`, without `makeHost`, retain their earlier navigation/abandonment semantics.

A main-frame loading deadline uses the browser owner's bounded recovery, including through
`Tools.run`: the model receives `timeout/unknown` after acknowledged stop and can inspect the
partial page before choosing its next action. Recovery and explicit stop share one coordinator;
the loading deadline may be followed by up to three seconds of recovery, never beyond the browser
lifetime. Failed recovery or a pinned child-frame timeout keeps the owner fenced. No failed
navigation is automatically repeated.

Inspection references come from the actual returned observation. They survive a host's
selection-only excursion or pinned input on another page, but refuse while the wrong page/frame
is selected or when the exact document/control changed. Input on their own page, including hover
and scrolling, still requires reinspection. Reconnect and a new inspection retire older references;
never construct an ID from an assumed counter.

`onInput` runs after input dispatch. Its failure is therefore not an undispatched input: the model receives `failed/unknown`, and the host retains the original error. In contrast, admission refusal and a call refused because its host is already closed/faulted dispatch nothing. Operation reservations, native fences and browser cleanup remain with the generic owner.

### Concurrent tool calls

Every `makeHost` owns one blocking invocation lane shared by its handler Layers and all
programs run through that host. Concurrent calls, including Effect Agent's default concurrency
of four, wait for their first execution. The lane stays held until the complete tool finishes:
navigation completion, callback finalizers and required stop cleanup all precede the next call.
Calls from different toolkit groups share it. A queued exact-node call can still be stale when
admitted if earlier input retired its observation; sequencing never refreshes references or
replays input.

The initial fixed policy permits 32 outstanding invocations including the active one, with at
most 30 seconds waiting from invocation entry. These are policy choices, not throughput
measurements. Overflow returns `busy/undispatched`; queue expiry returns `timeout/undispatched`.
The queue deadline does not limit a handler after admission. Waiting spends no browser action;
the operation's normal budget and deadline apply when it executes. Host closure, cancellation
and host failure cancel or wake accepted waiters, which recheck admission before browser work.
The lane serializes calls but does not promise a model-declared ordering for concurrent work.

A callback or its finalizer invoking another tool through the same host receives
`busy/undispatched` immediately. An inherited private context marker distinguishes this reentry
from an independent caller, which queues normally; nesting another host does not erase the
enclosing marker. Captured callback services and per-call services keep their existing meanings.

Direct browser reads, capture and page control are outside the tool lane and retain the browser
owner's fail-fast native permit. They can still report `Busy` while a native operation holds that
permit. Module-level `handlers`, `nativeHandlers`, `keyboardHandlers` and `selectionHandlers` are the unsupervised,
caller-managed path: they do not add this lane. Use `makeHost` or `Tools.run` for the maintained
sequencing and supervision lifecycle.

## Know what authority this grants

`browser_click`, `browser_fill`, `browser_hover`, `browser_press` and `browser_type` accept only an exact node from the most recent observation, so a model cannot name a target of its own, and a replaced or detached reference fails rather than resolving to something else. `browser_navigate` is different: the URL comes from the model, bounded only by the session's network policy, and the shared browser currently supports only trusted-host `Unrestricted` (see [Network policy](#network-policy)). There is deliberately no per-tool host allowlist: a URL check on the first request says nothing about where it redirects or what the page then loads. A host that needs navigation confined to known hosts must enforce that beneath the browser, at an egress proxy it operates.

## Network policy

`Unrestricted` is supported only when selected by trusted host policy. `ExactHosts` fails before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers. `PublicWeb` also fails before allocation because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

The generic guide's [Network policy](../browser/README.md#network-policy) section says why this package has no request-admission hook, and which boundary can enforce containment instead: a proxy the host operates, selected for the whole session at launch. A host that uses one still selects `Unrestricted` here, and the containment claim stays the host's own. The model-facing Tools take no admission policy. Host `admission` options decide whether an exact control may receive input; they do not establish redirect, subresource or connection-time network containment.

## Error translation

`host.toolFailures` includes the browser's current `status`, read from host memory when the
snapshot is requested. It is not historical state at the recorded failure: a `timeout/unknown`
entry may accompany an open, recovered owner or a subsequently closed owner. Status carries
phase, reason, generation, busy and unresolved-dispatch facts without becoming model output.
The browser's separate `diagnostics` keeps bounded policy/native records; typed callback causes
remain separate. All these snapshots remain readable after host closure.

The generic package's `BrowserError` carries a tagged `reason` and required `outcome`. The Tools return only `stale`, `busy`, `denied`, `not-found`, `ambiguous`, `not-visible`, `not-focused`, `limit`, `timeout`, `closed`, or `failed`, alongside the unchanged `undispatched`, `rejected`, or `unknown` outcome. An `Interrupted` navigation projects to `stale/unknown`; that does not authorize replay. Rate limiting projects to `busy`, with retry timing retained for the host. Provider status, diagnostic paths, limit measurements and native exceptions never enter this failure projection.

Read `host.toolFailures` for the original `_tag`, `operation`, tagged `reason` fields and `outcome`, plus the supplied tool-call ID. Each `ToolFailureDiagnostic` is recorded before projection; navigation start/completion, exact-node refusals and malformed typed results use the same channel. The `ToolFailureSnapshot` keeps the latest 32 entries in oldest-first order, with a `dropped` count for evictions. IDs longer than 256 UTF-16 code units are omitted with `toolCallIdOmitted: true`; an absent ID leaves that flag false. Snapshots and their recorded fields are copied and frozen. Reading them performs no browser work, takes no action permit, adds no callback services and remains possible after host closure.

```ts
const host = yield * BrowserTools.makeHost(browser);
const result = yield * host.run(agentProgram);
const diagnostics = yield * host.toolFailures;
// Keep diagnostics on the host; only result is part of the agent's declared output.
```

Ordinary failures do not complete `host.failure`. Consumer callback, browser fail-session and failed navigation-cleanup causes keep their existing supervision behavior. Direct module-level handler Layers retain caller-managed composition and do not create a diagnostic store. Framework parameter-validation and result-encoding failures outside the handlers belong to the Toolkit's own error contract.

The separate `InteractiveBrowser` adapter maps only factual `Limit` reasons for `actions`, `elapsed` and `returned-bytes`, with a positive integer maximum, to `InteractiveBrowserLimitError`. Other dimensions or an unsupported zero maximum retain a bounded action error. Its pinned contract has no dispatch-outcome field; the adapter neither adds one nor infers it from exception text. Concrete browser diagnostics remain on the original session.

This package exposes Effect AI Tools over a long-lived, execution-owned browser session supplied by Chromium or Browserbase. The pinned upstream browser guide describes its own interactive pass as a different, bounded construct and says it cannot become an agent Tool. The generic package's ownership and fencing model explains this extension; it should not be presented as upstream approval of it.

The common adapter and Tools support both self-managed Chromium and Browserbase. The Tools borrow the concrete browser directly, so Browserbase Live View, handoff, reference and remote cleanup or Chromium reference/process cleanup remain available to host code on that same object. `fromSession` retains the same concrete object beside its framework handle when an `InteractiveBrowser` integration is required. Provider capabilities are never added to the model-facing Tool schemas.

## Development and evidence

Use the frozen Vite+ workspace described in [Contributing](../../CONTRIBUTING.md). Both owners are exercised with the actual public AgentRuntime and Toolkit, using a scripted model and real Chromium. The `agent` installed consumer includes Chromium and the common Tools with no Browserbase installation. The `agent-hosted` consumer adds Browserbase and exercises provider acquisition/cleanup composition through scripted provider HTTP. They preserve typed callback errors, one session identity and capture after agent execution.

Native framework tests prove that the adapter Layer captures configured services while each acquired browser closes with its caller's Scope, even while the Layer remains alive. Tool regressions cover direct BrowserSession dispatch classification, exact-node pointer and keyboard input, host callback/fail-session supervision, host-scope cancellation, viewport policy and capture on the same owner. A local native pass is not hosted Browserbase or paid-model evidence.

## API migration

| Previous use                                                         | Current use                                                                                                                                                     |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `Adapter.fromSession(browser)`                                       | `yield* Adapter.fromSession(browser, { selection: "retained" })` preserves retained behavior; choose `"current"` deliberately for follow-selection.             |
| `AgentSession<E>` and `adapted.currentHandle`                        | `AdaptedSession<S>` retains exact `S`; run `fromSession` again to acquire a new handle.                                                                         |
| `BoundTarget`, `browser.bind()` and `browser.currentTarget`          | Use `TargetOperations` for common operations and `yield* browser.retain` for a checked `RetainedTarget`. Ordinary calls use the session directly.               |
| A string from `createPage`, passed to select/close                   | `createPage` returns `PageInfo`; `selectPage(page)` and `closePage(page)` check it. `selectPage` and `selectFrame` return `void`.                               |
| `error.reason === "limit"`, top-level `status` or `retryAfterMillis` | Match `error.reason._tag` or use Effect reason handlers. Producer facts live inside the reason; `outcome` is required.                                          |
| Full host reason names in model failures                             | Use the compact vocabulary above; read `host.toolFailures` for the original fields.                                                                             |
| Concrete `closeChecked` returning `void`                             | Concrete browser owners return their canonical cleanup receipt. The framework handle still returns `void`.                                                      |
| Capture `dropped`                                                    | Capture `discarded = overflow + late + duplicates + rejected`; default buffering stays unchanged. `toolFailures.dropped` separately counts diagnostic eviction. |

Common-operation helpers may accept `AnySession`; helpers such as the example's `turns<E>` that supervise browser failure stay generic in `E`. Binding bounds now have validated defaults, while explicit bounds retain their meaning. `NavigateRequest.timeoutMillis` is a host option and does not add a model-selected timeout to the existing URL-only navigation Tool. Added observation state is bounded and does not include field values or destinations. The earlier `Browser.scoped` inference fix changes explicit curried generic argument lists from five to four outer parameters and two to three inner parameters; ordinary call syntax remains.
