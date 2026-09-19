# Browserbase platform for Effect Agent

`@effect-agent/platform-browserbase` implements Effect Agent's existing
`InteractiveBrowser` service for trusted Node and Bun hosts. One scoped
Browserbase session owns one Playwright-over-CDP connection; application code and
Effect AI Tools borrow handles from that owner rather than allocating browsers per
turn.

The package is an unpublished maintainer-review candidate. Hosted Browserbase
acceptance is separately gated and has not been executed. No release, deployment,
paid model invocation, or paid Browserbase session is performed by the ordinary
test suite.

## Public entry points

- `interactive-browser` — scoped Browserbase allocation, deterministic page
  control, host-only tabs/frames/viewport, Live View handoff, keep-alive detach and
  explicit reconnect.
- `tools` — bounded model-facing navigation, inspection, exact observed-node
  click/fill and scroll. Provider credentials, CDP URLs, context choices and Live
  View controls are never Tool parameters.
- `recordings` — post-session Browserbase MP4 assembly/status/download. Stable
  identity is session + recording page; signed download URLs are refreshed and
  never used as durable identity.
- `replays` — host-authorized replay metadata and validated HLS media proxy
  material. It is playback access, not another recording.
- `downloads` — ordinary website download metadata and bounded byte streams,
  separate from provider recordings.
- `capture` — optional same-live-page JPEG frame stream using Playwright 1.63's
  maintained screencast API. The caller owns encoding, storage and presentation.
- `types` — credential-free schemas and typed expected errors.

Importing a Layer does not allocate a browser. Recording/replay/download-only
imports do not import Playwright. Playwright is loaded lazily when an interactive
session actually connects.

## Ownership and outcomes

The browser belongs to the enclosing Effect `Scope`, not to an agent turn.
Mutations are serialized. An observation identifies retained native nodes only
until the next invalidating event; it is not a DOM snapshot version. Replaced or
detached nodes fail without resolving onto a replacement.

An action interrupted or timed out after native dispatch has an **unknown**
outcome. The owner is fenced and the package never automatically replays it.
`undispatched` means the package established that native mutation dispatch did
not occur. A local disconnect, accepted provider release request and
provider-confirmed termination remain distinct cleanup states.

Human handoff pauses automation before returning host-only Live View material.
Resume requires an explicit operator-release signal and performs the fresh
observation while still holding the same mutation permit. A failed handoff does
not silently resume automation. Live View URLs are temporary bearer material;
iframe styling is not an authorization boundary.

Persistent Browserbase contexts require a host-provided exclusive lease when
writes are persisted. Detach/reconnect is opt-in with `keepAlive`; reconnect
creates a new handle generation, verifies the selected target and obtains fresh
state. It never replays a pending action or treats serialized agent state as a
live browser.

## Network policy

`Unrestricted` is supported only when selected by trusted host policy.
`ExactHosts` currently fails before allocation because Browserbase's
`allowedDomains` setting does not prove exact-host containment for redirects,
frames, subresources, popups and service workers. `PublicWeb` also fails before
allocation because request interception cannot establish connection-time
public-address containment. These modes are deliberately not weakened to make
them appear supported.

## Bounded artifacts

Provider recordings are available only through their independent post-session
lifetime. Assembly POST is a mutation; an uncertain POST is reconciled with
status before any deliberate retry. Polling is bounded and preserves per-page
partial success/failure. BYOS completion without a Browserbase download URL is
reported explicitly.

Website downloads retain their provider download ID, safe filename, MIME type and
declared size. Streaming enforces the configured MIME, byte and deadline bounds
and verifies the completed byte count. A click result alone is never reported as
a completed file.

Replay playlists reject arbitrary URI-bearing tags and only proxy indexed media
from the validated playlist. API credentials are never returned to a browser
client.

## Live capture

Capture borrows the selected live remote page and can be started/stopped more
than once without ending the browser. Frames carry owned JPEG bytes, selected
target identity, sequence number, source presentation time, host monotonic
receipt time, geometry and explicit drop accounting. Buffers are bounded by frame
count and bytes; slow consumers drop old frames rather than creating an unbounded
fiber/callback backlog.

Viewport changes and parent target invalidation terminate an interval explicitly.
Stopping a child capture does not close its browser. The frame seam has **no
website-audio source**, so this package does not claim audio capture, synthesize
silent samples, or infer audio support from a video container. Caller encoding is
demonstrated in `examples/record-video.ts` and intentionally remains outside the
runtime package. The example probes every stream, then decodes every video frame
with the caller's FFmpeg to obtain presentation timestamps and pixel checksums.
Native acceptance checks changing pixels and timing against the capture source;
reading container headers alone is not accepted as video verification.

## Development and evidence

See the repository browser guide and `examples/`. Repository commands use
Vite+: `vp run check`, `vp test`, `vp run install:test-browser`,
`vp run test:native`, and `vp pack`. Native tests use Playwright 1.63.0
Chromium against loopback HTTP fixtures over the real CDP boundary. Unit tests use
Effect TestClock and scripted provider edges. Agent tests use the actual public
`AgentRuntime`, Effect AI Toolkit and `@effect-agent/testing/ScriptedModel`.

`tools/packed-consumer.sh` installs the emitted npm tarball into a separate
consumer with exact public dependency versions, checks NodeNext declarations,
and runs the unchanged native/AgentRuntime suites without workspace aliases.
It also runs a real navigation/action/capture/cleanup program directly on both
Node and Bun. Unpaid Actions retain the decoded-frame verification and local
capture video alongside the command logs, review patch, candidate archive and
checksums. These tests script only provider allocation/status and address lookup;
they do not allocate Browserbase or invoke a paid model.

Those boundaries remain distinct from hosted Browserbase evidence. A local CDP
pass proves native integration, not provider allocation, Live View authorization,
recording coexistence or Browserbase network behavior.

## Hosted acceptance gate

Ordinary CI never allocates Browserbase. After separate approval, maintainers can
run `tools/hosted-acceptance.sh <patched-effect-agent-worktree>` with
`EFFECT_AGENT_BROWSERBASE_LIVE=1`, `BROWSERBASE_API_KEY` and
`BROWSERBASE_PROJECT_ID` plus `BROWSERBASE_ARTIFACT_ORIGINS` (comma-separated exact
HTTPS delivery origins approved by the trusted operator). Missing or malformed
origins fail before allocation. The command is bounded to one session, 180 seconds,
10 actions, a three-second live capture, at most 512 MiB of provider-recording
download, and zero model calls. It records allocation/control/capture/cleanup and
post-close recording results separately. Line-delimited JSON records allocation,
cleanup and interactive results before attempting post-close recording retrieval,
so a later recording failure does not erase the known cleanup identity.

That command does not pretend to perform a human takeover: Live View issuance is
automated, while an actual operator takeover/release and provider-side coexistence
of Live View, native recording and capture remain explicit hosted/manual checks.

`tools/hosted-demo.sh <patched-effect-agent-worktree> <output>` is a second,
separate guarded command under the same opt-in. It records the repository's
published demo video from one bounded session and requests no provider recording,
so it approves no artifact delivery origin. It is documentation evidence, not an
acceptance result: a recording shows a session ran, not that Live View
authorization, handoff, reconnection or artifact retrieval behaved correctly.
Both commands run only from the manual, default-off `Hosted Browserbase`
workflow or a maintainer's own machine.
