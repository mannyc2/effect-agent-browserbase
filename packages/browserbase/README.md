# Browserbase for Effect

`effect-browserbase` owns the whole Browserbase surface for an Effect application: account identity and transport, session, context and extension resources, one owned browser over Playwright/CDP — allocated or borrowed — with trusted registrations, modeled file selection, bounded live capture, explicit page holds, the provider's recordings, replays, uploads and website downloads, and the platform APIs outside a browser session (projects, certificates, Search, Fetch, Agents, Functions and webhooks).

It has no Effect Agent dependency. Playwright is an optional peer, loaded lazily and only when a browser actually connects; a consumer that just reads artifacts never imports it. The package targets trusted Node and Bun hosts. It is an unpublished maintainer-review candidate: hosted provider behavior requires separate validation, and ordinary tests never create a paid Browserbase session or invoke a paid model.

## One account, then resources

Construct one account Layer and provide it to everything else. Credentials, approved artifact origins and request bounds live there and nowhere else; a browser recipe cannot carry them.

```ts
import * as Account from "effect-browserbase/account";

// Reads BROWSERBASE_PROJECT_ID and a redacted BROWSERBASE_API_KEY from the active
// ConfigProvider (the environment by default) when the Layer is built.
const account = Account.layerConfig({
  // Your project's own recording-delivery origin; see below for how to find it.
  artifactOrigins: ["https://recording-delivery.example"],
});
```

`Account.layer({ projectId, apiKey: Redacted.make(key), ... })` takes the same authority explicitly. Either one bundles every resource service on a single Client, so credentials are composed once instead of per service; each service still exports its own `layer` when you want a narrower set. `BrowserbaseBrowser.layer` stays separate, because a browser also fixes budgets and a connection lifetime that an account does not. The Client uses Effect's `FetchHttpClient.Fetch` reference, which already defaults to `globalThis.fetch`; provide a different `fetch` only when you need one.

`artifactOrigins` is the exact set of HTTPS origins this client will fetch provider media from, and it is deliberately empty by default: recording downloads and replay media are refused with `unsafe-url` until you approve a host. Browserbase documents only a "signed CDN URL" and does not publish that origin, so discover your own rather than copying anyone's — request a recording for a completed session, read `downloadUrl` from `GET /v1/sessions/{id}/recording/downloads`, and approve exactly its origin. A hosted run on 21 September 2026 confirmed that a completed recording then downloads through this check rather than around it. The origin is an observation and not a contract: it may differ by project or region, the provider can re-point it without notice, and a BYOS project returns no signed URL at all. Treat a later `unsafe-url` as the delivery host having moved, not as a defect.

`sessions.retrieve`, `list`, `waitUntilRunning` and `waitForTerminal` are passive. `sessions.requestRelease` is an explicit remote mutation and is never issued as a side effect of reading. Context create/retrieve/delete are separate resource operations; deleting a Context is never a browser finalizer. Mutating control-plane requests are never retried automatically, and a rejected request stays distinguishable from one whose effect is unknown.

`extensions.register` is the same kind of explicit resource operation. The archive is inspected before it is sent — a root `manifest.json`, no rooted or `..` members, bounded entries, names and declared size — and nothing is decompressed or written; the provider remains the loader of record. A launch recipe then selects the provisioned `extension` by reference. That qualified reference is the only spelling — the compiler alone projects it onto the provider's `extensionId` — so an unqualified identifier cannot be passed through unchecked and a foreign project is refused before allocation.

`ContextCoordination.withWriter` accepts a consumer-owned distributed lease backend and preserves the consumer's Effect error and environment types. A persisting allocation authenticates that live permit and reports its exact attempt, session and cleanup receipt before settlement. Unknown writers and unconfirmed persistence are quarantined. A terminal session does not establish that Context data finished synchronizing.

## Start with the result you need

For the simplest post-session video path, opt in to Browserbase recording in the launch recipe:

