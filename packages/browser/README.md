# Browser automation for Effect

`effect-browser` owns one scoped browser runtime: bounded actions, exact observations, typed page-to-host bindings, live JPEG capture and explicit page holds. `effect-browser/chromium` launches or attaches to self-managed Chromium. [Browserbase](../browserbase/README.md) supplies the same runtime through its own hosted acquisition and cleanup.

This package has no Browserbase or Effect Agent dependency. Its common entry points do not load Chromium process-management code. Playwright is an optional peer loaded when a browser connects; install the pinned `playwright-core@1.63.0` to use that capability. The implementation targets trusted Node and Bun hosts. Data contracts being provider-independent do not imply browser-client or edge-runtime support.

## One owner and two ways to supply it

A `BrowserSession<E>` is the live, host-only capability returned by the supplying implementation. It preserves callback failures and diagnostics of type `E`, one action budget, one native connection and one set of capture/page-control reservations. `implementation` identifies the control implementation. `closeChecked` performs the owner's cleanup and fails if its required cleanup was not confirmed. On concrete Chromium and Browserbase sessions it returns that same frozen cleanup receipt on success; the generic session permits discarding that value. Helpers that only use operations take `AnySession`, an alias for `BrowserSession<unknown>`. Helpers that supervise callback failures must stay generic in `E` or the concrete session so they retain those failures.

All callers use this exact session. `Capture.start`, `Capture.stream` and `PageControl` authenticate its identity privately; spreading or decoding an object cannot copy authority. A session or binding absent from the receiving runtime's private registry fails with reason `UnregisteredSession` and outcome `undispatched`. A copy, fabricated value or separately loaded runtime can cause that refusal; it does not establish which occurred. A registered session with page control disabled still fails `Unsupported`. `Tools.run` from `effect-agent-browser/tools` uses the original session directly; `yield* Adapter.fromSession(session, { selection: "current" | "retained" })` adapts it to the framework's handle with an explicit target policy. Neither opens another browser.

Mutations are serialized. An observed node remains usable only until an invalidating event; a replaced node is never searched for again. A timed-out or interrupted mutation after dispatch has an unknown outcome and is never automatically replayed. Unresolved control fences the owner; a main-frame loading timeout can instead retire control through one acknowledged stop, as described below. `undispatched`, `rejected` and `unknown` remain distinct expected outcomes.

## Self-managed Chromium

`effect-browser/chromium` provides `Chromium`. It uses the same modeled browser owner, native driver, exact-node observations, bootstrap bindings, capture and page control as a hosted session. It requires no Browserbase client, project, key, allocation response or provider endpoint. `BrowserSession<E>` is their shared modeled capability; `BrowserbaseSession<E>` retains the separate provider reference, artifacts, Live View, handoff and release contracts.

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

const program = Browser.scoped(Chromium.launch(BrowserPolicy.unrestricted()), (browser) =>
  Effect.gen(function* () {
    yield* browser.navigate({ url: "https://example.com" });
    return yield* browser.observe({ scope: "viewport" });
  }),
).pipe(
  Effect.provide(
    Chromium.layer({
      viewport: { width: 1280, height: 720 },
      pageControl: true,
      launch: { headless: true, chromiumSandbox: true },
    }).pipe(Layer.provide(NodeServices.layer)),
  ),
);
```

The Layer requires Effect's `Crypto`, which the host platform supplies: `NodeServices.layer` here, `BunServices.layer` on Bun, or `NodeCrypto.layer` alone. Process references, connection ids, native binding names and handoff tokens are drawn from it. The Layer captures it once, so `launch`, `acquire` and `attach` never require it. Layer construction validates configuration and starts nothing. The optional `playwright-core` peer is loaded only when needed. `Chromium.acquire(policy, { bootstrap })` starts one owned Chromium process and registers cleanup before waiting for a connection; its cached `connect` yields one `ChromiumSession<E>`. `Chromium.launch` combines those steps. These static operations access the configured service, as do `Chromium.attach` and the corresponding `BrowserbaseBrowser` operations. Bootstrap consumer errors and services remain in the acquisition signatures.

`Browser.scoped(open, use)` is the common workflow supervisor for both sources, including borrowed attachment. It runs the acquisition once in its own scope, retains the concrete browser type in `use`, and races workflow completion against typed fail-session callbacks. The workflow has its own child scope: fibers and finalizers finish before `closeChecked` runs, so callback cleanup may still use a healthy browser. Checked closure runs on success, failure, thrown defects and cancellation. A body failure and a cleanup failure both remain in this workflow's own final Effect cause; neither is overwritten. An outer race or timeout can select another result and discard that losing cause even though cleanup ran. Configure the provider's `onCleanup` to record its receipt in a host-owned sink outside the raced workflow when cleanup evidence must survive that composition. A body that completes concurrently with a fail-session callback can still win the race; supervision does not establish failure priority. The ownership finalizer still runs if acquisition itself fails. No failed acquisition or action is replayed.

The same combinator supports `open.pipe(Browser.scoped(use))`, including a reusable `const use = Browser.scoped((browser) => browser.observe())` stored before choosing the provider. That unannotated callback sees common browser operations; use an annotated callback or the data-first form for provider-specific members or typed binding diagnostics. The returned function infers the supplying session's callback error independently of its acquisition error. Explicit generic applications must follow the curried overload's revised parameter lists: four outer parameters (`S, A, E2, R2`) and three returned parameters (`E, AE, AR`). It removes the scopes it owns while preserving other required services and error types. Returning a browser, stream or other live capability from `use` does not extend that resource's lifetime. The old provider-specific `withBrowser` methods and `BrowserRuntime.withBrowser` are replaced by this one public operation.

### A long-lived session in a Layer

An application can share one acquired session through a Layer for its finite application scope:

```ts
import { NodeServices } from "@effect/platform-node";
import { Context, Effect, Layer } from "effect";
import { Chromium, type ChromiumSession } from "effect-browser/chromium";
import { BrowserPolicy } from "effect-browser/browser-data";

class SharedBrowser extends Context.Service<SharedBrowser, ChromiumSession>()(
  "app/SharedBrowser",
) {}

const shared = Layer.effect(
  SharedBrowser,
  Chromium.launch(BrowserPolicy.unrestricted({ maxElapsedMillis: 300_000 })),
).pipe(
  Layer.provide(Chromium.layer({ onCleanup: recordReceipt })),
  Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const browser = yield* SharedBrowser;
  return yield* browser.observe({ scope: "viewport" });
}).pipe(Effect.provide(shared));
```

Here `recordReceipt` is the host's bounded receipt sink. Consumers of the same Layer build share
selection, budgets, native admission and lifetime; the Layer does not reset an expired session or
make concurrent operations independent. Its acquisition finalizer performs unchecked release and
stores the receipt. It does not supervise `browser.failure`, and does not turn incomplete cleanup
into a checked-close error for every consumer. The application must choose that supervision and
explicit checked closure, or use `Browser.scoped` for a bounded workflow that owns those decisions.
Calling `Browser.scoped` on the shared live session would close it for every consumer, so it is not
a per-request wrapper for this pattern.

### Receipts outside a race

An outer timeout may return `None` while discarding the losing workflow's checked-close error.
Place the receipt sink outside that race when those facts must remain observable:

```ts
let receipt: ChromiumCleanupResult | undefined;
const result =
  yield *
  Browser.scoped(Chromium.launch(policy), (browser) => browser.navigate({ url })).pipe(
    Effect.timeoutOption("30 seconds"),
    Effect.provide(
      Chromium.layer({
        onCleanup: (value) =>
          Effect.sync(() => {
            receipt = value;
          }),
      }),
    ),
  );
