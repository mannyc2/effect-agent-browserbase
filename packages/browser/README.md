# Browser automation for Effect

`effect-browser` owns one scoped browser runtime: bounded actions, exact observations, typed page-to-host bindings, live JPEG capture and explicit page holds. `effect-browser/chromium` launches or attaches to self-managed Chromium. [Browserbase](../browserbase/README.md) supplies the same runtime through its own hosted acquisition and cleanup.

This package has no Browserbase or Effect Agent dependency. Its common entry points do not load Chromium process-management code. Playwright is an optional peer loaded when a browser connects; install the pinned `playwright-core@1.63.0` to use that capability. The implementation targets trusted Node and Bun hosts. Data contracts being provider-independent do not imply browser-client or edge-runtime support.

## One owner and two ways to supply it

A `BrowserSession<E>` is the live, host-only capability returned by the supplying implementation. It preserves callback failures and diagnostics of type `E`, one action budget, one native connection and one set of capture/page-control reservations. `implementation` identifies the control implementation. `closeChecked` performs the owner's cleanup and fails if its required cleanup was not confirmed. On concrete Chromium and Browserbase sessions it returns that same frozen cleanup receipt on success; the generic session permits discarding that value. Helpers that only use operations take `AnySession`, an alias for `BrowserSession<unknown>`. Helpers that supervise callback failures must stay generic in `E` or the concrete session so they retain those failures.

All browser operations use issued `Page` and `Frame` objects on the original connection. `Capture.start`, `Capture.stream` and `PageControl` authenticate the exact Page privately; spreading or decoding an object cannot copy authority. An absent registration fails with reason `UnregisteredSession` and outcome `undispatched`. A copy, fabricated value or separately loaded runtime can cause that refusal; it does not establish which occurred. A registered Page with page control disabled still fails `Unsupported`. Tools and adapters bind the issued Page together with its original session for callback supervision and checked owner cleanup. Neither opens another browser.

Mutations on one Page share its permit with its Frames; healthy Pages can proceed independently. Registry operations remain serialized. An observed node remains usable only until an invalidating event; a replaced node is never searched for again. A timed-out or interrupted mutation with an unacknowledged native command has an `unknown` outcome and is never automatically replayed. Its exact page is revoked before bounded closure. Positive closure reports `containment: PageClosed` and preserves healthy pages; unconfirmed closure fences the session and reports `SessionFenced`. This applies to the selected page too. Containment does not make the original action known. `performed` means dispatched input was acknowledged before a later step failed; it also must not be replayed blindly. `undispatched`, `rejected`, `performed` and `unknown` remain distinct outcomes.

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
    yield* browser.initialPage.navigate({ url: "https://example.com" });
    return yield* browser.initialPage.observe({ scope: "viewport" });
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

The same combinator supports `open.pipe(Browser.scoped(use))`, including a reusable `const use = Browser.scoped((browser) => browser.initialPage.observe())` stored before choosing the provider. That unannotated callback sees common browser operations; use an annotated callback or the data-first form for provider-specific members or typed binding diagnostics. The returned function infers the supplying session's callback error independently of its acquisition error. Explicit generic applications must follow the curried overload's revised parameter lists: four outer parameters (`S, A, E2, R2`) and three returned parameters (`E, AE, AR`). It removes the scopes it owns while preserving other required services and error types. Returning a browser, stream or other live capability from `use` does not extend that resource's lifetime. The old provider-specific `withBrowser` methods and `BrowserRuntime.withBrowser` are replaced by this one public operation.

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
  return yield* browser.initialPage.observe({ scope: "viewport" });
}).pipe(Effect.provide(shared));
```

Here `recordReceipt` is the host's bounded receipt sink. Consumers of the same Layer build share
selection, budgets, native admission and lifetime; the Layer does not reset an expired session or
give same-Page operations independent permits. Its acquisition finalizer performs unchecked release and
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
  Browser.scoped(Chromium.launch(policy), (browser) => browser.initialPage.navigate({ url })).pipe(
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

Owned Chromium also watches a parent-owned debugging pipe for disconnection. The pipe carries
no protocol commands; Playwright continues to use the loopback endpoint. If the host exits or is
killed, including before `connect`, the operating system closes the pipe and Chromium exits.
Normal scoped cleanup still checks process-group termination and removes the profile. A killed
host cannot produce a cleanup receipt or remove its temporary profile. Borrowed attachments have
no such pipe and leave their externally owned browser running.

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
An attributed popup/dialog pause quarantines its exact Page and stops its capture and bindings;
healthy peers keep working. The original Page reports `paused` and permits explicit close, while
input remains refused. Recovery requires a drained session handoff and explicit operator release,
then newly acquired Page/Frame authority. Unattributed policy or shared connection failures fence
the session conservatively.

## Browser operations

### Page and Frame authority

`session.initialPage` is the Page acquired on the first connection. `session.listPages()` returns
bounded metadata; `session.page(info)` authenticates it and issues the canonical Page for that
native page and generation. A Page provides navigation, input, observation, exact-node actions,
checkpoint, readiness, viewport control and close. `page.listFrames()` and `page.frame(info)`
issue a Frame with the same document operations for that exact frame. None changes display
selection or opens a connection.

```ts
const stage = session.initialPage;
const scoutInfo = yield * session.createPage();
const scout = yield * session.page(scoutInfo);
yield * scout.navigate({ url: scoutUrl });
const stageObservation = yield * stage.observe();

yield * scout.observe();
yield * scout.screenshot({ fullPage: false });
yield *
  stage.clickElement({
    observationId: stageObservation.observationId,
    elementId: stageObservation.controls[0]!.elementId,
  });
```

Use a control whose inspected role and label match your intent. Each frame has its own current
observation: reading or acting on the scout preserves the stage's exact references. Another
observation of the same frame retires its predecessor. A reference passed through the wrong
Page or Frame fails `Stale/undispatched` before input. Mutation invalidation remains conservative
for the affected page. A detached frame, closed page or old connection generation cannot acquire
fresh authority. A refusal names the session's own reason first: while the session is closed,
expired, fenced or paused, work through any issued Page fails `Closed`, `Expired` or `Busy`, not as
a stale capability. Otherwise a closed Page fails `Closed`, and a Page from an earlier generation,
a closing page or a detached frame fails `Stale`, all `undispatched`. `page.status` is passive
host state, including terminal containment facts, and
remains readable after closure. Reconnect and handoff resume return a bounded `Inventory` with
the current generation and fresh Page metadata. Acquire a Page from that inventory and call
`page.observe()` explicitly; old capabilities stay stale. Native title and URL reads are
non-atomic. The separate `session.pages` lifecycle stream attaches its cached registry snapshot
and journal cursor together.

Observation storage is finite, including snapshots awaiting native disposal. Optional
`automation.observationLimits` sets all six bounds together: defaults are 16 snapshots,
8,192 handles and 64 MiB per page, and 64 snapshots, 32,768 handles and 256 MiB per session.
Reads reserve capacity before native allocation and return `Limit/undispatched` when it is
unavailable. Timeout or caller cancellation does not return a reservation until native work
and disposal settle, or exact positive page/connection retirement proves it unusable.
The snapshot bounds include temporary reads such as facts, screenshots and checkpoints. Leave
one slot beyond each retained frame observation for an action's fresh read; a one-slot bound
supports passive reads alone but cannot read facts or act while an observation occupies it.
Extraction reserves 4 KiB plus the requested text bytes and 512 KiB per requested control;
a picture checkpoint also reserves its picture allowance. A standalone screenshot reserves
4 KiB plus its returned-byte allowance. A plan step's targets reserve, per frame, one
descriptor read at a time (4 KiB plus 512 KiB) and then what each resolved control actually
retains, so a large form refuses only when its retained facts exceed the bound. Released native
resources reduce the retained reservation.

`page.ready({ timeoutMillis })`, `page.describe({ timeoutMillis })`,
`page.listFrames({ timeoutMillis })`, `page.close({ timeoutMillis })` and
`session.listPages({ timeoutMillis })` narrow the owner's deadline. `Capture.start(page, options)`
and `Capture.stream(page, options)` use the same owner and capture budget. With page control
enabled, `PageControl.state(page)`, `PageControl.suspend(page)` and
`PageControl.resume(page, receipt)` authenticate that exact Page and suspension receipt.

### Actions, plans and recording

Issued Pages and Frames expose `run(plan, options)` and scoped `start(plan, options)` on their original owner. `effect-browser/plan-data` supplies one tagged action schema for navigation, exact target input, selection, forms, scrolling and bounded waits. A live plan can name an observed Ref or a Descriptor; durable version-1 targets are descriptor-only, with authored literal values or named inputs. Recording replaces input literals with named slots. `Plan.make` validates live intent, `Plan.decode` validates stored intent, and `Plan.encode` serializes normalized defaults. Ingress checks finite data cost before semantic decoding: at most 128 distinct steps and 1 MiB of encoded data.

```ts
import * as Plan from "effect-browser/plan";