```ts
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { BrowserPolicy, NavigateRequest } from "effect-browserbase/browser-data";
import { recipe } from "effect-browserbase/launch";
import { BrowserbaseRecordings } from "effect-browserbase/recordings";
import { RecordingPageReference } from "effect-browserbase/transfers";
import { Effect, Layer, Stream } from "effect";

// Five-minute provider lifetime and a provider-managed viewport unless overridden.
const launch = recipe({ provider: { browserSettings: { recordSession: true } } });

// 100 actions, five minutes, 2 MiB returned unless overridden.
const policy = BrowserPolicy.unrestricted();

const layers = Layer.merge(BrowserbaseBrowser.layer({ launch }), BrowserbaseRecordings.layer).pipe(
  Layer.provide(account),
);

const program = Effect.gen(function* () {
  const browser = yield* BrowserbaseBrowser;
  const recordings = yield* BrowserbaseRecordings;

  const reference = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* browser.open(policy);

      yield* session.bind().navigate(NavigateRequest.make({ url: "https://example.com" }));

      // An AgentRuntime can borrow this same session through the adapter package.
      return session.reference;
    }),
  );

  yield* recordings.request(reference);
  const batch = yield* recordings.wait(reference, { timeoutMillis: 120_000 });
  const page = batch.pages.find((item) => item.delivery === "download");

  if (page === undefined) return batch;

  const bytes = yield* recordings
    .download(RecordingPageReference.make({ session: reference, pageId: page.pageId }), {
      maxBytes: 512 * 1024 * 1024,
      timeoutMillis: 120_000,
    })
    .pipe(Stream.runCollect);

  return { batch, bytes };
}).pipe(Effect.provide(layers));
```

The launch recipe deliberately differs from three Browserbase defaults. Set a field explicitly to get the provider's behavior; recording cannot be enabled retroactively after allocation.

| Setting         | Browserbase default | This package | Why                                               |
| --------------- | ------------------- | ------------ | ------------------------------------------------- |
| `recordSession` | on                  | off          | page video is sensitive; `Recordings` needs it on |
| `logSession`    | on                  | off          | CDP logs carry page content and typed input       |
| `solveCaptchas` | on                  | off          | solving is an action the host should choose       |

For model-driven control, use `effect-agent-browserbase`, whose tools borrow an already-owned session rather than allocating a browser per tool call. Provider credentials, CDP URLs, context choices, Live View controls and recording configuration are host decisions and are never Tool parameters.

## Choose a video path

|            | Provider recording (`recordings` / `replays`) | Live `capture`                                      |
| ---------- | --------------------------------------------- | --------------------------------------------------- |
| Encoding   | Browserbase                                   | caller-owned                                        |
| Available  | after the session ends                        | while the session is live                           |
| Enablement | `recordSession: true` at allocation           | independent of provider recording                   |
| Output     | per-page MP4 download or validated HLS replay | bounded JPEG frames                                 |
| Control    | provider-owned encoding                       | JPEG quality/source-fit bounds plus caller encoding |
| Audio      | none: measured, see below                     | none; the screencast frame seam has no audio source |

A bounded hosted check ran a page producing a known 440 Hz tone two independent ways, an `<audio>` element and a WebAudio oscillator started under real user activation, and confirmed from inside the page that it was playing (`AudioContext.state: "running"`, the element unpaused, `currentTime` advancing). The assembled provider MP4 decoded to a single h264 video stream with no audio track, in each of three recordings. That follows from the architecture: the provider records a CDP screencast of viewport screenshots, and its MP4 and HLS renditions draw from that same data. This package does not synthesize a silent track or infer audio support from a container; real audio needs control of the browser host process, which a hosted session does not give.

Prefer provider recording when post-session MP4/HLS is enough. Use `capture` when you need frames during the session, need to transform or encode them yourself, did not enable provider recording, are testing locally without a paid session, or need a live-frame path distinct from Browserbase's post-session artifact lifetime. BYOS recording completion is reported explicitly even when Browserbase does not return a download URL.

`Capture.start(session, { target: page })` accepts a `PageInfo` from `session.pages` and pins the interval to that page independently of the selected automation target. Omitting `target` binds to the page selected when capture starts; later selection changes do not move or stop it. An agent can drive a scout tab while the stage page keeps recording. Distinct pages may capture concurrently, with one interval per native target, at most four active or quarantined intervals, and 64 MiB of aggregate reserved buffering per session. The maintained Playwright screencast callback is JPEG-only here and the public API does not expose an FPS cap or lossless format.

`Capture.start(session, { target: page, size: { width: 640, height: 360 } })` requests source frames fitted within those pixel bounds without resizing the live viewport. Both dimensions must be integers from 1 through 16,384; the existing 33,554,432-pixel and byte limits still apply to actual frames. The request is validated and copied before native work or capture-budget admission. Omitting `size` preserves Playwright's default (the viewport fitted within 800×800). An already-active native screencast can override a requested size, so the package independently checks actual JPEG dimensions and ends the affected interval with a `limit` error before delivering an oversized frame. It does not silently resize bytes, invent dimensions, alter timestamps, or end a sibling page's capture. A size request is not a frame-rate limit or a guarantee about bytes produced before they reach the package.

## Session, reference, and ownership

