# Browserbase for Effect

`@effect-agent/browserbase` owns the whole Browserbase surface for an Effect application: account identity and transport, session and context resources, one owned browser over Playwright/CDP, bounded live capture, explicit page holds, and the provider's recordings, replays and website downloads.

It has no Effect Agent dependency. Playwright is an optional peer, loaded lazily and only when a browser actually connects; a consumer that just reads artifacts never imports it. The package targets trusted Node and Bun hosts. It is an unpublished maintainer-review candidate: hosted provider behavior requires separate validation, and ordinary tests never create a paid Browserbase session or invoke a paid model.

## One account, then resources

Construct `BrowserbaseClient.layer(account)` once and provide it to everything else. Credentials, approved artifact origins and request bounds live there and nowhere else; a browser recipe cannot carry them.

```ts
import { BrowserbaseClient } from "@effect-agent/browserbase/client";
import { BrowserbaseSessions } from "@effect-agent/browserbase/sessions";
import { Layer, Redacted } from "effect";

const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId: process.env.BROWSERBASE_PROJECT_ID!,
      apiKey: Redacted.make(process.env.BROWSERBASE_API_KEY!),
      artifactOrigins: ["https://media.browserbase.com"],
    }),
  ),
);
```

`sessions.retrieve`, `list`, `waitUntilRunning` and `waitForTerminal` are passive. `sessions.requestRelease` is an explicit remote mutation and is never issued as a side effect of reading. Context create/retrieve/delete are separate resource operations; deleting a Context is never a browser finalizer. Mutating control-plane requests are never retried automatically, and a rejected request stays distinguishable from one whose effect is unknown.

`ContextCoordination.withWriter` accepts a consumer-owned distributed lease backend and preserves the consumer's Effect error and environment types. A persisting allocation authenticates that live permit and reports its exact attempt, session and cleanup receipt before settlement. Unknown writers and unconfirmed persistence are quarantined. A terminal session does not establish that Context data finished synchronizing.

## Start with the result you need

For the simplest post-session video path, opt in to Browserbase recording in the launch recipe:

```ts
import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { BrowserPolicy, NavigateRequest } from "@effect-agent/browserbase/browser-data";
import { BrowserbaseRecordings } from "@effect-agent/browserbase/recordings";
import { RecordingPageReference } from "@effect-agent/browserbase/transfers";
import { Effect, Layer, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const launch = {
  remoteTimeoutSeconds: 600,
  viewport: { _tag: "Fixed", width: 1280, height: 720 },
  provider: { browserSettings: { recordSession: true } },
} as const;

const policy = BrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

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
}).pipe(Effect.provide(layers), Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch));
```

The launch recipe deliberately leaves `recordSession` off, even though Browserbase itself currently records sessions by default. Set it explicitly if you need `Recordings` or `Replays`; it cannot be enabled retroactively after allocation.

For model-driven control, use `@effect-agent/platform-browserbase`, whose tools borrow an already-owned session rather than allocating a browser per tool call. Provider credentials, CDP URLs, context choices, Live View controls and recording configuration are host decisions and are never Tool parameters.

## Choose a video path

|            | Provider recording (`recordings` / `replays`)             | Live `capture`                                      |
| ---------- | --------------------------------------------------------- | --------------------------------------------------- |
| Encoding   | Browserbase                                               | caller-owned                                        |
| Available  | after the session ends                                    | while the session is live                           |
| Enablement | `recordSession: true` at allocation                       | independent of provider recording                   |
| Output     | per-page MP4 download or validated HLS replay             | bounded JPEG frames                                 |
| Control    | provider-owned encoding                                   | JPEG quality/source-fit bounds plus caller encoding |
| Audio      | not claimed until provider evidence proves a track exists | none; the screencast frame seam has no audio source |

Prefer provider recording when post-session MP4/HLS is enough. Use `capture` when you need frames during the session, need to transform or encode them yourself, did not enable provider recording, are testing locally without a paid session, or need a live-frame path distinct from Browserbase's post-session artifact lifetime. BYOS recording completion is reported explicitly even when Browserbase does not return a download URL.

`Capture.start(session, { target: page })` accepts a `PageInfo` from `session.pages` and pins the interval to that page independently of the selected automation target. Omitting `target` binds to the page selected when capture starts; later selection changes do not move or stop it. An agent can drive a scout tab while the stage page keeps recording. Distinct pages may capture concurrently, with one interval per native target, at most four active or quarantined intervals, and 64 MiB of aggregate reserved buffering per session. The maintained Playwright screencast callback is JPEG-only here and the public API does not expose an FPS cap or lossless format.