// result can be None; receipt still records the completed cleanup attempt's actual facts.
```

The sink above retains one host-only receipt; it is not durable storage. A direct path can return
`yield* browser.closeChecked` from the callback to obtain the concrete receipt, with typed failure
when the owner's required cleanup was unconfirmed. Repeated checked closure and scope finalization
reuse the same cleanup attempt. Body failure and direct or explicitly awaited interruption retain
checked-close errors in that workflow's own cause; a racing parent chooses which result survives.
The [complete compiled example](examples/shared-session.ts) shows all three compositions.

Cleanup notification is attempted once after canonical evidence has been stored. Callback
construction throws, defects, self-interruption and a two-second cooperative timeout are contained.
Browserbase's built-in diagnostic reporter and the optional `onCleanup` sink are contained
independently, so a broken reporter cannot suppress the sink. A failed sink does not confirm
cleanup, alter the stored receipt, or retry teardown. `cleanupResult` remains the canonical local
record. Notification timeout relies on cooperative interruption and cannot preempt synchronous
host code that never yields. Receipt storage, Context-writer settlement and `closeChecked` validation
are outside this optional-notification boundary.

Owned launch currently supports POSIX hosts (Linux and macOS). It uses a fresh temporary profile, an ephemeral loopback debugger port and one maintained CDP connection. The launcher owns those arguments; callers cannot replace them through `args`. `executablePath` selects an installed Chromium explicitly; otherwise the pinned Playwright executable is used. Headless mode and Chromium sandboxing default to enabled. `chromiumSandbox: false` is an explicit host exception, never inferred from `CI`, root execution or a connection failure. Setting the option alone does not prove the operating system's sandbox configuration. Startup waiting is bounded by `startupTimeoutMillis` (15 seconds by default, at most 60 seconds) and the owner's remaining lifetime. Acquisition does not retry a failed launch.

For an externally owned Chromium, use `browser.attach(endpoint, { policy, target?, bootstrap? })`. `endpoint` is a `Redacted<string>` containing the exact `ws://127.0.0.1:PORT/devtools/browser/ID` or IPv6-loopback equivalent advertised by that browser. HTTP discovery URLs, non-loopback hosts, credentials, queries and fragments are refused. This validates the control endpoint's shape; it does not authenticate the host running it. A supplied `target.targetId` must identify an existing page. Without one, several candidate pages are an explicit ambiguity error. Attachment preserves the existing viewport and does not replay the layer's launch arguments or create a replacement browser. Coordinate any independent controllers yourself, especially when enabling page control.

Chromium identity is `{ provider: "chromium", id }`, identifying this ownership lifetime. It is not a Browserbase session reference, a PID or an attachment credential. `close` and `cleanupResult` retain `connection` and `process` facts separately. Owned cleanup fences operations, stops capture, disposes initialization, disconnects and terminates its process group; only observed termination permits removing the temporary profile. Failure or timeout remains in `issues` and leaves `process: "unknown"` when exit was not established. Borrowed cleanup disconnects its own client and reports `process: "not-owned"`; it never terminates the external process. Repeated close calls share one result. No local result has a provider `remote: "confirmed"` field. `onCleanup` receives these bounded, host-only facts even when connection setup fails after launch.

`launch.proxy: { server, bypass? }` forwards an existing host-operated proxy to Chromium. With a proxy, the default bypass value is `<-loopback>` so Chromium does not silently exclude loopback destinations; a different bypass is an explicit host choice. Additional reviewed native flags, such as disabling QUIC and non-proxied WebRTC UDP, can be supplied through `launch.args`. This module does not implement a proxy or qualify its transport/DNS coverage. Browser policy remains `Unrestricted`; a local endpoint, URL admission or successful local test never establishes whole-browser egress containment. Preserve and test the selected enforcing proxy independently. The Browserbase integration validates its own provider-issued endpoints separately.

## Passive status and native diagnostics

```ts
const status = yield * session.status;
const diagnostics = yield * session.diagnostics;
// status: { phase, reason, generation, busy, unresolvedDispatch, actions: { used, maximum } }
// diagnostics: { records, total, dropped, truncated }
```

Both reads copy host memory, acquire no browser permit, charge no action and remain available
while busy, faulted or closed. A snapshot is not an admission token: the next operation still
checks its ticket. `phase` describes admission/lifecycle, not remote cleanup confirmation. Its
closed vocabulary includes `faulted` for a known terminal trigger, alongside `acquiring`, `open`,
`paused`, `detached`, `uncertain`, `closing` and `closed`; exhaustive host matches must include the
new case. `reason` retains the original terminal trigger through later cleanup. `busy` reports
active admission or pending policy cleanup. Action-count or host-read exhaustion leaves the owner
open and is not a terminal failure.