`BrowserbaseSession` is the live capability. It belongs to the enclosing Effect `Scope`, owns the Playwright-over-CDP connection, and cannot outlive that scope. `SessionReference` is credential-free durable identity; it can be retained after the browser is gone and is what the independent `recordings`, `replays` and cleanup APIs use.

That split is why an agent can use one browser for many turns while provider artifacts remain accessible after the interactive scope ends. Importing a Layer does not allocate a browser.

`Allocation.scoped(recipe)` allocates a session without connecting a browser, for a caller that drives the remote session with its own automation client. It is the same allocation path the browser owner uses, so the creation request is never retried, an unknown outcome is still reported exactly once, a persisting Context still needs a live writer permit, and no native peer is loaded. The scope owns the release: closing it releases the session whether or not anything ever connected. A reply naming another project is refused, and because a foreign reference is never acted on, the caller is handed that reference rather than a mutation attempted against it.

The browser owner does not allocate or release anything itself. It supplies the local half of cleanup — fence, capture stop, initialization teardown, disconnect — and the canonical control plane owns the release request and the terminal status observation. A local disconnect, an accepted provider release request and provider-confirmed termination therefore stay distinct facts in one `CleanupResult`, together with the exact steps that failed.

Mutations are serialized. An observation identifies retained native nodes only until the next invalidating event; it is not a DOM snapshot version. Replaced or detached nodes fail instead of silently resolving to replacements. An action interrupted or timed out after native dispatch has an **unknown** outcome: the owner is fenced and the package never automatically replays it. `undispatched` is used only when the package established that native mutation dispatch did not occur.

### A navigation you can watch while it loads

`navigate` holds nothing open that you can see into: it returns when the document reaches DOMContentLoaded. `startNavigation` is the same single dispatch, left in flight, so a recorder can look at a page while it is still arriving, hold it, and let it finish:

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
- `stop` asks the browser to stop loading. Its acknowledgement is a known outcome: `completed` then fails `interrupted`, the page holds whatever had loaded, and the session stays usable. It does not undo anything the page already did.
- Leaving the operation's scope unsettled, or a navigation that fails after dispatch, fences the session as uncertain, exactly as an interrupted mutation always has. Nothing knows what the browser did, so nothing more is sent, and it is never replayed.

A read is ordered against the document being replaced by failing: if the document it was reading was replaced underneath it, or a navigation is still in flight on its page, the error is `target-changed` and `undispatched`, which means read again. A read is never a mutation, so that is always safe. A held page is not read at all; take the checkpoint before the hold and keep it.

Locally, a hold during an incremental response stops parsing as well as timers: a chunk the server sends meanwhile is not parsed until resume. That is an observation of the pinned Chromium, not a guarantee about hosted sessions.

### What is on screen, and what a host may know about it

`session.observe()` reads the whole document. `session.observe({ scope: "viewport" })` keeps only text and controls that are on screen and reachable, and says what it left out:

```ts
const seen = yield * session.observe({ scope: "viewport" });
seen.viewport; // { clippedText, coveredText, uncertainText, unreachableControls, exhausted, ... }
```

Visibility here is geometry and hit-testing, never a pixel comparison, and the counts say which was which. Text is kept when its line boxes intersect the viewport and the browser finds its own element at a sampled point. A text node that crosses the viewport edge contributes only its lines on screen (`clippedText`). Text behind another element is left out (`coveredText`). Text under something that takes no pointer events cannot be hit-tested at all, so it is left out as `uncertainText` rather than called visible. `exhausted` means the traversal budget ran out first and the reading is known to be incomplete. Canvas pixels and compositing effects are not interpreted.

An `Observation` is safe to show a model, and the adapter's `browser_inspect` Tool returns it as is. It therefore carries no destination, form target or field value, in either scope. What a host needs to decide whether a control may be acted on is a separate, host-only read from the exact node:

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

### Passive checkpoints for a recorder

`observe()` replaces the one observation whose nodes later actions may name, so a recorder calling it would retire the references an agent is about to use. `session.checkpoint()` is the passive path: viewport text, control facts and, when asked, a PNG of the viewport.

```ts
const checkpoint = yield * session.checkpoint({ picture: true });
```

It issues no references, is not a mutation, and leaves the action observation and the selection exactly as they were, so inspect, checkpoint, then act on the inspected node all compose. It is host-only, because it carries control facts. Text and picture are read one after the other, never atomically: the interval is on the host monotonic clock, and `documentChanged` says the document was replaced in between. A checkpoint is charged as one action, like any other bounded read. A held page is refused `busy` rather than woken to be read: take the checkpoint before the hold and keep it.

### Real pointer and wheel input