`Capture.start(session, { target: page, size: { width: 640, height: 360 } })` requests source frames fitted within those pixel bounds without resizing the live viewport. Both dimensions must be integers from 1 through 16,384; the existing 33,554,432-pixel and byte limits still apply to actual frames. The request is validated and copied before native work or capture-budget admission. Omitting `size` preserves Playwright's default (the viewport fitted within 800×800). An already-active native screencast can override a requested size, so the package independently checks actual JPEG dimensions and ends the affected interval with a `limit` error before delivering an oversized frame. It does not silently resize bytes, invent dimensions, alter timestamps, or end a sibling page's capture. A size request is not a frame-rate limit or a guarantee about bytes produced before they reach the package.

## Session, reference, and ownership

`BrowserbaseSession` is the live capability. It belongs to the enclosing Effect `Scope`, owns the Playwright-over-CDP connection, and cannot outlive that scope. `SessionReference` is credential-free durable identity; it can be retained after the browser is gone and is what the independent `recordings`, `replays` and cleanup APIs use.

That split is why an agent can use one browser for many turns while provider artifacts remain accessible after the interactive scope ends. Importing a Layer does not allocate a browser.

The browser owner does not allocate or release anything itself. It supplies the local half of cleanup — fence, capture stop, initialization teardown, disconnect — and the canonical control plane owns the release request and the terminal status observation. A local disconnect, an accepted provider release request and provider-confirmed termination therefore stay distinct facts in one `CleanupResult`, together with the exact steps that failed.

Mutations are serialized. An observation identifies retained native nodes only until the next invalidating event; it is not a DOM snapshot version. Replaced or detached nodes fail instead of silently resolving to replacements. An action interrupted or timed out after native dispatch has an **unknown** outcome: the owner is fenced and the package never automatically replays it. `undispatched` is used only when the package established that native mutation dispatch did not occur.

The connection endpoint is read through the exact allocated session, so a provider reply that names a different session is refused before any CDP attachment.

Persistent Browserbase contexts require a live writer permit from `ContextCoordination.withWriter` when writes are persisted. Detach/reconnect is opt-in with `keepAlive`; reconnect creates a new handle generation, verifies the selected target, obtains fresh state, and never replays pending input or treats serialized agent state as a live browser.

Human handoff pauses automation before returning host-only Live View material. Resume requires an explicit operator-release signal and obtains a fresh observation while holding the same mutation permit. A failed handoff does not silently resume automation. Live View URLs are temporary bearer material; iframe styling is not an authorization boundary.

## Network policy

`Unrestricted` is the only supported `BrowserPolicy.network`, and only when selected by trusted host policy. The adapter package refuses Effect Agent's `ExactHosts` before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups and service workers, and refuses `PublicWeb` because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

## Public entry points

- `client` — one immutable account, transport and approved artifact origins.
- `sessions`, `contexts`, `context-coordination` — passive inspection, explicit release, context resources and writer settlement.
- `launch`, `references`, `browser-data`, `session-data`, `cleanup`, `transfers`, `errors` — credential-free schemas and typed expected errors.
- `browser` — scoped allocation, deterministic page control, host-only tabs/frames/viewport, Live View handoff, keep-alive detach and explicit reconnect.
- `capture` — optional target-pinned live-page JPEG frame streams using Playwright 1.63's maintained screencast API. The caller owns encoding, storage and presentation.
- `page-control` — opt-in host-owned stage holds and explicit receipt-based resume, independent of scout selection.
- `recordings` — post-session Browserbase MP4 assembly, status and bounded retrieval. Stable identity is session + recording page; signed URLs are refreshed and are not durable identity.
- `replays` — host-authorized replay metadata and validated HLS media proxy material. It is playback access to a recording, not another recording.
- `downloads` — ordinary website download metadata and bounded byte streams, separate from provider recordings.

Everything under `src/internal/` is private, and no consumer CDP seam or lower-level binding/lifecycle Layer is exported. The driver does hold a CDP session; exposing it, or the ownership internals, would place actions outside the mutation permit that serializes them and outside the fencing that makes an uncertain outcome detectable. Opening a second debugger connection beside this one has the same effect and is equally unsupported. An unmodeled need is a request for a modeled entry point, not a reason to reach around the boundary.

## Artifact and capture guarantees

