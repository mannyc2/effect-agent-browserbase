# Livestream an agent's browser, live or a few seconds behind

One agent, one browser, one stream. Viewers open a page that shows the browser inside a drawn
browser window, with a caption about each step. The stream can be live, or run a configurable
delay behind the browser. With a delay, the text about each moment is written while that moment
waits, and appears when it airs.

```ts
import { NodeServices } from "@effect/platform-node";
import { Effect, Layer } from "effect";

import { watchChromium } from "./chromium.ts";

// Viewers open http://127.0.0.1:8080/. Provide a LanguageModel for the agent and the narrator.
watchChromium("Find the pricing page", { delayMillis: 5000, port: 8080 }).pipe(
  Effect.provide(Layer.mergeAll(NodeServices.layer, yourLanguageModel)),
);
```

`browserbase.ts` runs the same program on a Browserbase session. `test/native/livestream.test.ts`
runs it on a local Chromium with scripted models for both the agent and the narrator.

## How it works

- **Delay.** One capture interval follows the page across documents. Its own bounded buffer is
  the delay line: each frame is shown once it is `delayMillis` old on the host monotonic clock.
  A delay of `0` is live. What does not fit is dropped oldest-first and counted as `overflow` in
  the capture summary.
- **Pictures.** `Capture.multipart` sends motion JPEG to an `<img>`, one response per viewer,
  over a sliding fan-out. A slow viewer skips pictures and slows nobody else.
- **The window.** The screencast shows the page and nothing else, so `Viewer.ts` draws a
  browser window around it. The address comes from the capture's document boundaries and airs
  with the first picture of each document. The tab title is read with `session.pages` while the
  model is thinking, when no browser call is running, and airs `delayMillis` later.
- **Captions.** `Narrator.ts` is a separate model. It is given each browser step's facts (tool,
  the label of the control acted on, and whether it succeeded), never the agent's reasoning or
  any typed value. A step's caption airs from the step's start until the next step starts. It
  stays at least as long as it takes to read (20 characters a second, never under 5/6 s) and at
  most 7 s. Text that would not stay that long inside its own step's window is skipped rather
  than shown over another step. The run events that time each step are stamped on receipt.
  Live (`delayMillis: 0`), a caption appears once it is written and clears when the next step
  starts.
- **What viewers get.** Pictures, and `{ address, title, caption }` as server-sent events. The
  address is origin and path only, because a query or fragment can carry a token. No session,
  page or target identifier is sent. Every value is page-derived and untrusted, so the viewer
  sets it with `textContent`. Captions are drawn over the footage, never into the page, so the
  agent never reads them.

## Limits

- No audio: the screencast has no audio source.
- The window is drawn, not Chrome's own. Real Chrome UI would need a headful browser on a
  display you control and captured as a screen, which rules out Browserbase.
- Pictures arrive only when the page repaints. On a distant hosted browser, frame
  acknowledgements take a round trip, which caps the frame rate. When the round trip is 120 ms
  or more, the last picture before the page goes still may never arrive; this has not been
  measured on Browserbase.
- Pictures and captions are in step at the server. A viewer on a slow link can see pictures
  fall behind the captions.
- Live View is not used. Its URL controls the browser, so it is for an operator, never an
  audience.