// page is an issued Page on the browser's active connection.
const ran =
  yield *
  page.run(
    {
      version: 1,
      steps: [
        { id: "open", action: { _tag: "Navigate", url: "https://example.com" } },
        {
          id: "search",
          action: {
            _tag: "Fill",
            target: { _tag: "Descriptor", descriptor: { kind: "input", label: "Search" } },
            value: { _tag: "Input", name: "query" },
          },
        },
        {
          id: "quiet",
          action: { _tag: "Wait", mode: { _tag: "Settled", quietMillis: 100, withinMillis: 2000 } },
        },
      ],
    },
    { inputs: { query: "Effect" }, within: "20 seconds", style: "plain" },
  );
const stored = yield * Plan.recorded(ran);
const encoded = yield * Plan.encode(stored);
```

Every step has its own admission and action accounting. Form fields, verification and submit reuse the existing exact-node form implementation; a walk never holds a permit across its steps. `within` captures one absolute run bound, and each step captures its action and queue deadlines once. Resolution, form phases, conditions and optional checkpoints cannot renew those bounds. `through: stepId` returns a successful prefix and the next step's index and id; it does not automatically resume or replay that prefix. Missing input bindings or an invalid `through` fail preparation before any input.

Descriptors compare the full exact kind and label, optional destination and stable field metadata, checked ordinal/cardinality and a bounded main-anchored frame path. Scope normalizes to `document`; a recorded viewport descriptor uses document-wide uniqueness by default. Explicit `ViewportContext` resolution requires checked preconditions. Missing, ambiguous, incomplete or exhausted evidence refuses before input. Descriptor steps resolve private exact nodes within the step's admission without replacing the public observation. A live Ref always keeps its original identity and is never substituted.

`yield* page.resolve(descriptor, { guard })` performs an explicit admitted read and returns a fresh ordinary Ref. It retires that Frame's previous public observation on success. A Page cannot mint a child Frame's Ref: acquire the checked child Frame and resolve there. A plan on a Page can route a main-anchored child descriptor privately to that exact frame without changing selection.

`const operation = yield* page.start(plan, options)` returns a scoped handle before its worker is scheduled. Its `completed` Effect joins one result; repeated joins submit no new input. `operation.cancel` interrupts that worker. `operation.attempts` retains bounded host evidence after cancellation, scope exit or an outer race, including original causes and every native dispatch/acknowledgement phase. Run registrations are bounded to 32 per Page and 128 per session, with at most 1,024 phase rows per step. Evidence overflow prevents complete recording. `StepFailed` distinguishes preparation from an attempted step and retains the completed prefix, current attempt and original `BrowserError`. Its `message` names only the stage, step and reason; the retained steps can hold authored literal values, so log the message rather than the whole error. An acknowledgement survives later verification or postcondition failure; an unknown command stops the walk and keeps the original owner's containment outcome.

`Plan.recorded(ran)` projects only completely captured successful intent. Literal fill/type values become deterministic named input slots; existing input names and source conditions remain unchanged. `Plan.inputSlots(plan)` lists every named input a plan reads, with its step, action path and whether it is typed `text` or a replacement `value`, so a host binds `inputs` to replay a recording without the literal ever entering the stored plan. Failed or incomplete whole forms and unknown attempts are not reusable plans. After a later failure, `Plan.recorded(yield* operation.attempts, { through: completedStepId })` can explicitly retain an acknowledged completed prefix. Capture is based on checked native facts, and missing or omitted identity facts produce `Incomplete` rather than executable descriptor intent.

`yield* page.settled({ quiet: "100 millis", within: "2 seconds" })` uses one owned wait in the pinned document. It reports quiet DOM mutation, scroll, root geometry and viewport signals. It does not establish network, descendant animation or business completion. Native timers work on hidden pages, but browser throttling can still cause an honest timeout. Cancellation retains wait capacity until native observer disposal is confirmed. A page-initiated navigation that replaces the observed document ends the wait `Stale` and confirms that disposal, so the next wait can start. Plain plans use the same browser inputs as ordinary operations; presentation and recording composition stay with the host.

### Replayable session evidence

`session.timeline` publishes one bounded metadata journal for the active connection. An issued
`page.timeline` filters that same journal for its original Page. Snapshot reads and independent
subscribers acquire no browser permit, send no input and cannot stop native capture.

```ts
import * as Timeline from "effect-browser/timeline";

