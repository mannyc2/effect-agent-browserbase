# Realistic browser footage

Films a scripted browser session so that it reads as a person using a product:
a visible pointer that travels and settles, typing with a cadence, scrolling
with momentum, pauses long enough to read, and a constant-frame-rate H.264 file
at the end. The film in [`docs/media/`](../../../../docs/media/README.md) was
made by this code against a local Chromium.

Every change to the page in that film is one of the session's ordinary bounded
actions. The example adds presentation around them; it does not add a second
way to drive the browser.

## What makes footage look real

Ranked by how much each one matters on screen. The numbers live, with their
sources, in [`Humanize.ts`](Humanize.ts).

| What a viewer notices                                                                                                                                        | What the example does                                                                                                                                                                                                                                     |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **There is no pointer.** A screencast carries rendered pixels, and the operating system's pointer is not one of them. Controls change under no visible hand. | `Stagehand.ts` draws one in the page, in a closed shadow root that takes no input. It becomes a hand over links and an I-beam over fields by asking the page what cursor it wants there.                                                                  |
| **The pointer teleports, or moves like a ruler.**                                                                                                            | A cubic Bézier bowed to one side, travelled on the minimum-jerk profile, so it accelerates and lands with no speed left. Duration comes from Fitts's law: a far or small target takes longer. Reaches over 500px sometimes overshoot and come back.       |
| **Clicks hit the mathematical centre, the instant the pointer arrives.**                                                                                     | The aim point is drawn around the centre, never on it. The pointer settles for 80–180ms, then the session's own `click` is dispatched. The press and ripple are drawn from the page's real `mousedown`, so a ripple on film means the real click arrived. |
| **Text appears all at once.**                                                                                                                                | One `fill` per key, through every value the field passes through, at log-normal intervals with a 60ms floor, a slower first key of each word, and an occasional neighbouring-key slip that is noticed and corrected.                                      |
| **The page jumps to the next thing.**                                                                                                                        | Before using anything outside the comfortable middle of the viewport, the page is scrolled to it in a few eased flicks with a breath between them.                                                                                                        |
| **Nothing is on screen long enough to read.**                                                                                                                | `Read` rests in proportion to how many words just appeared, at a fraction of the measured silent reading rate, within bounds.                                                                                                                             |
| **Motion stutters, or a still moment vanishes.**                                                                                                             | A screencast only delivers a frame when the page repaints. `Reel.ts` places each frame by its own presentation timestamp on a constant 30 fps grid and holds the picture across empty slots.                                                              |
| **Soft text.**                                                                                                                                               | Frames are requested at the viewport's own size (the default fit is 800×800) at JPEG quality 92, and encoded once: x264 CRF 18, `yuv420p`, even dimensions, `+faststart`.                                                                                 |
| **The film opens on a blank or reflowing page.**                                                                                                             | The opening document is loaded, and its fonts are ready, before the camera rolls; the performance starts only after the first frame arrives; the last picture is held for a moment after the final action.                                                |
| **A retake looks different.**                                                                                                                                | All randomness comes from Effect's `Random`, so one `Random.withSeed` reproduces every path, pause and slip.                                                                                                                                              |

Tools in this space (Screen Studio, Cap, webreel, ghost-cursor, Playwright's own
`recordVideo`) agree on this list. What they add beyond it is post-production:
zoom-to-click, motion blur, window chrome. Those composite over a finished
film and are out of scope here.

## How it fits the library

The library has no pointer-move and no single key press, and it lets a page call
the host but never the reverse. The example is built on what it does have:

```
host                                            page (allowed origins only)
────                                            ────
Storyboard ─► Actor ─► Director.perform(cue) ◄── footageCue(report) ── Stagehand
                │            slot + ack          typed Bootstrap.binding   draws pointer,
                │                                                          plays tracks
                └────► session.click / fill / clickAndWait ──────────────► real input events
Camera ◄── Capture.start … one interval per document ◄──────────────────── screencast
   ├─► Broadcast ─► /live.mjpeg   every frame, as it arrives, to whoever is watching
   ├─► Reel (constant rate) ─► ffmpeg stdin ─► .mp4
   └─► Telemetry ─► Footage.metrics, and /metrics while it runs
```

