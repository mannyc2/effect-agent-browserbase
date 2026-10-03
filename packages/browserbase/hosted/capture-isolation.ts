import { Deferred, Effect, Fiber, Stream } from "effect";
import * as Bootstrap from "effect-browser/bootstrap";
import * as Capture from "effect-browser/capture";
import { recipe } from "effect-browserbase/launch";

import { hostedCase } from "./harness.ts";

const h = hostedCase("capture-isolation");
const origin = "https://example.com";
const maximumGapMillis = 600;

// A continuously painted scene makes silence meaningful. The peer supplies one fresh
// ElementHandle per document; pinned Playwright initializes its large injected script there.
const fixture = Bootstrap.init({
  id: "capture-isolation-fixture",
  origins: [origin],
  content: `globalThis.__captureIsolationReady = new Promise((resolve) => {
    const install = () => {
      const button = document.createElement("button");
      button.textContent = "Read isolation " + new URLSearchParams(location.search).get("read");
      const visibility = document.createElement("p");
      visibility.id = "visibility";
      const publish = () => { visibility.textContent = document.visibilityState; };
      document.addEventListener("visibilitychange", publish);
      publish();
      document.body.replaceChildren(button, visibility);
      if (new URLSearchParams(location.search).has("stage")) {
        const canvas = document.createElement("canvas");
        canvas.width = 640;
        canvas.height = 360;
        document.body.append(canvas);
        const context = canvas.getContext("2d");
        const paint = (time) => {
          context.fillStyle = "hsl(" + Math.floor(time / 20) % 360 + ",60%,45%)";
          context.fillRect(0, 0, 640, 360);
          context.fillStyle = "white";
          context.fillRect(300 + 250 * Math.sin(time / 300), 140, 40, 80);
          requestAnimationFrame(paint);
        };
        requestAnimationFrame(paint);
      }
      resolve(true);
    };
    if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", install, { once: true });
    else install();
  });`,
  readiness: {
    expression: "globalThis.__captureIsolationReady",
    timeoutMillis: 10_000,
    existingDocuments: "RequireFreshNavigation",
  },
});

interface Window {
  readonly start: bigint;
  readonly end: bigint;
}

const millis = (nanos: bigint) => Number(nanos) / 1e6;

// Include the complete gaps crossing each window's edges. Clipping at the edges would
// understate a stall that began just before the read or ended just after it.
const cadence = (received: ReadonlyArray<bigint>, window: Window) => {
  const before = received.findLastIndex((at) => at <= window.start);
  const after = received.findIndex((at) => at >= window.end);
  const bracketed = before >= 0 && after > before;
  const edges = bracketed ? received.slice(before, after + 1) : [];
  const gaps = edges.slice(1).map((at, index) => millis(at - (edges[index] ?? at)));

  return {
    durationMillis: millis(window.end - window.start),
    frames: received.filter((at) => at >= window.start && at <= window.end).length,
    bracketed,
    maximumGapMillis: gaps.length === 0 ? null : Math.max(...gaps),
    gapsMillis: gaps,
  };
};

await h.run(
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* h.open({ bootstrap: fixture });
      const peer = session.initialPage;
      const stage = yield* session.createPage();

      yield* stage.navigate({ url: `${origin}/?stage` });
      const beforeVisibility = (yield* stage.readText({ selector: "#visibility" })).text;

      yield* h.established({ capturedPageVisible: beforeVisibility === "visible" });

      const interval = yield* Capture.start(stage, {
        lifetime: "page",
        size: { width: 640, height: 360 },
        quality: 70,
        maxFrames: 64,
        maxFrameBytes: 1024 * 1024,
        maxBufferedBytes: 8 * 1024 * 1024,
        maxDurationMillis: h.budget.captureSeconds * 1000,
      });

      const first = yield* Deferred.make<void>();
      const received: Array<bigint> = [];
      let exactTarget = true;

      const collecting = yield* interval.frames.pipe(
        Stream.runForEach((frame) =>
          Effect.gen(function* () {
            if (received.length >= 8192)
              return yield* h.established({ boundedCaptureFacts: false });
            received.push(frame.receivedMonotonicNanos);
            exactTarget &&= frame.target.pageId === stage.identity.pageId;
            yield* Deferred.succeed(first, undefined);
          }),
        ),
        Effect.forkScoped,
      );

      yield* Deferred.await(first).pipe(Effect.timeout(8000));
      const idleStart = yield* session.monotonicTimeNanos;

      yield* Effect.sleep(2000);
      const idle: Window = { start: idleStart, end: yield* session.monotonicTimeNanos };
      const reads: Array<Window & { readonly controlFound: boolean }> = [];

      for (let document = 0; document < 4; document++) {
        yield* peer.navigate({ url: `${origin}/?read=${String(document)}` });
        const start = yield* session.monotonicTimeNanos;
        // readText uses evaluate without a handle and would not exercise this upload.
        const reading = yield* peer.observe({ maxControls: 1, maxTextBytes: 1024 });
        const end = yield* session.monotonicTimeNanos;

        reads.push({
          start,
          end,
          controlFound: reading.controls.some(
            (control) => control.label === `Read isolation ${String(document)}`,
          ),
        });
        yield* Effect.sleep(1000);
      }
      const afterVisibility = (yield* stage.readText({ selector: "#visibility" })).text;
      const summary = yield* interval.stop;

      yield* Fiber.join(collecting);
      const cleanup = yield* session.closeChecked;
      const baseline = cadence(received, idle);

      const windows = reads.map((read, document) => ({
        document,
        startMillis: millis(read.start - idleStart),
        controlFound: read.controlFound,
        ...cadence(received, read),
      }));

      const evidence = {
        maximumGapMillis,
        baseline,
        reads: windows,
        visibility: { before: beforeVisibility, after: afterVisibility },
        capture: {
          reason: summary.reason,
          received: summary.received,
          delivered: summary.delivered,
          discarded: summary.discarded,
          overflow: summary.overflow,
          nativeStop: summary.nativeStop,
          upstreamDrops: "unknown",
        },
        cleanup,
      };

      yield* h.report("capture-isolation", evidence);
      yield* h.established({
        animatedBaseline: baseline.bracketed && baseline.frames >= 10,
        fourFreshDocumentReads: windows.length === 4 && windows.every((read) => read.controlFound),
        framesDuringEveryRead: windows.every((read) => read.bracketed && read.frames >= 2),
        gapsDuringReadsBounded: windows.every(
          (read) => read.maximumGapMillis !== null && read.maximumGapMillis <= maximumGapMillis,
        ),
        capturedPageRemainedVisible: afterVisibility === "visible",
        originalCaptureStoppedCleanly:
          exactTarget &&
          summary.reason === "stopped" &&
          summary.nativeStop === "confirmed" &&
          summary.overflow === 0,
        checkedProviderRelease: cleanup.remote === "confirmed",
      });

      return evidence;
    }).pipe(
      Effect.provide(
        h.browser({ launch: recipe({ viewport: { _tag: "Fixed", width: 800, height: 600 } }) }),
      ),
    ),
  ),
);