const history = yield * session.timeline.snapshot();
const tail = session.timeline.events(history.resumeAfter);
const appendTime = yield * session.timeline.now;
const fromTime = session.timeline.events({ at: appendTime });
const portable = yield * Timeline.encodeSnapshot(history);
```

`events(cursor)` resumes exclusively after that sequence; `events({ at })` includes events
appended at or after the domain-qualified time. `events()` follows from the current tail when
the stream executes. Snapshots carry immutable events, global available bounds, eviction facts,
terminal state and `resumeAfter`. A quiet Page's filtered snapshot still uses the global
watermark, including when it has no matching events. Evicting every retained event does not
reset that watermark. Requested evicted history and lapped subscribers fail `TimelineGap` with
requested and available cursors. Foreign store/clock identities and future cursors fail
`TimelineCursorError`; consumers choose how to recover rather than silently losing evidence.
An event the journal refuses as malformed or oversized leaves a `MetadataOmitted` marker with
its original target, correlation and tag, so a Page view sees its own gap. An omission whose
attribution was itself refused is unattributed and appears in every Page view.

`session.pages` is a lifecycle stream: it atomically attaches a copied Inventory baseline from
the canonical bounded native registry and the journal watermark, then follows lifecycle events.
Inventory metadata is explicitly cached: unread or omitted title/address fields are `null`.
It grants no live Page authority. `session.listPages()` remains the admitted fresh native
metadata read; its URL/title round trips are non-atomic. Restarting `session.pages` obtains a
fresh baseline after a gap. `Timeline.projectPages` and `Timeline.encodePages` remove cached
addresses, titles and native target IDs from the client projection. Native navigation and capture
boundaries retain bounded host addresses observed at their original callbacks; `Timeline.project`
and `Timeline.encodeClient` strip those nested fields too. `Timeline.encode` and `encodeSnapshot`
encode host evidence and preserve those addresses.

The session facade chooses the current journal when an Effect or Stream executes. Each active
subscription stays on that journal. Reconnect creates a new store identity; old subscribers
drain their available tail and terminate, or report a gap if lapped. A time selector earlier
than the current journal's start fails `TimelineGap`: that history belongs to the previous
journal, which an issued Page's timeline from that connection still reads. Issued Page timelines stay
on their original domain. Page/session terminal delivery does not bypass retention, and
`page.status` retains original containment facts after the corresponding events have evicted.

Events include plan correlation, original native phases, genuine input intervals, navigation,
settled/containment outcomes and capture references. A dispatch means handoff to checked native
implementation; acknowledgement means native completion. A performed preparatory or burst reply
carries `acknowledgement: { subphase, logicalComplete }`; only an acknowledgement without that
fact, or with `logicalComplete: true`, completed logical input. Later follow-up failure remains
separate. Key events contain counts and their units, never text. Individual pointer commands
are `Pointer` events; `Glide` is reserved for an actual bounded intended schedule. Capture IDs,
interval-local frame sequences and boundary attribution refer to the original capture; no
frame bytes enter the journal. `FirstFrame` means first accepted received frame after a
boundary, without proving new-document pixels. Picture native-call intervals remain separate
from DOM/text intervals and screencast receipt times.

Phase `nativeOrdinal` counts original dispatch phases within its `operationId`, rather than
individual CDP commands. `DisplayChanged` carries the selection and qualified running, held or
unknown display state from the same native callback.

Terminal retirement waits for original logical ticket/run outcomes and bounded capture stop
cleanup to publish their evidence. An unconfirmed native stop remains unconfirmed; retirement
does not wait indefinitely for raw native promises. Later native callbacks stay pinned to the
old journal and can be refused once it has retired. Capture `latePhase` qualifies a Watching or
Started callback after the logical interval ended. Original capture snapshots and quarantine
retain their independent native stop and loss facts.

Append timestamps come from the owner's captured host Clock and order with global sequences.
Receipt/source times are payload facts and never backdate append order. `Stamp.offsetNanos`
is relative to that clock domain's origin; its `clockId` is required. Explicit `*Json` schemas
and Timeline encoding helpers represent bigint offsets/sequences as decimal strings. Native
presentation Unix milliseconds remain a separately qualified source clock.

`timelineLimits` on Chromium/Browserbase options, or `automation.timelineLimits` on the runtime,
bounds retained metadata and subscriptions. Defaults are 60 seconds, 4,096 events, 4 MiB,
32 subscribers and 64 KiB per event. Configurable maxima are six hours, 65,536 events, 64 MiB,
256 subscribers and 1 MiB per event. Metadata-byte and per-event limits have a 2 KiB minimum so
canonical terminal and omission evidence fits. Count/time/byte eviction runs on append and read. Subscribers
retain bounded cursor/wakeup state rather than event queues; a slow consumer cannot backpressure
an admitted native action. Returned values are ordinary immutable snapshots, without an archive
registry retaining old journals.

### Admission and deadlines

Ordinary operations on one Page share its permit, including operations on its Frames. Work on
other Pages can proceed independently: a held scout read or typing response does not block
stage input, a stage checkpoint or another Page's capture. Creation, inventory and global
lifecycle operations use the registry permit. Inventory is bounded and non-atomic.

Every admitted operation accepts trailing host-only `OperationOptions`:

```ts
yield * scout.click({ selector: "#advance" }, { admission: { queue: "1 second" } });
yield * stage.checkpoint({}, { timeoutMillis: 2000, admission: { queue: "500 millis" } });
```

Omitting `admission.queue`, or setting it to zero, refuses conflicting work immediately with
`Busy/undispatched`. A positive finite Effect duration allows FIFO waiting for that permit.
The queue defaults to 32 pending callers per Page or registry and 128 across the session.
`automation.admissionLimits.pendingPerPage` and `pendingPerSession` can set either bound to an
integer from 1 through 1,024. `Chromium.layer` and `BrowserbaseBrowser.layer` accept those fields
under their top-level `admissionLimits` option. `QueueFull` reports the refusing scope, maximum and observed count;
`QueueExpired` means the admission wait expired. Cancellation and either refusal dispatch
nothing and consume no action allowance. A granted waiter owns the permit before waking, so a
new arrival cannot overtake it.

The operation deadline and queue deadline start when the Effect executes. Waiting counts toward
`timeoutMillis`, the policy deadline and the browser lifetime; admission never renews them.
The queue deadline bounds only waiting, so admitted work can finish after that deadline. An
operation deadline that ends first reports `Timeout`. These options do not queue away a stale
target, a Page hold, a navigation reservation or a native-wait conflict. The issued Page/frame
authority remains fixed while waiting; display selection cannot redirect queued input.
`Capture.start` and `Capture.stream` accept admission through their capture options. Exact-node
methods keep the host's `ElementAdmission` callback separate from trailing operation options.

`page.status` includes passive `admission` state: the active operation, pending count and bound,
oldest wait age, retained native operations, native wait and stop setup. `session.admission` adds
aggregate counts and registry state. Native capacity remains occupied after caller cancellation
until the actual work settles or exact positive Page/connection retirement proves it unusable.
These host snapshots grant no priority and expose no native handles.

Navigation stopping and Page closure have reserved, bounded cleanup admission, so a full ordinary
queue cannot prevent recovery. Page closure uses fail-fast reserved admission and its operation
deadline when joining an existing close; `admission.queue` does not control those waits. Session closure
preempts work. Handoff, resume and reconnect refuse
an existing ordinary permit holder before installing their exclusive lifecycle barrier; handoff
then drains retained native work within its bound before granting operator control.

### Exact Pages and Frames

The session owns lifecycle, display selection and the page registry. `initialPage` is the Page
issued on the first connection; it remains that original lifetime fact after reconnect. Browser
input and reads belong to issued Pages and Frames. Constructing or running an operation on one
never follows display selection:

```ts
const stage = session.initialPage;
const scout = yield * session.page(yield * session.createPage());
const navigateStage = stage.navigate({ url: stageUrl });

yield * session.selectPage(yield * scout.describe());
yield * navigateStage; // still navigates the original stage
const seen = yield * scout.observe({ scope: "viewport" });
```

`session.page(pageInfo)` checks both local and native identity under owner admission.
`createPage()` returns checked metadata without selecting the page. `selectPage(pageInfo)` and
`selectFrame(frameId)` affect display selection only. Use `page.describe()`, `page.listFrames()`,
`page.frame(frameInfo)`, `page.resizeViewport(viewport)` and `page.close()` for exact page work.
The selected-session actions, `retain`, `pinPage`, `pinFrame` and their target-view types are
removed. The shared operation contract is `PageOperations`.

| Previous API                                                      | Current API                                                             |
| ----------------------------------------------------------------- | ----------------------------------------------------------------------- |
| Session actions, `observe`, `checkpoint`, `ready`, `target`       | Issued `Page`/`Frame` methods and immutable `identity`                  |
| `retain`, `pinPage`, `pinFrame`                                   | `initialPage`, checked `session.page(info)` and `page.frame(info)`      |
| Session `describePage`, `framesOf`, `closePage`, `resizeViewport` | `page.describe`, `page.listFrames`, `page.close`, `page.resizeViewport` |
| Session capture and PageInfo capture target                       | `Capture.start(page)` / `Capture.stream(page)`                          |
| Session PageControl adapters                                      | `PageControl.state(page)`, `suspend(page)`, `resume(page, receipt)`     |

Failed metadata acquisition after creation keeps its original dispatch evidence and never
creates a second page. Page operations preserve typed failures and scoped ownership; a terminal
Page's retained status and timeline remain readable, while new work refuses undispatched.

Each page `createPage` opens is a window of its own, not a tab. Chromium paints only the front
tab of a window, so a screenshot of a tab behind another waits seconds for a compositor frame, or
never gets one, and the page that was in front goes behind each new tab. A window of its own is
painted whether or not another page is in front, so any page can be pictured and read at speed
and the selected page keeps its capture. With a fixed viewport, each new window's contents are
set to it, as the first page's are; a provider-managed or preserved viewport is left to the
browser, which sizes a new window like the last one it showed. A browser that answers the
request for a window with a protocol error, which means it created nothing, gets tabs from then
on. `createPage()` serializes creation and adoption under the registry permit and fails immediately
when it is occupied. Pass `{ admission: { queue: "1 second" } }` to wait FIFO within the same
operation deadline. It does not wait behind another Page's ordinary operation. A refused or
expired caller opens nothing.

Inventory authenticates each native Page before adopting it into the owner's registry,
including popups. `page.describe()` reads its current address and title without reading every
other page. `session.listPages()` reads every page's title concurrently under bounded admission.
Metadata does not itself grant live input authority.

```ts
const stageInfo = (yield * session.listPages()).find((info) => info.title === "Stage")!;
const stage = yield * session.page(stageInfo);
const childInfo = (yield * stage.listFrames()).find((info) => info.parentFrameId !== null)!;
const child = yield * stage.frame(childInfo);

