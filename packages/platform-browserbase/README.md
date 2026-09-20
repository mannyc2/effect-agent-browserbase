# Browserbase platform for Effect Agent

`@effect-agent/platform-browserbase` gives an Effect application one owned Browserbase session that can be driven directly or borrowed by Effect AI Tools across agent turns. The same session can produce provider recordings after it ends, or bounded JPEG frames while it is live.

The package targets trusted Node and Bun hosts and uses Playwright over CDP. It is an unpublished maintainer-review candidate. Hosted provider behavior requires separate validation; ordinary tests never create a paid Browserbase session or invoke a paid model. Consult the repository status for the scope of any separately recorded hosted evidence.

## Start with the result you need

For the simplest post-session video path, opt in to Browserbase recording when the session is allocated:

```ts
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserbaseRecordings } from "@effect-agent/platform-browserbase/recordings";
import { RecordingPageReference } from "@effect-agent/platform-browserbase/types";
import { Effect, Layer, Redacted, Stream } from "effect";
import { BrowserNavigateRequest, InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";

const options = {
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  apiKey: Redacted.make(process.env.BROWSERBASE_API_KEY!),
  recordSession: true,
};

const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const layers = Layer.merge(
  BrowserbaseInteractiveHost.layer(options),
  BrowserbaseRecordings.layer(options),
);

const program = Effect.gen(function* () {
  const host = yield* BrowserbaseInteractiveHost;
  const recordings = yield* BrowserbaseRecordings;

  const reference = yield* Effect.scoped(
    Effect.gen(function* () {
      const session = yield* host.open(policy);
      yield* session.handle.navigate(BrowserNavigateRequest.make({ url: "https://example.com" }));

      // An AgentRuntime can borrow this same session; see examples/agent.ts.
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

This adapter deliberately defaults `recordSession` to `false`, even though Browserbase itself currently records sessions by default. Set `recordSession: true` explicitly if you need `Recordings` or `Replays`; it cannot be enabled retroactively after allocation.

For model-driven control, `examples/agent.ts` shows an `AgentRuntime` whose `Navigate`, `Inspect`, `Click`, `Fill`, and `Scroll` tools borrow the already-owned session rather than allocating a browser per tool call. Provider credentials, CDP URLs, context choices, Live View controls, and recording configuration are host decisions and are never Tool parameters.

## Choose a video path

|            | Provider recording (`Recordings` / `Replays`)             | Live `Capture`                                      |
| ---------- | --------------------------------------------------------- | --------------------------------------------------- |
| Encoding   | Browserbase                                               | caller-owned                                        |
| Available  | after the session ends                                    | while the session is live                           |
| Enablement | `recordSession: true` at allocation                       | independent of provider recording                   |
| Output     | per-page MP4 download or validated HLS replay             | bounded JPEG frames                                 |
| Control    | provider-owned encoding                                   | JPEG quality/source-fit bounds plus caller encoding |
| Audio      | not claimed until provider evidence proves a track exists | none; the screencast frame seam has no audio source |

Prefer provider recording when post-session MP4/HLS is enough. Use `Capture` when you need frames during the session, need to transform or encode them yourself, did not enable provider recording, are testing locally without a paid session, or need a live-frame path distinct from Browserbase's post-session artifact lifetime. BYOS recording completion is reported explicitly even when Browserbase does not return a download URL.

`Capture.start(session, { target: page })` accepts a `PageInfo` from `session.pages` and pins the interval to that page independently of the selected automation target. Omitting `target` binds to the page selected when capture starts; later selection changes do not move or stop it. An agent can drive a scout tab while the stage page keeps recording. Distinct pages may capture concurrently, with one interval per native target, at most four active or quarantined intervals, and 64 MiB of aggregate reserved buffering per session. The maintained Playwright screencast callback is JPEG-only here and the public API does not expose an FPS cap or lossless format.

`Capture.start(session, { target: page, size: { width: 640, height: 360 } })` requests source frames fitted within those pixel bounds without resizing the live viewport. Both dimensions must be integers from 1 through 16,384; the existing 33,554,432-pixel and byte limits still apply to actual frames. The request is validated and copied before native work or capture-budget admission. Omitting `size` preserves Playwright's default (the viewport fitted within 800×800). An already-active native screencast can override a requested size, so the adapter independently checks actual JPEG dimensions and ends the affected interval with a `limit` error before delivering an oversized frame. It does not silently resize bytes, invent dimensions, alter timestamps, or end a sibling page's capture. A size request is not a frame-rate limit or a guarantee about bytes produced before they reach the adapter.

## Session, reference, and ownership

`BrowserbaseSession` is the live capability. It belongs to the enclosing Effect `Scope`, owns the Playwright-over-CDP connection, and cannot outlive that scope. `SessionReference` is credential-free durable identity; it can be retained after the browser is gone and is what the independent `Recordings`, `Replays`, and cleanup APIs use.

That split is why an agent can use one browser for many turns while provider artifacts remain accessible after the interactive scope ends. Importing a Layer does not allocate a browser. Recording/replay/download-only imports do not import Playwright; Playwright is loaded lazily only when interactive control connects.

Mutations are serialized. An observation identifies retained native nodes only until the next invalidating event; it is not a DOM snapshot version. Replaced or detached nodes fail instead of silently resolving to replacements. An action interrupted or timed out after native dispatch has an **unknown** outcome: the owner is fenced and the package never automatically replays it. `undispatched` is used only when the package established that native mutation dispatch did not occur.

This package intentionally exposes Effect AI Tools over its long-lived, execution-owned Browserbase session. The pinned upstream browser guide describes its own interactive pass as a different, bounded construct and says it cannot become an agent Tool. The local ownership/fencing model explains this package's extension; it should not be presented as upstream approval of that extension.

A local disconnect, an accepted provider release request, and provider-confirmed termination remain distinct cleanup states. Persistent Browserbase contexts require a host-provided exclusive lease when writes are persisted. Detach/reconnect is opt-in with `keepAlive`; reconnect creates a new handle generation, verifies the selected target, obtains fresh state, and never replays pending input or treats serialized agent state as a live browser.

Human handoff pauses automation before returning host-only Live View material. Resume requires an explicit operator-release signal and obtains a fresh observation while holding the same mutation permit. A failed handoff does not silently resume automation. Live View URLs are temporary bearer material; iframe styling is not an authorization boundary.

## Network policy

`Unrestricted` is supported only when selected by trusted host policy. `ExactHosts` fails before allocation because Browserbase's `allowedDomains` setting does not prove exact-host containment for redirects, frames, subresources, popups, and service workers. `PublicWeb` also fails before allocation because request interception cannot establish connection-time public-address containment. These modes are deliberately not weakened to make them appear supported.

## Public entry points

- `interactive-browser` — scoped Browserbase allocation, deterministic page control, host-only tabs/frames/viewport, Live View handoff, keep-alive detach, and explicit reconnect.
- `tools` — bounded model-facing navigation, inspection, exact observed-node click/fill, and scroll.
- `recordings` — post-session Browserbase MP4 assembly, status, and bounded retrieval. Stable identity is session + recording page; signed URLs are refreshed and are not durable identity.
- `replays` — host-authorized replay metadata and validated HLS media proxy material. It is playback access to a recording, not another recording.
- `downloads` — ordinary website download metadata and bounded byte streams, separate from provider recordings.
- `capture` — optional target-pinned live-page JPEG frame streams using Playwright 1.63's maintained screencast API. The caller owns encoding, storage, and presentation.
- `page-control` — opt-in host-owned stage holds and explicit receipt-based resume, independent of scout selection.
- `types` — credential-free schemas and typed expected errors.

## Artifact and capture guarantees

Provider recordings have an independent post-session lifetime. Assembly POST is a mutation; an uncertain POST is reconciled with status before any deliberate retry. Polling is bounded and preserves per-page partial success/failure. BYOS completion without a Browserbase download URL is reported explicitly.

Website downloads retain their provider download ID, safe filename, MIME type, and declared size. Streaming enforces configured MIME, byte, and deadline bounds and verifies the completed byte count. A click result alone is never reported as a completed file.

Replay playlists reject arbitrary URI-bearing tags and proxy only indexed media from the validated playlist. API credentials are never returned to a browser client.

Live `Capture` frames carry owned JPEG bytes, captured target identity, sequence number, source presentation time, host monotonic receipt time, geometry, and explicit drop accounting. Buffers are bounded by frame count and bytes; slow consumers drop old frames instead of creating an unbounded fiber/callback backlog. Buffer dropping is not page-clock backpressure and does not reduce what the browser produced upstream. Page holds require explicit host policy through the opt-in `page-control` capability described below. Holding a capture callback is not a promise that page timers or animations stop.

Closing, navigating, detaching a relevant frame, or resizing the captured page ends its interval explicitly without ending a sibling page's capture. Selecting another page or frame does not invalidate an unrelated interval. Handoff pause, connection loss, an uncertain owner, and session closure still invalidate all child intervals. A confirmed native stop releases only its own reservation; a failed stop on a live page keeps that target quarantined. A definitively closed page releases its capture reservation. Stopping a child capture does not close its browser. The frame seam has **no website-audio source**, so this package does not synthesize silent samples or infer audio support from a video container. Caller encoding is demonstrated in `examples/record-video.ts`; the example decodes every generated frame with the caller's FFmpeg and checks presentation timestamps and pixel checksums. Native acceptance requires changing pixels and source-time agreement rather than accepting container headers as video evidence.

## Development and evidence

Repository commands use Vite+: `vp run check`, `vp test`, `vp run install:test-browser`, `vp run test:native`, `vp pack`. Native tests use Playwright 1.63.0 Chromium against loopback HTTP fixtures over the real CDP boundary. Unit tests use Effect TestClock and scripted provider edges. Agent tests use the actual public `AgentRuntime`, Effect AI Toolkit, and `@effect-agent/testing/ScriptedModel`.

`tools/packed-consumer.sh` installs the emitted npm tarball into a separate consumer with exact public dependency versions, checks NodeNext declarations, and runs the unchanged native/AgentRuntime suites without workspace aliases. It also runs a real navigation/action/capture/cleanup program directly on Node and Bun. Unpaid Actions retain decoded-frame verification and local capture video alongside command logs, the source-only review patch, candidate archive, and checksums. These tests script provider allocation/status and address lookup only; they do not allocate Browserbase or invoke a paid model.

Those boundaries remain distinct from hosted Browserbase evidence. A local CDP pass proves native integration, not provider allocation, Live View authorization, provider recording/audio behavior, recording coexistence, or Browserbase network behavior.

## Hosted acceptance gate

Ordinary CI never allocates Browserbase. After separate approval, maintainers can run `tools/hosted-acceptance.sh <patched-effect-agent-worktree>` with `EFFECT_AGENT_BROWSERBASE_LIVE=1`, `BROWSERBASE_API_KEY`, and `BROWSERBASE_PROJECT_ID` plus `BROWSERBASE_ARTIFACT_ORIGINS` (comma-separated exact HTTPS delivery origins approved by the trusted operator). Missing or malformed origins fail before allocation.

The command is bounded to one session, 180 seconds, 10 actions, a three-second live capture, at most 512 MiB of provider-recording download, and zero model calls. It records allocation/control/capture/cleanup and post-close recording results separately. Line-delimited JSON records allocation, cleanup, and interactive results before post-close recording retrieval so a later artifact failure does not erase known cleanup identity.

That command does not pretend to perform a human takeover. Live View issuance is automated, while actual operator takeover/release and provider-side coexistence of Live View, native recording, and capture remain explicit hosted/manual checks.

## Explicit stage-page holds (opt-in)

Set `pageControl: true` on `BrowserbaseInteractiveHost.layer` to use the host-only `@effect-agent/platform-browserbase/page-control` module. The default remains off. `PageControl.suspend(session, page)` returns a live `PageSuspension`; `PageControl.resume(session, receipt)` consumes that exact receipt. Use a `PageInfo` from `session.pages`. Selection can move to the scout without invalidating the receipt, but connection loss, external target invalidation, completed resume, or another session does invalidate it. `PageControl.state` reports the last acknowledged local state, not proof about a lost remote connection.

This opt-in uses maintained CDP attachment with `noDefaults: true` and adapter-owned per-page focus emulation. It intentionally does not support `keepAlive`, reattachment, human handoff, or popup/dialog `pause` policies. These combinations fail before provider allocation; use the existing `retain`/`close` popup policies and `dismiss` dialog policy. Resume explicitly activates the native page without changing SDK selection. Do not enable it where another native client owns focus. Modeled input, DOM reads, waits and viewport changes on held/unknown pages fail before dispatch; the scout remains operable. Page close and session close remain available. Capture does not thaw a held page; frame consumption and acknowledgements never suspend/resume it implicitly.

The native tests cover page timers, RAF and CSS animation, scout progress with both pages captured, an already-paused animation, and restoration of a non-default rate. Resume waits for one bounded real RAF in an isolated world at rate zero before restoring that rate, avoiding Blink's stale pre-hold animation clock. In-flight callbacks are not undone. Date/wall time, network, media/audio, workers/service workers, and external/provider actions are not promised frozen. This is presentation control, not a security boundary or browser virtual time.

Partial native failures fence the session as uncertain; there is no success receipt, automatic rollback or retry. Scope cleanup never sends a hidden resume: it closes the owned session/connection. Chromium may reset animation state on CDP detachment, so a previous hold acknowledgement does not guarantee remote clocks remain held after connection loss. Hosted-provider equivalence has not been tested.
