import { expect, it } from "@effect/vitest";
import { Schema } from "effect";
import { Target } from "effect-browserbase/browser-data";
import type { CapturedFrame } from "effect-browserbase/capture";
import { CaptureSummary } from "effect-browserbase/capture";
import { BrowserError } from "effect-browserbase/errors";

import { CaptureEvidence, captureEvidence } from "../examples/capture-evidence.ts";

const target = Target.make({ generation: 1, pageId: "PRIVATE-PAGE", frameId: "PRIVATE-FRAME" });

const summary = (delivered: number, received = delivered, duplicates = 0) =>
  CaptureSummary.make({
    target,
    reason: "duration",
    received,
    delivered,
    dropped: duplicates,
    duplicates,
    late: 0,
    peakBufferedFrames: delivered,
    peakBufferedBytes: delivered * 100,
    bufferedFrames: 0,
    bufferedBytes: 0,
    sourceFirstMillis: delivered ? 1234 : null,
    sourceLastMillis: delivered ? 1234 : null,
    nativeStop: "confirmed",
    upstreamDrops: "unknown",
    error: BrowserError.make({ operation: "capture", reason: "provider" }),
  });

const frame: CapturedFrame = {
  target,
  bytes: new TextEncoder().encode("PRIVATE-BYTES"),
  mediaType: "image/jpeg",
  sequence: 3,
  sourceTimeMillis: 1234,
  sourceClock: "presentation-unix-millis",
  receivedMonotonicNanos: 15n,
  width: 64,
  height: 48,
  viewportWidth: 640,
  viewportHeight: 480,
};

it("zero-frame evidence retains null source/receipt endpoints and actual counters", () => {
  const result = captureEvidence([], summary(0), 2000, 10n, 50n);

  expect(Schema.decodeSync(CaptureEvidence)(result)).toEqual(result);
  expect(result.collected).toBe(0);
  expect(result.received).toBe(0);
  expect(result.firstReceivedMonotonicNanos).toBeNull();
  expect(result.lastReceivedMonotonicNanos).toBeNull();
  expect(result.sourceFirstMillis).toBeNull();
  expect(result.captureStartedMonotonicNanos).toBe("10");
  expect(result.captureCompletedMonotonicNanos).toBe("50");
});

it("one delivered frame is distinguished from repeated native source timestamps", () => {
  const result = captureEvidence([frame], summary(1, 9, 8), 2000, 10n, 50n);

  expect(Schema.decodeSync(CaptureEvidence)(result)).toEqual(result);
  expect(result.collected).toBe(1);
  expect(result.received).toBe(9);
  expect(result.duplicates).toBe(8);
  expect(result.sourceFirstMillis).toBe(1234);
  expect(result.firstReceivedMonotonicNanos).toBe("15");
  expect(result.lastReceivedMonotonicNanos).toBe("15");
  expect(result.nativeStop).toBe("confirmed");
});

it("projects fixed scalar metadata and never image bytes, target identity or nested errors", () => {
  const result = captureEvidence([frame], summary(1), 2000, 10n, 50n);
  const encoded = JSON.stringify(result);

  expect(encoded).not.toContain("PRIVATE");
  expect(encoded).not.toContain('"bytes"');
  expect(encoded).not.toContain('"error"');
  // An operation is a closed vocabulary now, so it cannot carry a marker: look for the error's
  // own tag and reason instead.
  expect(encoded).not.toContain("BrowserError");
  expect(encoded).not.toContain("provider");
  expect(encoded).not.toContain('"target"');
  expect(frame.sourceTimeMillis).toBe(1234);
  expect(frame.receivedMonotonicNanos).toBe(15n);
});