`actions` is the model-reachable allowance as the owner counts it: `maximum` is the policy's
`maxActions` and `used` the operations admitted against it, whether they then succeeded or not.
Every step of `fillForm` and its submit is an action, and so is each reading an agent Tool takes
after its action; a form's verification, `checkpoint`, `controlFacts` and `status` itself are not.
A refused operation is not counted, so `used` never passes `maximum`, and at `maximum` the next
action fails `Limit { dimension: "actions" }` undispatched while the owner stays open. A host that
runs one long session reads `used` instead of counting actions itself. `BrowserPolicy.maxActions`
accepts 1–1,000,000 (100 by default, like the host-read allowance's bound); a long session raises it
together with `maxElapsedMillis`.

`unresolvedDispatch` is separate from the trigger. Idle expiry records `expired` without inventing
an unknown dispatch. Expiry or a fail-session callback overlapping native work retains both the
known trigger and unresolved control. A fence or borrowed disconnection is not acknowledgement
that the browser stopped. Positive owned termination evidence can retire that control indication;
it does not reconcile earlier business effects or change their `unknown` outcomes. The concrete
cleanup receipt remains the authority for process termination or provider release confirmation.

Diagnostics retain the latest 32 records, oldest first, with a closed reason, disposition,
connection generation and host monotonic timestamp. Counters saturate at `Number.MAX_SAFE_INTEGER`;
`truncated` and `dropped` disclose eviction. Records contain no URL, title, message, native object
or consumer cause. Typed callback errors remain in `failure` and `bindingDiagnostics`.

Under popup-close policy, a popup beyond `maxPages` is quarantined and closed once. Its originating
click can finish, while new browser work is refused until cleanup is confirmed. Confirmed closure
preserves the original page's usability. The native cleanup pool is bounded at 32 operations;
the two-second acknowledgement deadline does not free an unresolved native promise's slot.
Lost acknowledgement fences control without replay; a late acknowledgement cannot reopen it.
Capacity refusal before dispatch is a known block rather than fabricated uncertainty. Dialog-cap
overflow follows the same bounded dismissal rules. An acknowledged before-unload dismissal can
retire only the exact navigation captured when its dialog arrived and subsequently rejected.
Existing popup/dialog pause policies still require their explicit host recovery path.

## Browser operations

### Selected, retained and pinned targets

The session itself is the convenient selected-target API. Its `navigate`, `readText`, `click`,
`fill`, pointer/key input and screenshot Effects resolve the selected page/frame when the Effect
actually executes. Constructing an Effect does not freeze the current selection:

```ts
const navigateScout = session.navigate({ url: scoutUrl });
yield * session.selectPage(scoutInfo);
yield * navigateScout; // navigates the scout selected above
```

`yield* session.retain` is the deliberate retained-selection form. Acquisition resolves and
validates selection under the owner's permit, then remembers its generation and selection revision.
Selecting another page or frame, including moving away and back, makes that handle fail
`Stale/undispatched`. The shared operation interface is `TargetOperations`; the session, retained
view and pinned view choose their target at different times. The old `bind()` and `currentTarget`
members have been removed; `session.target` remains a checked metadata read.

| Previous API                                                        | Current API                                                                                       |
| ------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `bind()` / `currentTarget`, `BoundTarget`                           | `retain`, `RetainedTarget` and shared `TargetOperations`; direct operations remain on the session |
| `selectPage(id)` / `closePage(id)`, string returned by `createPage` | Checked `PageInfo` in and out; `selectPage` and `selectFrame` return `void`                       |
| String `BrowserError.reason`, optional outcome                      | Tagged reason, `catchReason`/`catchReasons`, and required dispatch outcome                        |
| Concrete `closeChecked` returns `undefined`                         | The canonical frozen receipt after the existing ownership check passes                            |
| Capture `dropped`                                                   | `discarded` and disjoint `overflow`, `late`, `duplicates`, `rejected`                             |
| Default-never `BrowserSession` on a non-supervising helper          | `AnySession`; supervisors preserve their actual `E` or concrete session                           |

The [root migration table](../../README.md#api-migration) also covers the adapter's required
selection option, compact tool reasons/host diagnostics, binding defaults, common navigation
deadline, optional control state and the explicit C1 generic-arity edge.

`createPage` returns `PageInfo` for the exact created entry and does not select it. Both
`selectPage(pageInfo)` and `closePage(pageInfo)` verify its local and native identities under
owner admission. Page/frame selection returns `void`; request `retain` separately when a retained
sequence is intended. Failed metadata acquisition after creation keeps the creation's dispatch
evidence and never creates a second page.

For work that must stay on a page while selection moves elsewhere, pin it explicitly:

```ts
const stageInfo = (yield * session.pages).find((page) => page.title === "Stage")!;
const stage = yield * session.pinPage(stageInfo);
const childInfo = (yield * session.framesOf(stageInfo)).find(
  (frame) => frame.parentFrameId !== null,
)!;
const child = yield * session.pinFrame(stageInfo, childInfo);

yield * session.selectPage(scoutInfo);
yield * stage.click({ selector: "#advance" });
const childText = yield * child.readText({ selector: "#status" });
```

Pinning never changes global selection and opens no second browser connection. A pinned handle
contains only modeled operations plus its immutable `Target`; every operation re-resolves the
connection-local page/frame identity through the same owner. Reconnect makes the old generation
stale, closing its page or detaching its frame makes it unusable, and an in-flight navigation
reservation or page hold is checked on the pinned page rather than whichever page happens to be
selected.

Page and frame IDs are opaque and namespaced per connection. Old `PageInfo`, IDs and live handles
are invalid after reconnect. In the same known browser lifetime, read fresh `pages`, match exactly
one saved `targetId`, and use that fresh page record; zero matches means gone and multiple matches
mean ambiguous. Never fall back to order, local serial, URL or title. Then reacquire frames with
`framesOf(freshPage)`. A surviving native target can identify the same page, but cannot make old
local metadata or handles current again.

Pinned operations are selector-based. They intentionally do not create another retained
`Observation` or an exact-node namespace. There is still one observation: a new `observe` replaces
it. A pinned read or mutation on another page leaves that observation intact, as does selecting
away and back without observing another document. Exact-node work refuses `Stale/undispatched`
while another page or frame is selected; it never redirects the reference to that selection.
Returning to the original page/frame can use the original reference only if its document and
exact control are still valid. This does not revive a retained-selection handle: `retain` still
becomes stale after every selection change, including away and back.

Dispatched input on the observation's own page still retires its references, including `hover`,
`pointerMove`, `wheel` and `scroll`. Hover then click therefore deliberately needs a new inspection.
Page scripts can replace nodes or change relevant state in response to any input; no verb is
assumed harmless. Navigation or closure on that page and reconnect also retire its observation,
even while another page is selected. IDs are opaque and connection-specific; consume the actual
inspection result rather than predicting serials. Attachment, identity and fresh-state checks at
dispatch remain necessary even when the last input targeted a different page.

The complete [multi-page example](examples/multi-page.ts) keeps a presentation page pinned while
the selected scout supplies observations. It reads and captures the presentation page without
switching selection and returns only data after the shared browser scope closes.

### Typed host failures

`BrowserError` keeps its operation and a required `outcome` (`undispatched`, `rejected`, or
`unknown`), while `reason` is a tagged union. Recover by reason without parsing strings:

```ts
const read = session
  .readText({})
  .pipe(Effect.catchReason("BrowserError", "Busy", () => Effect.succeed({ text: "" })));
```

`Limit` includes measured `dimension`, `maximum` and `observed` fields. For example, an action
allowance exhausted at two reports `maximum: 2, observed: 2`; it does not count a third call that
was never admitted. `Configuration` and `Malformed` may name a declared schema-field prefix,
never a supplied value or unknown property name. `Provider`/`Transport` may carry `status` and
`RateLimited` may carry `retryAfterMillis`; those fields no longer sit on the outer error.
`InitializationError` and the provider's separate resource-error families retain their own
contracts. The Agent tools project host errors to their compact eleven-reason vocabulary and
retain the originals in the bounded, host-only `ToolHost.toolFailures` snapshot.

### A navigation you can watch while it loads

`navigate` holds nothing open that you can see into: it returns when the document reaches DOMContentLoaded. `startNavigation` is the same single dispatch, left in flight, so a recorder can look at a page while it is still arriving, hold it, and let it finish:

Both accept optional `timeoutMillis` from 1 to 600000, capped by the remaining session lifetime.
Omitting it uses the configured action timeout. Direct, retained and pinned calls share the
same navigator; the maintained model `browser_navigate` tool still accepts only its upstream URL
request. This field is the loading deadline, not a promise of rollback on timeout. On a main-frame
timeout from the pinned engine, up to 3000 ms of recovery may follow that deadline. One absolute
recovery deadline includes owner-permit waiting, native setup and acknowledgement, and is capped
by the remaining session lifetime. It is never renewed and cannot extend that lifetime.

```ts
const operation =
  yield * handle.startNavigation(StartNavigationRequest.make({ url, timeoutMillis: 30_000 }));

const early = yield * session.checkpoint({ picture: true }); // what has loaded so far
const receipt = yield * PageControl.suspend(session, page); // timers, CSS and parsing stop
yield * PageControl.resume(session, receipt);
const { url: loaded } = yield * operation.completed;
```

The owner's permit is released as soon as the navigation is dispatched. While it loads, reads, checkpoints, holds and every other page proceed, and anything that would change _this_ page fails `busy` and `undispatched`. `navigate` runs on the same machinery, so there is one navigator.

- `completed` belongs to that one navigation: a successor reaching the same URL fails it instead of completing it, and its URL is the page that navigated, not whichever page is selected by then. **Interrupting a waiter stops nothing.** The browser keeps loading and nothing is dispatched again.
- `stop` asks the browser to stop loading. Its acknowledgement is a known outcome: `completed` then fails `interrupted`, the page holds whatever had loaded, and the session stays usable. It does not undo anything the page already did. Concurrent callers share their active stop attempt. A busy refusal or cancellation before dispatch allows a later request only after native setup and its port retire; pending or unconfirmed retirement keeps setup capacity occupied. Once a stop is dispatched, every later caller receives that attempt's recorded result, including failure or interruption, without sending it again. A completed navigation cannot stop its successor.
- A main-frame loading timeout asks the same stop coordinator to retire that exact navigation. Acknowledged stop completes it with `Timeout/unknown` and leaves the owner open: partial content remains inspectable and deliberate subsequent input is allowed. An explicit stop racing recovery shares its attempt; a completed predecessor cannot stop a successor. The `unknown` outcome still says nothing about page effects before cancellation.
- A failed or unacknowledged recovery, replacement navigation, detached frame or other native rejection keeps the conservative fence. Pinned child-frame timeout also fences: `Page.stopLoading` acts on the whole page, so automatic frame-local cancellation is not claimed. Explicit stop retains its page-wide meaning.
- Leaving the operation's scope unsettled fences it as unknown. Neither navigation nor a dispatched stop is replayed, and no timeout or acknowledgement promises rollback, an unchanged DOM, or termination of every page timer or worker.

A read is ordered against the document being replaced by failing: if the document it was reading was replaced underneath it, or a navigation is still in flight on its page, the error is `target-changed` and `undispatched`, which means read again. A read is never a mutation, so that is always safe. A held page is not read at all; take the checkpoint before the hold and keep it.

Locally, a hold during an incremental response stops parsing as well as timers: a chunk the server sends meanwhile is not parsed until resume. That is an observation of the pinned Chromium, not a guarantee about hosted sessions.

### What is on screen, and what a host may know about it

`session.observe()` reads the whole document. `session.observe({ scope: "viewport" })` keeps only text and controls that are on screen and reachable, and says what it left out:

```ts
const seen = yield * session.observe({ scope: "viewport" });
seen.viewport; // { clippedText, coveredText, uncertainText, unreachableControls, exhausted, ... }
```

Visibility here is geometry and hit-testing, never a pixel comparison, and the counts say which was which. Text is kept when its line boxes intersect the viewport and the browser finds its own element at a sampled point. A text node that crosses the viewport edge contributes only its lines on screen (`clippedText`). Text behind another element is left out (`coveredText`). Something that takes no pointer events is invisible to that hit test, so for a point beneath one the browser is asked, on the existing connection, which box is on top with pointer events ignored; that also finds boxes inside closed shadow roots. A box that paints at the point, with a fill, border, shadow, filter, image, canvas, SVG, text or a generated `::before`/`::after`, covers the text (`coveredText`); an empty transparent container over the whole page hides nothing. Text the browser could not settle, for example beneath a second such box, in a child frame, or past 256 such points in one reading, is left out as `uncertainText` rather than called visible. `exhausted` means the traversal budget ran out first and the reading is known to be incomplete. Canvas pixels and compositing effects are not interpreted.

`match` narrows a reading, in either scope, to what contains a piece of text, ignoring case: text lines, and controls whose label contains it. A select is kept when its own label or any of its option labels matches, with its options beside it. The filter runs inside the page before `maxControls` and `maxTextBytes` are spent, so twenty header links cannot crowd out the one control asked for:

```ts
const found = yield * session.observe({ scope: "document", match: "create account" });
found.match; // "create account"
```

It filters what is read and never searches for, re-finds or substitutes a node: references still come from the reading itself, with every exact-node check. What a matched reading leaves out is not evidence of absence, which is why it names its `match`.

An `Observation` is safe to show a model, and the adapter's `browser_inspect` Tool returns it as is. It therefore carries no destination, form target or field value, in either scope. What a host needs to decide whether a control may be acted on is a separate, host-only read from the exact node:

Controls also carry optional `checked`, `selected`, `inputType` and `required`. Native checkbox
and radio state comes from the element; applicable ARIA state accepts only explicit true/false.
Mixed, unknown or invalid values are omitted, not converted to false. Selection describes an
option or selectable control, never an invented state for an entire `<select>`. Required state
is emitted only for applicable native inputs or reviewed ARIA roles. State that can change an
input decision participates in the exact-node fresh-facts check; field values and destinations
remain excluded from the model projection.

```ts
const facts = yield * session.controlFacts(reference);
// kind, label, disabled, editable, inputType, autocomplete, formMethod, box, placement, hitTest
// destination: the resolved link target, or where this control submits its form
```

`destination` is resolved by the browser against the document's base URL, and honours a `formaction` override. It can carry a token, which is why it is not in an `Observation`. An over-long destination is left out, never cut. No value and no markup is ever included.

A reference is to the control that was inspected, not merely to a node. If the same attached node now has a different destination, input type, autocomplete category, form method, label or disabled state, acting on it fails `stale` and `undispatched`, exactly as it does for a replaced or detached node. Nothing is ever re-found by selector or label.

When a decision has to be current at dispatch, pass a policy. It is evaluated on facts read from that exact node immediately before the input:

```ts
yield *
  session.fillElement(reference, value, {
    admit: (facts) => facts.inputType !== "password" && facts.autocomplete !== "cc-number",
  });
```

Anything but `true`, or a policy that throws, sends nothing and fails `denied`. The policy is a plain synchronous function on purpose: it runs while the owner's permit is held, where waiting on a model or a network call would stall every other operation. It is not an atomic check-and-input transaction, because page script can still run before the native input lands.

`fillElement` also refuses, undispatched, what the maintained engine would otherwise refuse only after dispatch, where the unknown outcome would fence the owner: a hidden control (`not-visible`), a disabled one (`disabled`), one that is not an editable input, textarea or content-editable element, and text that a `number`, `date`, `time`, `range` or other value-typed input would not keep (`unsupported`). The value is checked on a detached copy with the same constraints; the page's own control is not touched until the fill is sent.

### Exact native option selection

`selectOption(reference, options, admission?)` selects once on the native `<select>` named by
an `ObservedElement`. The options are a nonempty array of at most 64 unique option `elementId`s
from the same observation. No label, value or selector is a substitute for an issued ID.

An observed native select has `multiple` and `optionsTruncated` metadata. Its retained option
controls carry `selectElementId`, `selected`, `disabled` and a bounded label. Choices of a visible
select are available in viewport observations even when its menu is collapsed; they consume the
same `maxControls` allowance as other controls. Truncation is explicit, and an option outside the
retained set cannot be selected by guessing its position or value.

The private value comparison is bounded to 65,536 UTF-16 units per option. A longer value is not
issued for selection: its legacy control state may remain visible, but `selectElementId` is
absent and the parent reports `optionsTruncated`. After a page hold, revalidate the select and
each requested option through `revalidateElement`; revalidating only the select does not approve
its option nodes.

The owner validates the same select and option nodes, document, current membership, multiple and
enabled state before dispatch. It also compares the submitted value privately without returning
that value in the observation or action result. Duplicate labels remain distinguishable through
their IDs. Changed or replaced controls are refused before input; unknown outcomes after dispatch
are never replayed. Selection emits ordinary native select input/change events through the
maintained engine, returns `ActionResult` and retires the observation on that page. It does not
claim the website finished work triggered by those events. The same synchronous host `admission`
used for exact-node input applies to the selected control.

### Filling a form in one operation

`fillForm(request, admission?, options?)` sets several controls of one observation, in order, then optionally clicks one submit control:

```ts
const result =
  yield *
  session.fillForm({
    observationId: seen.observationId,
    fields: [
      { elementId: email, value: "ada@example.test" },
      { elementId: terms, checked: true },
      { elementId: plan, options: [pro] },
    ],
    submit: create,
  });
// Dispatched toggle fields and the optional submit also carry bounded input receipts.
```

Each field gives exactly one of `value`, text that replaces the contents of an input, textarea or content-editable element; `checked`, the state a checkbox, radio or switch should end in, clicked only when it differs, and a native radio is never asked to clear itself; or `options`, issued option IDs of a native select exactly as for `selectOption`. A form has at most 32 fields, each control at most once, and its submit control is not also one of its fields.

Every step is its own admitted and charged action on the exact observed node, after the same fresh checks as `fillElement`, `selectOption` and `clickElement`, including the host's `admission` policy. One difference is deliberate: a control may have become enabled since it was observed, such as a submit button a form enables once it is complete, but it must be enabled when its step runs. The observation stays usable for this form's own steps only. Navigation, a page hold or any other caller's action still retires it, and the form retires it when it ends.

After each dispatched step, the page's own handlers get at least two rendered frames and `settleMillis` (50 by default, at most 5000, 0 to skip). A text field is then left, as a person moving on would leave it, so formatting a page applies on blur belongs to that step. Before submit, `verify` (true by default) reads every field again and stops the form when one no longer holds what its own step left there: a re-render, an asynchronous reset, anything that changed a field after it was set. What was read is compared on the host and never returned.

The first refused or uncertain step ends the form, and nothing after it is sent. A form is not a transaction: fields set before the stop stay set, and `stopped` says where it ended (`field`, `verify` or `submit`) and why, as a `BrowserError` whose outcome says whether that step itself was dispatched. A toggle the page would not change stops with `failed` and `rejected`. `submitted` is true only when the submit click completed. The operation fails outright only when its first step does, exactly as that single action would.

### Bounded waits that leave room for recording

`waitFor({ selector, state })` still supports the host's bounded selector conditions: `visible`,
`hidden`, `attached` and `detached`. It captures the selected page, frame and document when admitted.
`waitForElement({ reference, state, timeoutMillis? })` instead waits on an exact node issued by the
current observation, with `visible`, `hidden`, `enabled` or `disabled`. It never searches for a node
that replaced the reference. Hidden includes detachment of the original node; for the other
conditions detachment fails `Stale/undispatched`. Replacing the document or frame fails even a
hidden wait. A node's changed enabled/visible state is what the wait observes, not fresh input
authorization: inspect again before acting on changed control state.

Wait admission briefly holds the existing permit, checks readiness and page holds, and charges
one model-reachable action. The pending wait then owns its own cancellation signal, connection
generation and absolute deadline. An exact-node request may shorten the deadline to 1–60,000 ms;
the configured action timeout and remaining lifetime still cap it, including setup. Selection
can move elsewhere without retargeting the wait. Its condition is a sample, not a reservation
that the page will remain unchanged.

While a wait is pending, `checkpoint`, `pages` and ordinary bounded reads can use the normal
permit. Mutations, another navigation and page holds on the waited page are refused before
dispatch. Input on another page may proceed; replacing the single observation is refused until
the logical wait ends. Closing a page or session remains available and cancels affected waits.
No general read-under-write bypass has been added.

One native wait may be outstanding per browser session. Cancellation and timeout release the
logical barrier without inventing an uncertain mutation, but retain native capacity until the
actual native promise and any required handle disposal settle, or that exact connection retires.
Consequently another wait can still receive `Busy/undispatched` after its predecessor's caller
has stopped waiting. Status `busy` includes that retained native capacity; it does not mean every
ordinary operation is blocked. A cancelled exact-node wait keeps only its leased node alive when
the observation is replaced, and its late cleanup cannot dispose a successor's references.

### Passive checkpoints for a recorder

`observe()` replaces the one observation whose nodes later actions may name, so a recorder calling it would retire the references an agent is about to use. `session.checkpoint()` is the passive path: viewport text, control facts and, when asked, a PNG of the viewport.

```ts
const checkpoint = yield * session.checkpoint({ picture: true });
```

It issues no references, is not a mutation, and leaves the action observation and the selection exactly as they were, so inspect, checkpoint, then act on the inspected node all compose. It is host-only, because it carries control facts. Text and picture are read one after the other, never atomically: the interval is on the host monotonic clock, and `documentChanged` says the document was replaced in between. A held page is refused `busy` rather than woken to be read: take the checkpoint before the hold and keep it.

`checkpoint` and `controlFacts` each consume one separate host-read allowance, configured by
`Chromium.layer({ maxHostReads })` or the corresponding provider Layer. The default is 10,000,
with an explicit integer bound of 1–1,000,000; invalid values are refused rather than clamped.
Exhaustion reports `Limit { dimension: "host-reads", maximum, observed } / undispatched` while the
owner stays open. These operations still obey the same lifetime, bytes, deadline and fail-fast
concurrency bounds: a checkpoint can execute page script and is not unlimited free work.
`observe`, `readText`, `screenshot` and `waitFor` continue consuming the model-reachable action
allowance, which `status.actions` reports. Neither budget is a tool parameter, and `maxActions`
has not become mutations-only.

### Real pointer and wheel input

`pointerMove`, `hover` and `wheel` send the input a person's hardware would, so pages see trusted events, `:hover` applies, and the browser itself decides what is under the pointer. `scroll` stays what it was: script in the page, instantaneous, raising no wheel event. That difference is how a recording tells one from the other.

```ts
const handle = session; // ordinary selected-page operations

yield * handle.pointerMove(PointerMoveRequest.make({ to: { x: 140, y: 100 } }));
yield * handle.hover(HoverRequest.make({ selector: "#menu" }));
// A nested scroll container under the pointer scrolls, not the page.
const receipt =
  yield * handle.wheel(WheelRequest.make({ deltaX: 0, deltaY: 240, at: { x: 420, y: 120 } }));
```

Coordinates are CSS pixels in the main frame's viewport. Each call is one native command, charged as one action and fenced like any other mutation, so a handle bound to a page that is no longer selected sends nothing to either page. Easing, pacing and cursor artwork are yours: send the points you want, and draw the cursor from the positions the receipts report.

`hover` places the pointer on one exact element where it is, by selector or by the node an observation named (`session.hoverElement`). It never scrolls to reach it, because that would hide a scripted scroll inside a native-input operation. If the pointer cannot be placed on the element (it is outside the viewport, has no area, or something covers it) the call fails `not-visible` and `undispatched`.

For a child-frame element, hover checks the commanded point through each ancestor
frame and then the exact node, including cross-origin documents. The receipt
still uses main-viewport CSS coordinates. An overlay or clipping ancestor refuses
input. Frame traversal is bounded at 32 levels, with bounded shadow/DOM ancestry
checks. Axis-aligned translation and positive scaling are supported; rotation,
perspective and other unsupported frame mappings are refused rather than guessed.
These reads and native input are separate operations in the browser: page script
can still change geometry between validation and dispatch.

An `InputReceipt` carries the target it was sent to, the position this owner commanded, and an interval on the same host monotonic clock that stamps `CapturedFrame.receivedMonotonicNanos`. Pointer moves, hovers and positioned wheels report their known point. A Playwright-managed click reports `position: null`: Playwright does not expose its chosen click point through the supported API, so the receipt does not guess. The click still uses Playwright's exact-node checks and native hit testing. Its unknown point invalidates the owner's remembered pointer position, so later key receipts also report `null` until a known pointer command places it again. The click interval brackets the supported Playwright call and may include actionability or navigation waits; Playwright does not expose the exact native dispatch instant. Input and pixels share one timeline, so a compositor can place known points on frames that show them. A wheel or click receipt does not claim the page finished work triggered by the input or that any frame shows it.

### Real key input

`fill` sets a field's value in one step: the page gets an `input` event and no `keydown`, `keypress` or `keyup`, so anything that reacts to keys behaves differently under a recorder than it does for a person. `press` and `type` send the strokes a keyboard would. Handlers see trusted key events, and the browser does what it does for a person: Tab moves focus and selects the field it lands in, Enter submits a form that has a submit button, and Backspace edits.

```ts
const handle = session; // ordinary selected-page operations

// Focus is the page's business. A real click gives it, and keys then follow it.
yield * handle.click(ClickRequest.make({ selector: "#from" }));
yield * handle.type(TypeRequest.make({ text: "Vienna" }));
yield * handle.press(PressRequest.make({ key: "Backspace" }));
yield * handle.press(PressRequest.make({ key: "k", modifiers: ["Control"] }));
// Sent only if `#from` still has focus; otherwise nothing is sent at all.
yield * handle.press(PressRequest.make({ key: "Enter", into: "#from" }));
```

Keys go to whatever has focus in the selected page, in whichever frame that is, because that is where the browser sends them. `into` narrows that to one exact element, which must already have focus or hold the element that does, through any open shadow root. If it does not, the call fails `not-focused` and `undispatched`. It never focuses the element for you, for the reason `hover` never scrolls: that would hide a scripted focus inside a native-input operation. `session.pressElement` and `session.typeElement` apply the same rule to the node an observation named and take the same host admission as `fillElement`, so switching from `fill` to real typing gives up neither exactness nor the check on fresh control facts.

A key is spelled as the `KeyboardEvent.key` the page will see, and the vocabulary is closed: `Enter`, `Tab`, `Backspace`, `Delete`, `Escape`, the four arrows, `Home`, `End`, `PageUp`, `PageDown`, or one printable ASCII character (a space is `" "`), with `Shift`, `Control`, `Alt` and `Meta` as modifiers. The native engine parses a key string, chords included, and begins holding the modifiers before it has validated the key, so nothing reaches it that was not reviewed here. A modifier other than Shift makes a chord rather than a character, and nothing is typed.

`type` sends up to 256 characters as one charged action, two native commands for each, one after another under a single action timeout. On a slow link a long passage can outlast that timeout, which leaves an unknown outcome and fences the session like any interrupted mutation, so send it as several shorter runs. The owner is checked between characters, which means a fence stops the rest instead of typing into a session that is closing. Two limits come from the pinned engine. A character the US layout cannot produce is committed as text, the way an input method commits it: the field changes and no key event says so. And a shifted character arrives as its own key with `shiftKey` false. When a page reads the modifier, send that stroke through `press` with `Shift` held, spelling the key as the page will see it: `{ key: "A", modifiers: ["Shift"] }`. Spelled `"a"`, the engine sends `a` with Shift down, which is what Shift produces with Caps Lock on. Control characters are refused in text because the engine presses Enter for a line break; a named key is always its own `press`. Pacing is yours, as easing is for the pointer: for a typist's cadence, send one character per call and sleep between them, at one action each.

A press is dispatched, not awaited. If Enter submits a form, wait for what the next document shows with `waitFor`. A receipt carries the same target, pointer position and interval as any other input, and never says which key was pressed or what was typed. Typing a secret is still more observable than one `fill`, because the page sees every stroke; prefer `fill` for one unless the page requires keys. Neither operation is part of the model-facing toolkit in `effect-agent-browser`.

The connection endpoint is read through the exact allocated session, so a provider reply that names a different session is refused before any CDP attachment.

Persistent Browserbase contexts require a live writer permit from `ContextCoordination.withWriter` when writes are persisted. Detach/reconnect is opt-in with `keepAlive`; reconnect creates a new handle generation, verifies the selected target, obtains fresh state, and never replays pending input or treats serialized agent state as a live browser.

Human handoff pauses automation before returning host-only Live View material. Resume requires an explicit operator-release signal and obtains a fresh observation while holding the same mutation permit. A failed handoff does not silently resume automation. Live View URLs are temporary bearer material; iframe styling is not an authorization boundary. Live View is also where browser-window presentation already exists for watching a session as it runs, and it is the provider's: beside each full-screen URL Browserbase issues a bordered one (`debuggerUrl`, "mimic a real browser with borders"), and a navbar that `navbar=false` hides. This package decodes and returns only the full-screen URL. The bordered one carries the same control authority and would be issued under the same rules, so surfacing it is a small host-only addition whenever something needs it; nothing here does yet, so it is not exported.

## Registrations, capabilities and document readiness

`browser.launch(policy, { bootstrap })`, `browser.acquire(policy, { bootstrap })` and `browser.attach(endpoint, { policy, bootstrap })` take a trusted registration plan at acquisition. The browser Layer fixes launch configuration; consumer callback dependencies are captured at acquisition. A plan is built from `Bootstrap.binding`, `Bootstrap.init`, `Bootstrap.permissions` and `Bootstrap.combine`. Combination preserves the error and service unions of different handlers; the callable bridge precedes all dependent init steps in one native script registration. Script content, handler implementations and origin grants are host configuration, never model output or page input.

```ts
import * as Bootstrap from "effect-browser/bootstrap";
import * as Browser from "effect-browser/browser";
import { Chromium } from "effect-browser/chromium";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Context, Effect, Schema } from "effect";

class ShowSettings extends Context.Service<ShowSettings, { readonly title: string }>()(
  "ShowSettings",
) {}

const bootstrap = Bootstrap.combine(
  Bootstrap.permissions({ origin: "https://portal.example.com", permissions: ["clipboard-read"] }),
  Bootstrap.binding({
    name: "getShowSettings",
    origins: ["https://portal.example.com"],
    input: Schema.Struct({ version: Schema.Literal(3) }),
    output: Schema.Struct({ title: Schema.String }),
    maxConcurrent: 2,
    maxInputBytes: 256,
    maxOutputBytes: 4096,
    timeoutMillis: 2000,
    failureMode: "fail-session",
    handle: () => Effect.map(ShowSettings, (settings) => ({ title: settings.title })),
  }),
  Bootstrap.init({
    id: "show-settings-v3",
    origins: ["https://portal.example.com"],
    content: "globalThis.__ready = globalThis.getShowSettings({ version: 3 }).then(() => true);",
    readiness: {
      expression: "globalThis.__ready",
      timeoutMillis: 5_000,
      existingDocuments: "RequireFreshNavigation",
    },
  }),
);

const run = Browser.scoped(
  Chromium.launch(BrowserPolicy.unrestricted(), { bootstrap }),
  (session) =>
    Effect.gen(function* () {
      yield* session.navigate({ url: "https://portal.example.com" });
      yield* session.ready;
      return yield* session.observe();
    }),
);
// run requires Chromium and ShowSettings. Browser.scoped discharges both the
// callback's and the use function's Scope, but neither one's other services or errors.
```

Registration is installed before this connection creates any document, and permissions precede the bundle. It is still not readiness: an asynchronous step cannot pause a website's own scripts, so a document is ready only when its expression resolves to exactly `true`. Readiness is keyed by frame and document epoch and evaluated once per document, so a completed wait can never ready the document that replaced the one it observed.

Each binding accepts exactly one JSON-compatible argument and returns the output codec's **encoded** JSON value. A transforming codec such as `Schema.FiniteFromString` therefore exposes a string to the page while its host handler works with a number. The native callback validates the actual caller's allowed origin and document before input decoding, immediately before invoking the handler, and before replying. This uses Chromium's execution-context identity and `uniqueContextId` on child CDP sessions belonging to the existing connection: a frame URL, a page-supplied origin, and a reused numeric context id are not authorization. The pinned Playwright `exposeBinding` callback supplies a frame but not the calling document's identity; it is deliberately not used as a weaker substitute. No raw protocol or second browser owner is exposed.

Plans admit at most 16 uniquely named bindings. Omitted binding options default to `maxConcurrent: 1`, `maxInputBytes: 65536`, `maxOutputBytes: 65536`, `timeoutMillis: 10000` and `failureMode: "reject-call"`. Name, exact origins, codecs and handler remain required. Explicit bounds/mode pass the same validated registration path; zero, null or excessive values are rejected, never clamped. `combine` selects the most conservative `existingDocuments` policy across its scripts, even when their origin sets differ. Admission reserves capacity before native validation, codec work or a callback fiber starts; a timed-out native operation retains that reservation until it actually settles, including across reconnect. The page wrapper additionally rejects cyclic, sparse, accessor-bearing, non-plain, non-finite and non-JSON input rather than silently changing it through `JSON.stringify`. Its traversal admits at most 64 levels and 65,536 nodes; the configured byte limit still applies. Native target and default-document registries are finite, and closed native targets retire their authority immediately.

`reject-call` rejects only the affected invocation and permits subsequent healthy calls. `fail-session` completes `session.failure` with the original typed consumer cause and fences the owner. Pages receive only `BrowserBindingError: Browser binding call rejected`, with no host stack, consumer error payload, credentials or SDK cause. `session.bindingDiagnostics` is a bounded **host-only** snapshot containing per-binding accounting and the latest 32 typed causes; do not serialize it into a Tool response. Callback service reads run independently of a browser mutation, but reentrant browser work never waits behind that mutation's permit: it fails `busy` with `undispatched` instead.

`Browser.scoped` supervises fail-session errors and requires the owner's checked cleanup. Explicit `acquire`/`launch` retain the typed failure signal and detailed cleanup receipt for callers that need to manage that decision themselves. Teardown synchronously closes callback admission, interrupts managed callback fibers, removes this connection's registrations, disconnects locally, and still invokes the supplying lifetime’s release when a prior cleanup step fails. Reconnect installs fresh callable registrations, never replays an old invocation or a consumer init script into an already-running document, and cannot reuse quarantined callback capacity.

Operations that depend on an initialized document wait for the current one. Navigation, selection and page management do not, so initialization cannot deadlock the navigation that produces the document it is waiting for. A document that was already running when the bundle was registered — the page you attach to, or the one a reconnect finds — never ran it: `RequireFreshNavigation` reports `RequiresNavigation` and refuses dependent work, while `AcceptAlreadyRunning` verifies the requirement against that document instead of assuming it. Neither reloads a page whose work may be uncertain; that stays your decision. `session.ready` reports the current document without charging an action, and an origin outside the plan is reported as `NotApplicable` rather than waited on.

The reviewed permission subset is exercised against real Chromium. Provider extensions, persistent contexts and provider reconnect evidence belong to the supplying integration; see the [Browserbase guide](../browserbase/README.md).

## Live capture and presentation

For a frame-processing pipeline, use `Capture.stream(session, options)`. It starts only when consumed and owns one interval per subscription. `Stream.take`, consumer failure and interruption all finish that interval before the stream completes, while the enclosing browser stays open. A new subscription creates a new interval; concurrent subscriptions on the same page still fail `busy` under the existing reservation. Capture bounds and native-stop quarantine rules are unchanged.

```ts
import { Stream } from "effect";
import * as Capture from "effect-browser/capture";

const firstFrame = Capture.stream(session, { lifetime: "page" }).pipe(
  Stream.take(1),
  Stream.runCollect,
);
```

Use `Capture.start` instead when the host needs passive snapshots, an explicit stop acknowledgement or the final loss summary. Stream completion runs cleanup but does not itself assert that Chromium acknowledged the stop; unconfirmed cleanup keeps the page quarantined. Both APIs use the same bounded frame stream and owner.

Live capture frames carry owned JPEG bytes, captured target identity, sequence number, source presentation time, host monotonic receipt time, geometry and explicit drop accounting. Buffers are bounded by frame count and bytes; slow consumers drop old frames instead of creating an unbounded fiber/callback backlog. Buffer dropping is not page-clock backpressure and does not reduce what the browser produced upstream. Holding a capture callback is not a promise that page timers or animations stop.

`sourceTimeMillis` is the browser's wall clock when it took the frame for the screencast, stamped before the frame is encoded. Chromium encodes up to three frames at once and emits each when its encode completes, so two frames stamped close together can arrive in either order. A frame that arrives behind a newer one can no longer be presented in order: it is discarded and counted in `late`. It is never sorted back in or given another time, so delivered source times strictly increase and a gap in `sequence` marks the omission. Concurrent encoding can put at most two late frames in a row. A longer run means source time itself went backwards, and the interval ends with `Timestamp` error evidence.

The migration equation is **`discarded = overflow + late + duplicates + rejected`**. The four
components are mutually exclusive: `overflow` is buffer eviction, `late` is out-of-order input,
`duplicates` is repeated source time, and `rejected` contains other refused or undelivered frames.
The old `dropped` field is removed, not redefined as overflow. A late frame was omitted from
delivery; that fact does not prove network loss. The same counters appear in live snapshots,
and `upstreamDrops` remains `"unknown"`. The default frame capacity remains four.

### Watching live or with a delay

A viewer can watch as it happens, or a few seconds behind so that text or other media made about a moment is ready when that moment is shown. Both are the same interval. For a delay, the consumer waits until each frame's `receivedMonotonicNanos` plus the delay before passing it on. While it waits, frames stay in the interval's own buffer, so `maxFrames` (at most 1024) and `maxBufferedBytes` are the delay's memory bound, and anything beyond them is dropped oldest-first and counted as `overflow`. Size them for the delay: five seconds of a busy page at up to 60 frames a second is 300 frames, and a 1280×720 JPEG of dense text is about 200 KB. The same clock stamps `documentBoundaries`, so an address bar drawn beside the frames changes when the frame after a boundary is shown. The record keeps the latest 64 boundaries, so a long stream can still name what it is showing. An interval may last up to six hours (`maxDurationMillis`, 60 seconds by default).

```ts
import { Clock, Effect, Stream } from "effect";

const interval =
  yield *
  Capture.start(session, {
    lifetime: "page",
    size: { width: 1280, height: 720 },
    maxFrames: 400,
    maxBufferedBytes: 64 * 1024 * 1024,
    maxDurationMillis: 30 * 60_000,
  });
const delayed = interval.frames.pipe(
  Stream.mapEffect((frame) =>
    Effect.flatMap(Clock.monotonicTimeNanos, (now) => {
      const wait = Number(frame.receivedMonotonicNanos + 5_000_000_000n - now) / 1e6;
      return Effect.as(wait > 0 ? Effect.sleep(wait) : Effect.void, frame);
    }),
  ),
);
```

`Capture.multipart(frames)` turns frames into one `multipart/x-mixed-replace` response for an `<img>`, the motion JPEG that WHATWG HTML defines for images. It closes each frame with the next part's delimiter and headers at once, because a browser shows a part only when it has read the headers of the one after it: without that, a viewer runs one frame behind and never shows the last picture of a page that has gone still. It writes no metadata, so nothing but pictures reaches a viewer, and it draws a new boundary from `Crypto` for each response. Call it once per viewer, over one fan-out of the interval, for example a sliding `PubSub` with `replay: 1` so that a slow viewer skips frames without slowing anyone else and a new one is shown the current picture. End that fan-out before the HTTP server stops: a server waits for its open responses.

Closing, navigating, detaching a relevant frame, or resizing the captured page ends its interval explicitly without ending a sibling page's capture. `Capture.start(session, { lifetime: "page" })` instead follows a page's main frame across documents: start it before a navigation and it covers the loading in between. The native screencast is never restarted for a navigation, so a boundary is not a gap this package introduced. Each frame carries the `document` it was received during (0, then one more per navigation), and the summary's bounded `documentBoundaries` give the last sequence before each one and the address it committed, with `initialUrl` for document 0. That is attribution by receipt order, not proof of whose pixels a frame shows: one received just after a navigation can still show the document before it. Selecting another page or frame does not invalidate an unrelated interval. Handoff pause, connection loss, an uncertain owner and session closure still invalidate all child intervals. A confirmed native stop releases only its own reservation; a failed stop on a live page keeps that target quarantined. A definitively closed page releases its capture reservation. Stopping a child capture does not close its browser. The frame seam has **no website-audio source**, so this package does not synthesize silent samples or infer audio support from a video container. Caller encoding is demonstrated in [the caller encoder example](../browserbase/examples/record-video.ts); the example decodes every generated frame with the caller's FFmpeg and checks presentation timestamps and pixel checksums. Native acceptance requires changing pixels and source-time agreement rather than accepting container headers as video evidence. Filming across a navigation with one page-lifetime interval, resampled onto a constant-rate reel with the address of each document reported, is demonstrated in [the footage example](../browserbase/examples/realistic-footage/README.md).

### Read metadata while capture is running

```ts
const interval = yield * Capture.start(session, { lifetime: "page" });
const current = yield * interval.snapshot;
// current.phase is "capturing"; initialUrl and recorded documentBoundaries are available now.
```

`snapshot` copies the bounded metadata already recorded in host memory. It does
no browser work, consumes no frames, charges no action, and works while the page
is held. Repeated reads neither stop nor restart capture. `observedMonotonicNanos`
stamps the read; each boundary retains its own commit observation time. The
record keeps the latest 64 boundaries; `documentBoundariesTruncated` reports that earlier
ones were let go, and `currentDocument` continues counting. Addresses longer than the existing
bound remain `null`. The model should not receive these host-only addresses by
accident merely because it can inspect the page.

While capturing, `reason` and `nativeStop` are `null`. `phase: "stopping"` means
capture has stopped accepting frames but native cleanup is pending. `"stopped"`
means that cleanup attempt settled; only `nativeStop: "confirmed"` confirms the
native stop. All snapshots are observations of accounting so far: buffered frames
can still be drained after stop. For final accounting, stop or await capture
termination, finish draining `frames`, then read `completed` to obtain the terminal
summary with final delivery counts. Preserve the terminal error and loss counters
when reconciling earlier snapshots. `late` is one disjoint component of `discarded`, and
`upstreamDrops` remains `"unknown"`; live metadata adds no stronger pixel or loss
guarantee.

### What a compositor is given, and what it owns

Footage from `capture` is the page surface. It has no pointer, no tab strip and no address bar, so on its own it reads as the inside of a tab rather than as a browser. Drawing those is the application's, exactly as cursor artwork, easing and encoding are: this package has no window-compositing API and will not grow one. What it owes a compositor is the evidence only it can see, on one timeline:

- each frame's `receivedMonotonicNanos`, and the `document` it was received during;
- an `InputReceipt` for each exposed native pointer, click and key operation, with a known position when the owner has one and an interval on that same clock. Internal download and file-chooser clicks clear the remembered pointer position but do not expose a receipt;
- an address for every document a frame can name: `initialUrl` for document 0, read in the same turn the watch is installed, and a `url` on each boundary, read inside the navigation event that committed it. An application that samples `observe()` between actions can learn an address, but never when it became the address. One longer than 8192 characters is `null`, never cut into an address the page did not show.

A boundary is the commit, and it is the only moment of a navigation an application cannot see for itself. When the navigation started and when its document finished loading are yours to stamp around the operation that caused it, because you made the call: `startNavigation` returns at dispatch and its `completed` resolves at DOMContentLoaded. The clock is Effect's `Clock`, read where the session was opened and the capture was started, so `Clock.clockWith((clock) => clock.monotonicTimeNanos)` in the same runtime is on the same timeline as every frame and receipt. A title is page state that changes whenever the page likes, not part of a transition: read it with `session.pages` when you need one, and stamp that read yourself.

The two clocks are never related for you. `sourceTimeMillis` is the browser's wall clock; everything above is the host's monotonic clock; on a hosted session they differ by an offset this package cannot observe. Every frame it receives is already late by the very capture latency it would be trying to measure, and nothing else it is handed carries the browser's time. Relating them takes a round trip into the page, which costs either a charged action or a registered binding, on a schedule only the application can choose, and it fails on a held page. So place input on frames by receipt time, which is always available and late by the capture latency, or measure the offset yourself with a four-timestamp exchange over a typed binding, as NTP does: the page stamps when it called and when the reply arrived, the host stamps when it received and when it replied, and half the best round trip is the error bound to report beside the offset.

## Explicit stage-page holds (opt-in)

Set `pageControl: true` on `Chromium.layer` or `BrowserbaseBrowser.layer` to use the host-only `page-control` module. The default remains off. `PageControl.suspend(session, page)` returns a live `PageSuspension`; `PageControl.resume(session, receipt)` consumes that exact receipt. Use a `PageInfo` from `session.pages`. Selection can move to the scout without invalidating the receipt, but connection loss, external target invalidation, completed resume, or another session does invalidate it. Holding or resuming a page may run its `freeze` and `resume` handlers, so nothing observed on _that_ page may be acted on unchecked afterwards: a reference fails `stale` until `session.revalidateElement(reference)` confirms it is still attached and still the control that was inspected. That check sends nothing, never searches for a substitute, and refuses a replaced, detached or changed node. An observation of another page is untouched, so an agent keeps driving the scout while the stage is held. `PageControl.state` reports the last acknowledged local state, not proof about a lost remote connection.

This opt-in uses maintained CDP attachment with `noDefaults: true` and owner-controlled per-page focus emulation. It intentionally does not support `keepAlive`, reattachment, human handoff, or popup/dialog `pause` policies. These combinations fail before acquisition; use the existing `retain`/`close` popup policies and `dismiss` dialog policy. Resume explicitly activates the native page without changing SDK selection. Do not enable it where another native client owns focus. Modeled input, DOM reads, waits and viewport changes on held/unknown pages fail before dispatch; the scout remains operable. Page close and session close remain available. Capture does not thaw a held page; frame consumption and acknowledgements never suspend/resume it implicitly.

The native tests cover page timers, RAF and CSS animation, scout progress with both pages captured, an already-paused animation, and restoration of a non-default rate. Resume waits for one bounded real RAF in an isolated world at rate zero before restoring that rate, avoiding Blink's stale pre-hold animation clock. In-flight callbacks are not undone. Date/wall time, network, media/audio, workers/service workers, and external/provider actions are not promised frozen. This is presentation control, not a security boundary or browser virtual time.

Partial native failures fence the session as uncertain; there is no success receipt, automatic rollback or retry. Scope cleanup never sends a hidden resume: it closes the owned session/connection. Chromium may reset animation state on CDP detachment, so a previous hold acknowledgement does not guarantee remote clocks remain held after connection loss. Hosted-provider equivalence has not been tested.

## Network policy

Only explicit trusted-host `Unrestricted` network policy is implemented. `ExactHosts` and `PublicWeb` fail before acquisition. A local debugger endpoint, an input-admission callback or a filtered initial navigation URL does not establish containment for redirects, subresources, popups, workers or DNS. Applications requiring egress restrictions must operate and independently qualify that enforcing boundary. Chromium can select a host-operated proxy at launch; provider routing is configured by its own integration. These choices never silently substitute a browser provider.

## Testing without a browser

`effect-browser/testing` opens the real owner over a scripted native engine. `Testing.open(script, options)` returns a `ScriptedSession<E>`: the same `BrowserSession<E>` that Chromium and Browserbase return, and admission, budgets, staleness, dispatch evidence, capture accounting, page holds and typed callbacks are the production code paths. Only the pages and the native outcomes are scripted, so an application, a Toolkit composition or a Layer runs on the pinned Node and Bun with no Chromium process, no Playwright installation and no credentials. The defaults are the ones a Chromium launch would use: an unrestricted policy, a 1280×720 viewport and a ten-second action timeout.

A script lists documents by address, each with its text and the controls it offers. A control's `id` becomes its issued `elementId`, and observations are numbered `observation-1`, `observation-2`, …, so a scripted model turn or a stored expectation can name a node statically. A `link` or a submit control carries a `destination`, which is both its host-only destination fact and where activating it leads; a plain button navigates through `activates` and reports no destination, as a real `onclick` handler has none, and the schema refuses a destination where a real document would report none. Navigating to an unlisted address reaches an empty document at that address. A checkbox or radio `input` without `checked` starts unchecked, as a real one does. `fillForm` and matched readings take the same steps over the script: a text step records its value in `document.values` and leaves the control, a toggle is clicked only when it differs, options are the observation's issued option IDs, and `next("fill-form", …)` arms the next step, verification read or submit.

```ts
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Reasons } from "effect-browser/errors";
import * as Testing from "effect-browser/testing";