`pointerMove`, `hover` and `wheel` send the input a person's hardware would, so pages see trusted events, `:hover` applies, and the browser itself decides what is under the pointer. `scroll` stays what it was: script in the page, instantaneous, raising no wheel event. That difference is how a recording tells one from the other.

```ts
const handle = session.bind();

yield * handle.pointerMove(PointerMoveRequest.make({ to: { x: 140, y: 100 } }));
yield * handle.hover(HoverRequest.make({ selector: "#menu" }));
// A nested scroll container under the pointer scrolls, not the page.
const receipt =
  yield * handle.wheel(WheelRequest.make({ deltaX: 0, deltaY: 240, at: { x: 420, y: 120 } }));
```

Coordinates are CSS pixels in the main frame's viewport. Each call is one native command, charged as one action and fenced like any other mutation, so a handle bound to a page that is no longer selected sends nothing to either page. Easing, pacing and cursor artwork are yours: send the points you want, and draw the cursor from the positions the receipts report.

`hover` places the pointer on one exact element where it is, by selector or by the node an observation named (`session.hoverElement`). It never scrolls to reach it, because that would hide a scripted scroll inside a native-input operation. If the pointer cannot be placed on the element (it is outside the viewport, has no area, or something covers it) the call fails `not-visible` and `undispatched`.

An `InputReceipt` carries the target it was sent to, the position this owner commanded (null until it has placed the pointer on that page), and an interval on the same host monotonic clock that stamps `CapturedFrame.receivedMonotonicNanos`. Input and pixels share one timeline, so a compositor can place the pointer on the frame that shows it. A wheel event is dispatched, not awaited: the receipt does not claim the page finished scrolling or that any frame shows it.

The connection endpoint is read through the exact allocated session, so a provider reply that names a different session is refused before any CDP attachment.

Persistent Browserbase contexts require a live writer permit from `ContextCoordination.withWriter` when writes are persisted. Detach/reconnect is opt-in with `keepAlive`; reconnect creates a new handle generation, verifies the selected target, obtains fresh state, and never replays pending input or treats serialized agent state as a live browser.

Human handoff pauses automation before returning host-only Live View material. Resume requires an explicit operator-release signal and obtains a fresh observation while holding the same mutation permit. A failed handoff does not silently resume automation. Live View URLs are temporary bearer material; iframe styling is not an authorization boundary.

## Registrations, capabilities and document readiness

`browser.open(policy, { bootstrap })`, `browser.acquire(policy, { bootstrap })` and `browser.attach(reference, { policy, bootstrap })` take a trusted registration plan at acquisition. The browser Layer fixes account and launch configuration, not consumer callback dependencies. A plan is built from `Bootstrap.binding`, `Bootstrap.init`, `Bootstrap.permissions` and `Bootstrap.combine`. Combination preserves the error and service unions of different handlers; the callable bridge precedes all dependent init steps in one native script registration. Script content, handler implementations and origin grants are host configuration, never model output or page input.

```ts
import * as Bootstrap from "effect-browserbase/bootstrap";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import { BrowserPolicy } from "effect-browserbase/browser-data";
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

const run = Effect.gen(function* () {
  const browser = yield* BrowserbaseBrowser;
  return yield* browser.withBrowser(BrowserPolicy.unrestricted(), { bootstrap }, (session) =>
    Effect.gen(function* () {
      yield* session.bind().navigate({ url: "https://portal.example.com" });
      yield* session.ready;
      return yield* session.observe();
    }),
  );
});
// run requires BrowserbaseBrowser and ShowSettings. withBrowser discharges both the
// callback's and the use function's Scope, but neither one's other services or errors.
```

Registration is installed before this connection creates any document, and permissions precede the bundle. It is still not readiness: an asynchronous step cannot pause a website's own scripts, so a document is ready only when its expression resolves to exactly `true`. Readiness is keyed by frame and document epoch and evaluated once per document, so a completed wait can never ready the document that replaced the one it observed.

Each binding accepts exactly one JSON-compatible argument and returns the output codec's **encoded** JSON value. A transforming codec such as `Schema.FiniteFromString` therefore exposes a string to the page while its host handler works with a number. The native callback validates the actual caller's allowed origin and document before input decoding, immediately before invoking the handler, and before replying. This uses Chromium's execution-context identity and `uniqueContextId` on child CDP sessions belonging to the existing connection: a frame URL, a page-supplied origin, and a reused numeric context id are not authorization. The pinned Playwright `exposeBinding` callback supplies a frame but not the calling document's identity; it is deliberately not used as a weaker substitute. No raw protocol or second browser owner is exposed.

