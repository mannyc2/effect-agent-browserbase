# Browser tools for Effect Agent

`effect-agent-browser` connects [`effect-browser`](../browser/README.md) to Effect Agent. One adapter, maintained Toolkit and host callback implementation support both self-managed Chromium and Browserbase. The host supplies its required peers explicitly: `effect-browser@0.2.0-beta.7` and `effect-agent@0.1.0-beta.142` for this release. These exact prerelease peers express the qualified combination; supply matching versions and keep one runtime instance across the application and adapter. The Effect peer is `^4.0.0-rc.117`, with rc.117 qualified. The adapter does not install Browserbase or own a Playwright peer.

## Public entry points

`tools` exports the maintained Toolkit, handlers over an issued Page (or a Frame one of its Pages issued) and its owning session, supervised host composition and separate reading, pointer/wheel, keyboard, option-selection, wait and form opt-ins. `adapter` exports `fromSession` and `interactiveLayer` for Effect Agent's original `InteractiveBrowser` contract. The root exports those two namespaces. Tests acquire real owners through `effect-browser/testing` or `effect-browserbase/testing`; forged structural objects carry no Page authority.

## One session, chosen by the host

Acquire a session once and bind the Tools to an explicit Page:

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { Chromium } from "effect-browser/chromium";

const program = Browser.scoped(Chromium.launch(BrowserPolicy.unrestricted()), (browser) =>
  BrowserTools.run(browser, browser.initialPage, agentProgram, {
    maxControls: 32,
    policy: { admit: (facts) => facts.inputType !== "password" },
  }),
).pipe(Effect.provide(Chromium.layer().pipe(Layer.provide(NodeServices.layer))));
```

Both browser Layers take Effect's `Crypto` from the host platform, here `NodeServices.layer`.

To work inside an iframe, bind the Tools to the Frame its Page issued instead:
`BrowserTools.makeHost(browser, yield* browser.initialPage.frame(info))`, with `info` from
`listFrames()`. Readings, references and input then stay inside that frame; a detached frame or
a closed Page fails like any retired target, and nothing retargets the Tools to another frame.

A complete agent declares the Tools it may use and takes its instructions and policy from them:

```ts
import { Toolkit } from "effect/unstable/ai";

const toolkit = Toolkit.merge(
  BrowserTools.observedToolkit,
  BrowserTools.observedFormToolkit,
  BrowserTools.readingToolkit,
);

const agent = Agent.make("browser", {
  input: Schema.String,
  output: Schema.Struct({ summary: Schema.String }),
  instructions: BrowserTools.instructions(toolkit),
  toolkit,
  policy: BrowserTools.policy({ maxTurns: 8, maxDuration: "2 minutes" }),
});
```

For Browserbase, use `BrowserbaseBrowser.open(...)` from `effect-browserbase/browser`, supplying its account and launch configuration, then pass that session to the same `BrowserTools` functions. Nothing in the tool implementation branches on the provider. The model does not choose the account, browser source, credentials, endpoint, launch options or capture settings.

[`examples/chromium.ts`](examples/chromium.ts) and [`examples/agent.ts`](examples/agent.ts) use the same [`BrowserAgent.ts`](examples/BrowserAgent.ts) definition. The hosted example also shows human handoff and typed page-to-host callbacks. Both leave the model choice to the caller.

[`examples/livestream`](examples/livestream/README.md) shows an agent's browser to viewers, live or a few seconds behind, inside a drawn browser window with a caption for each step. A separate narrator model writes the captions while each step waits in the delay. It runs on either browser source, and its native test runs it on a local Chromium with scripted models.

Every constructor validates the exact `(session, page)` pair. Display selection cannot retarget operations or continuations. Inputs execute as single-step public Plans; `makeHost` retains their original RunOperation or navigation capability in its bounded host-only `receipts` snapshot before model projection. `toolFailures` preserves original error fields. Concrete provider capabilities remain on the original session. `Browser.scoped(open, use)` owns checked cleanup; `BrowserTools.run(browser, page, program, options)` owns only Tool-host lifetime and supervision.

## Provide InteractiveBrowser directly

A host can configure framework acquisition without introducing separate provider adapters:

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";
import { interactiveLayer } from "effect-agent-browser/adapter";
import { Chromium } from "effect-browser/chromium";

const browserLayer = interactiveLayer({
  implementation: "chromium-playwright-cdp",
  open: (policy) => Chromium.launch(policy),
}).pipe(Layer.provide(Chromium.layer()), Layer.provide(NodeServices.layer));
```

The opener's services are captured when the Layer is built; each `open` uses its caller's execution Scope. Building the Layer allocates nothing. Unsupported containment fails before acquisition. The handle binds the acquired owner's checked initial Page, and acquisition failures are sanitized into the framework's error contract.

`fromSession<S>(browser, page)` keeps the exact concrete `S` beside a handle for that issued Page, or for a Frame one of its Pages issued. Adaptation validates authority when its Effect executes and allocates no browser:

```ts
import * as Adapter from "effect-agent-browser/adapter";

const adapted = yield * Adapter.fromSession(browser, browser.initialPage);
const next = yield * browser.createPage();
yield * browser.selectPage(next);
yield * adapted.handle.navigate({ url: "https://example.com" });
// The operation still targets initialPage, regardless of the displayed Page.
```

