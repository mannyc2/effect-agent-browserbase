# Browserbase for Effect

`effect-browserbase` supplies Browserbase resources and hosted lifetimes to the shared browser runtime: account identity and transport, session, context and extension resources, one owned browser over Playwright/CDP — allocated or borrowed — with trusted registrations, modeled file selection, bounded live capture, explicit page holds, the provider's recordings, replays, uploads and website downloads, and the platform APIs outside a browser session (projects, certificates, Search, Fetch, Agents, Functions and webhooks).

Its host supplies the required `effect-browser` peer, at the same coordinated `0.2.0-beta.5` version; it has no Effect Agent dependency. Install both packages explicitly so the provider and application share one runtime instance. Playwright is an optional peer of the shared runtime and is loaded only when a browser connects; artifact-only consumers do not need it. The Effect peer range is `^4.0.0-rc.117`, with rc.117 qualified. The package targets trusted Node and Bun hosts. It is published as a beta (`0.2.0-beta.0` on the `beta` dist-tag): hosted provider behavior requires separate validation, and ordinary tests never create a paid Browserbase session or invoke a paid model.

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

`Account.layer({ projectId, apiKey: Redacted.make(key), ... })` takes the same authority explicitly. Either one bundles every resource service on a single Client, so credentials are composed once instead of per service; each service still exports its own `layer` when you want a narrower set. `BrowserbaseBrowser.layer` stays separate, because a browser also fixes budgets and a connection lifetime that an account does not. It also requires Effect's `Crypto` from the host platform (`NodeServices.layer`, `BunServices.layer` or `NodeCrypto.layer`), which supplies allocation attempt ids, connection ids and handoff tokens; the account services need no `Crypto`. The Client uses Effect's `FetchHttpClient.Fetch` reference, which already defaults to `globalThis.fetch`; provide a different `fetch` only when you need one.

`artifactOrigins` is the exact set of HTTPS origins this client will fetch provider media from, and it is deliberately empty by default: recording downloads and replay media are refused with `unsafe-url` until you approve a host. Browserbase documents only a "signed CDN URL" and does not publish that origin, so discover your own rather than copying anyone's — request a recording for a completed session, read `downloadUrl` from `GET /v1/sessions/{id}/recording/downloads`, and approve exactly its origin. A hosted run on 21 September 2026 confirmed that a completed recording then downloads through this check rather than around it. The origin is an observation and not a contract: it may differ by project or region, the provider can re-point it without notice, and a BYOS project returns no signed URL at all. Treat a later `unsafe-url` as the delivery host having moved, not as a defect.

`sessions.retrieve`, `list`, `waitUntilRunning` and `waitForTerminal` are passive. `sessions.requestRelease` is an explicit remote mutation and is never issued as a side effect of reading. Context create/retrieve/delete are separate resource operations; deleting a Context is never a browser finalizer. Mutating control-plane requests are never retried automatically, and a rejected request stays distinguishable from one whose effect is unknown.

`extensions.register` is the same kind of explicit resource operation. The archive is inspected before it is sent — a root `manifest.json`, no rooted or `..` members, bounded entries, names and declared size — and nothing is decompressed or written; the provider remains the loader of record. A launch recipe then selects the provisioned `extension` by reference. That qualified reference is the only spelling — the compiler alone projects it onto the provider's `extensionId` — so an unqualified identifier cannot be passed through unchecked and a foreign project is refused before allocation.

`ContextCoordination.withWriter` accepts a consumer-owned distributed lease backend and preserves the consumer's Effect error and environment types. A persisting allocation authenticates that live permit and reports its exact attempt, session and cleanup receipt before settlement. Unknown writers and unconfirmed persistence are quarantined. A terminal session does not establish that Context data finished synchronizing.

## Start with the result you need

For the simplest post-session video path, opt in to Browserbase recording in the launch recipe:

```ts
import { NodeServices } from "@effect/platform-node";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy, NavigateRequest } from "effect-browser/browser-data";
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
  Layer.provide(NodeServices.layer),
);

const program = Effect.gen(function* () {
  const recordings = yield* BrowserbaseRecordings;

  const reference = yield* Browser.scoped(BrowserbaseBrowser.open(policy), (session) =>
    Effect.gen(function* () {
      yield* session.navigate(NavigateRequest.make({ url: "https://example.com" }));

      // Browser.scoped checks the owner's release before returning this durable identity.
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

For model-driven control, use `effect-agent-browser`, whose tools borrow an already-owned session rather than allocating a browser per tool call. Provider credentials, CDP URLs, context choices, Live View controls and recording configuration are host decisions and are never Tool parameters.

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

`Allocation.scoped(recipe)` allocates a session without connecting a browser, for a caller that drives the remote session with its own automation client. It is the same allocation path the browser owner uses, so the creation request is never retried, an unknown outcome is still reported exactly once, a persisting Context still needs a live writer permit, and no native peer is loaded. The scope owns the release: closing it releases the session whether or not anything ever connected. A reply naming another project is refused, and because a foreign reference is never acted on, the caller is handed that reference rather than a mutation attempted against it. The attempt id comes from Effect's `Crypto`, so `Allocation.scoped` requires that service beside the account.

The shared browser runtime delegates allocation and release to this provider lifetime. It supplies the local half of cleanup — fence, capture stop, initialization teardown, disconnect — and the canonical control plane owns the release request and the terminal status observation. A local disconnect, an accepted provider release request and provider-confirmed termination therefore stay distinct facts in one `CleanupResult`, together with the exact steps that failed.

`onCleanup` runs once after the canonical receipt and any Context-writer settlement are recorded.
Its construction throws, defects, self-interruption and two-second cooperative timeout are
contained separately from the built-in diagnostics reporter. A failed reporter cannot suppress
the sink, and a failed sink cannot change cleanup facts or repeat release. The receipt remains
readable through `cleanupResult`; `closeChecked` still fails when its actual confirmation predicate
fails. An outer race can discard that checked error, so keep any required host receipt sink outside
the raced workflow. The shared guide's [Layer and receipt examples](../browser/README.md#a-long-lived-session-in-a-layer)
describe sharing one bounded session and the supervision that a Layer alone does not provide.

Mutations are serialized. An observation identifies retained native nodes only until the next invalidating event; it is not a DOM snapshot version. Replaced or detached nodes fail instead of silently resolving to replacements. An action interrupted or timed out after native dispatch has an **unknown** outcome and is never automatically replayed. Unresolved control fences the owner; the shared runtime's main-frame navigation recovery can preserve usability after one acknowledged stop while still reporting `Timeout/unknown`. Recovery is bounded by the loading deadline plus at most three seconds and the existing lifetime. Child-frame timeouts retain the conservative fence. `undispatched` is used only when the package established that native mutation dispatch did not occur.

## Shared browser operations

Navigation, observation, native input, typed bootstrap bindings, live capture and page holds are implemented by [`effect-browser`](../browser/README.md). Import their contracts from that package and use them with the exact `BrowserbaseSession` returned here. The [`effect-agent-browser`](../agent-browser/README.md) adapter and maintained tools accept both this session and self-managed Chromium without a second connection.

The shared session also provides passive `status` and bounded `diagnostics`, including after
closure. Known expiry, callback failure and policy pressure are not automatically labeled
uncertain; unresolved native dispatch remains a separate fact. Owned provider termination can
retire native control, whereas borrowed disconnection alone cannot. These snapshots do not replace
the provider's canonical cleanup receipt or make business outcomes known. `maxHostReads` is a
browser Layer option (default 10,000, maximum 1,000,000) for checkpoint/control-facts sampling;
it is independent of model action accounting and never a tool parameter.

## Files in and out

Small selection needs no provisioning: `session.selectFiles` attaches in-memory bytes the caller already holds, and `session.clickForFileSelection` registers the chooser observation before the single click that opens it and attaches exactly once.

Larger files use `BrowserbaseUploads.create`, which places bytes for the exact running session and returns a receipt. A stored file is named to the browser process, which opens the path itself; only in-memory bytes are streamed from this client, and the two mechanisms are never mixed. Attachment authority is the identity of a receipt this package issued for that session, so a value that merely has the right shape carries none: no caller, and no model, turns a server pathname into an attached file. The receipt reports the provider's remote path only when the provider returned one; when it does not, attachment by path is refused rather than guessed. Hosted H6 remains the check for real provider upload identity and routing.

## Borrowed attachment

`BrowserbaseBrowser.attach(reference, { policy, target })` takes control of a session this process did not allocate. It reads status first, so project authority is checked before anything is borrowed; a terminal session is refused because that needs a fresh allocation rather than a reattachment, and a starting session is admitted only within a bounded `pendingWaitMillis`. The requested target is resolved explicitly — there is no positional first-tab fallback — and connection credentials are fetched fresh, because expiry races the caller's own status read.

`session.closeChecked` accepts confirmed owned cleanup or complete borrowed disconnection according to the actual ownership, then returns the same frozen `CleanupResult` cached by `close`. The concrete success value replaces the former `undefined`; failed confirmation remains a typed `BrowserError`. A borrowed scope disconnects locally and reports `ownership: "borrowed"` with `remote: "not-owned"`. It never requests release and never claims Context-writer authority: whoever allocated the session keeps both. It also does not detach and reattach inside itself; attaching again is the cross-process path, and it revalidates the session instead of assuming it is still there. A prior uncertain business mutation is still yours to reconcile before the next one; nothing is replayed automatically.

## Shared API migration

| Before                                                         | Now                                                                                                                                                             |
| -------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `session.bind()` or `yield* session.currentTarget`             | Ordinary calls use `session` directly; `yield* session.retain` explicitly obtains checked stale-on-selection semantics                                          |
| Bare page IDs in selection/closure, selection returns a handle | Pass `PageInfo` to `selectPage`/`closePage`; selection returns `void`, and `createPage` returns the exact created record                                        |
| Reuse old page/frame metadata after reconnect                  | In the same known browser lifetime, read fresh pages and match exactly one saved `targetId`; then read fresh frames. No fallback to order, old ID, URL or title |
| `Adapter.fromSession(session)` or `currentHandle`              | Await the Effect with explicit `{ selection: "current" }` or `{ selection: "retained" }`; its browser is the original concrete session                          |
| `BrowserError.reason` string and optional outcome              | Tagged reason and required outcome. Use `Effect.catchReason`; factual limit/status/retry fields belong to their reason                                          |
| All host reason names reach model output                       | A compact eleven-reason tool failure; original structured fields and bounded call IDs remain in `ToolHost.toolFailures`                                         |
| `closeChecked` success is `undefined`                          | Concrete receipt success after the existing ownership check; `close` and `cleanupResult` remain available                                                       |
| Capture `dropped`                                              | `discarded = overflow + late + duplicates + rejected`; no change to default capacity or unknown upstream loss                                                   |
| Non-supervising helper takes default `BrowserSession`          | Use `AnySession`; keep supervising helpers generic in callback error or concrete session                                                                        |

Binding omission defaults are one concurrent call, 64 KiB each direction, 10 seconds and
`reject-call`; explicit values remain validated. Combined readiness uses the most conservative
`existingDocuments` policy. Common navigation now accepts optional `timeoutMillis` with the same
bounds as `startNavigation`; direct, retained and pinned operations share it. Observations add
bounded checked/selected/inputType/required state without field values or destinations. These
contracts live in the [common browser guide](../browser/README.md).

Explicit generic applications of curried `Browser.scoped` use four outer parameters and three
returned parameters; ordinary inferred syntax is unchanged. Provider resource errors such as
`SessionError` keep their independent reason schemas. When a control-plane read becomes a browser
operation failure, the bridge preserves available facts; a resource limit with no measured bound
becomes `Provider` rather than fabricating `Limit` values. A native connection whose setup fails
after connection work began carries `unknown` outcome.

`test/native/handoff-process.test.ts` exercises that path with a real second process: it starts a fresh runtime that receives only the reference, a target id and fixture addresses, attaches, changes the page and closes as a borrower, and the allocating process then drives the same page and releases it. That is local CDP evidence, not a hosted handoff.

## The native engine

`browser-binding` names the engine an owned or borrowed browser connects through. The default is Playwright over CDP with the provider's own address, so nothing has to be provided; `BrowserBinding.layer(binding)` supplies another to every browser Layer built beneath it. A binding is opaque and issued by the common runtime, so a value that merely has its shape is refused before anything is allocated.

`BrowserBinding.playwright({ resolveEndpoint, onConnected })` is trusted host configuration for running the unmodified Playwright engine somewhere else, such as a local Chromium. `resolveEndpoint` runs only after the provider-issued address passed the default checks, and chooses the CDP endpoint actually connected to; `onConnected` sees the engine's own browser object before the owner drives it. Neither is model-facing, and a local engine reached this way says nothing about how a hosted connection behaves. This package's own native fixtures use exactly this, rather than replacing `chromium.connectOverCDP` globally.

## Network policy

`Unrestricted` is the only supported `BrowserPolicy.network`, and only when selected by trusted host policy. The adapter package refuses Effect Agent's `ExactHosts` before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers, and refuses `PublicWeb` because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

### Why there is no request-admission hook

A hook that lets a host allow or deny each request is worth having only if it sees every request it claims to cover. The owner drives the browser through the engine's one connection, where the available interception is Playwright routing, and in the pinned Playwright 1.63.0 that does not see them all:

- A redirected request is continued by the engine itself and is never offered to a route handler. A hook would decide the first hop of a chain and none of the rest.
- A paused request the engine cannot match to a network request, or to a frame or service worker it knows, is continued without being offered.
- Turning routing on disables the HTTP cache for every page it covers, so the policy would change what a page loads, and what a recording of it shows.

A second interception client on the same targets would compete with the engine for the same paused requests, and is the raw-protocol side channel the single owner exists to rule out. So this package offers no hook, rather than one that covers less than it appears to.

Complete URL-level admission would still not be `PublicWeb`. A URL names a host. The address is chosen afterwards, by whichever resolver the connecting browser or proxy uses, so a lookup the host makes beforehand says nothing about the connection that follows.

### The boundary that can enforce it

Containment has to be enforced where the session's connections are made: an egress point beneath every page, frame, worker and socket, which sees each connection's real target and resolves names itself. On this provider that is a proxy the host operates, selected for the whole session at launch:

```ts
const launch = recipe({
  provider: { proxies: [{ type: "external", server, username, password }] },
});
```

`username` and `password` are `Redacted`, and a `server` URL that carries credentials is refused before allocation. The rule is listed alone and has no `domainPattern`: the provider applies the first rule that matches, so a rule ahead of it, or a pattern on it, is a way round the proxy. Exact hosts, public addresses, redirects and child pages are then the proxy's decisions, made per connection.

A host that does this still selects `Unrestricted` here, and the containment claim is the host's own, made at its proxy. This package keeps refusing `ExactHosts` and `PublicWeb`, because it has no evidence that every connection of a hosted session takes that proxy. The provider documents how rules are ordered, not whether WebRTC, QUIC or name resolution go through one, and no hosted run in this repository has tested it. Accepting either policy needs that evidence first: a hosted session behind one catch-all proxy, exercised through navigation, redirects, frames, subresources, popups, workers, service workers, WebSockets and non-HTTP transports, with nothing arriving anywhere but the proxy.

What this package does check is input, not requests. `controlFacts` and an `admit` policy ([above](#what-is-on-screen-and-what-a-host-may-know-about-it)) let a host that drives the session refuse a link or a form by its resolved destination before anything is sent. That limits what the host's own automation acts on. It does not limit what a page loads, or where it redirects.

## Testing against a scripted control plane

`effect-browserbase/testing` supplies the provider side of a test the way `effect-browser/testing` supplies the browser side. `Testing.provider(script)` returns a `fetch` for `FetchHttpClient.Fetch` and a `ProviderControl` handle; the real `Client`, `Sessions`, `Uploads`, allocation and cleanup code parse its replies, apply their bounds and reconcile release against it. The script says how creation answers (`Accept`, `Reject` with a status the transport classifies and an optional `retryAfterMillis`, `Malformed`, or `Lost` after the request was sent, so the allocation outcome is unknown), whether a release request is `confirmed`, stays `pending` or fails, whether a Live View is issued, and whose identity a session's retrieval and release replies carry (`own`, `foreign-session` or `foreign-project`). Its secrets are marker strings, so evidence can be grepped for a leak, and nothing in it is a credential.

`Testing.layer({ browser, provider?, launch?, options? })` composes that control plane under the real `Account.layer` and `BrowserbaseBrowser.layer`, with the scripted engine from `effect-browser/testing` as the `BrowserBinding` and its `sequentialCrypto` as the browser's `Crypto`, and adds a `ScriptedBrowserbase` service whose `provider` is the control handle and whose `browsers` are the engine control handles, one per provider session: a keep-alive reconnection or a borrowed attachment reaches the same scripted browser again, with the pages it kept. An application written against `BrowserbaseBrowser.open` runs unchanged:

```ts
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import * as Browser from "effect-browser/browser";
import { BrowserPolicy } from "effect-browser/browser-data";
import { BrowserbaseBrowser } from "effect-browserbase/browser";
import * as Testing from "effect-browserbase/testing";