- **`Stagehand.ts`** is a `Bootstrap.init` script plus one `Bootstrap.binding`.
  The page long-polls the host: each call reports what it just finished and
  returns the next `Cue`. Both directions are Schema-decoded (`Cues.ts`).
- **`Director.ts`** is the host half, a `Context.Service`. One cue sits in a
  slot until a page reports it done. Handing it over does not consume it, so a
  call left behind by a replaced document cannot lose a cue. The binding's
  handler requires `Director`, and that requirement stays visible on the plan
  until `browser.open` captures it.
- **Motion plays in the page**, at display rate, from a sampled track the host
  computed. A host that sent one position per round trip would film its own
  latency, and would spend an action per frame.
- **`Camera.ts`** treats a navigation as a cut. Navigating ends a capture
  interval by design, so the camera starts the next take and the reel holds the
  last picture across the gap. Frames stream straight into FFmpeg's stdin;
  nothing is buffered beyond the capture's own bounds and no frame files are
  written.
- **`Broadcast.ts`** sends the same frames to live viewers, and
  **`Telemetry.ts`** accounts for them. Both are described below.
- **`Storyboard.ts`** is the performance as Schema data, so it can be written by
  hand, stored, or proposed by a model and still be decoded before it runs.

## Watching it live

The frames the camera films are a live stream before they are a file, so the
same session can be watched while it runs. `Broadcast.layer({ port })` serves:

- `/` is a viewer page: the live picture beside the numbers below, refreshed
  twice a second.
- `/live.mjpeg` is motion JPEG. Every captured frame is written to every viewer
  as it arrives, as one part of a `multipart/x-mixed-replace` response, which an
  `<img>` plays with no script. Nothing is encoded or segmented on the way, so
  this adds one write of latency. A viewer slower than the capture skips frames
  instead of queueing them, and a new viewer is shown the current picture at
  once.
- `/metrics` is the same `Metrics` value `Footage.record` returns, as JSON.

It binds to loopback by default. A filmed page can show anything the session can
see, so reaching it from another machine should be a tunnel someone chose to
open:

```sh
# on the machine that films
REALISTIC_FOOTAGE_LIVE_PORT=8787 \
  ../../node_modules/.bin/vp test --config vite.native.config.ts --run test/native/realistic-footage.test.ts

# on the machine that watches
ssh -N -L 8787:127.0.0.1:8787 <filming-host>    # then open http://127.0.0.1:8787/
```

With that variable set, the film waits up to two minutes for a viewer before it
starts. Without it, the test is its own viewer: it reads `/live.mjpeg` while the
storyboard runs and requires most frames to have arrived before the film ended.

An **encoded** stream (HLS, RTMP, WHIP) is the other shape, for reach rather
than latency. It needs a constant frame rate and cannot wait for the page's next
repaint to get one: drive `Reel` from a clock so the held picture is repeated
every slot, and give FFmpeg a muxer instead of a file path (`+faststart` needs a
finished file; use fragmented MP4 or HLS). Expect seconds, not milliseconds.

## What it reports

This code sits between a browser and whoever watches. `Telemetry.ts` reports
what that position is answerable for, and nothing past it.

