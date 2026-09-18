import { Effect, Layer, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";
import { BrowserNavigateRequest, InteractiveBrowserPolicy } from "effect-agent/interactive-browser";
import { BrowserbaseInteractiveHost } from "@effect-agent/platform-browserbase/interactive-browser";
import { BrowserbaseRecordings } from "@effect-agent/platform-browserbase/recordings";
import * as Capture from "@effect-agent/platform-browserbase/capture";
import { RecordingPageReference } from "@effect-agent/platform-browserbase/types";

const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;
if (process.env.EFFECT_AGENT_BROWSERBASE_LIVE !== "1" || !apiKey || !projectId) {
  throw new Error("Set EFFECT_AGENT_BROWSERBASE_LIVE=1, BROWSERBASE_API_KEY and BROWSERBASE_PROJECT_ID");
}

const common = {
  projectId,
  apiKey: Redacted.make(apiKey),
  recordSession: true,
  actionTimeoutMillis: 15_000,
  requestTimeoutMillis: 15_000,
} as const;
const policy = InteractiveBrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 180_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const interactive = Effect.scoped(Effect.gen(function* () {
  const session = yield* (yield* BrowserbaseInteractiveHost).open(policy);
  yield* session.handle.navigate(BrowserNavigateRequest.make({ url: "https://example.com/" }));
  const observation = yield* session.observe({ maxTextBytes: 16 * 1024, maxControls: 16 });
  const screenshot = yield* session.handle.screenshot({ fullPage: true });
  const capture = yield* Capture.start(session, {
    maxFrames: 120,
    maxBufferedBytes: 16 * 1024 * 1024,
    maxFrameBytes: 4 * 1024 * 1024,
    maxDurationMillis: 3_000,
    quality: 75,
  });
  const frames = yield* capture.frames.pipe(Stream.take(12), Stream.runCollect);
  const captureSummary = yield* capture.completed;
  const liveView = yield* session.liveView(120);
  // This proves issuance only. A real operator takeover/release is a separate
  // manual hosted check; the script does not pretend an iframe was controlled.
  const cleanup = yield* session.close;
  return {
    reference: session.reference,
    observation: { url: observation.url, textBytes: new TextEncoder().encode(observation.text).length },
    screenshotBytes: screenshot.bytes.byteLength,
    capture: { frames: frames.length, summary: captureSummary },
    liveView: { pages: liveView.pages.length, requestedTtlSeconds: liveView.requestedTtlSeconds },
    cleanup,
  };
}).pipe(
  Effect.provide(BrowserbaseInteractiveHost.layer(common)),
  Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
));

const program = Effect.gen(function* () {
  const browser = yield* interactive;
  const recordings = yield* BrowserbaseRecordings;
  const requested = yield* recordings.request(browser.reference);
  const completed = yield* recordings.wait(browser.reference, { timeoutMillis: 120_000, intervalMillis: 3_000 });
  const downloadable = completed.pages.find((page) => page.delivery === "download");
  let recordingBytes: number | null = null;
  if (downloadable !== undefined) {
    const bytes = yield* recordings.download(
      RecordingPageReference.make({ session: browser.reference, pageId: downloadable.pageId }),
      { maxBytes: 512 * 1024 * 1024, timeoutMillis: 120_000 },
    ).pipe(Stream.runCollect);
    recordingBytes = Array.from(bytes).reduce((total, chunk) => total + chunk.byteLength, 0);
  }
  return {
    ...browser,
    recording: {
      requested: requested.pages.map((page) => ({ pageId: page.pageId, status: page.status })),
      completed: completed.pages.map((page) => ({ pageId: page.pageId, status: page.status, delivery: page.delivery })),
      timedOut: completed.timedOut,
      recordingBytes,
    },
  };
}).pipe(
  Effect.provide(BrowserbaseRecordings.layer(common)),
  Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
);

const result = await Effect.runPromise(program);
console.log(JSON.stringify(result, (_key, value) => typeof value === "bigint" ? value.toString() : value, 2));