it.effect("release is requested once and confirmed", () =>
  Effect.gen(function* () {
    const scripted = yield* Testing.ScriptedBrowserbase;

    const receipt = yield* Browser.scoped(
      BrowserbaseBrowser.open(BrowserPolicy.unrestricted()),
      (session) =>
        Effect.gen(function* () {
          yield* session.navigate({ url: "https://shop.test/" });

          return yield* session.closeChecked;
        }),
    );

    expect(receipt).toMatchObject({ releaseRequested: true, remote: "confirmed", local: "closed" });
    expect(yield* scripted.provider.sessions).toMatchObject([
      { id: "session-1", status: "COMPLETED", releaseRequests: 1 },
    ]);
  }).pipe(Effect.provide(Testing.layer({ browser: shop }))),
);
```

Sessions are numbered `session-1`, `session-2`, … in creation order. A `pending` release leaves the session `RUNNING`, so checked close fails `Provider` with outcome `unknown` after the real status bound elapses, and the receipt carries `remote: "pending"`; under `it.effect` a `TestClock.adjust` reaches that bound with nothing real elapsing. A `Lost` creation makes `onAllocationUncertain` fire once, as it does when a real request is cut off. A `foreign-session` or `foreign-project` identity makes connection fail `Malformed` before any page is reached, and no reply about the other session can confirm this one's release, so its receipt carries `remote: "unknown"`. Borrowed attachment through `attach` makes a second connection to the owner's scripted browser, which its control lists under `connections`, and no release request. `Allocation.scoped`, `BrowserbaseSessions` and the other resource services run over the same `fetch` with `Testing.provider()` alone, with no browser at all; `Allocation.scoped` also takes a `Crypto`, and `sequentialCrypto` from `effect-browser/testing` keeps its attempt ids predictable.

What a scripted control plane answers is what this repository has read of the provider API, replayed. It establishes that this package handles those answers correctly; it establishes nothing about what Browserbase answers today, which only the hosted checks in [Status](../../docs/STATUS.md) record.

## Beyond the browser session

These services share the Client and its rules: strict input decoding, identity-checked replies, 1 MiB reply bounds, mutations that are never retried, and typed failures whose `outcome` says whether a request was sent. They are host APIs; none of them is exposed to a model by the adapter package.

- `sessions.logs(reference, { includePayloads? })` returns CDP log entries. Protocol payloads are omitted unless requested, because they carry page content, cookies and typed input.
- `sessions.liveUrls(reference, ttl?)` issues redacted Live View URLs for any session in the project. These URLs are bearer capabilities: Browserbase documents that a holder can watch and control the session. Issuing one does not pause automation; use `beginHandoff` when the owner must suspend its own operations for an operator. See Browserbase's [Session Live URLs API](https://docs.browserbase.com/reference/api/session-live-urls) and [Session Live View guide](https://docs.browserbase.com/platform/browser/observability/session-live-view).
- `downloads.list(reference, query)` filters by filename, MIME type, size and creation time at the provider. `downloads.delete` first proves that the file belongs to the session.
- `projects` reads the Client's project and its usage. `certificates` registers proxy CA certificates for `proxySettings.caCertificates`.
- `search` and `page-fetch` call Browserbase's Search and Fetch APIs. `agents` starts, observes and stops hosted agent runs. `functions` invokes and observes deployed Functions; deployment stays with Browserbase's CLI. `webhooks` manages endpoints and returns signing secrets as `Redacted`.

The Live View `ttl` is a requested TTL in seconds. This client accepts positive safe integers from 1 through 21,600 and reports the request as `requestedTtlSeconds`; that field is not a provider-issued expiration receipt. The pinned SDK documents `expiresIn` as optional with a 21,600-second maximum, and says omission lets the URLs expire with the session. The published debug-route schema currently lists the session ID path parameter but omits `expiresIn`. Neither source establishes a provider minimum, so the session-create `timeout` minimum does not apply here and this package does not claim that a one-second request is accepted or honored.

Browserbase's read-only embed example applies `pointer-events: none` to the iframe. That disables pointer interaction through that embed; it does not turn the Live View URL into a read-only capability. Keep the URL private to the intended operator. The provider's `debuggerUrl` is its bordered Live View variant, with the Live View navbar shown by default; its `navbar=false` option hides that provider UI, not native browser chrome.

An agent run or Function invocation that persists a Context writes it from Browserbase's side, outside `ContextCoordination.withWriter`. It is refused while a local writer holds that Context, but nothing stops a later local writer from racing the hosted run.

## Usage observations and allowances

`BrowserbaseProjects.usage` returns the Client project's `browserMinutes` and `proxyBytes`, with no billing period or as-of time. The [usage observation example](examples/usage-observation.ts) timestamps each sample with the Effect Clock **after** the decoded reply: “observed by this host,” not “current in Browserbase's ledger.” Reporting lag, adjustments and resets are unspecified, and session times and proxy bytes do not establish billable units.

| Resource          | Unit and scope                                                                         | Available source                                                                       | Period, rounding and remaining unknowns                                                                                                                                                                                                                                 |
| ----------------- | -------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Browser time      | Minutes, one project                                                                   | `BrowserbaseProjects.usage.browserMinutes`; session timestamps are diagnostic          | The API supplies no period or as-of time. [Plan billing](https://docs.browserbase.com/account/billing/plans) rounds per session with a one-minute minimum; whether the API value is already rounded is unspecified. Reporting lag and paid-plan reset date are unknown. |
| Proxy traffic     | Bytes, one project or session                                                          | Project usage and `SessionMetadata.proxyBytes`                                         | The API supplies no period or as-of time. Billing rounds MB with a one-MB minimum per session; the mapping from reported bytes to billed units and reporting lag are unspecified.                                                                                       |
| Search            | Calls, plan/account allowance                                                          | Host observation of `BrowserbaseSearch.web` only                                       | The [Project Usage API](https://docs.browserbase.com/reference/api/get-project-usage) has no Search counter or billing period. Other writers, failure billing, reporting lag and paid-plan reset date are unknown.                                                      |
| Fetch and Extract | Calls, plan/account allowance; format and proxy choice matter                          | Host observation of `BrowserbasePageFetch.fetch` only                                  | The Project Usage API has no Fetch or Extract counter or billing period. Provider classification and billing of failed or uncertain calls, other writers, reporting lag and reset date are unknown.                                                                     |
| Agents            | Calls, plan/account allowance                                                          | Host observation of `BrowserbaseAgents.run`; its reply can represent a pending run     | The Project Usage API has no Agent counter. Run completion, inference charges, failure billing, other writers, period and reset date are not established by a run reply.                                                                                                |
| Capacity          | Concurrent sessions, session duration, creation rate, Search/Fetch requests per second | Project metadata and [plan limits](https://docs.browserbase.com/account/billing/plans) | These are operational limits, not a consumed monthly allowance or a price. `effect-browser`'s action budget is likewise local policy.                                                                                                                                   |

The example's `observe(attempt, journal)` wraps the host's own Search, Fetch or Agent-run Effect, such as `search.web(query)`. Through `Effect.acquireUseRelease` it commits a journal intent with its Clock start time before the POST and settles it on exit; `Effect.onExit` alone cannot make the intent durable. Both writes are bounded at two seconds: a failed or late `begin` stops the call with its error or a `Cause.TimeoutError`, a failed or late `finish` logs a fixed warning, and an unsettled intent stays `unknown`. The deadlines are cooperative, and `finish` must be idempotent. One intent covers one attempt: retrying or recovering inside the wrapped Effect would hide POSTs or mislabel a failure.

`undispatched` means not sent, `api-reply` means a decoded reply arrived, and `rejected` and `unknown` mean possibly billed; interruptions and defects are `unknown`. `api-reply` replaces the issue's `confirmed`, which reads as a billing confirmation. Observations store only the project, operation, Fetch's requested format and proxy flags, time and outcome. Spans can export journal failure causes, so the host sanitizes them. Metrics may carry the finite operation and outcome values but are not a ledger.

No documented Browserbase API reports allowance consumption, so `assessAllowance` returns `Unknown` unless the host supplies a provider total for the same scope, meter and billing period, or when the period is unknown: 720 observed Fetch replies do not mean “280 of 1,000 left.” The host decodes both at its boundary and verifies a total's provenance through its own billing channel. For an owner's browser-minutes alert, `observedUsageChange` reports the host-observed change between two samples of one project and whether it reached a decoded `BrowserMinutesThreshold`, or `Unknown` after a counter reset.

Rates are outside this package's runtime contract. As reviewed on 25 September 2026, the [Startup pricing card](https://www.browserbase.com/pricing) says $1 per 1,000 unproxied Fetch calls after the included quantity, while its comparison table and the [plan guide](https://docs.browserbase.com/account/billing/plans) say $0.50. The repository maintainer should compare those two sources at least monthly and when the [provider changelog](https://www.browserbase.com/changelog) announces a change, notify maintainers through an issue when they disagree or change materially, and check account billing before updating an example. A webpage is not an automatic rate feed; no price or USD calculator is shipped here.

## Public entry points

- `client` — one immutable account, transport and approved artifact origins.
- `account` — every resource service on one Client, so credentials are composed once.
- `allocation` — a scoped session with no browser connected, released by its own scope.
- `sessions`, `contexts`, `context-coordination` — passive inspection, explicit release, context resources and writer settlement.
- `extensions` — provisioning a Chrome extension archive once as a durable project resource, and selecting it by reference at launch.
- `uploads` — placing a file where the running session can already reach it, and the receipt that authorizes attaching it.
- `launch`, `references`, `session-data`, `cleanup`, `transfers`, `errors` — credential-free schemas and typed expected errors.
- `browser-binding` — the trusted, opaque native engine a browser connects through: Playwright by default, or Playwright routed to a host-resolved endpoint.
- `browser` — scoped allocation, borrowed attachment to a running session, deterministic page control, real pointer, wheel and key input, host-only tabs/frames/viewport, modeled file selection, Live View handoff, keep-alive detach and explicit reconnect.
- `recordings` — post-session Browserbase MP4 assembly, status and bounded retrieval. Stable identity is session + recording page; signed URLs are refreshed and are not durable identity.
- `replays` — host-authorized replay metadata and validated HLS media proxy material. It is playback access to a recording, not another recording.
- `downloads` — ordinary website download metadata, provider-side filters, bounded byte streams and deletion, separate from provider recordings.
- `projects`, `certificates` — project inspection and usage; proxy CA certificate administration.
- `search`, `page-fetch`, `agents`, `functions`, `webhooks` — the Browserbase platform APIs outside a browser session.
- `testing` — a scripted control plane as `fetch`, and the real account and browser Layers composed over it and over the scripted engine from `effect-browser/testing`.

Every expected failure says three things. `operation` is what you asked for, from a closed vocabulary per error class: `BrowserError` names the browser operations, `SessionError` only session calls, and so on, so you can match on them exhaustively and a misspelling is a type error, not a string that happens to compile. `reason` is why it failed. `outcome`, when present, is the package's dispatch evidence: `undispatched` proves this package did not send the mutation and is safe to retry, `rejected` means a provider response refused it, and `unknown` means dispatch or acceptance cannot be ruled out. None is a billing decision. Mutations with `unknown` outcome are never replayed for you. Why an extension archive was refused is a `reason` (`limit`, `unsafe-filename`, `configuration`) of the one `extension-archive` operation. A native step's own name never appears: the driver raises a private failure, and the owner stamps the operation it admitted.

Everything under `src/internal/` is private; the common runtime offers a modeled integration constructor, while no consumer CDP seam is exported; `browser-binding` chooses the engine and where it connects, never what runs over the connection. The driver does hold a CDP session; exposing it, or the ownership internals, would place actions outside the mutation permit that serializes them and outside the fencing that makes an uncertain outcome detectable. Opening a second debugger connection beside this one has the same effect and is equally unsupported. An unmodeled need is a request for a modeled entry point, not a reason to reach around the boundary.

## Artifact and capture guarantees

Provider recordings have an independent post-session lifetime. Assembly POST is a mutation; an uncertain POST is reconciled with status before any deliberate retry. Polling is bounded and preserves per-page partial success/failure. BYOS completion without a Browserbase download URL is reported explicitly.

Website downloads retain their provider download ID, safe filename, MIME type and declared size. Streaming enforces configured MIME, byte and deadline bounds and verifies the completed byte count. A click result alone is never reported as a completed file.

Replay playlists reject arbitrary URI-bearing tags and proxy only indexed media from the validated playlist. API credentials are never returned to a browser client.

Live frames and page holds follow the common [capture guarantees](../browser/README.md#live-capture-and-presentation). The provider's recording/replay services retain their independent lifetime after the browser scope ends. A downstream encoder consumes public frame streams; it does not own another browser.

## Development and evidence

Read [Contributing](../../CONTRIBUTING.md) for the frozen compatibility workspace and required checks. Provider unit tests cover HTTP/resources and release reconciliation; `test/testing.test.ts` runs the public scripted control plane and Layer through the real allocation and cleanup code. Provider regressions that need a browser, such as release reconciliation around a held teardown or a keep-alive reconnection, run over the same public entries in this package's `test/`. The `generic` and `agent-hosted` installed consumers run the maintained native suites against real Chromium with scripted provider HTTP; the `resources` consumer installs no Playwright or Effect Agent, and it also opens scripted browsers through both testing entry points from the packed tarballs. Hosted evidence remains separately recorded in [Status](../../docs/STATUS.md) and never inferred from a local pass.
