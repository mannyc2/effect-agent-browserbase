# Realistic browser footage

Films original public Page plans with a visible pointer, scrolling with
momentum, pauses long enough to read, and a constant-frame-rate H.264 file.
The demo runs bounded `PlanData.Step` browser intent through `Page.run` with
performed style. Captions and reading pauses are application choreography; the library owns
checked browser input and timing. The film in
[`docs/media/`](../../../../docs/media/README.md) records an earlier version
with individually paced typing against local Chromium.

Every change to the page in that film is one of the session's ordinary bounded
actions. The example adds presentation around them; it does not add a second
way to drive the browser.

## Public browser intent

`Storyboard.ts` decodes durable `PlanData.Step` values. Every browser scene runs on the original
issued Page with `page.run(plan, { style: { seed }, within: "15 seconds" })`. Hover is an authored
native action; Type requires the focus established by its preceding Click. Captions and reading
pauses are bounded application Effects outside admission. There is no selector-based reenactment,
page cue exchange or separately charged per-character browser action.

The performed policy chooses a finite curved cursor schedule, intended aim, key intervals and
holds, and paced scrolling. Its seed repeats policy choices for the same step identity; actual
geometry, native replies and delivery time remain observations. Pointer duration uses a chosen
Shannon-style distance/width policy and fifth-order progress; its constants are not calibrated
human measurements, and applying that progress to a curve does not establish minimum Cartesian
jerk. Slips are opt-in and default to zero. Unsupported input semantics fail explicitly.

## Capture and artwork

```text
Storyboard ──► issued Page.run(performed) ──► original checked native execution
                        │
                        └─► public Page.timeline ─┬─► graphics reader ─► host compositor / live SVG
                                                 └─► independent metrics reader
issued Page ──► one Capture.start ──► one frame consumer ─┬─► Broadcast MJPEG
                                                        └─► Reel ─► FFmpeg ─► raw H.264
raw H.264 + bounded artwork ──► FFmpeg ASS composition ──► final H.264 + ffprobe
```

`Presentation.ts` resumes its two journal subscriptions by cursor and reports a gap as an explicit
failure/reset. Cancelling a reader owns only that subscription. The camera owns capture stop;
checked cleanup remains on the original browser owner. No capture byte stream is consumed twice.

`ClockProbe.ts` retains the typed, origin-bounded application bootstrap needed for font readiness
and six clock calls. Each call carries the page's stamps for the call before it, so the sixth call
completes the fifth exchange and five four-timestamp samples reach the host. It reads clock/font
state only. Pointer, caption and press artwork
live in the viewer's SVG/HTML or the host's bounded ASS artifact; no presentation nodes are added
to the website. Captions use textContent in the viewer and literal glyph escaping in ASS. The
compositor passes filenames as process arguments and uses a fixed filter filename in its private
working directory.

Glide is an intended schedule with no native hover events. Pointer receipts identify commanded
points. A performed click carries a checked intended aim separately from its unknown actual
Playwright position. A press marker at that aim remains qualified intended artwork; it does not
claim an observed hit coordinate. Failed/cancelled live input clears speculative motion.

`Reel.ts` retains the latest JPEG in each constant-rate slot and holds it through still periods
and navigation gaps. Capture uses its viewport size within the requested fit, JPEG quality92;
the example encodes x264 CRF18/yuv420p/even dimensions/faststart, then makes a second composition
pass. The extra encode has measured cost and may introduce additional compression. FFmpeg and
ffprobe are host dependencies, not public browser engines.

## Measurements and live view

`Footage.record` returns the actual ffprobe dimensions, decoded frame count, duration and metrics.
`Broadcast.layer({ port: 0 })` serves `/live.mjpeg`, `/presentation` and `/metrics` from a loopback
viewer; `Broadcast.silent` records only. Its small sliding buffers let slow viewers skip samples.
The audience projection contains bounded artwork and captions, without raw timeline events,
provider authority, native target IDs or typed browser text.
The served metrics omit navigation addresses; the recording's host metrics retain them.
Glides have presentation IDs, so caption updates preserve motion. Delivery and replay subtract
elapsed host time from their relative schedules and press-marker lifetime. Network time between
the host and viewer is still unmeasured.

Metrics retain capture interval accounting, presentation-clock offset/uncertainty, inter-frame
spacing, first-frame latency, navigation holds, original action/native-input intervals, timeline
event/gap counts, held output frames and composition cost.
Failed and cancelled journal events are counted by their original outcome, with containment
events counted separately. Failure cleanup stops the owned readers, clears speculative artwork,
and drains retained metrics after the last consumed cursor; a retention gap remains explicit and
diagnostic failures do not replace the original performance Cause. Native and run metadata can describe the same failure, so these
are event counts rather than distinct action counts. `nativeReturnToNextFrameMillis` measures
temporal proximity from a click's native return to the next received frame. A frame may show a
caret blink or unrelated repaint; the metric makes no causal claim. Artwork uses a bracketed
owner-clock origin and maps the first browser presentation stamp through the measured clock
offset. Its reported uncertainty includes both clock exchanges and the owner bracket; frame
rate quantization and the viewer's network remain separate limits. Without clock comparison,
source-timed composition fails explicitly. Telemetry binds the original Session clock through
a bracketed comparison before recording, including when that owner uses a different Clock.

## Run a storyboard

```ts
const session =
  yield *
  browser.open(policy, {
    bootstrap: ClockProbe.plan([origin]),
  });
const footage =
  yield *
  Footage.record(session, {
    url,
    storyboard: Footage.demo,
    outputPath,
    seed: 94007,
  });
```

Provide `Telemetry.layer`, `Broadcast.silent` or the live Broadcast layer, and the host's
NodeServices. The maintained native proof uses real local Chromium and the actual Browserbase
adapter with scripted allocation only. It preserves the train search, route navigation, berth
selection and hold, the live viewer, real encoded output and checked original cleanup. Historical
media in `docs/media` retains its own original implementation identity. Local evidence does not
qualify hosted pacing, background painting, transport delay or provider cleanup.