| Metric                                        | What it tells you                                                                                                                                                                                                                                                                     |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `capture.latencyMillis`                       | Presentation in the browser to receipt on the host, p50/p95/p99/max. A frame's source time is on the **browser's** clock, so this is `null` until the clocks have been compared.                                                                                                      |
| `capture.clock`                               | That comparison: host minus browser, and its error bound. Every cue exchange doubles as a four-timestamp NTP sample; the tightest round trip wins, and half of it is the uncertainty on every latency above.                                                                          |
| `capture.interFrameMillis`, `framesPerSecond` | Pacing as delivered. A still page is a long gap, not a fault.                                                                                                                                                                                                                         |
| `takes[]`                                     | Per interval: received, delivered, dropped **by this host**, duplicates, peak buffer (backpressure from the encoder shows here first), time to first frame, and whether the native stop was confirmed. What the browser or network dropped upstream is unknown, and is not estimated. |
| `uncoveredMillis[]`                           | Source time that no interval filmed, one entry per cut. On film it is a held picture; here it is a number.                                                                                                                                                                            |
| `control.actionMillis`                        | Dispatch to return for each of the session's actions, by kind. On a hosted session this is mostly round trip.                                                                                                                                                                         |
| `control.cueRoundTripMillis`                  | A `Locate` cue out and its report back: the page-to-host channel alone.                                                                                                                                                                                                               |
| `control.clickToFrameMillis`                  | A click's dispatch to the next frame received. An upper bound on action-to-pixel, since the next frame may be a caret blink.                                                                                                                                                          |
| `output.heldFrames`                           | Output frames that repeat the previous picture. High on still pages by design; a sudden rise on a busy page means frames are not arriving.                                                                                                                                            |

Deliberately absent: glass-to-glass latency, rebuffering, anything about a
viewer's player or network. Each live frame carries `X-Source-Time-Millis` so an
application can measure its own last hop.

On one machine, the committed storyboard measures about 6ms p50 capture latency
with a clock offset of −0.6 ± 1.0ms, 170ms uncovered at the navigation, and 3ms
p50 cue round trip. Those are loopback numbers; hosted ones will be dominated by
the network and have not been measured.

## Running it

FFmpeg and ffprobe must be on `PATH`; encoding is deliberately not a package
dependency. From a bootstrapped workspace:

```sh
cd packages/browserbase
REALISTIC_FOOTAGE_DIR=/somewhere/to/keep/it \
  ../../node_modules/.bin/vp test --config vite.native.config.ts --run test/native/realistic-footage.test.ts
```

That films `Footage.demo` against `StageSite.ts`, a small fictional product
served from loopback, through the real adapter over real CDP. Only provider
allocation is scripted, as in every native test here. It also writes
`realistic-footage.metrics.json` beside the film. The motion models, the reel,
the director and the telemetry arithmetic are tested without a browser in
`test/realistic-footage.test.ts`.

To film your own product on a hosted session, open it with the plan and provide
the services the film needs:

```ts
const film = Effect.gen(function* () {
  const browser = yield* BrowserbaseBrowser;

  const session = yield* browser.open(policy, {
    bootstrap: Stagehand.plan(["https://app.example.com"]),
  });

  return yield* Footage.record(session, { url, storyboard, outputPath, seed: "take-1" });
}).pipe(
  Effect.provide(
    Layer.mergeAll(Director.layer, Broadcast.layer({ port: 8787 }), NodeServices.layer).pipe(
      Layer.provideMerge(Telemetry.layer),
    ),
  ),
);
```

Use `Broadcast.silent` to film to a file only.

Budget one action per typed key: `Type` is the expensive scene.

## Limits worth knowing

- Whether the library should offer real pointer movement, wheel input and key
  presses is an open question, tracked in
  [#34](https://github.com/mannyc2/effect-agent-browserbase/issues/34). That
  issue's position is that the library owns faithful input and trustworthy
  evidence while the application owns cursor artwork, window graphics, easing and
  encoding. This example is the application side of that line, built on today's
  actions; the next two limits are what the missing input costs.
- The drawn pointer is not the real one. The real pointer moves only when the
  session clicks, so `:hover` styles do not follow the glide, and the real click
  lands on the element's centre while the ripple is drawn at the aim point.
- Each `fill` selects the field's contents before replacing them, and a camera
  catches that as a flash. The stagehand stops selections in fields from being
  painted while it is installed. A modeled key-press action would remove the
  need for both this and the per-key budget.
- A strict `style-src` policy on the filmed site can refuse the overlay's
  styles. Film origins you control.
- Captions live in the document, so a navigation clears them.
- The film shows a page, not a browser window. Tab strip, address bar and window
  chrome would be composited over the finished reel, and a pointer that can
  leave the page has to be composited too rather than drawn inside it.
- Frame timing follows the browser's presentation clock. On a hosted session
  the frames also cross a network; drops and uncovered time show up in
  `Footage.metrics` and are holds on film, never silent.
