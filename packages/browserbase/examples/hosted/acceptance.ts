// The guarded correctness run: one session through allocation, navigation, capture, Live View
// retrieval and confirmed release, then the provider recording retrieved after the browser
// scope has ended.
import { NavigateRequest } from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import { recipe } from "@effect-agent/browserbase/launch";
import { BrowserbaseRecordings } from "@effect-agent/browserbase/recordings";
import { RecordingPageReference } from "@effect-agent/browserbase/transfers";
import { Effect, Stream } from "effect";

import { hostedCase } from "./harness.ts";

const h = hostedCase("acceptance");

const interactive = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* h.open;

    yield* session.bind().navigate(NavigateRequest.make({ url: "https://example.com/" }));
    const observation = yield* session.observe({ maxTextBytes: 16 * 1024, maxControls: 16 });
    const screenshot = yield* session.bind().screenshot({ fullPage: true });

    const capture = yield* Capture.start(session, {
      maxFrames: 64,
      maxBufferedBytes: 16 * 1024 * 1024,
      maxFrameBytes: 4 * 1024 * 1024,
      maxDurationMillis: h.budget.captureSeconds * 1000,
      quality: 75,
    });

    const frames = yield* capture.frames.pipe(Stream.take(12), Stream.runCollect);
    const captureSummary = yield* capture.completed;
    const liveView = yield* session.liveView(120);
    // This proves issuance only. A real operator takeover/release is the separate `handoff`
    // check; this one does not pretend an iframe was controlled.
    const cleanup = yield* session.close;

    return {
      reference: session.reference,
      observation: {
        url: observation.url,
        textBytes: new TextEncoder().encode(observation.text).length,
      },
      screenshotBytes: screenshot.bytes.byteLength,
      capture: { frames: frames.length, summary: captureSummary },
      liveView: { pages: liveView.pages.length, requestedTtlSeconds: liveView.requestedTtlSeconds },
      cleanup,
    };
  }).pipe(
    Effect.provide(
      h.browser({
        launch: recipe({
          viewport: { _tag: "Fixed", width: 1280, height: 720 },
          provider: { browserSettings: { recordSession: true } },
        }),
      }),
    ),
  ),
);

await h.run(
  Effect.gen(function* () {
    const browser = yield* interactive;

    yield* h.report("interactive", browser);
    const recordings = yield* BrowserbaseRecordings;
    const requested = yield* recordings.request(browser.reference);

    const completed = yield* recordings.wait(browser.reference, {
      timeoutMillis: 120_000,
      intervalMillis: 3_000,
    });

    const downloadable = completed.pages.find((page) => page.delivery === "download");
    let recordingBytes: number | null = null;

    if (downloadable !== undefined) {
      const bytes = yield* recordings
        .download(
          RecordingPageReference.make({ session: browser.reference, pageId: downloadable.pageId }),
          { maxBytes: h.budget.transferBytes, timeoutMillis: 120_000 },
        )
        .pipe(Stream.runCollect);

      recordingBytes = Array.from(bytes).reduce((total, chunk) => total + chunk.byteLength, 0);
    }

    return {
      ...browser,
      recording: {
        requested: requested.pages.map((page) => ({ pageId: page.pageId, status: page.status })),
        completed: completed.pages.map((page) => ({
          pageId: page.pageId,
          status: page.status,
          delivery: page.delivery,
        })),
        timedOut: completed.timedOut,
        recordingBytes,
      },
    };
  }),
);
