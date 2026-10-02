# Livestream an agent's browser, live or a few seconds behind

One agent, one browser, one stream. Viewers open a page that shows the browser inside a drawn
browser window, with a caption about each step. The stream can be live, or run a configurable
delay behind the browser. With a delay, the text about each moment is written while that moment
waits, and appears when it airs.

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { watchChromium } from "./chromium.ts";

// Viewers open http://127.0.0.1:8080/. Provide a model for the agent and the narrator, such as
// OpenAiLanguageModel.model(...) from @effect/ai-openai.
watchChromium("Find the pricing page", { delayMillis: 5000, port: 8080 }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, yourModel)),
);
```

`browserbase.ts` runs the same program on a Browserbase session. `test/native/livestream.test.ts`
runs it on a local Chromium with scripted models for both the agent and the narrator.

## How it works

- **Delay.** Capture and Tools bind one issued Page beside its original session. One capture interval follows that Page across documents. Its own bounded buffer is
  the delay line: each frame is shown once it is `delayMillis` old on the host monotonic clock.
  A delay of `0` is live. What does not fit is dropped oldest-first and counted as `overflow` in
  the capture summary.
- **Pictures.** `Capture.multipart` sends motion JPEG to an `<img>`, one response per viewer,
  over a sliding fan-out. A slow viewer skips pictures and slows nobody else.
- **The window.** The screencast shows the page and nothing else, so `Viewer.ts` draws a
  browser window around it. The address comes from the capture's document boundaries and airs
  with the first picture of each document. Same-document address changes come from their own
  capture-boundary timeline events. The tab title is read from that exact Page with bounded
  admission, then airs `delayMillis` after the read; another Page host may still be running.
- **Metadata.** Two independent subscribers read snapshot plus events(resumeAfter): one projects
  composition and pointer graphics, the other counts native outcomes. Neither subscribes to pixels
  or stops capture. The composition reader takes each event at once and queues the pointer and
  address graphics it implies in air-time order, so a delay longer than the timeline's retention
  never lets unread events be evicted; more than 16,384 queued cues resets presentation as a
  timeline gap does. Timeline offsets are bridged to the capture owner's monotonic clock with
  measured uncertainty. A Gap is reported and resets presentation; older queued pictures are
  skipped explicitly rather than paired with invented history. Page terminal and capture-stream
  failures are reported separately from the agent outcome. Capture draining publishes an ended
  presentation even while the Page remains open. This is the original logical capture end; an
  unconfirmed native stop stays qualified in the capture summary.
- **Captions.** `Narrator.ts` is a separate Effect Agent with its own conversation store. It
  keeps one conversation for the whole stream and takes one Run per browser step, in order, so it
  builds on what it already said. Each step reaches it as facts: the tool, the label of the
  control acted on, whether it succeeded, and the address and title of the page the step left,
  read when the next model call starts. It never sees the agent's reasoning or any typed value.
  It answers `{ caption }`, or `{ caption: null }` when the step shows viewers nothing new. A
  step's caption airs only while the latest presented frame was received during that step, and
  clears before a later-step frame is presented. It stays at least as long as it takes
  to read (20 characters a second, never under 5/6 s) and at most 7 s. A caption still unwritten
  when its step's window has aired is abandoned, which interrupts its Run, and text that would
  not stay long enough inside that window is skipped rather than shown over another step. If the
  page does not repaint during a step, its caption is skipped rather than placed over the retained
  picture from the previous step. Each skip is reported as `late`, `silent` or `failed`. The run
  events that time each step are stamped on receipt. Live (`delayMillis: 0`), the same frame
  ordering applies without a delay.
- **What viewers get.** Pictures, bounded address/title/caption/pointer/viewport/status graphics
  as server-sent events. The
  address is origin and path only, because a query or fragment can carry a token. No session,
  page or target identifier is sent. Every value is page-derived and untrusted, so the viewer
  sets text with `textContent`. Pointer schedules describe intended artwork, not proof that pixels
  changed. Captions and pointer graphics are drawn over the footage, never into the page, so the
  agent never reads them.

The host joins toolCallIds to actual bounded Tool-host receipts and their run/step/attempt IDs.
Agent RunEvents still define model/tool lifecycle and narration context; they do not supply native
dispatch times. Typed inputs and agent reasoning never reach the narrator or audience. The returned
host diagnostics retain timeline gaps, clock uncertainty and original capture failures.

## Limits

- No audio: the screencast has no audio source.
- The window is drawn, not Chrome's own. Real Chrome UI would need a headful browser on a
  display you control and captured as a screen, which rules out Browserbase.
- Pictures arrive only when the page repaints. On a distant hosted browser, frame
  acknowledgements take a round trip, which caps the frame rate and makes pictures uneven. On
  Browserbase the hosted `live-capture` check saw the last picture before a still page arrive in
  every cycle it measured; see `docs/STATUS.md`.
- The narrator has the delay to write each caption. Give it a fast model: one that reasons first
  can spend all of it. Its conversation grows by a step each Run, so a long stream needs that
  history compacted or restarted.
- Pictures and captions are in step at the server. A viewer on a slow link can see pictures
  fall behind the captions.
- Live View is not used. Its URL controls the browser, so it is for an operator, never an
  audience.