yield * session.selectPage(scoutInfo);
yield * stage.click({ selector: "#advance" });
const childText = yield * child.readText({ selector: "#status" });
```

Issuance changes no display selection and opens no second connection. Each operation keeps its
exact connection-local page/frame authority. Closing its Page, detaching its Frame or reconnecting
makes it stale. Navigation preserves the Page/Frame authority and retires that document's node
references. Holds and in-flight navigation reservations are checked on the issued target.

IDs are opaque and namespaced per connection. After reconnect, read fresh `listPages()`, match
exactly one saved native `targetId`, issue `session.page(freshInfo)`, and reacquire its Frames with
`page.listFrames()` / `page.frame(info)`. Zero matches means gone and multiple matches mean
ambiguous. Never fall back to ordering, local serial, URL or title. A surviving native target
cannot make an old Page or copied metadata current again.

Dispatched input on the observation's own page still retires its references, including `hover`,
`pointerMove`, `wheel` and `scroll`. Hover then click therefore deliberately needs a new inspection.
Page scripts can replace nodes or change relevant state in response to any input; no verb is
assumed harmless. Navigation or closure on that page and reconnect also retire its observation,
even while another page is selected. IDs are opaque and connection-specific; consume the actual
inspection result rather than predicting serials. Attachment, identity and fresh-state checks at
dispatch remain necessary even when the last input targeted a different page.

### Performed plans and absolute starts

`page.run(plan, { style: {} })` uses the named default performed profile; omitted style or
`style: "plain"` keeps plain input. `Plan.validateOptions(value)` validates and normalizes host
options, preserving public `within`, queue admission and performed defaults. Profiles have finite
pointer duration/inset/curvature, key interval/hold and scroll duration/interval bounds. `seed` is
an optional safe integer; the actual chosen seed is retained in run and attempt receipts.
Step-local planning depends on that seed and stable step ID, independently of other Pages or
ambient Random use. It reproduces planned paths for the same geometry, not website behavior or
remote delivery timing. Slips default to probability zero and require explicit opt-in.

The pointer timing uses a chosen bounded Shannon-form policy for measured targets, and explicit
coordinates use a chosen bounded distance policy. The fifth-order progress polynomial gives zero
endpoint velocity/acceleration; applying it to a curved policy path does not claim globally minimum
Cartesian jerk. Constants are library policy, not calibrated human guarantees. Scheduled glides are
output-only compositor metadata: they do not generate hover along the drawn path. Exact native hit
checks and selected node identity remain required immediately before real input. A missing actual
click position stays null even when an intended aim is retained.

A schedule has at most 128 geometry samples per path or scroll, and performed text at most 256
Unicode code points, which expand to at most 768 strokes (a slip adds a wrong key and its
Backspace), independently of action and pending-native capacity. Longer text fails `Limit` with
dimension `code-points` and its measured count before any input. Performed Fill
may focus/select/replace inside its action; Type still requires existing focus. Each performed
logical action costs the same action budget as its plain counterpart. FillForm retains its
per-field admission, verification, partial results and guarded submit.

`startAt` is an absolute bigint on this owner's host monotonic clock, available through
`session.monotonicTimeNanos`. Future starts wait before admission, reserve no Page permit and
never begin before that instant on the owner's clock, so `latenessNanos` is never negative.
A waiting start holds only its run registration, never the timeline: when its Page closes or its
owner pauses, detaches or ends, the run fails preparation at once instead of at its start.
`within` starts at the intended boundary and bounds queueing, preparation, pacing, input and
postconditions together, capped by owner lifetime and each action deadline. Missed preparation
reports `ScheduleMissed` without inventing an attempt; an insufficient pacing budget reports
`TimingBudgetExceeded` before new input. Performed strokes start at their absolute schedule
offsets, so a slow reply delays one stroke rather than every later one. Before each stroke's
first key, the rest of the schedule must still fit the deadline at the round trips the browser
has actually taken; a stroke that could not finish is refused whole, and strokes already
acknowledged stay `performed`. Receipts retain requested/intended/actual start, deadline
and lateness. Cancellation stops future submissions and keeps readable attempt history with the
original Effect Cause. Known preparatory work followed by refusal is rejected with its subphase
receipts; pending input remains unknown, and acknowledged logical input stays performed when a
later check fails.

### An unknown outcome on an exact Page

A mutation whose outcome becomes unknown after dispatch, because it timed out, failed or was
interrupted, never runs again automatically. When the owner can attribute it to an exact Page,
it revokes that Page's admission and asks the browser to close it within two seconds. This
includes issued Page/Frame operations, forms, file transfers,
navigation, initialization and callback retirement. Concurrent close requests join the same
owned closure attempt. Once the browser confirms closure, healthy Pages, their observations and
captures can continue. The original operation still fails with its own reason and `unknown`
outcome, carrying `PageClosed` containment; its Page and Frame authority remains terminal.
`session.diagnostics` records `page-contained`.

Closing the page does not undo what the operation already did. A request it made, a cookie or
storage it changed, a download or a popup it started can all outlast the page, exactly as they
can after a known outcome. Unconfirmed closure or a failure without trustworthy Page attribution
fences the session conservatively and reports `SessionFenced`. A late response never reopens
fenced control. Containment reports owner safety independently of the original action outcome.

The complete [multi-page example](examples/multi-page.ts) keeps an issued presentation Page while
the selected scout supplies observations. It reads and captures the presentation page without
switching selection and returns only data after the shared browser scope closes.

### Typed host failures

`BrowserError` keeps its operation and a required `outcome` (`undispatched`, `rejected`, `performed`, or
`unknown`), while `reason` is a tagged union. Recover by reason without parsing strings:

```ts
const read = session.initialPage
  .readText({})
  .pipe(Effect.catchReason("BrowserError", "Busy", () => Effect.succeed({ text: "" })));
```

`Limit` includes measured `dimension`, `maximum` and `observed` fields. For example, an action
allowance exhausted at two reports `maximum: 2, observed: 2`; it does not count a third call that
was never admitted. `Configuration` and `Malformed` may name a declared schema-field prefix,
never a supplied value or unknown property name. `Provider`/`Transport` may carry `status` and
`RateLimited` may carry `retryAfterMillis`; those fields no longer sit on the outer error. A
`Provider` failure the native engine raised carries `detail`: the first line of what the engine
said, such as `elementHandle.click: Target page, context or browser has been closed`, without
terminal escape codes and at most 512 characters, with every address cut to its origin
(`https://shop.test/…`) and Playwright's call log dropped, since a path, query or DevTools endpoint
can carry a credential. It is a host diagnostic, and the agent tools never project it.
`InitializationError` and the provider's separate resource-error families retain their own
contracts. The Agent tools project host errors to their compact model-facing vocabulary and
retain the originals in the bounded, host-only `ToolHost.toolFailures` snapshot.

### A navigation you can watch while it loads

`navigate` holds nothing open that you can see into: it returns when the document reaches DOMContentLoaded. `startNavigation` is the same single dispatch, left in flight, so a recorder can look at a page while it is still arriving, hold it, and let it finish:

Both accept optional `timeoutMillis` from 1 to 600000, capped by the remaining session lifetime.
Omitting it uses the configured action timeout. Page and Frame calls share the
same navigator; the maintained model `browser_navigate` tool still accepts only its upstream URL
request. This field is the loading deadline, not a promise of rollback on timeout. On a main-frame
timeout from the pinned engine, up to 3000 ms of recovery may follow that deadline. One absolute
recovery deadline includes owner-permit waiting, native setup and acknowledgement, and is capped
by the remaining session lifetime. It is never renewed and cannot extend that lifetime.

```ts
const operation =
  yield * handle.startNavigation(StartNavigationRequest.make({ url, timeoutMillis: 30_000 }));

const early = yield * page.checkpoint({ picture: true }); // what has loaded so far
const receipt = yield * PageControl.suspend(page); // timers, CSS and parsing stop
yield * PageControl.resume(page, receipt);
const { url: loaded } = yield * operation.completed;
```

The owner's permit is released as soon as the navigation is dispatched. While it loads, reads, checkpoints, holds and every other page proceed, and anything that would change _this_ page fails `busy` and `undispatched`. `navigate` runs on the same machinery, so there is one navigator.