Plans admit at most 16 uniquely named bindings. Each binding declares its concurrent-call, UTF-8 input/output byte and whole-invocation deadline limits. Admission reserves capacity before native validation, codec work or a callback fiber starts; a timed-out native operation retains that reservation until it actually settles, including across reconnect. The page wrapper additionally rejects cyclic, sparse, accessor-bearing, non-plain, non-finite and non-JSON input rather than silently changing it through `JSON.stringify`. Its traversal admits at most 64 levels and 65,536 nodes; the configured byte limit still applies. Native target and default-document registries are finite, and closed native targets retire their authority immediately.

`reject-call` rejects only the affected invocation and permits subsequent healthy calls. `fail-session` completes `session.failure` with the original typed consumer cause and fences the owner. Pages receive only `BrowserbaseBindingError: Browser binding call rejected`, with no host stack, consumer error payload, credentials or SDK cause. `session.bindingDiagnostics` is a bounded **host-only** snapshot containing per-binding accounting and the latest 32 typed causes; do not serialize it into a Tool response. Callback service reads run independently of a browser mutation, but reentrant browser work never waits behind that mutation's permit: it fails `busy` with `undispatched` instead.

`withBrowser` races the use function against fail-session errors, discharges the scope, and permits normal success only after confirmed owned-session termination and complete local cleanup. Explicit `acquire`/`open` retain the typed failure signal and detailed cleanup receipt for callers that need to manage that decision themselves. Teardown synchronously closes callback admission, interrupts managed callback fibers, removes this connection's registrations, disconnects locally, and still attempts remote release if a prior cleanup step fails. Reconnect installs fresh callable registrations, never replays an old invocation or a consumer init script into an already-running document, and cannot reuse quarantined callback capacity.

Operations that depend on an initialized document wait for the current one. Navigation, selection and page management do not, so initialization cannot deadlock the navigation that produces the document it is waiting for. A document that was already running when the bundle was registered — the page you attach to, or the one a reconnect finds — never ran it: `RequireFreshNavigation` reports `RequiresNavigation` and refuses dependent work, while `AcceptAlreadyRunning` verifies the requirement against that document instead of assuming it. Neither reloads a page whose work may be uncertain; that stays your decision. `session.ready` reports the current document without charging an action, and an origin outside the plan is reported as `NotApplicable` rather than waited on.

The reviewed permission subset is granted against a real browser in native acceptance rather than copied from a list. Extension identity and storage across Context reuse, and registration retention across provider reconnects, remain hosted questions and are not claimed here.

## Files in and out

Small selection needs no provisioning: `session.selectFiles` attaches in-memory bytes the caller already holds, and `session.clickForFileSelection` registers the chooser observation before the single click that opens it and attaches exactly once.

Larger files use `BrowserbaseUploads.create`, which places bytes for the exact running session and returns a receipt. A stored file is named to the browser process, which opens the path itself; only in-memory bytes are streamed from this client, and the two mechanisms are never mixed. Attachment authority is the identity of a receipt this package issued for that session, so a value that merely has the right shape carries none: no caller, and no model, turns a server pathname into an attached file. The receipt reports the provider's remote path only when the provider returned one; when it does not, attachment by path is refused rather than guessed. Hosted H6 remains the check for real provider upload identity and routing.

## Borrowed attachment

`BrowserbaseBrowser.attach(reference, { policy, target })` takes control of a session this process did not allocate. It reads status first, so project authority is checked before anything is borrowed; a terminal session is refused because that needs a fresh allocation rather than a reattachment, and a starting session is admitted only within a bounded `pendingWaitMillis`. The requested target is resolved explicitly — there is no positional first-tab fallback — and connection credentials are fetched fresh, because expiry races the caller's own status read.

A borrowed scope disconnects locally and reports `ownership: "borrowed"` with `remote: "not-owned"`. It never requests release and never claims Context-writer authority: whoever allocated the session keeps both. It also does not detach and reattach inside itself; attaching again is the cross-process path, and it revalidates the session instead of assuming it is still there. A prior uncertain business mutation is still yours to reconcile before the next one; nothing is replayed automatically.

`test/native/handoff-process.test.ts` exercises that path with a real second process: it starts a fresh runtime that receives only the reference, a target id and fixture addresses, attaches, changes the page and closes as a borrower, and the allocating process then drives the same page and releases it. That is local CDP evidence, not a hosted handoff.

## The native engine

`browser-binding` names the engine an owned or borrowed browser connects through. The default is Playwright over CDP with the provider's own address, so nothing has to be provided; `BrowserBinding.layer(binding)` supplies another to every browser Layer built beneath it. A binding is opaque and only this module issues one, so a value that merely has its shape is refused before anything is allocated.

