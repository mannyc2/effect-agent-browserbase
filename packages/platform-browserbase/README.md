# Browserbase platform for Effect Agent

One owned Browserbase session that your Effect code drives directly, an agent borrows across turns, or both at once — plus video of what happened, either as a provider MP4 after the session or as live frames while it runs.

Built on Playwright over CDP for trusted Node and Bun hosts.

> **Unpublished.** This is a maintainer-review candidate, so consuming it means vendoring the source into a checkout of `danieljvdm/effect-agent`. Ordinary tests never allocate a paid Browserbase session or call a paid model.

## Install

```sh
bun add @effect-agent/platform-browserbase   # once published
```

Peer dependencies: `effect@^4.0.0-rc.115`, `effect-agent@0.1.0-beta.102`, `playwright-core@1.63.0`. You supply an `HttpClient` — every example below provides `FetchHttpClient.Fetch`.

## Drive a browser

```ts
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { Effect, Redacted } from "effect";
import { BrowserNavigateRequest, InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { FetchHttpClient } from "effect/unstable/http";

const options = {
  projectId: process.env.BROWSERBASE_PROJECT_ID!,
  apiKey: Redacted.make(process.env.BROWSERBASE_API_KEY!),
};

const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 40,
  maxElapsedMillis: 5 * 60_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);

    yield* session.handle.navigate(BrowserNavigateRequest.make({ url: "https://example.com" }));
    const observation = yield* session.observe({ maxTextBytes: 8192, maxControls: 16 });

    return observation.url;
  }),
).pipe(
  Effect.provide(BrowserbaseInteractiveHost.layer(options)),
  Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
);
```

The session belongs to the enclosing `Scope` and cannot outlive it. Importing a Layer allocates nothing; the browser appears at `open`.

## Let an agent drive it

```ts
import { handlers, toolkit } from "@effect-agent/platform-browserbase/tools";

const layer = handlers(session); // browser_navigate, browser_inspect, browser_click, browser_fill, browser_scroll
```

The agent borrows the session you already own — no browser is allocated or closed per tool call, and credentials, CDP URLs, Live View and recording settings are never tool parameters. `examples/agent.ts` runs this against a real `AgentRuntime`.

**Know what authority this grants.** `browser_click` and `browser_fill` accept only an exact node from the most recent observation, so a model cannot name a target of its own and a replaced or detached reference fails rather than resolving to something else. `browser_navigate` is different: the URL comes from the model, bounded only by the session's network policy — and the only policy this adapter accepts is `Unrestricted` (see [Network policy](#network-policy)). There is deliberately no per-tool host allowlist, because none is enforceable on this provider. A host that needs navigation confined to known hosts must impose that above this package.

The pinned upstream guide says its own interactive pass "cannot become an agent Tool." That pass is a different, bounded construct; this package's session is long-lived, owned and fenced, which is what makes exposing it defensible. That is a local position, not upstream approval.

## Get video

Two independent paths. Pick by when you need the bytes.

|           | Provider recording                  | Live `Capture`                    |
| --------- | ----------------------------------- | --------------------------------- |
| Available | after the session ends              | while the session is live         |
| Encoding  | Browserbase                         | yours                             |
| Output    | per-page MP4, or HLS replay         | bounded JPEG frames               |
| Enable    | `recordSession: true` at allocation | nothing; independent              |
| Audio     | none — measured, see below          | none; the frame seam has no audio |

### Provider recording

```ts
const collect = Effect.gen(function* () {
  const recordings = yield* BrowserbaseRecordings;

  yield* recordings.request(reference);
  const batch = yield* recordings.wait(reference, { timeoutMillis: 120_000 });
  const page = batch.pages.find((item) => item.delivery === "download");

  if (page === undefined) return batch;

  return yield* recordings
    .download(RecordingPageReference.make({ session: reference, pageId: page.pageId }), {
      maxBytes: 512 * 1024 * 1024,
      timeoutMillis: 120_000,
    })
    .pipe(Stream.runCollect);
});
```