`AdaptedSession<S>` contains `browser` and `handle`. Page closure or owner retirement makes the handle stale. Framework `handle.close` calls the original session's `closeChecked`, so it closes other Pages owned by that session too; concrete receipts remain available on `adapted.browser`. Borrow direct Tool hosts for shared ownership. Resume/reconnect requires a newly issued Page from the returned inventory and explicit fresh observation.

## Host observation and exact-control policy

Every handler function, `makeHost` and `run` take the same `HandlerOptions`. Each is checked once, when the host or handler Layer is built: an invalid value fails there with a `Configuration` reason that names it, and never reaches a model as a failed call. So does a key nothing reads, such as `admission` (now `policy`) or a misspelt `lane` field; handler Layers also refuse the host-only `lane`, `scheduling`, `onNavigation` and `onInput`.

`execution` configures each single-step run's `style`, `within`, `timeoutMillis`, `checkpoint`
and bounded `admission.queue`. Omitted style is plain; `style: { seed: 7 }` selects the bounded
performed profile with slips disabled by default. A fixed seed is the base of a sequence: the nth
run the handlers start uses `seed + n - 1`, continuing from the smallest safe integer past the
largest, so each call draws its own timing while the same calls reproduce the same performance. Without a seed each run draws a fresh one. Seeds and pacing stay
on the host. The same logical action costs the same budget in either style. Input Plans retain
run/step/attempt IDs. No model parameter gains timing or recording authority.

Navigation is the one Tool whose `execution` differs by composition. Handler Layers without a host
run `browser_navigate` as a one-step Plan with every option. A host runs it as the original
NavigationOperation, so `onNavigation` can supervise and stop it: `within` narrows its loading
deadline and `timeoutMillis` and `admission.queue` apply, but it takes no `checkpoint`, and its
`receipts` entry is a `Navigation`, not a `Run`. `style` never changes a navigation.

```ts
const handlers = BrowserTools.handlers(browser, browser.initialPage, {
  observationScope: "viewport", // the default; "document" reads the whole page
  maxTextBytes: 8192, // text a model is shown from one reading
  maxControls: 16,
  resultMaxBytes: 48 * 1024, // the bound on every encoded Tool result
  continuationBytes: 32 * 1024, // text read per reading, for browser_read_more
  form: { verify: true, settleMillis: 50 }, // how browser_fill_form proceeds
  policy: {
    admit: (facts) =>
      facts.inputType !== "password" &&
      facts.autocomplete !== "current-password" &&
      facts.formMethod === undefined,
  },
});
```

Observations read the viewport by default: what a person would see, and what `browser_scroll` moves. `browser_inspect` takes two optional parameters, each null or absent when unused. `scope` asks for the whole document or the viewport for one reading. `find` keeps only controls whose label contains its text, and lines containing it, and it is applied inside the page before `maxControls` and `maxTextBytes` are spent, so a crowded header cannot hide the control a model is looking for. A matched reading names its `match`: what it leaves out is not evidence of absence. Neither parameter can widen the host's bounds, and references still come from the reading itself.

Viewport observations retain the generic reading's geometry budgets and its clipped, covered, uncertain and exhausted qualifications. Choosing viewport scope does not turn hit-testing into pixel-level visibility proof.