- `completed` belongs to that one navigation: a successor reaching the same URL fails it instead of completing it, and its URL is the page that navigated, not whichever page is selected by then. **Interrupting a waiter stops nothing.** The browser keeps loading and nothing is dispatched again.
- `stop` asks the browser to stop loading. Its acknowledgement is a known outcome: `completed` then fails `interrupted`, the page holds whatever had loaded, and the session stays usable. It does not undo anything the page already did. Concurrent callers share their active stop attempt. A busy refusal or cancellation before dispatch allows a later request only after native setup and its port retire; pending or unconfirmed retirement keeps setup capacity occupied. Once a stop is dispatched, every later caller receives that attempt's recorded result, including failure or interruption, without sending it again. A completed navigation cannot stop its successor.
- A main-frame loading timeout asks the same stop coordinator to retire that exact navigation. Acknowledged stop completes it with `Timeout/unknown` and leaves the owner open: partial content remains inspectable and deliberate subsequent input is allowed. An explicit stop racing recovery shares its attempt; a completed predecessor cannot stop a successor. The `unknown` outcome still says nothing about page effects before cancellation.
- A failed or unacknowledged recovery, replacement navigation, detached frame or other unknown native outcome closes that exact Page, with a session fence if closure is unconfirmed. Pinned child-frame timeout also uses Page containment: `Page.stopLoading` acts on the whole page, so automatic frame-local cancellation is not claimed. Explicit stop retains its page-wide meaning.
- Leaving the operation's scope unsettled retains an unknown outcome and closes its Page; healthy Pages survive confirmed closure. Neither navigation nor a dispatched stop is replayed, and no timeout or acknowledgement promises rollback, an unchanged DOM, or termination of every page timer or worker.

A read can inspect a loading Page. If a native read fails because its document was replaced or navigation is in flight, the error is `target-changed` and `undispatched`, which permits another read. A read is never a mutation. A held page is not read at all; take the checkpoint before the hold and keep it.

Locally, a hold during an incremental response stops parsing as well as timers: a chunk the server sends meanwhile is not parsed until resume. That is an observation of the pinned Chromium, not a guarantee about hosted sessions.

### What is on screen, and what a host may know about it

`page.observe()` reads the whole document. `page.observe({ scope: "viewport" })` keeps only text and controls that are on screen and reachable, and says what it left out:

```ts
const seen = yield * page.observe({ scope: "viewport" });
seen.viewport; // { clippedText, coveredText, uncertainText, unreachableControls, exhausted, ... }
```

Visibility here is geometry and hit-testing, never a pixel comparison, and the counts say which was which. Text is kept when its line boxes intersect the viewport and the browser finds its own element at a sampled point. A text node that crosses the viewport edge contributes only its lines on screen (`clippedText`). Text behind another element is left out (`coveredText`). Something that takes no pointer events is invisible to that hit test, so for a point beneath one the browser is asked, on the existing connection, which box is on top with pointer events ignored; that also finds boxes inside closed shadow roots. A box that paints at the point, with a fill, border, shadow, filter, image, canvas, SVG, text or a generated `::before`/`::after`, covers the text (`coveredText`); an empty transparent container over the whole page hides nothing. Text the browser could not settle, for example beneath a second such box, in a child frame, or past 256 such points in one reading, is left out as `uncertainText` rather than called visible. `exhausted` means the traversal budget ran out first and the reading is known to be incomplete. Canvas pixels and compositing effects are not interpreted.

`match` narrows a reading, in either scope, to what contains a piece of text, ignoring case: text lines, and controls whose label contains it. A select is kept when its own label or any of its option labels matches, with its options beside it. The filter runs inside the page before `maxControls` and `maxTextBytes` are spent, so twenty header links cannot crowd out the one control asked for:

```ts
const found = yield * page.observe({ scope: "document", match: "create account" });
found.match; // "create account"
```

It filters what is read and never searches for, re-finds or substitutes a node: references still come from the reading itself, with every exact-node check. What a matched reading leaves out is not evidence of absence, which is why it names its `match`.

An `Observation` is safe to show a model, and the adapter's `browser_inspect` Tool fits it to its model-result bounds. It carries no destination, form target or field value, in either scope. What a host needs to decide whether a control may be acted on is a separate, host-only read from the exact node:

Controls also carry optional `checked`, `selected`, `inputType` and `required`. Native checkbox
and radio state comes from the element; applicable ARIA state accepts only explicit true/false.
Mixed, unknown or invalid values are omitted, not converted to false. Selection describes an
option or selectable control, never an invented state for an entire `<select>`. Required state
is emitted only for applicable native inputs or reviewed ARIA roles. State that can change an
input decision participates in the exact-node fresh-facts check; field values and destinations
remain excluded from the model projection.

```ts
const facts = yield * page.controlFacts(reference);
// kind, label, disabled, editable, inputType, autocomplete, formMethod, box, placement, hitTest
// destination: the resolved link target, or where this control submits its form
```

`destination` is resolved by the browser against the document's base URL, and honours a `formaction` override. It can carry a token, which is why it is not in an `Observation`. An over-long destination is left out, never cut. No value and no markup is ever included.

A reference is to the control that was inspected, not merely to a node. If the same attached node now has a different destination, input type, autocomplete category, form method, label or disabled state, acting on it fails `stale` and `undispatched` before input, exactly as it does for a replaced or detached node. A performed action also rechecks after delayed preparation; an acknowledged preparatory scroll or focus retains its `rejected` outcome if that later check fails. An existing reference is never substituted by a selector or label lookup. A text-entry control's label never comes from what was entered into it: a textarea, an editable element or a `textbox`, `searchbox`, `combobox` or `spinbutton` role is named only by `aria-label`, `placeholder`, its `<label>` or `aria-placeholder`, so typing neither renames it nor puts the typed text into a recorded descriptor.

When a decision has to be current at dispatch, pass a policy. It is evaluated on facts read from that exact node immediately before the input:

```ts
yield *
  page.fillElement(reference, value, {
    admit: (facts) => facts.inputType !== "password" && facts.autocomplete !== "cc-number",
  });
```

Anything but `true`, or a policy that throws, sends no further input and fails `denied`. Performed pointer delays and fill preparation re-sample the original exact node and invoke the same policy again before further input. The policy is a plain synchronous function on purpose: it runs while the Page's permit is held, where waiting on a model or a network call would stall other ordinary operations on that Page. It is not an atomic check-and-input transaction, because page script can still run before the native input lands.