`BrowserBinding.playwright({ resolveEndpoint, onConnected })` is trusted host configuration for running the unmodified Playwright engine somewhere else, such as a local Chromium. `resolveEndpoint` runs only after the provider-issued address passed the default checks, and chooses the CDP endpoint actually connected to; `onConnected` sees the engine's own browser object before the owner drives it. Neither is model-facing, and a local engine reached this way says nothing about how a hosted connection behaves. This package's own native fixtures use exactly this, rather than replacing `chromium.connectOverCDP` globally.

## Network policy

`Unrestricted` is the only supported `BrowserPolicy.network`, and only when selected by trusted host policy. The adapter package refuses Effect Agent's `ExactHosts` before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers, and refuses `PublicWeb` because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

### Why there is no request-admission hook

A hook that lets a host allow or deny each request is worth having only if it sees every request it claims to cover. The owner drives the browser through the engine's one connection, where the available interception is Playwright routing, and in the pinned Playwright 1.63.0 that does not see them all:

- A redirected request is continued by the engine itself and is never offered to a route handler. A hook would decide the first hop of a chain and none of the rest.
- A paused request the engine cannot match to a network request, or to a frame or service worker it knows, is continued without being offered.
- Turning routing on disables the HTTP cache for the session, so the policy would change what a page loads, and what a recording of it shows.

A second interception client on the same targets would compete with the engine for the same paused requests, and is the raw-protocol side channel the single owner exists to rule out. So this package offers no hook, rather than one that covers less than it appears to.

Complete URL-level admission would still not be `PublicWeb`. A URL names a host. The address is chosen afterwards, by whichever resolver the connecting browser or proxy uses, so a lookup the host makes beforehand says nothing about the connection that follows.

### The boundary that can enforce it

Containment has to be enforced where the session's connections are made: an egress point beneath every page, frame, worker and socket, which sees each connection's real target and resolves names itself. On this provider that is a proxy the host operates, selected for the whole session at launch:

```ts
const launch = recipe({
  provider: { proxies: [{ type: "external", server, username, password }] },
});
```

`username` and `password` are `Redacted`, and a `server` URL that carries credentials is refused before allocation. The rule is listed alone and has no `domainPattern`, because the provider applies the first rule that matches, and a second rule would be a way round the first. Exact hosts, public addresses, redirects and child pages are then the proxy's decisions, made per connection.

A host that does this still selects `Unrestricted` here, and the containment claim is the host's own, made at its proxy. This package keeps refusing `ExactHosts` and `PublicWeb`, because it has no evidence that every connection of a hosted session takes that proxy. The provider documents how rules are ordered, not whether WebRTC, QUIC or name resolution go through one, and no hosted run in this repository has tested it. Accepting either policy needs that evidence first: a hosted session behind one catch-all proxy, exercised through navigation, redirects, frames, subresources, popups, workers, service workers, WebSockets and non-HTTP transports, with nothing arriving anywhere but the proxy.