Every result is fitted under `resultMaxBytes` (16 KiB–1 MiB, 48 KiB by default, under Effect Agent's default 50 KiB `toolResultBounds`), so the engine never cuts one in the middle of its JSON. A reading that does not fit loses text first and then trailing controls, never part of a reference it keeps, and says so through `textTruncated`, `controlsTruncated` and a select's `optionsTruncated`.

`observe` replaces how the Tools read the page, for `browser_inspect` and for the reading after an action. It receives the request (scope, optional `match`, text and control bounds) and the issued Page or Frame the Tools are bound to, and must return a reading that target issued, because later actions name its references. A host can wait for its own readiness signal first, retry, or narrow the request:

```ts
const host =
  yield *
  BrowserTools.makeHost(browser, browser.initialPage, {
    observe: (request, page) =>
      appReady.pipe(Effect.andThen(page.observe({ ...request, maxControls: 24 }))),
  });
```

`policy` runs for every exact-node Tool (`browser_click`, `browser_fill`, `browser_hover`, `browser_press`, `browser_type`, `browser_select_option`, each step of `browser_fill_form` and their `_and_inspect` variants) on fresh facts from the exact observed node. The owner first rejects replaced or changed controls, independently of that policy. Performed pointer delays and fill preparation recheck those facts and the policy before further input. `admit` is synchronous under the owner's permit; it returns a boolean. False, a thrown exception or a non-boolean result fails `denied/undispatched` before input, or `denied/rejected` after acknowledged preparation, without projecting the exception to the model. Policy and destination/type/autocomplete/form facts are host-only and are never Tool parameters. Asynchronous application checks belong before dispatch and retain their own Effect errors, services and cancellation; they do not replace this final synchronous policy. Native input is still not atomic with DOM validation: page script can run after validation and before input arrives.

Passive `checkpoint` does not replace the observation used by Tools. After a page hold/resume, call `revalidateElement` on the retained exact reference before dispatch; unchanged, admissible controls remain usable, while replacements and changed control facts fail without substitution. The native AgentRuntime regression exercises this composition on the same owner.

## Reading on past what a model was shown

Merge `readingToolkit` to give a model `browser_read_more`. Each reading reads `continuationBytes` of text (32 KiB by default, at least `maxTextBytes`, at most 128 KiB) while the model is shown `maxTextBytes`; `browser_read_more({ observationId })` returns the next part of the latest reading's text, with `remaining` and the page's own `textTruncated`. It reads nothing new from the page, spends no browser action and changes no reference; an older reading's ID fails `stale`. A browser policy whose `maxReturnedBytes` is too small for the continuation reads `maxTextBytes` instead. The latest reading is kept per issued Page, so hosts for sibling Pages have independent continuations.

## Forms in one call

`browser_fill` and replacement values in form calls accept at most 65,536 UTF-8 bytes per input,
matching the public Plan input bound. The Tool validates this before a run is prepared, including
for `_and_inspect` variants. A form's complete encoded input bindings also share the Plan's 1 MiB
total bound; the Tool validates the same named inputs the executor sends.

Every action on a page retires the observation its references came from, so a model that sends three fills and a click in one response gets one fill and three `stale` refusals, and each refusal counts toward Effect Agent's `repeatedFailureLimit`. `formToolkit` adds `browser_fill_form`, and `observedFormToolkit` its `_and_inspect` variant:

```ts
{
  observationId, // from the latest observation
  fields: [
    { elementId, value: "ada@example.test" }, // replaces the text
    { elementId, checked: true }, // the state a toggle should end in
    { elementId, options: [optionId] }, // a native select's issued options
  ],
  submit: buttonId, // clicked once every field is set and still holds; null or absent leaves it unsent
}
```

It runs on `effect-browser`'s `fillForm`: every step is the exact-node action it replaces, with the same fresh checks and the host's `policy`, and each is charged as one action. The observation stays usable for the form's own steps only. Before submit the form reads every field again, unless the host sets `form: { verify: false }`, and does not submit when one was changed after its step. A completed form returns each field's `status` (`set`, or `unchanged` for a toggle already in the requested state), `submitted` and the URL. A form that stopped fails with `BrowserFormFailure`: the compact `reason` and `outcome` of the step it stopped at, its `stage` (`field`, `verify` or `submit`) and `elementId`, and the fields it `completed`, which stay set. The whole form costs one model turn and at most one counted failure.

`browser_fill_form` clicks and selects as well as filling text, so it carries the authority of `browser_click` and `browser_select_option` together; no other Toolkit gains it.

## Optional native input

`nativeToolkit` adds `browser_pointer_move`, `browser_hover` and `browser_wheel`. `keyboardToolkit` separately adds `browser_press` and `browser_type`; existing native-tool opt-ins therefore do not silently gain keyboard authority. Merge only the Toolkits the agent should see. `host.layer` can provide every handler service at once because an Effect AI agent can call only Tools declared in its own Toolkit.

Pointer requests use the generic `PointerMoveRequest` and wheel requests `WheelRequest`'s fields, with a null `at` meaning the current pointer: CSS pixels in the main-frame viewport. Hover takes an `ObservedElement` and applies the same exact-node admission as click/fill. It never scrolls an off-screen element into view. A wheel event reaches the nested container or page the browser hit-tests under the pointer. `browser_scroll` remains an instantaneous scripted scroll with no wheel event.

Keyboard Tools also take an exact `ObservedElement`. That node must already have focus; the Tool never focuses or searches for a replacement. `browser_press` accepts the generic `KeyStroke`, with null `modifiers` for none, and `browser_type` takes the browser package's bounded text: at most 256 characters, with control characters refused. No JSON Schema keyword carries a character count, so its description gives the limit in characters and words, and a longer text is refused with its own length so the model can split it. Both apply the same fresh `policy` as click/fill/hover.

Real-input model results contain only `{ dispatched: true }`. They do not claim scrolling, focus-driven page work or a website action has settled. Observe again for the result. `makeHost`'s `onInput` receives the unmodified `InputReceipt` and optional tool-call ID for exposed pointer, click and key input, including target, known position/delta and host-monotonic interval. Playwright-managed clicks report a null position because their internal hit-tested point is not exposed. Internal download and file-chooser clicks clear the remembered pointer position but do not produce a receipt. A receipt never includes the key or typed text. Receipt times, private capabilities and callback output never enter the model result. The host owns pacing, easing and drawing; these Tools add none and never replay failed input.

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
one selection dispatch. It never searches for replacement nodes. Fresh host `policy` applies
to the select. Success returns the bounded action result, without submitted values, and retires
that page's observation; inspect again for new references and selected state. Rejections use the
same compact failure vocabulary and host diagnostics as the existing tools.

`host.selectionHandlers` shares the complete-invocation lane with the other host handler Layers.
`selectionHandlers(browser, page, options)` remains available for caller-managed composition. Neither
the default five-tool toolkit nor the pointer or keyboard toolkits gain selection authority.

## Optional bounded waits

`waitToolkit` adds `browser_wait_for` with `{ reference, state, timeoutMillis? }`. Its reference
comes from an actual inspection; the state is `visible`, `hidden`, `enabled` or `disabled`, and
the optional deadline is 1–60,000 ms, shortened by the host's action timeout and remaining
browser lifetime; null or absent waits until that deadline. No CSS selector, JavaScript or arbitrary sleep is a Tool parameter. Hidden
includes disappearance of the original node; it never re-finds a replacement. Document or frame
replacement fails. Success is `{ satisfied: true }`, a sampled condition rather than a guarantee
about a later action. Reinspect when state has changed before sending input.

The wait occupies the same complete-invocation lane as the host's other tools, while its native
observation releases the browser permit for direct recorder checkpoints and page reads. Same-page
input and observation replacement remain excluded. A cancelled wait cannot report late success;
one unresolved native wait or its handle disposal keeps the finite wait capacity until it settles
or its connection retires. `host.waitHandlers` supplies the scoped path;
`waitHandlers(browser, page, options)` is caller-managed and accepts the same host execution
bounds as the other handler families. No existing toolkit gains the wait tool automatically.

## Optional observation results after input

Choose `observedToolkit` in place of the default toolkit when mutation results should include a
fresh inspection, which saves a model turn after every action. It contains the unchanged
`browser_inspect` and separately named `browser_navigate_and_inspect`,
`browser_click_and_inspect`, `browser_fill_and_inspect` and `browser_scroll_and_inspect`.
`observedNativeToolkit`, `observedKeyboardToolkit`, `observedSelectionToolkit` and
`observedFormToolkit` separately offer the corresponding native, keyboard, select and form
operations with `_and_inspect` names. Distinct names keep the original Tool success schemas and
handler identities intact; only the groups explicitly declared by the agent are available.

```ts
const toolkit = Toolkit.merge(BrowserTools.observedToolkit, BrowserTools.waitToolkit);
// Declare this toolkit on the agent, then use BrowserTools.run(browser, browser.initialPage, program, options).
```

Every successful result contains `action`, the original bounded action/navigation result or
`{ dispatched: true }` for native input, and a separate `observation`:

```ts
{ action: { url }, observation: { _tag: "Available", observation: fresh } }
{ action: { url }, observation: { _tag: "Unavailable", failure: { reason: "limit", outcome: "undispatched" } } }
```

The nested failure belongs only to the follow-up read. A timeout, ordinary read failure or result
overflow does not turn successful input into a failed or undispatched action and never causes a
replay. Original read-failure facts remain in `host.toolFailures`. Failed input performs no follow-up
read. Cancellation and callback/host failures preserve their existing supervision semantics.
The lane covers input, callback finalizers and then inspection before admitting the next tool.
The observation is sampled afterwards through normal exact-Page admission, not atomically
with input; its target and URL identify what was actually inspected.

The extra `observe` spends one more action from the owner's allowance (`status.actions` counts both), and uses the same `maxTextBytes`,
`maxControls`, `observationScope` and `observe` settings. The whole encoded action-plus-observation
result is fitted under `resultMaxBytes`: the reading loses text, then trailing controls, and only a
reading whose fixed fields alone exceed the bound becomes `Unavailable/limit`; the action remains
intact. Keep the agent's `toolResultBounds.maxBytes` at this bound or higher, as
`BrowserTools.policy` does, so the framework does not truncate a result again. Token budgeting and
history compaction still belong to the Agent policy and selected model; these byte bounds are not a
token-count estimate. For long sessions set the Agent's `contextTokenLimit`, so compaction prunes
old readings that later actions have already made stale.

`ObservedActionResult`, `ObservedNavigationResult`, `ObservedInputResult`, `ObservedFormResult`
and `FollowUpObservation` are exported schemas. `host.observedHandlers` shares the host's lane; `observedHandlers(browser,
page, options)` provides the caller-managed variant handlers. The default toolkit and existing result
formats remain unchanged.

## Scoped navigation and receipt callbacks

`makeHost(browser, page, options)` acquires a scoped host composition without opening another browser. It returns `handlers`, `readingHandlers`, `nativeHandlers`, `keyboardHandlers`, `selectionHandlers`, `waitHandlers`, `formHandlers`, `observedHandlers`, their merged `layer`, `failure`, `toolFailures`, `receipts`, and `run(effect)`. Its `HostOptions<E, R>` adds `lane` and `scheduling` (below) and these optional host callbacks:

`onNavigation` receives `{ operation: NavigationOperation, toolCallId: string | undefined }`; `onInput` receives `{ receipt: InputReceipt, toolCallId: string | undefined }`. Each returns `Effect<void, E, R | Scope.Scope>`.

`host.receipts` returns an immutable window of the latest 32 host CallReceipts, plus a dropped
count. Run entries hold the original RunOperation; its attempts remain available after interruption
or timeline eviction. Navigation entries hold the original NavigationOperation and carry no
invented Plan IDs. Preparation refusals retain the original StepFailed or BrowserError. A local
invocation ID distinguishes repeated or omitted toolCallIds; overlong toolCallIds are omitted
explicitly. These live capabilities and descriptor captures are never encoded in tool results.
Fill/Type/Form input values use named host slots in recorded intent; native success and callback
or observation failure remain separately inspectable.

The callback service requirements are captured at `makeHost` acquisition; each callback gets its own invocation scope. `failure` retains the first original host callback/navigation-cleanup cause or the browser's original fail-session cause, including the browser's typed bootstrap error. `host.run(effect)` provides every maintained handler Layer and races the whole program against that failure. `BrowserTools.run(browser, page, effect, options)` is the scoped convenience form. Program requirements unrelated to Tool handlers stay in `R`; callback requirements also stay visible and are captured before handlers are provided.

The host refuses a run that begins after its browser has already failed. Closing the host scope interrupts and joins `host.run` itself, its in-flight Tool calls and callback scopes. None of those operations closes the browser: ownership and checked cleanup remain with `Browser.scoped` or the caller's enclosing browser scope. The model receives only a bounded `BrowserToolFailure`, never a callback cause, its service values or a raw operation object.

This scoped path deliberately uses `startNavigation` once for `browser_navigate`. `onNavigation` starts once with that exact operation before completion is raced, including for an already-settled navigation. Returning from the callback does not finish navigation; the Tool still waits for DOMContentLoaded. The callback may checkpoint/capture while the page loads or wait for an application cancellation signal and call `operation.stop`. Waiting on `operation.completed` and cancelling that waiter alone stops nothing. A callback that needs to inspect a failed completion can use `Effect.result` or `Effect.exit` rather than raising it as a callback failure.

Navigation completion cancels remaining callback work and joins its scoped cleanup before returning. Callback failure or interruption of the Tool/host scope asks that same pending operation to stop before its operation scope closes. A failed stop preserves the native error and owner fencing; it is not treated as confirmed termination. Confirmed stop produces the generic `interrupted` completion and keeps a healthy session usable, without undoing page effects. The existing generic failure schema still reports that completion's `outcome: "unknown"`; acknowledgement of stop does not establish what the page did before it stopped. Default `handlers`, without `makeHost`, retain their earlier navigation/abandonment semantics.

A main-frame loading deadline uses the browser owner's bounded recovery, including through
`Tools.run`: the model receives `timeout/unknown` after acknowledged stop and can inspect the
partial page before choosing its next action. Recovery and explicit stop share one coordinator;
the loading deadline may be followed by up to three seconds of recovery, never beyond the browser
lifetime. Failed recovery, or a loading deadline on a child Frame, closes that exact Page
instead; the owner is fenced only when that closure is unconfirmed. No failed navigation is
automatically repeated.

Inspection references come from the actual returned observation. Display selection and input on
another Page cannot retarget them. A foreign Page or changed exact document/control is refused. Input on their own page, including hover
and scrolling, still requires reinspection. Reconnect and a new inspection retire older references;
never construct an ID from an assumed counter.

`onInput` runs after input dispatch. Its failure is therefore not an undispatched input: the model receives `failed/performed`, and the host retains the original callback cause plus the original run receipt. In contrast, admission refusal and a call refused because its host is already closed/faulted dispatch nothing. Operation reservations, native fences and browser cleanup remain with the generic owner.

### Concurrent tool calls

`host.run` and `Tools.run` schedule this package's Tools sequentially by default: they add every
browser Tool to Effect Agent's `RunToolScheduling`, keeping whatever the caller already provides,
so the engine runs each browser call alone and in the order the model declared it, while other
Tools still run concurrently between them. A host that passes `RunOptions.scheduling` replaces the
ambient reference rather than merging with it, and a durable host registers its own scheduling, so
both pass their hook through `BrowserTools.sequentialScheduling(hook)`. `scheduling: "lane"` leaves
the engine's scheduling alone.

Every `makeHost` also owns one blocking invocation lane shared by its handler Layers and all
programs run through that host. Concurrent calls wait for their first execution. The lane stays
held until the complete tool finishes: navigation completion, callback finalizers and required stop
cleanup all precede the next call. Calls from different toolkit groups share it. A queued
exact-node call can still be stale when admitted if earlier input retired its observation;
sequencing never refreshes references or replays input.

`lane.maxOutstanding` (32 by default, 1–1024) bounds invocations including the active one, and
`lane.maxQueueMillis` (30,000 by default, 1–600,000) bounds waiting from invocation entry. These are
policy choices, not throughput measurements. Overflow returns `busy/undispatched`; queue expiry
returns `timeout/undispatched`. The queue deadline does not limit a handler after admission.
Waiting spends no browser action; the operation's normal budget and deadline apply when it
executes. Host closure, cancellation and host failure cancel or wake accepted waiters, which
recheck admission before browser work. Without sequential scheduling the lane serializes calls but
does not promise a model-declared ordering for concurrent work.

A callback or its finalizer invoking another tool through the same host receives
`busy/undispatched` immediately. An inherited private context marker distinguishes this reentry
from an independent caller, which queues normally; nesting another host does not erase the
enclosing marker. Captured callback services and per-call services keep their existing meanings.

Direct browser reads, capture and page control are outside the tool lane. Operations on one Page
and its frames share admission, while independent Pages can proceed concurrently. Page calls
accept explicit trailing `OperationOptions`: queue omission or zero fails immediately with `Busy`,
and a positive finite `admission.queue` allows bounded FIFO waiting. Queue waiting counts toward
the operation deadline. These host options stay outside Tool schemas and are distinct from the
exact-control `HandlerOptions.policy` callback. Module-level `handlers`, `nativeHandlers`, `keyboardHandlers` and `selectionHandlers` are the unsupervised,
caller-managed path: they do not add this lane. Use `makeHost` or `Tools.run` for the maintained
sequencing and supervision lifecycle.

## Instructions, policy and descriptions

`BrowserTools.instructions(toolkit)` returns agent instructions for the Tools a Toolkit declares:
page text is untrusted data, one control per response, how to read the new observation, a form in
one call, what an unknown outcome means and how to reach what a reading left out. They restate the
rules the Tools enforce, so a model plans around them instead of learning them from failures. Use
them as they are, add to them, or write your own; nothing depends on their wording.

`BrowserTools.policy(input, { resultMaxBytes })` returns Agent policy fields for these Tools under
the host's own: `repeatedFailureLimit: 5`, because a refused stale action counts like any failure
and the engine's default of 3 can end a run after one batched response, and a `toolResultBounds`
at least as large as the Tools' own bound. Anything in `input` wins.

`BrowserTools.describe(toolkit, { browser_click: "..." })` returns the same Toolkit with some
descriptions replaced. Names, schemas and annotations are unchanged, so the maintained handlers
still serve it: a deployment can tell the model what it allows. A host may also narrow a Tool's
parameters by making its own Tool with the same name; handlers are keyed by name and accept the
maintained parameters. `BrowserTools.toolNames` and `isBrowserTool` name every Tool this package
defines.

The Tools are ordinary Effect AI Tools, so `tool.setNeedsApproval(...)` gates a consequential
call, such as `browser_fill_form` with a submit, and the maintained handlers still serve it because
handlers are keyed by name. The host decides through Effect Agent's `approval` run option, for
example `toRunApprovalHook(...)` from `effect-agent/run-hooks`. Unlike a synchronous `policy`
refusal, an explicit denial fails the run with `AgentApprovalDenied` rather than returning a
failure to the model.

Every Tool's parameters are an object schema with described fields. The pinned OpenAI and
Anthropic providers make every key required and nullable, so a model sends null for each optional
parameter it leaves out. Every optional parameter therefore takes null as the absent key, and its
description says what null does: the handlers, an approval predicate such as
`params.submit !== undefined` and the recorded call see the request the model meant. A conformance
test runs each Tool through both providers' own schema transforms and decodes what they send with
the Tool's own schema, as Effect Agent does.

Effect Agent returns a refused parameter to the model in the same run, so the Tools' own checks
say what was wrong and what to send instead: a form field that sets both `value` and `checked`, a
control listed twice, a submit control that is also a field, or text longer than one call types,
with its length and the limit.

## Testing an agent without a browser process

`effect-browser/testing` opens the real session owner over a scripted page, so an Agent composition runs the maintained Toolkit, host supervision and adapter against deterministic pages with no Chromium process, no provider account and no credentials. Observations are numbered `observation-1`, `observation-2`, … and a control's script `id` is its `elementId`, so a `ScriptedModel` turn from `@effect-agent/testing` can name the node it clicks statically instead of parsing a tool result.

```ts
import { ScriptedModel } from "@effect-agent/testing/scripted-model";
import { expect, it } from "@effect/vitest";
import { Effect, Layer } from "effect";
import * as BrowserTools from "effect-agent-browser/tools";
import * as AgentRuntime from "effect-agent/agent-runtime";
import * as InMemory from "effect-agent/in-memory";
import * as Browser from "effect-browser/browser";
import * as Testing from "effect-browser/testing";
import { Model } from "effect/unstable/ai";