`fillElement` also refuses, undispatched, what the maintained engine would otherwise refuse only after dispatch, where an unknown outcome would close that Page or fence the session if closure is unconfirmed: a hidden control (`not-visible`), a disabled one (`disabled`), one that is not an editable input, textarea or content-editable element, and text that a `number`, `date`, `time`, `range` or other value-typed input would not keep (`unsupported`). The value is checked on a detached copy with the same constraints; the page's own control is not touched until the fill is sent.

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
  page.fillForm({
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

Every step is its own admitted and charged action on the exact observed node, after the same fresh checks as `fillElement`, `selectOption` and `clickElement`, including the host's `admission` policy. Each step, the verification read included, captures its own action deadline and queue window when it is requested, so `timeoutMillis` and `admission.queue` bound every step rather than the whole form; inside a plan, the step's captured bounds still cap them all. One difference is deliberate: a control may have become enabled since it was observed, such as a submit button a form enables once it is complete, but it must be enabled when its step runs. The observation stays usable for this form's own steps only. Navigation, a page hold or any other caller's action still retires it, and the form retires it when it ends.

After each dispatched step, the page's own handlers get at least two rendered frames and `settleMillis` (50 by default, at most 5000, 0 to skip). A text field is then left, as a person moving on would leave it, so formatting a page applies on blur belongs to that step. Before submit, `verify` (true by default) reads every field again and stops the form when one no longer holds what its own step left there: a re-render, an asynchronous reset, anything that changed a field after it was set. What was read is compared on the host and never returned.

The first refused or uncertain step ends the form, and nothing after it is sent. A form is not a transaction: fields set before the stop stay set, and `stopped` says where it ended (`field`, `verify` or `submit`) and why, as a `BrowserError` whose outcome says whether that step itself was dispatched. A toggle the page would not change stops with `failed` and `rejected`. `submitted` is true only when the submit click completed. The operation fails outright only when its first step does, exactly as that single action would.

### Bounded waits that leave room for recording

`waitFor({ selector, state })` still supports the host's bounded selector conditions: `visible`,
`hidden`, `attached` and `detached`. It captures the issued page, frame and document when admitted.
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

While a wait is pending, `checkpoint`, `listPages` and ordinary bounded reads can use the normal
permit. Mutations, another navigation and page holds on the waited page are refused before
dispatch. Input and observation on another page may proceed; replacing the waited frame's observation is refused until the logical wait ends. Closing a page or session remains available and cancels affected waits.
No general read-under-write bypass has been added.

One native wait may be outstanding per exact Page, with a finite session bound of 32. Cancellation and timeout release the
logical barrier without inventing an uncertain mutation, but retain native capacity until the
actual native promise and any required handle disposal settle, or that exact connection retires.
Consequently another wait can still receive `Busy/undispatched` after its predecessor's caller
has stopped waiting. Status `busy` includes that retained native capacity; it does not mean every
ordinary operation is blocked. A cancelled exact-node wait keeps only its leased node alive when
the observation is replaced, and its late cleanup cannot dispose a successor's references.

### Passive checkpoints for a recorder

`page.observe()` replaces that frame's current observation, so a recorder calling it on the same frame would retire the references an agent is about to use. `page.checkpoint()` is the passive path: viewport text, control facts and, when asked, a PNG of the viewport.

```ts
const checkpoint = yield * page.checkpoint({ picture: true });
```

It issues no references, is not a mutation, and leaves the action observation and the selection exactly as they were, so inspect, checkpoint, then act on the inspected node all compose. It is host-only, because it carries control facts. Text and picture are read one after the other, never atomically: the interval is on the host monotonic clock, and `documentChanged` says the document was replaced in between. A held page is refused `busy` rather than woken to be read: take the checkpoint before the hold and keep it.

`checkpoint` and `controlFacts` each consume one separate host-read allowance, configured by
`Chromium.layer({ maxHostReads })` or the corresponding provider Layer. The default is 10,000,
with an explicit integer bound of 1–1,000,000; invalid values are refused rather than clamped.
Exhaustion reports `Limit { dimension: "host-reads", maximum, observed } / undispatched` while the
owner stays open. These operations still obey the same lifetime, bytes, deadline and admission
concurrency bounds: a checkpoint can execute page script and is not unlimited free work.
`observe`, `readText`, `screenshot` and `waitFor` continue consuming the model-reachable action
allowance, which `status.actions` reports. Neither budget is a tool parameter, and `maxActions`
has not become mutations-only.

### Real pointer and wheel input

`pointerMove`, `hover` and `wheel` send the input a person's hardware would, so pages see trusted events, `:hover` applies, and the browser itself decides what is under the pointer. `scroll` stays what it was: script in the page, instantaneous, raising no wheel event. That difference is how a recording tells one from the other.

```ts
const handle = session.initialPage; // exact original Page authority

yield * handle.pointerMove(PointerMoveRequest.make({ to: { x: 140, y: 100 } }));
yield * handle.hover(HoverRequest.make({ selector: "#menu" }));
// A nested scroll container under the pointer scrolls, not the page.
const receipt =
  yield * handle.wheel(WheelRequest.make({ deltaX: 0, deltaY: 240, at: { x: 420, y: 120 } }));
```

Coordinates are CSS pixels in the main frame's viewport. Each logical input is one action on its issued Page or Frame. Performed plans add bounded pacing and output-only glide evidence; viewers draw cursor artwork from projected evidence without injecting presentation DOM into the website.

`hover` places the pointer on one exact element where it is, by selector or by the node an observation named (`page.hoverElement`). It never scrolls to reach it, because that would hide a scripted scroll inside a native-input operation. If the pointer cannot be placed on the element (it is outside the viewport, has no area, or something covers it) the call fails `not-visible` and `undispatched`.

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
const handle = session.initialPage; // exact original Page authority

// Focus is the page's business. A real click gives it, and keys then follow it.
yield * handle.click(ClickRequest.make({ selector: "#from" }));
yield * handle.type(TypeRequest.make({ text: "Vienna" }));
yield * handle.press(PressRequest.make({ key: "Backspace" }));
yield * handle.press(PressRequest.make({ key: "k", modifiers: ["Control"] }));
// Sent only if `#from` still has focus; otherwise nothing is sent at all.
yield * handle.press(PressRequest.make({ key: "Enter", into: "#from" }));
```

Keys go to whatever has focus in the issued page, in whichever frame that is, because that is where the browser sends them. `into` narrows that to one exact element, which must already have focus or hold the element that does, through any open shadow root. If it does not, the call fails `not-focused` and `undispatched`. It never focuses the element for you, for the reason `hover` never scrolls: that would hide a scripted focus inside a native-input operation. `page.pressElement` and `page.typeElement` apply the same rule to the node an observation named and take the same host admission as `fillElement`, so switching from `fill` to real typing gives up neither exactness nor the check on fresh control facts.

A key is spelled as the `KeyboardEvent.key` the page will see, and the vocabulary is closed: `Enter`, `Tab`, `Backspace`, `Delete`, `Escape`, the four arrows, `Home`, `End`, `PageUp`, `PageDown`, or one printable ASCII character (a space is `" "`), with `Shift`, `Control`, `Alt` and `Meta` as modifiers. The native engine parses a key string, chords included, and begins holding the modifiers before it has validated the key, so nothing reaches it that was not reviewed here. A modifier other than Shift makes a chord rather than a character, and nothing is typed.

`type` sends up to 256 characters as one charged action under a single action timeout. It submits ordered native input in windows of at most 16 code points and 32 commands, without waiting for every individual reply. Each normal stroke ends at key-up, and the window drains before another begins. The owner is checked before every command, including key-up: a fence stops unsent input, and no interrupted run is replayed or repaired. Failure while dispatched input is still unacknowledged leaves an `unknown` outcome; the owner closes that exact page, or fences the session when closure is unconfirmed. Failure after all earlier input was acknowledged reports `performed`. Neither result replays the run. A canceled caller does not release native typing capacity; unresolved attachment, replies or failed port cleanup retain it until confirmed retirement. A run whose replies all succeeded leaves its private port attached for the next run on the same Page. Each Page owns its port, with at most 32 retained ports across the connection; switching Pages does not detach another Page's idle port. Positive Page closure or connection retirement releases its capacity.

With `into`, the original node and document must still have focus before each subsequent window. Focus is never repaired. Commands already submitted in a window can land after focus moves. Once that window has successfully drained, a later `not-focused` refusal reports `performed`: earlier input was acknowledged, and the refused window sends nothing.

Performed typing checks focus once before each stroke, never between a key and its release: a
key whose own default action moves focus (Tab, an Enter that submits, an auto-advancing field)
still completes its stroke. A fully acknowledged stroke, including its key and modifier releases,
retains `performed` evidence if a later stroke is refused. An acknowledged text insertion, the
Backspace that erases a performed Fill's old value, a filled form field and an acknowledged
scroll sample do the same. Only focus, selection and scroll-into-view preparation remain partial
and report `rejected` when nothing else landed; unresolved key input still reports `unknown` and
receives the original containment policy. A later failure never weakens what was acknowledged.

A character the US layout cannot produce is committed as text, the way an input method commits it: the field changes and no key event says so. Plain `type` sends a shifted character as its own key with `shiftKey` false. When a page reads the modifier, send that stroke through `press` with `Shift` held, spelling the key as the page will see it: `{ key: "A", modifiers: ["Shift"] }`. Spelled `"a"`, the engine sends `a` with Shift down, which is what Shift produces with Caps Lock on. Control characters are refused in text because the engine presses Enter for a line break; a named key is always its own `press`. Performed plans hold Shift for uppercase and shifted punctuation and pace complete balanced strokes under one logical action. A stroke remains unresolved until its key and modifiers are released; quiet intervals do not renew the absolute deadline or retain unresolved native replies.

A press waits for native input acknowledgement, without waiting for resulting navigation. If Enter submits a form, wait for what the next document shows with `waitFor`. A receipt carries the same target, pointer position and interval as any other input, and never says which key was pressed or what was typed. Typing a secret is still more observable than one `fill`, because the page sees every stroke; prefer `fill` for one unless the page requires keys. Both operations are available in the model-facing toolkit in `effect-agent-browser`.

The connection endpoint is read through the exact allocated session, so a provider reply that names a different session is refused before any CDP attachment.

Persistent Browserbase contexts require a live writer permit from `ContextCoordination.withWriter` when writes are persisted. Detach/reconnect is opt-in with `keepAlive`; reconnect creates a new handle generation, verifies the selected target, obtains fresh state, and never replays pending input or treats serialized agent state as a live browser.

Human handoff blocks new admission and drains native work within a bounded interval before
pausing automation and returning host-only Live View material. Failure to establish that drain
fences the session and grants no handoff. Resume requires an explicit operator-release signal
and returns fresh bounded Page inventory under the lifecycle permit; observing a newly acquired
Page is explicit. A failed handoff does not silently resume automation. Live View URLs are temporary bearer material; iframe styling is not an authorization boundary. Live View is also where browser-window presentation already exists for watching a session as it runs, and it is the provider's: beside each full-screen URL Browserbase issues a bordered one (`debuggerUrl`, "mimic a real browser with borders"), and a navbar that `navbar=false` hides. This package decodes and returns only the full-screen URL. The bordered one carries the same control authority and would be issued under the same rules, so surfacing it is a small host-only addition whenever something needs it; nothing here does yet, so it is not exported.

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
      yield* session.initialPage.navigate({ url: "https://portal.example.com" });
      yield* session.initialPage.ready();
      return yield* session.initialPage.observe();
    }),
);
// run requires Chromium and ShowSettings. Browser.scoped discharges both the
// callback's and the use function's Scope, but neither one's other services or errors.
```

Registration is installed before this connection creates any document, and permissions precede the bundle. It is still not readiness: an asynchronous step cannot pause a website's own scripts, so a document is ready only when its expression resolves to exactly `true`. Readiness is keyed by frame and document epoch and evaluated once per document, so a completed wait can never ready the document that replaced the one it observed.

Each binding accepts exactly one JSON-compatible argument and returns the output codec's **encoded** JSON value. A transforming codec such as `Schema.FiniteFromString` therefore exposes a string to the page while its host handler works with a number. The native callback validates the actual caller's allowed origin and document before input decoding, immediately before invoking the handler, and before replying. This uses Chromium's execution-context identity and `uniqueContextId` on child CDP sessions belonging to the existing connection: a frame URL, a page-supplied origin, and a reused numeric context id are not authorization. The pinned Playwright `exposeBinding` callback supplies a frame but not the calling document's identity; it is deliberately not used as a weaker substitute. No raw protocol or second browser owner is exposed.

Plans admit at most 16 uniquely named bindings. Omitted binding options default to `maxConcurrent: 1`, `maxInputBytes: 65536`, `maxOutputBytes: 65536`, `timeoutMillis: 10000` and `failureMode: "reject-call"`. Name, exact origins, codecs and handler remain required. Explicit bounds/mode pass the same validated registration path; zero, null or excessive values are rejected, never clamped. `combine` selects the most conservative `existingDocuments` policy across its scripts, even when their origin sets differ. Admission reserves capacity before native validation, codec work or a callback fiber starts; a timed-out native operation retains that reservation until it actually settles, including across reconnect. The page wrapper additionally rejects cyclic, sparse, accessor-bearing, non-plain, non-finite and non-JSON input rather than silently changing it through `JSON.stringify`. Its traversal admits at most 64 levels and 65,536 nodes; the configured byte limit still applies. Native target and default-document registries are finite, and closed native targets retire their authority immediately.

`reject-call` rejects only the affected invocation and permits subsequent healthy calls. `fail-session` completes `session.failure` with the original typed consumer cause and fences the owner. A call from a document outside the binding's origins is refused before admission under either mode: it takes no capacity, never reaches the codecs or the handler, and cannot fail the session. It is counted as rejected and recorded as a `reject-call` failure with reason `origin`. Pages receive only `BrowserBindingError: Browser binding call rejected`, with no host stack, consumer error payload, credentials or SDK cause. `session.bindingDiagnostics` is a bounded **host-only** snapshot containing per-binding accounting and the latest 32 typed causes; do not serialize it into a Tool response. Callback service reads run independently of a browser mutation. Reentrant browser work on that same Page follows ordinary admission: it fails `busy` and `undispatched` by default, or waits under an explicit finite queue. Other healthy Pages can proceed independently.

`Browser.scoped` supervises fail-session errors and requires the owner's checked cleanup. Explicit `acquire`/`launch` retain the typed failure signal and detailed cleanup receipt for callers that need to manage that decision themselves. Teardown synchronously closes callback admission, interrupts managed callback fibers, removes this connection's registrations, disconnects locally, and still invokes the supplying lifetime’s release when a prior cleanup step fails. Reconnect installs fresh callable registrations, never replays an old invocation or a consumer init script into an already-running document, and cannot reuse quarantined callback capacity.

Operations that depend on an initialized document wait for the current one. Navigation, selection and page management do not, so initialization cannot deadlock the navigation that produces the document it is waiting for. A document that was already running when the bundle was registered — the page you attach to, or the one a reconnect finds — never ran it: `RequireFreshNavigation` reports `RequiresNavigation` and refuses dependent work, while `AcceptAlreadyRunning` verifies the requirement against that document instead of assuming it. Neither reloads a page whose work may be uncertain; that stays your decision. `session.initialPage.ready()` reports the current document without charging an action, and an origin outside the plan is reported as `NotApplicable` rather than waited on.

The reviewed permission subset is exercised against real Chromium. Provider extensions, persistent contexts and provider reconnect evidence belong to the supplying integration; see the [Browserbase guide](../browserbase/README.md).

## Live capture and presentation

For a frame-processing pipeline, use `Capture.stream(page, options)`. It starts only when consumed and owns one interval per subscription. `Stream.take`, consumer failure and interruption all finish that interval before the stream completes, while the enclosing browser stays open. A new subscription creates a new interval; concurrent subscriptions on the same page still fail `busy` under the existing reservation. Capture bounds and native-stop quarantine rules are unchanged.

```ts
import { Stream } from "effect";
import * as Capture from "effect-browser/capture";

const firstFrame = Capture.stream(page, { lifetime: "page" }).pipe(
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
  Capture.start(page, {
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

Closing, navigating, detaching a relevant frame, or resizing the captured page ends its interval explicitly without ending a sibling page's capture. `Capture.start(page, { lifetime: "page" })` instead follows a page's main frame across documents: start it before a navigation and it covers the loading in between. Same-document URL changes leave document-lifetime capture and observations active. A page-lifetime interval records those changes with `sameDocument: true` and keeps the current document number; only a cross-document commit advances it. The native screencast is never restarted for a navigation, so a boundary is not a gap this package introduced. Each frame carries the `document` it was received during (0, then one more per new document), and the summary's bounded `documentBoundaries` give the last sequence before each URL change and the address it reached, with `initialUrl` for document 0. That is attribution by receipt order, not proof of whose pixels a frame shows: one received just after a navigation can still show the document before it. Selecting another page or frame does not invalidate an unrelated interval. Handoff pause, connection loss, an uncertain owner and session closure still invalidate all child intervals. A confirmed native stop releases only its own reservation; a failed stop on a live page keeps that target quarantined until a late stop confirms or the page definitively closes. Stopping a child capture does not close its browser. The frame seam has **no website-audio source**, so this package does not synthesize silent samples or infer audio support from a video container. Caller encoding is demonstrated in [the caller encoder example](../browserbase/examples/record-video.ts); the example decodes every generated frame with the caller's FFmpeg and checks presentation timestamps and pixel checksums. Native acceptance requires changing pixels and source-time agreement rather than accepting container headers as video evidence. Filming across a navigation with one page-lifetime interval, resampled onto a constant-rate reel with the address of each document reported, is demonstrated in [the footage example](../browserbase/examples/realistic-footage/README.md).

Same-document detection uses the pinned Playwright 1.63.0 client `Frame` event `navigated`: `newDocument` is absent for URL-only changes, and the client emits this event synchronously before `Page` emits `framenavigated`. A runtime missing that private signal fails explicitly rather than treating URL changes as document commits.

### Read metadata while capture is running

```ts
const interval = yield * Capture.start(page, { lifetime: "page" });
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

Every summary and snapshot includes `qualification`: this exact target's authority phase,
containment facts, and the owner's phase and generation. A revoked Page may still be awaiting
closure; `PageClosed` appears only after positive native closure, independently of `nativeStop`.
Later `snapshot` and `completed` reads can retain that confirmation even when capture ended
earlier. The original action outcome and capture end reason remain unchanged. A terminal Page
requires explicitly fresh authority and intent before another capture can start.

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
- an address for every document a frame can name: `initialUrl` for document 0, read in the same turn the watch is installed, and a `url` on each cross-document boundary, read inside the navigation event that committed it. Page-lifetime captures separately mark same-document URL changes without advancing the document number. An application that samples `observe()` between actions can learn an address, but never when it became the address. One longer than 8192 characters is `null`, never cut into an address the page did not show.

A cross-document boundary is the commit, and it is the only moment of a navigation an application cannot see for itself. A same-document boundary records a URL change without claiming that a new document committed. When a cross-document navigation started and when its document finished loading are yours to stamp around the operation that caused it, because you made the call: `startNavigation` returns at dispatch and its `completed` resolves at DOMContentLoaded. Frames and receipts use the session's captured Effect `Clock`; a later caller Clock override does not change their domain. Capture `yield* Clock.Clock` when opening the session if you need raw host stamps on that same clock. `session.timeline.now` supplies the qualified offsets used by journal intervals. A title is page state that changes whenever the page likes, not part of a transition: read it with `page.describe()` when you need one, and stamp that read yourself.

The two clocks are never related for you. `sourceTimeMillis` is the browser's wall clock; everything above is the host's monotonic clock; on a hosted session they differ by an offset this package cannot observe. Every frame it receives is already late by the very capture latency it would be trying to measure, and nothing else it is handed carries the browser's time. Relating them takes a round trip into the page, which costs either a charged action or a registered binding, on a schedule only the application can choose, and it fails on a held page. So place input on frames by receipt time, which is always available and late by the capture latency, or measure the offset yourself with a four-timestamp exchange over a typed binding, as NTP does: the page stamps when it called and when the reply arrived, the host stamps when it received and when it replied, and half the best round trip is the error bound to report beside the offset.

## Explicit stage-page holds (opt-in)

Set `pageControl: true` on `Chromium.layer` or `BrowserbaseBrowser.layer` to use the host-only `page-control` module. The default remains off. `PageControl.suspend(page)` returns a live `PageSuspension`; `PageControl.resume(page, receipt)` consumes that exact receipt. Use an issued Page from `session.page(info)` or `initialPage`. Selection can move to the scout without invalidating the receipt, but connection loss, external target invalidation, completed resume, or another session does invalidate it. Holding or resuming a page may run its `freeze` and `resume` handlers, so nothing observed on _that_ page may be acted on unchecked afterwards: a reference fails `stale` until `page.revalidateElement(reference)` confirms it is still attached and still the control that was inspected. That check sends nothing, never searches for a substitute, and refuses a replaced, detached or changed node. An observation of another page is untouched, so an agent keeps driving the scout while the stage is held. `PageControl.state` reports the last acknowledged local state, not proof about a lost remote connection.

This opt-in uses maintained CDP attachment with `noDefaults: true` and owner-controlled per-page focus emulation. It intentionally does not support `keepAlive`, reattachment, human handoff, or popup/dialog `pause` policies. These combinations fail before acquisition; use the existing `retain`/`close` popup policies and `dismiss` dialog policy. Resume explicitly activates the native page without changing SDK selection. Do not enable it where another native client owns focus. Modeled input, DOM reads, waits and viewport changes on held/unknown pages fail before dispatch; the scout remains operable. Page close and session close remain available. Capture does not thaw a held page; frame consumption and acknowledgements never suspend/resume it implicitly.

The native tests cover page timers, RAF and CSS animation, scout progress with both pages captured, an already-paused animation, and restoration of a non-default rate. Resume waits for one bounded real RAF in an isolated world at rate zero before restoring that rate, avoiding Blink's stale pre-hold animation clock. In-flight callbacks are not undone. Date/wall time, network, media/audio, workers/service workers, and external/provider actions are not promised frozen. This is presentation control, not a security boundary or browser virtual time.

Unknown partial native failures close the exact Page, preserving healthy peers after confirmed closure; unconfirmed closure fences the session. There is no success receipt, automatic rollback or retry. Scope cleanup never sends a hidden resume: it closes the owned session/connection. Chromium may reset animation state on CDP detachment, so a previous hold acknowledgement does not guarantee remote clocks remain held after connection loss. Hosted-provider equivalence has not been tested.

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
        const observation = yield* browser.initialPage.observe();
        const accept = { observationId: observation.observationId, elementId: "accept" };

        const first = yield* browser.initialPage.clickElement(accept).pipe(Effect.flip);

        expect(first).toMatchObject({ reason: { _tag: "Timeout" }, outcome: "unknown" });
        const retry = yield* browser.initialPage.clickElement(accept).pipe(Effect.flip);

        expect(retry).toMatchObject({ reason: { _tag: "Closed" }, outcome: "undispatched" });
        const clicks = (yield* browser.control.calls).filter((c) => c.operation === "click");

        expect(clicks).toHaveLength(1);
        expect(clicks[0]).toMatchObject({ dispatched: true, settled: "failed" });
      }),
  ),
);
```

`browser.control` is the test's side of the scripted browser. The browser outlives any one connection, as a keep-alive browser does: a reconnection to the same address finds the pages it left, and the control keeps working while no connection is open, so a test can change a page while its owner is detached. `connections` lists every connection made to that browser and how each ended so far (`open`, `closed`, `dropped`, `close-failed`, or `refused` by the script's `connections: ["refuse", …]`), which makes a connection an owner left open visible. `next("disconnect", …)` scripts the owner's native teardown: `Fail` makes it fail, so the receipt reports `connection: "failed"` with a `disconnect` issue, and `Hold` parks it at a gate however long cleanup waits. A navigation stop is recorded in `calls` as `navigate-stop`, and its arms apply before or after it is sent. Closing the exact affected page after an unknown outcome is recorded as `close-page`; arming `close-page` with `Fail` makes that close fail, so the owner fences. The rest of `browser.control`: `next(operation, outcome)` arms what the next admitted call of one operation does. `Fail` with `outcome: "unknown"` dispatches and then fails: acknowledged exact-page closure preserves healthy peers, while failed closure fences the session and refuses every later mutation `Closed` and `undispatched`; `Fail` with `undispatched` or `rejected` never dispatches. `Hold` parks the call at a `Gate` before or after dispatch, so a test can interrupt or time out a call at a known point and then check what the owner made of it. `Disconnect` drops the connection inside the call. `calls` is the recorder: every admitted call with its operation, page, node, `dispatched` and `settled`, and never a filled value, typed text or address; `document.values` and `document.files` hold those separately. `document.replace` swaps the page's document as a navigation would, so retained nodes and pending waits go stale and a capture learns of a new document; `document.update` changes the same document in place, so controls that keep their `id` keep their identity and waits re-evaluate. `capture.emit` hands a frame to a running interval, `invoke` calls a registered binding as a page would, and `disconnect` drops every open connection outside any call. `closeChecked` returns a `ScriptedCleanupResult`, and `onCleanup` receives it, as the concrete owners do.

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
| `plan`                   | Live plan construction, durable encoding, recording and typed run failures            |
| `plan-data`              | Bounded actions, descriptors, conditions and durable plan schemas                     |
| `timeline`               | Live evidence capability, explicit JSON codecs and sanitized lifecycle projections    |
| `timeline-data`          | Bounded evidence, cursors, clock offsets, snapshots and typed gap/resource errors     |
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