const shop: Testing.Script = {
  documents: [
    {
      url: "https://shop.test/",
      text: "We use cookies.",
      controls: [
        {
          id: "accept",
          kind: "button",
          label: "Accept all",
          activates: "https://shop.test/?consent=1",
        },
      ],
    },
    { url: "https://shop.test/?consent=1", text: "Welcome back." },
  ],
};

it.effect("an unknown click is never replayed", () =>
  Browser.scoped(
    Testing.open(shop, { policy: BrowserPolicy.unrestricted({ maxActions: 10 }) }),
    (browser) =>
      Effect.gen(function* () {
        yield* browser.control.next("click", {
          _tag: "Fail",
          reason: Reasons.Timeout.make({}),
          outcome: "unknown",
        });
        const observation = yield* browser.observe();
        const accept = { observationId: observation.observationId, elementId: "accept" };

        const first = yield* browser.clickElement(accept).pipe(Effect.flip);

        expect(first).toMatchObject({ reason: { _tag: "Timeout" }, outcome: "unknown" });
        const retry = yield* browser.clickElement(accept).pipe(Effect.flip);

        expect(retry).toMatchObject({ reason: { _tag: "Closed" }, outcome: "undispatched" });
        const clicks = (yield* browser.control.calls).filter((c) => c.operation === "click");

        expect(clicks).toHaveLength(1);
        expect(clicks[0]).toMatchObject({ dispatched: true, settled: "failed" });
      }),
  ),
);
```

`browser.control` is the test's side of the scripted browser. The browser outlives any one connection, as a keep-alive browser does: a reconnection to the same address finds the pages it left, and the control keeps working while no connection is open, so a test can change a page while its owner is detached. `connections` lists every connection made to that browser and how each ended so far (`open`, `closed`, `dropped`, `close-failed`, or `refused` by the script's `connections: ["refuse", …]`), which makes a connection an owner left open visible. `next("disconnect", …)` scripts the owner's native teardown: `Fail` makes it fail, so the receipt reports `connection: "failed"` with a `disconnect` issue, and `Hold` parks it at a gate however long cleanup waits. A navigation stop is recorded in `calls` as `navigate-stop`, and its arms apply before or after it is sent. The rest of `browser.control`: `next(operation, outcome)` arms what the next admitted call of one operation does. `Fail` with `outcome: "unknown"` dispatches and then fails, so the owner fences the session and refuses every later mutation `Closed` and `undispatched`; `Fail` with `undispatched` or `rejected` never dispatches. `Hold` parks the call at a `Gate` before or after dispatch, so a test can interrupt or time out a call at a known point and then check what the owner made of it. `Disconnect` drops the connection inside the call. `calls` is the recorder: every admitted call with its operation, page, node, `dispatched` and `settled`, and never a filled value, typed text or address; `document.values` and `document.files` hold those separately. `document.replace` swaps the page's document as a navigation would, so retained nodes and pending waits go stale and a capture learns of a new document; `document.update` changes the same document in place, so controls that keep their `id` keep their identity and waits re-evaluate. `capture.emit` hands a frame to a running interval, `invoke` calls a registered binding as a page would, and `disconnect` drops every open connection outside any call. `closeChecked` returns a `ScriptedCleanupResult`, and `onCleanup` receives it, as the concrete owners do.

Time is the caller's clock. In-flight navigations, waits, holds and callback deadlines run under the context the session was opened in, so under `it.effect` from `@effect/vitest` a `TestClock.adjust` advances them and nothing real elapses, while `it.live` runs them in real time. `Testing.binding(script)` is the same engine as an opaque `BrowserBinding` for code that constructs a runtime itself; its `browsers` has one control handle for each address connected to, in first-connection order; `Testing.jpeg()` is a small valid JPEG for frames.

Randomness is scripted too. The owner's ids and handoff tokens come from `Testing.sequentialCrypto`, a `Crypto` Layer whose bytes count up from one, so `Testing.open` requires no platform service and its values repeat from run to run. A provider Layer built over `Testing.binding` still requires a `Crypto`; provide `Testing.sequentialCrypto` to keep that test free of a platform package. It is not random and computes no digest, so never give it to a real browser.

A scripted pass establishes the owner's behaviour over any engine, not what real Chromium reports for a page. `test/native/scripted-parity.test.ts` therefore runs one case list against both `Testing.open` and `Chromium.launch` on a loopback page, and every case must end in the same reason and outcome under both. Nothing scripted establishes anything about a hosted provider.

## Integration construction

`effect-browser/browser-runtime` is the supported host integration boundary. `make` validates an immutable runtime configuration and returns `acquire(policy, source, request)`. It requires Effect's `Crypto` and captures it for connection ids and handoff tokens, so an integration's Layer requires `Crypto` once and `acquire` never does. A source acquires one concrete lifetime, registers its release in the supplied Scope before returning, resolves its authorized endpoint, and supplies detailed release evidence plus `closeChecked`. Browserbase owns remote allocation/status and writer settlement; Chromium owns process termination/profile removal. The runtime supplies connection cleanup, captures bootstrap services, and creates the one registered session.

The connection exposes that exact session and a bounded set of modeled integration operations. An integration can add its own resource identity and authorized file-selection or handoff methods to the same object. It must authorize stored file paths before using integration file selection; ordinary browser sessions do not expose a server-path interface. Hosted handoff pauses under the existing owner before a provider Live View is issued, and resume/reconnect remain owned state transitions.

The native driver, action permits, mutable capture leases and registry lookup are private. No constructor returns a raw CDP driver or permits a consumer to recover native authority from a session. `playwright` issues opaque engine configuration; any endpoint resolver is trusted host configuration and must retain the supplying integration's endpoint validation. `Chromium` and `BrowserbaseBrowser` both use this same construction path.

## Public entry points

| Entry point              | Responsibility                                                                        |
| ------------------------ | ------------------------------------------------------------------------------------- |
| `browser`                | Common session, bound target, navigation operation and host admission types           |
| `browser-data`, `errors` | Credential-free schemas and expected browser/initialization errors                    |
| `bootstrap`              | Typed bindings, init/permission plans, readiness and host diagnostics                 |
| `capture`                | Bounded live frame intervals, snapshots and final accounting; reexports frame schemas |
| `capture-data`           | Capture options, binary frame and result schemas without session operations           |
| `page-control`           | Explicit host-owned page holds and receipt-based resume                               |
| `chromium`               | Self-managed Chromium launch, borrowed loopback attachment and process cleanup        |
| `browser-runtime`        | Supported construction for integrations supplying browser lifetimes                   |
| `testing`                | The real owner over a scripted engine: scripts, armed outcomes, a call recorder       |

The root intentionally excludes the Chromium namespace. Import its entry point explicitly.

## Validation

Use the pinned workspace and Vite+ commands described in [Contributing](../../CONTRIBUTING.md). Unit tests exercise ownership, callback errors, native-call classification and bounded capture; `test/testing.test.ts` exercises the public scripted engine through the same owner. Native Chromium tests use real loopback pages, capture and page holds, verify that borrowed closure leaves the external browser running, and run the scripted-parity case list against both engines. The `browser` installed consumer has no Browserbase or Effect Agent package; the `agent` consumer adds only the common adapter and framework. Provider-backed native integration remains separately exercised by Browserbase consumers. None of these local checks establishes hosted-provider equivalence.