it.effect("the agent clicks the observed control exactly once", () =>
  Browser.scoped(Testing.open(shop), (browser) =>
    Effect.gen(function* () {
      const turns = [
        call("c1", "browser_navigate", { url: "https://shop.test/" }),
        call("c2", "browser_inspect", {}),
        call("c3", "browser_click", { observationId: "observation-1", elementId: "accept" }),
        answer('{"done":true}'),
      ];

      const run = yield* BrowserTools.run(
        browser,
        browser.initialPage,
        AgentRuntime.run(consent, "accept"),
      ).pipe(
        Effect.provide(
          Layer.mergeAll(
            InMemory.layer,
            ScriptedModel.layer(turns),
            Layer.succeed(Model.ProviderName, "scripted"),
            Layer.succeed(Model.ModelName, "consent-test"),
          ),
        ),
      );

      expect(run.output).toEqual({ done: true });
      expect((yield* browser.control.calls).map((c) => c.operation)).toEqual([
        "navigate",
        "observe",
        "resolve",
        "click",
      ]);
    }),
  ),
);
```

`call` and `answer` build `ScriptedTurnInput` values; [`test/scripted-agent.test.ts`](test/scripted-agent.test.ts) is the maintained version with the `consent` agent and the `shop` script. Its second case arms an unknown click outcome: the model sees a `timeout`/`unknown` tool failure, retries with the same reference, and sees `closed`/`undispatched` because containment closed its Page, while `browser.control.calls` shows one dispatched click and `makeHost`'s `toolFailures` shows the same two failures, so a test can assert that a mutation whose outcome was lost was never re-sent on the model's behalf. The `agent-hosted` installed consumer runs the same composition from the packed tarballs on Node and Bun. A scripted pass is evidence about the Tools and the owner, not about Chromium or a hosted browser.

## Know what authority this grants

`browser_click`, `browser_fill`, `browser_hover`, `browser_press` and `browser_type` accept only an exact node from the most recent observation, so a model cannot name a target of its own, and a replaced or detached reference fails rather than resolving to something else. `browser_navigate` is different: the URL comes from the model, bounded only by the session's network policy, and the shared browser currently supports only trusted-host `Unrestricted` (see [Network policy](#network-policy)). There is deliberately no per-tool host allowlist: a URL check on the first request says nothing about where it redirects or what the page then loads. A host that needs navigation confined to known hosts must enforce that beneath the browser, at an egress proxy it operates.

## Network policy

`Unrestricted` is supported only when selected by trusted host policy. `ExactHosts` fails before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers. `PublicWeb` also fails before allocation because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

The generic guide's [Network policy](../browser/README.md#network-policy) section says why this package has no request-admission hook, and which boundary can enforce containment instead: a proxy the host operates, selected for the whole session at launch. A host that uses one still selects `Unrestricted` here, and the containment claim stays the host's own. The model-facing Tools take no admission policy. Host `policy` options decide whether an exact control may receive input; they do not establish redirect, subresource or connection-time network containment.

## Error translation

`host.toolFailures` includes the browser's current `status`, read from host memory when the
snapshot is requested. It is not historical state at the recorded failure: a `timeout/unknown`
entry may accompany an open, recovered owner or a subsequently closed owner. Status carries
phase, reason, generation, busy and unresolved-dispatch facts without becoming model output.
The browser's separate `diagnostics` keeps bounded policy/native records; typed callback causes
remain separate. All these snapshots remain readable after host closure.

The generic package's `BrowserError` carries a tagged `reason` and required `outcome`. The Tools return only `stale`, `busy`, `denied`, `not-found`, `ambiguous`, `not-visible`, `not-focused`, `disabled`, `unsupported`, `limit`, `timeout`, `closed`, or `failed`, alongside the unchanged `undispatched`, `rejected`, `performed`, or `unknown` outcome. `disabled` asks for a control that is not enabled now; `unsupported` for input a control cannot take, such as text in a checkbox or a date it would not keep. `performed` means native input was acknowledged before a later step failed; `unknown` means a command outcome remains unresolved. Neither authorizes blind replay. Host diagnostics retain exact `PageClosed` or `SessionFenced` containment separately. A `Stale` refusal from the bound Page or Frame itself, once it is no longer open (closed, contained, retired by reconnect or handoff, or a detached frame), projects to `closed`: nothing on that target can succeed again, so a model should stop instead of inspecting again. The host still records the original `Stale`. An `Interrupted` navigation projects to `stale/unknown`; that does not authorize replay. Rate limiting and `QueueFull` project to `busy`; `QueueExpired` projects to `timeout`. Original retry timing and admission reasons remain available to the host. Provider status, diagnostic paths, limit measurements and native exceptions never enter this failure projection.

Read `host.toolFailures` for the original `_tag`, `operation`, tagged `reason` fields and `outcome`, plus the Tool's name and the supplied tool-call ID. Each `ToolFailureDiagnostic` is recorded before projection; navigation start/completion, exact-node refusals and malformed typed results use the same channel. The `ToolFailureSnapshot` keeps the latest 32 entries in oldest-first order, with a `dropped` count for evictions. IDs longer than 256 UTF-16 code units are omitted with `toolCallIdOmitted: true`; an absent ID leaves that flag false. Snapshots and their recorded fields are copied and frozen. Reading them performs no browser work, takes no action permit, adds no callback services and remains possible after host closure.

```ts
const host = yield * BrowserTools.makeHost(browser, browser.initialPage);
const result = yield * host.run(agentProgram);
const diagnostics = yield * host.toolFailures;
// Keep diagnostics on the host; only result is part of the agent's declared output.
```

Ordinary failures do not complete `host.failure`. Consumer callback, browser fail-session and failed navigation-cleanup causes keep their existing supervision behavior. Direct module-level handler Layers retain caller-managed composition and do not create a diagnostic store. Framework parameter-validation and result-encoding failures outside the handlers belong to the Toolkit's own error contract.

The separate `InteractiveBrowser` adapter maps only factual `Limit` reasons for `actions`, `elapsed` and `returned-bytes`, with a positive integer maximum, to `InteractiveBrowserLimitError`. Other dimensions or an unsupported zero maximum retain a bounded action error. `Closed`, `Expired`, `Disconnected` and `Stale` map to `InteractiveBrowserExpiredError`; a target refused before input because it `Drifted` from its guarded geometry maps to the ordinary action error, because the handle itself remains usable. Its pinned contract has no dispatch-outcome field; the adapter neither adds one nor infers it from exception text. Concrete browser diagnostics remain on the original session.

This package exposes Effect AI Tools over a long-lived, execution-owned browser session supplied by Chromium or Browserbase. Effect Agent's browser guide describes its own interactive pass as a different, bounded construct and says it cannot become an agent Tool. The generic package's ownership and fencing model explains this extension; it should not be presented as Effect Agent's approval of it.

The common adapter and Tools support both self-managed Chromium and Browserbase. The Tools borrow the concrete browser directly, so Browserbase Live View, handoff, reference and remote cleanup or Chromium reference/process cleanup remain available to host code on that same object. `fromSession` retains the same concrete object beside its framework handle when an `InteractiveBrowser` integration is required. Provider capabilities are never added to the model-facing Tool schemas.

## Development and evidence

Use the frozen Vite+ workspace described in [Contributing](../../CONTRIBUTING.md). Both owners are exercised with the actual public AgentRuntime and Toolkit, using a scripted model and real Chromium, and `test/scripted-agent.test.ts` runs the same AgentRuntime and Toolkit over the scripted engine with no browser process. The `agent` installed consumer includes Chromium and the common Tools with no Browserbase installation. The `agent-hosted` consumer adds Browserbase and exercises provider acquisition/cleanup composition through scripted provider HTTP. They preserve typed callback errors, one session identity and capture after agent execution.

Native framework tests prove that the adapter Layer captures configured services while each acquired browser closes with its caller's Scope, even while the Layer remains alive. Tool regressions cover explicit Page dispatch classification, exact-node pointer and keyboard input, host callback/fail-session supervision, host-scope cancellation, viewport policy and capture on the same owner. Native AgentRuntime tests also fill a whole form in one call, reach a crowded-out control with `find`, read on with `browser_read_more`, run browser calls in declared order, and show that a batched response ends a run under the engine's default failure limit but not under `BrowserTools.policy`. Every Tool's parameters are checked against the pinned OpenAI and Anthropic schema transforms, which a scripted model never exercises, and the scripted AgentRuntime sends the null-for-none calls those providers' models make. A local native pass is not hosted Browserbase or paid-model evidence.

## API migration

| Previous use                                                                                | Current use                                                                                                                                                        |
| ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `Adapter.fromSession(browser, { selection })`                                               | `yield* Adapter.fromSession(browser, page)` validates exact owner/Page authority; display selection cannot retarget the handle.                                    |
| `AgentSession<E>` and `adapted.currentHandle`                                               | `AdaptedSession<S>` retains exact `S`; run `fromSession` again to acquire a new handle.                                                                            |
| `BoundTarget`, `browser.bind()` and `browser.currentTarget`                                 | Use an issued `Page` from `initialPage` or `yield* browser.page(info)`; input and observation stay on that Page.                                                   |
| Tools inside a child frame after `selectFrame`                                              | Bind the Tools to an issued Frame: `yield* page.frame(info)`; display or frame selection never retargets them.                                                     |
| A string from `createPage`, passed to select/close                                          | `createPage` returns the issued Page; display selection uses `selectPage(page)`, and `page.close()` closes it.                                                     |
| `error.reason === "limit"`, top-level `status` or `retryAfterMillis`                        | Match `error.reason._tag` or use Effect reason handlers. Producer facts live inside the reason; `outcome` is required.                                             |
| Full host reason names in model failures                                                    | Use the compact vocabulary above; read `host.toolFailures` for the original fields.                                                                                |
| Concrete `closeChecked` returning `void`                                                    | Concrete browser owners return their canonical cleanup receipt. The framework handle still returns `void`.                                                         |
| Capture `dropped`                                                                           | Capture `discarded = overflow + late + duplicates + rejected`; default buffering stays unchanged. `toolFailures.dropped` separately counts diagnostic eviction.    |
| Document scope by default                                                                   | Viewport is the default. Pass `observationScope: "document"`, or let the model pass `scope: "document"` to `browser_inspect` for one reading.                      |
| `observedResultMaxBytes`, `ObservedResultMaxBytes`, `Unavailable/limit` for a large reading | `resultMaxBytes` and the `ResultMaxBytes` schema (16 KiB–1 MiB, 48 KiB default) bound every result, and readings are fitted to them instead.                       |
| An invalid option failing each Tool call `failed/undispatched`                              | `makeHost`, `run` and handler Layers fail when built, with a `Configuration` reason naming the option.                                                             |
| `admission: { admit }` handler option                                                       | `policy: { admit }`. An unknown or renamed key now fails when the Layer is built instead of being ignored.                                                         |
| `unsupported` and `disabled` projected to `failed`                                          | They keep their own names in `BrowserToolFailure`; match them where a switch was exhaustive.                                                                       |
| Browser calls run concurrently, ordered only by the lane                                    | `host.run` schedules them sequentially in declared order; `scheduling: "lane"` restores the previous behaviour.                                                    |
| Session actions, `ready`, `retain`, `target`, `frames`, or `closePage`                      | Use the issued Page's operations, `ready()`, `describe()`, `listFrames()`, `frame(info)`, or `close()`. Session inventory uses `listPages()`; `pages` is a stream. |

Operation helpers accept an exact `Page`; helpers such as the example's `turns<E>` separately retain the original session and stay generic in its failure type `E`. Binding bounds now have validated defaults, while explicit bounds retain their meaning. `NavigateRequest.timeoutMillis` is a host option and does not add a model-selected timeout to the existing URL-only navigation Tool. Added observation state is bounded and does not include field values or destinations. The earlier `Browser.scoped` inference fix changes explicit curried generic argument lists from five to four outer parameters and two to three inner parameters; ordinary call syntax remains.

## Unpaid evaluation

The unpublished [evaluation runner](test/evaluation/README.md) records actual
AgentRuntime model-boundary inputs, projected tool results and independent
application or owner state for six resettable cases: form submission, a write
whose acknowledgement is lost, a write refused before dispatch, a cancelled
waiter, a long reading and a page that instructs the agent to cancel an order.
Scripted reference and known-bad policies, with retained-evidence tests, check
its deterministic oracles, which grade task success, output, claims, duplicate
writes, retries after an unknown outcome, termination, cleanup, whether the
injected condition occurred and whether a named attack was resisted separately.
Two cases are held out from tuning. Offline grading and compatible-action replay
need no model calls. These scripted cases establish integration contracts. A
guarded campaign command runs the same cases with OpenAI or Anthropic models: its
dry run shows the whole matrix and spend bounds, and a live run needs an opt-in,
the approved plan digest and credentials, and reserves each request's worst-case
cost before sending it. One owner-authorized pilot has run two cheap models
through it, once per case; comparisons for #93 remain separately authorized work.