`recordSession` defaults to `false` here even though Browserbase records by default, and it cannot be enabled after allocation — set it when you open the session if you want `recordings` or `replays` later.

Recordings outlive the session: `SessionReference` is credential-free durable identity you can keep after the browser is gone. Download URLs are signed and short-lived; re-list to re-mint. BYOS projects complete without a download URL, and that is reported explicitly rather than looking like a failure.

### Live capture

```ts
const record = Effect.gen(function* () {
  const interval = yield* Capture.start(session, {
    target: page, // a PageInfo from session.pages
    size: { width: 640, height: 360 }, // optional source-fit bounds
    maxDurationMillis: 5_000,
  });

  yield* Stream.runForEach(interval.frames, (frame) => encode(frame.bytes));

  return yield* interval.completed;
});
```

Capture is pinned to the page you name, not to whatever is selected — so an agent can research in a scout tab while a stage page keeps recording. Distinct pages capture concurrently: one interval per native target, up to four active, 64 MiB of aggregate buffering per session.

Frames carry owned JPEG bytes, target identity, sequence, source presentation time, host monotonic receipt time, geometry and explicit drop accounting. Slow consumers drop old frames rather than growing an unbounded backlog — that is buffer management, not backpressure on the page.

`size` fits source frames within pixel bounds without resizing the live viewport (1–16,384 per axis). An already-active screencast can override the request, so actual JPEG dimensions are checked independently and the affected interval ends with a `limit` error rather than delivering something oversized.

The maintained Playwright screencast callback is JPEG-only and exposes no FPS cap, every-Nth control or lossless format, so neither does this package. `examples/record-video.ts` shows caller-side encoding with FFmpeg.

### Audio

There isn't any, on either path, and this is measured rather than assumed.

A bounded hosted check ran a page producing a known 440 Hz tone two independent ways — a `<audio>` element and a WebAudio oscillator started under real user activation — and confirmed from inside the page that it was genuinely playing (`AudioContext.state: "running"`, element unpaused, `currentTime` advancing). The assembled provider MP4 decoded to a single h264 video stream with no audio track. Three recordings, same result.

That follows from the architecture: Browserbase's recording source is a CDP screencast of timestamped viewport screenshots, and the MP4 and HLS renditions draw from that same replay data. There is no audio channel in the pipeline. Live `Capture` has none either — `Page.startScreencast` emits image frames.

This package will not synthesize a silent track or infer audio support from a container. Real audio needs control of the browser host process (a virtual sink), which a hosted session does not give you.

## Hold a page still

```ts
const hold = Effect.gen(function* () {
  const receipt = yield* PageControl.suspend(session, stagePage);

  // ... the scout keeps browsing, the stage does not advance
  yield* PageControl.resume(session, receipt);
});
```

Opt in with `pageControl: true` on the layer. Freezing lifecycle state and zeroing animation playback stops timers, rendering and CSS animation together. Resume consumes that exact receipt — there is no implicit resume, and scope cleanup closes the session rather than silently thawing.

Selection can move to the scout without invalidating the receipt; connection loss, external target invalidation, a completed resume or another session do invalidate it. Resume waits for one bounded real animation frame at rate zero before restoring the previous rate, which avoids Blink's stale pre-hold animation clock.

This is presentation control, not a security boundary and not browser virtual time. Wall time, network, media, workers and provider-side actions are not frozen, and in-flight callbacks are not undone. It intentionally refuses to combine with `keepAlive`, reconnect, handoff or popup/dialog `pause` policies, failing before allocation rather than half-working.

## Ownership and failure

Mutations are serialized through one permit. An observation identifies retained native nodes until the next invalidating event — it is not a DOM snapshot version, and replaced or detached nodes fail rather than silently resolving to a lookalike.

The outcome vocabulary is the important part:

- **`undispatched`** — the package established that native dispatch did not happen. Safe to retry.
- **`unknown`** — interrupted or timed out after dispatch. The owner is fenced and the package never automatically replays it.

