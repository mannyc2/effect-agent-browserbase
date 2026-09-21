import { BrowserbaseBrowser } from "@effect-agent/browserbase/browser";
import { BrowserPolicy, NavigateRequest } from "@effect-agent/browserbase/browser-data";
import * as Capture from "@effect-agent/browserbase/capture";
import { BrowserbaseClient } from "@effect-agent/browserbase/client";
import { BrowserbaseRecordings } from "@effect-agent/browserbase/recordings";
import { BrowserbaseSessions } from "@effect-agent/browserbase/sessions";
import { RecordingPageReference } from "@effect-agent/browserbase/transfers";
import { Effect, Layer, Redacted, Stream } from "effect";
import { FetchHttpClient } from "effect/unstable/http";

const apiKey = process.env.BROWSERBASE_API_KEY;
const projectId = process.env.BROWSERBASE_PROJECT_ID;
const configuredOrigins = process.env.BROWSERBASE_ARTIFACT_ORIGINS;

if (
  process.env.EFFECT_AGENT_BROWSERBASE_LIVE !== "1" ||
  !apiKey ||
  !projectId ||
  !configuredOrigins
) {
  throw new Error(
    "Set EFFECT_AGENT_BROWSERBASE_LIVE=1, BROWSERBASE_API_KEY, BROWSERBASE_PROJECT_ID and BROWSERBASE_ARTIFACT_ORIGINS",
  );
}

// A trusted operator supplies exact approved delivery origins before allocation.
// Never derive this allowlist from untrusted page data or a newly returned URL.
const artifactOrigins = configuredOrigins.split(",").map((origin) => origin.trim());

if (
  artifactOrigins.length > 32 ||
  artifactOrigins.some((origin) => {
    try {
      const url = new URL(origin);

      return url.protocol !== "https:" || url.origin !== origin || !!url.username || !!url.password;
    } catch {
      return true;
    }
  })
) {
  throw new Error("BROWSERBASE_ARTIFACT_ORIGINS must contain exact approved HTTPS origins");
}

const report = (phase: string, result: unknown) => {
  console.log(
    JSON.stringify({ phase, result }, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ),
  );
};

/** One account, shared by the browser and by independent recording retrieval. */
const account = BrowserbaseSessions.layer.pipe(
  Layer.provideMerge(
    BrowserbaseClient.layer({
      projectId,
      apiKey: Redacted.make(apiKey),
      artifactOrigins,
      requestTimeoutMillis: 15_000,
    }),
  ),
);

const policy = BrowserPolicy.make({
  network: { _tag: "Unrestricted" },
  maxActions: 10,
  maxElapsedMillis: 180_000,
  maxReturnedBytes: 2 * 1024 * 1024,
});

const interactive = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* (yield* BrowserbaseBrowser).open(policy);

    yield* Effect.sync(() => report("allocated", session.reference));
    yield* session.bind().navigate(NavigateRequest.make({ url: "https://example.com/" }));
    const observation = yield* session.observe({ maxTextBytes: 16 * 1024, maxControls: 16 });
    const screenshot = yield* session.bind().screenshot({ fullPage: true });

    const capture = yield* Capture.start(session, {
      maxFrames: 64,
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
      BrowserbaseBrowser.layer({
        launch: {
          remoteTimeoutSeconds: 300,
          viewport: { _tag: "Fixed", width: 1280, height: 720 },
          provider: { browserSettings: { recordSession: true } },
        },
        actionTimeoutMillis: 15_000,
        onCleanup: (cleanup) => Effect.sync(() => report("cleanup", cleanup)),
        onAllocationUncertain: (attempt) =>
          Effect.sync(() => report("allocation-unknown", attempt)),
      }).pipe(Layer.provide(account)),
    ),
    Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  ),
);

const program = Effect.gen(function* () {
  const browser = yield* interactive;

  yield* Effect.sync(() => report("interactive", browser));
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
        { maxBytes: 512 * 1024 * 1024, timeoutMillis: 120_000 },
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
}).pipe(
  Effect.provide(BrowserbaseRecordings.layer.pipe(Layer.provide(account))),
  Effect.provideService(FetchHttpClient.Fetch, globalThis.fetch),
  Effect.tapError((error) => Effect.sync(() => report("failure", error))),
);

const result = await Effect.runPromise(program);

report("complete", result);