What this package does check is input, not requests. `controlFacts` and an `admit` policy ([above](#what-is-on-screen-and-what-a-host-may-know-about-it)) let a host that drives the session refuse a link or a form by its resolved destination before anything is sent. That limits what the host's own automation acts on. It does not limit what a page loads, or where it redirects.

## Beyond the browser session

These services share the Client and its rules: strict input decoding, identity-checked replies, 1 MiB reply bounds, mutations that are never retried, and typed failures whose `outcome` says whether a request was sent. They are host APIs; none of them is exposed to a model by the adapter package.

- `sessions.logs(reference, { includePayloads? })` returns CDP log entries. Protocol payloads are omitted unless requested, because they carry page content, cookies and typed input.
- `sessions.liveUrls(reference, ttl?)` issues redacted Live View URLs for any session in the project. Unlike `beginHandoff`, it does not pause automation.
- `downloads.list(reference, query)` filters by filename, MIME type, size and creation time at the provider. `downloads.delete` first proves that the file belongs to the session.
- `projects` reads the Client's project and its usage. `certificates` registers proxy CA certificates for `proxySettings.caCertificates`.
- `search` and `page-fetch` are Browserbase's billed Search and Fetch APIs. `agents` starts, observes and stops hosted agent runs. `functions` invokes and observes deployed Functions; deployment stays with Browserbase's CLI. `webhooks` manages endpoints and returns signing secrets as `Redacted`.

An agent run or Function invocation that persists a Context writes it from Browserbase's side, outside `ContextCoordination.withWriter`. It is refused while a local writer holds that Context, but nothing stops a later local writer from racing the hosted run.

## Public entry points

- `client` — one immutable account, transport and approved artifact origins.
- `account` — every resource service on one Client, so credentials are composed once.
- `allocation` — a scoped session with no browser connected, released by its own scope.
- `sessions`, `contexts`, `context-coordination` — passive inspection, explicit release, context resources and writer settlement.
- `extensions` — provisioning a Chrome extension archive once as a durable project resource, and selecting it by reference at launch.
- `uploads` — placing a file where the running session can already reach it, and the receipt that authorizes attaching it.
- `bootstrap` — E/R-preserving bounded typed bindings, one ordered init bundle, reviewed permission grants, per-document readiness and bounded host-only callback diagnostics.
- `launch`, `references`, `browser-data`, `session-data`, `cleanup`, `transfers`, `errors` — credential-free schemas and typed expected errors.
- `browser-binding` — the trusted, opaque native engine a browser connects through: Playwright by default, or Playwright routed to a host-resolved endpoint.
- `browser` — scoped allocation, borrowed attachment to a running session, deterministic page control, real pointer and wheel input, host-only tabs/frames/viewport, modeled file selection, Live View handoff, keep-alive detach and explicit reconnect.
- `capture` — optional target-pinned live-page JPEG frame streams using Playwright 1.63's maintained screencast API. The caller owns encoding, storage and presentation.
- `page-control` — opt-in host-owned stage holds and explicit receipt-based resume, independent of scout selection.
- `recordings` — post-session Browserbase MP4 assembly, status and bounded retrieval. Stable identity is session + recording page; signed URLs are refreshed and are not durable identity.
- `replays` — host-authorized replay metadata and validated HLS media proxy material. It is playback access to a recording, not another recording.
- `downloads` — ordinary website download metadata, provider-side filters, bounded byte streams and deletion, separate from provider recordings.
- `projects`, `certificates` — project inspection and usage; proxy CA certificate administration.
- `search`, `page-fetch`, `agents`, `functions`, `webhooks` — the Browserbase platform APIs outside a browser session.

Every expected failure says three things. `operation` is what you asked for, from a closed vocabulary per error class: `BrowserError` names the browser operations, `SessionError` only session calls, and so on, so you can match on them exhaustively and a misspelling is a type error, not a string that happens to compile. `reason` is why it failed. `outcome`, when present, is whether the work was sent: `undispatched` is safe to retry, `rejected` was refused, and `unknown` means a mutation may have happened and is never replayed for you. Why an extension archive was refused is a `reason` (`limit`, `unsafe-filename`, `configuration`) of the one `extension-archive` operation. A native step's own name never appears: the driver raises a private failure, and the owner stamps the operation it admitted.

Everything under `src/internal/` is private, and no consumer CDP seam or lower-level lifecycle Layer is exported; `browser-binding` chooses the engine and where it connects, never what runs over the connection. The driver does hold a CDP session; exposing it, or the ownership internals, would place actions outside the mutation permit that serializes them and outside the fencing that makes an uncertain outcome detectable. Opening a second debugger connection beside this one has the same effect and is equally unsupported. An unmodeled need is a request for a modeled entry point, not a reason to reach around the boundary.

## Artifact and capture guarantees

Provider recordings have an independent post-session lifetime. Assembly POST is a mutation; an uncertain POST is reconciled with status before any deliberate retry. Polling is bounded and preserves per-page partial success/failure. BYOS completion without a Browserbase download URL is reported explicitly.

Website downloads retain their provider download ID, safe filename, MIME type and declared size. Streaming enforces configured MIME, byte and deadline bounds and verifies the completed byte count. A click result alone is never reported as a completed file.

Replay playlists reject arbitrary URI-bearing tags and proxy only indexed media from the validated playlist. API credentials are never returned to a browser client.

Live capture frames carry owned JPEG bytes, captured target identity, sequence number, source presentation time, host monotonic receipt time, geometry and explicit drop accounting. Buffers are bounded by frame count and bytes; slow consumers drop old frames instead of creating an unbounded fiber/callback backlog. Buffer dropping is not page-clock backpressure and does not reduce what the browser produced upstream. Holding a capture callback is not a promise that page timers or animations stop.

`sourceTimeMillis` is the browser's wall clock when it took the frame for the screencast, stamped before the frame is encoded. Chromium encodes up to three frames at once and emits each when its encode completes, so two frames stamped close together can arrive in either order. A frame that arrives behind a newer one can no longer be presented in order: it is discarded and counted in `late`, which is part of `dropped`. It is never sorted back in or given another time, so delivered source times strictly increase and a gap in `sequence` marks the omission. Concurrent encoding can put at most two late frames in a row. A longer run means source time itself went backwards, and the interval ends with reason `timestamp`.

Closing, navigating, detaching a relevant frame, or resizing the captured page ends its interval explicitly without ending a sibling page's capture. `Capture.start(session, { lifetime: "page" })` instead follows a page's main frame across documents: start it before a navigation and it covers the loading in between. The native screencast is never restarted for a navigation, so a boundary is not a gap this package introduced. Each frame carries the `document` it was received during (0, then one more per navigation), and the summary's bounded `documentBoundaries` give the last sequence before each one. That is attribution by receipt order, not proof of whose pixels a frame shows: one received just after a navigation can still show the document before it. Selecting another page or frame does not invalidate an unrelated interval. Handoff pause, connection loss, an uncertain owner and session closure still invalidate all child intervals. A confirmed native stop releases only its own reservation; a failed stop on a live page keeps that target quarantined. A definitively closed page releases its capture reservation. Stopping a child capture does not close its browser. The frame seam has **no website-audio source**, so this package does not synthesize silent samples or infer audio support from a video container. Caller encoding is demonstrated in `examples/record-video.ts`; the example decodes every generated frame with the caller's FFmpeg and checks presentation timestamps and pixel checksums. Native acceptance requires changing pixels and source-time agreement rather than accepting container headers as video evidence.

## Explicit stage-page holds (opt-in)

Set `pageControl: true` on `BrowserbaseBrowser.layer` to use the host-only `page-control` module. The default remains off. `PageControl.suspend(session, page)` returns a live `PageSuspension`; `PageControl.resume(session, receipt)` consumes that exact receipt. Use a `PageInfo` from `session.pages`. Selection can move to the scout without invalidating the receipt, but connection loss, external target invalidation, completed resume, or another session does invalidate it. Holding or resuming a page may run its `freeze` and `resume` handlers, so nothing observed on _that_ page may be acted on unchecked afterwards: a reference fails `stale` until `session.revalidateElement(reference)` confirms it is still attached and still the control that was inspected. That check sends nothing, never searches for a substitute, and refuses a replaced, detached or changed node. An observation of another page is untouched, so an agent keeps driving the scout while the stage is held. `PageControl.state` reports the last acknowledged local state, not proof about a lost remote connection.

This opt-in uses maintained CDP attachment with `noDefaults: true` and owner-controlled per-page focus emulation. It intentionally does not support `keepAlive`, reattachment, human handoff, or popup/dialog `pause` policies. These combinations fail before provider allocation; use the existing `retain`/`close` popup policies and `dismiss` dialog policy. Resume explicitly activates the native page without changing SDK selection. Do not enable it where another native client owns focus. Modeled input, DOM reads, waits and viewport changes on held/unknown pages fail before dispatch; the scout remains operable. Page close and session close remain available. Capture does not thaw a held page; frame consumption and acknowledgements never suspend/resume it implicitly.

The native tests cover page timers, RAF and CSS animation, scout progress with both pages captured, an already-paused animation, and restoration of a non-default rate. Resume waits for one bounded real RAF in an isolated world at rate zero before restoring that rate, avoiding Blink's stale pre-hold animation clock. In-flight callbacks are not undone. Date/wall time, network, media/audio, workers/service workers, and external/provider actions are not promised frozen. This is presentation control, not a security boundary or browser virtual time.

Partial native failures fence the session as uncertain; there is no success receipt, automatic rollback or retry. Scope cleanup never sends a hidden resume: it closes the owned session/connection. Chromium may reset animation state on CDP detachment, so a previous hold acknowledgement does not guarantee remote clocks remain held after connection loss. Hosted-provider equivalence has not been tested.

## Development and evidence

Repository commands use Vite+: `vp run check`, `vp test`, `vp run install:test-browser`, `vp run test:native`, `vp pack`. Native tests use Playwright 1.63.0 Chromium against loopback HTTP fixtures over the real CDP boundary. Unit tests use Effect TestClock and a provider scripted through `fetch` behind the real Client. Those local boundaries remain distinct from hosted Browserbase evidence: a local CDP pass proves native integration, not provider allocation, Live View authorization, provider recording/audio behavior, recording coexistence, or Browserbase network behavior.

`tools/packed-consumer.sh` installs the emitted npm tarballs into separate consumers with exact public dependency versions, checks NodeNext declarations, and runs the unchanged native suites without workspace aliases. It also runs real programs directly on Node and Bun: `test/consumer/resources.ts` with no Playwright and no framework installed, and `test/consumer/native.ts` against a real local Chromium.