Provider recordings have an independent post-session lifetime. Assembly POST is a mutation; an uncertain POST is reconciled with status before any deliberate retry. Polling is bounded and preserves per-page partial success/failure. BYOS completion without a Browserbase download URL is reported explicitly.

Website downloads retain their provider download ID, safe filename, MIME type and declared size. Streaming enforces configured MIME, byte and deadline bounds and verifies the completed byte count. A click result alone is never reported as a completed file.

Replay playlists reject arbitrary URI-bearing tags and proxy only indexed media from the validated playlist. API credentials are never returned to a browser client.

Live capture frames carry owned JPEG bytes, captured target identity, sequence number, source presentation time, host monotonic receipt time, geometry and explicit drop accounting. Buffers are bounded by frame count and bytes; slow consumers drop old frames instead of creating an unbounded fiber/callback backlog. Buffer dropping is not page-clock backpressure and does not reduce what the browser produced upstream. Holding a capture callback is not a promise that page timers or animations stop.

Closing, navigating, detaching a relevant frame, or resizing the captured page ends its interval explicitly without ending a sibling page's capture. Selecting another page or frame does not invalidate an unrelated interval. Handoff pause, connection loss, an uncertain owner and session closure still invalidate all child intervals. A confirmed native stop releases only its own reservation; a failed stop on a live page keeps that target quarantined. A definitively closed page releases its capture reservation. Stopping a child capture does not close its browser. The frame seam has **no website-audio source**, so this package does not synthesize silent samples or infer audio support from a video container. Caller encoding is demonstrated in `examples/record-video.ts`; the example decodes every generated frame with the caller's FFmpeg and checks presentation timestamps and pixel checksums. Native acceptance requires changing pixels and source-time agreement rather than accepting container headers as video evidence.

## Explicit stage-page holds (opt-in)

Set `pageControl: true` on `BrowserbaseBrowser.layer` to use the host-only `page-control` module. The default remains off. `PageControl.suspend(session, page)` returns a live `PageSuspension`; `PageControl.resume(session, receipt)` consumes that exact receipt. Use a `PageInfo` from `session.pages`. Selection can move to the scout without invalidating the receipt, but connection loss, external target invalidation, completed resume, or another session does invalidate it. `PageControl.state` reports the last acknowledged local state, not proof about a lost remote connection.

This opt-in uses maintained CDP attachment with `noDefaults: true` and owner-controlled per-page focus emulation. It intentionally does not support `keepAlive`, reattachment, human handoff, or popup/dialog `pause` policies. These combinations fail before provider allocation; use the existing `retain`/`close` popup policies and `dismiss` dialog policy. Resume explicitly activates the native page without changing SDK selection. Do not enable it where another native client owns focus. Modeled input, DOM reads, waits and viewport changes on held/unknown pages fail before dispatch; the scout remains operable. Page close and session close remain available. Capture does not thaw a held page; frame consumption and acknowledgements never suspend/resume it implicitly.

The native tests cover page timers, RAF and CSS animation, scout progress with both pages captured, an already-paused animation, and restoration of a non-default rate. Resume waits for one bounded real RAF in an isolated world at rate zero before restoring that rate, avoiding Blink's stale pre-hold animation clock. In-flight callbacks are not undone. Date/wall time, network, media/audio, workers/service workers, and external/provider actions are not promised frozen. This is presentation control, not a security boundary or browser virtual time.

Partial native failures fence the session as uncertain; there is no success receipt, automatic rollback or retry. Scope cleanup never sends a hidden resume: it closes the owned session/connection. Chromium may reset animation state on CDP detachment, so a previous hold acknowledgement does not guarantee remote clocks remain held after connection loss. Hosted-provider equivalence has not been tested.

## Development and evidence

Repository commands use Vite+: `vp run check`, `vp test`, `vp run install:test-browser`, `vp run test:native`, `vp pack`. Native tests use Playwright 1.63.0 Chromium against loopback HTTP fixtures over the real CDP boundary. Unit tests use Effect TestClock and a provider scripted through `fetch` behind the real Client. Those local boundaries remain distinct from hosted Browserbase evidence: a local CDP pass proves native integration, not provider allocation, Live View authorization, provider recording/audio behavior, recording coexistence, or Browserbase network behavior.

`tools/packed-consumer.sh` installs the emitted npm tarballs into separate consumers with exact public dependency versions, checks NodeNext declarations, and runs the unchanged native suites without workspace aliases. It also runs real programs directly on Node and Bun: `test/consumer/resources.ts` with no Playwright and no framework installed, and `test/consumer/native.ts` against a real local Chromium.