Cleanup keeps three states distinct: local disconnect, an accepted provider release request, and provider-confirmed termination. Detach/reconnect is opt-in with `keepAlive`; reconnect creates a new handle generation, verifies the selected target, refetches state, and never replays pending input.

Human handoff pauses automation before returning host-only Live View material, and resume needs an explicit operator-release signal. Live View URLs are temporary bearer material — iframe styling is not an authorization boundary.

## Network policy

`Unrestricted` is the only supported mode, and only when a trusted host selects it.

`ExactHosts` and `PublicWeb` both fail before allocation, deliberately. Browserbase's `allowedDomains` does not prove exact-host containment across redirects, frames, subresources, popups and service workers, and request interception cannot establish connection-time public-address containment. Neither is weakened to look supported — if you need containment, enforce it above this package.

## Entry points

| Module                | What it gives you                                                                                                |
| --------------------- | ---------------------------------------------------------------------------------------------------------------- |
| `interactive-browser` | scoped allocation, page control, host-only tabs/frames/viewport, Live View handoff, keep-alive detach, reconnect |
| `tools`               | model-facing navigate, inspect, observed-node click/fill, scroll                                                 |
| `recordings`          | post-session MP4 assembly, status, bounded retrieval                                                             |
| `replays`             | host-authorized replay metadata and validated HLS proxy material                                                 |
| `downloads`           | ordinary website downloads, separate from provider recordings                                                    |
| `capture`             | target-pinned live JPEG frame streams                                                                            |
| `page-control`        | opt-in host-owned holds with receipt-based resume                                                                |
| `types`               | credential-free schemas and typed errors                                                                         |

Everything under `src/internal/` is private. No consumer CDP seam and no lower-level binding or lifecycle Layer is exported. The driver does hold a CDP session — exposing it, or the ownership internals, would put actions outside the mutation permit that serializes them and outside the fencing that makes an uncertain outcome detectable. Opening a second debugger connection alongside this one has the same effect and is equally unsupported. An unmodeled need is a request for a modeled entry point, not a reason to reach around the boundary.

Host controls above core's provider-neutral handle are per-adapter and not portable. Two-phase allocation, detach, reconnect, Live View, handoff, viewport and cleanup outcomes are named and typed for Browserbase here; the sibling Cloudflare adapter names and types its own. The shapes converged, the types did not, and a shared vocabulary would have to be promoted into core first. No upstream proposal is filed, so an application moving between adapters owns that translation.

## Development

Commands run through Vite+: `vp run check`, `vp test`, `vp run install:test-browser`, `vp run test:native`, `vp pack`.

Native tests drive real Chromium over CDP against loopback HTTP fixtures. Unit tests use `TestClock` and scripted provider edges. Agent tests use the real `AgentRuntime`, Effect AI Toolkit and `@effect-agent/testing/ScriptedModel`. `tools/packed-consumer.sh` installs the emitted tarball into a separate consumer, checks NodeNext declarations, and reruns the native suites without workspace aliases on both Node and Bun.

None of that allocates Browserbase. A local CDP pass proves native integration — not provider allocation, Live View authorization, recording coexistence or Browserbase network behavior.

### Hosted checks

Ordinary CI never allocates a session. After separate approval:

```sh
EFFECT_AGENT_BROWSERBASE_LIVE=1 \
BROWSERBASE_API_KEY=… BROWSERBASE_PROJECT_ID=… \
BROWSERBASE_ARTIFACT_ORIGINS=https://… \
bash tools/hosted-acceptance.sh <patched-effect-agent-worktree>
```

Bounded to one session, 180 seconds, 10 actions, a three-second capture, 512 MiB of download and zero model calls. `BROWSERBASE_ARTIFACT_ORIGINS` is the exact HTTPS origin recordings are delivered from — discover it once from a completed download and pin it; malformed origins fail before allocation.

Live View issuance is automated. Actual operator takeover and release, and provider-side coexistence of Live View with recording and capture, remain manual checks.
