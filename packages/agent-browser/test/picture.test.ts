import { expect, test } from "vite-plus/test";

import * as Picture from "./bench/Picture.ts";
import { type RecordingFrame,Journal } from "./bench/Records.ts";
import { pictureMetrics } from "./bench/StageScenes.ts";

const frame = (at: number, document = 0): RecordingFrame => ({
  bytes: new Uint8Array(),
  sourceTimeMillis: at + 1,
  sourceClock: "presentation-unix-millis",
  receivedAt: at,
  receivedMonotonicNanos: String(BigInt(at) * 1000000n),
  sequence: at,
  document,
  width: 1280,
  height: 720,
  viewportWidth: 1280,
  viewportHeight: 720,
});

test("cadence preserves a long delivery gap and both edge waits", () => {
  const cadence = Picture.cadence([frame(100), frame(200), frame(1500)], { start: 0, end: 2000 });

  expect(cadence.fps).toBe(1.5);
  expect(cadence.gapMillis).toEqual({ p50: 100, p95: 1300, max: 1300 });
  expect(cadence.gapsOver1000Millis).toBe(1);
  expect(cadence.firstDeliveryMillis).toBe(100);
  expect(cadence.tailWithoutDeliveryMillis).toBe(500);
});

test("freezes count expected animation including initial and trailing silence", () => {
  const window = { start: 0, end: 2000 };
  const freeze = Picture.freezes([frame(400), frame(500)], [window], window);

  expect(freeze.count).toBe(2);
  expect(freeze.seconds).toBe(1.9);
  expect(freeze.longestMillis).toBe(1500);
  expect(Picture.freezes([frame(400), frame(500)], [], window).count).toBe(0);
});

test("freezes use only the changing part of an interval", () => {
  expect(
    Picture.freezes([frame(0), frame(2000)], [{ start: 1000, end: 1600 }], { start: 0, end: 2000 })
      .seconds,
  ).toBe(0.6);
});

test("first frame matches the new document on the owner's receipt clock", () => {
  expect(
    Picture.firstFrame(
      [frame(200, 0), frame(600, 1)],
      [
        { document: 1, sameDocument: false, observedMonotonicNanos: "500000000" },
        { document: 1, sameDocument: true, observedMonotonicNanos: "550000000" },
        { document: 2, sameDocument: false, observedMonotonicNanos: "700000000" },
      ],
    ),
  ).toEqual([
    { document: 1, millis: 100, basis: "navigation-commit-to-received-frame" },
    { document: 2, millis: null, basis: "navigation-commit-to-received-frame" },
  ]);
});

test("open overlays remain counted through the end of capture", () => {
  expect(
    Picture.shownIntervals(
      [
        { kind: "cookies", at: 100, shown: true },
        { kind: "cookies", at: 200, shown: true },
        { kind: "cookies", at: 600, shown: false },
        { kind: "blocked", at: 800, shown: true },
      ],
      { start: 0, end: 2000 },
    ),
  ).toEqual([
    { kind: "cookies", start: 100, end: 600 },
    { kind: "blocked", start: 800, end: 2000 },
  ]);
});

test("blank time is duration-weighted rather than a fraction of frames", () => {
  expect(
    Picture.blank([frame(0), frame(100), frame(1500)], [200, 2, 200], { start: 0, end: 2000 })
      .seconds,
  ).toBe(1.4);
});

test("a retained capture cutoff leaves later animation time unmeasured", () => {
  const journal = new Journal({
    version: 1,
    runId: "cutoff",
    scene: "busy",
    backend: "chromium",
    driver: "scripted",
    sourceRevision: "test",
    sourceDirty: false,
    trial: 0,
    seed: 0,
    viewport: { width: 1280, height: 720 },
    settings: {},
    capture: { maxFrames: 2, maxBytes: 1024, quality: 15, maxDurationMillis: 5000 },
  });

  journal.recording = {
    ...journal.manifest.capture,
    frames: [frame(0), frame(100)],
    startedAt: 0,
    endedAt: 5000,
    captureEndedAt: 200,
    nativeStop: "confirmed",
    summary: null,
    totalBytes: 0,
    discardedFrames: 0,
    limitReached: "frames",
    error: null,
  };

  const metrics = pictureMetrics(journal, [{ start: 0, end: 5000 }], {
    after: { start: 2000, end: 5000 },
  });

  expect(journal.snapshot().capture).toMatchObject({ captureEndedAt: 200 });

  expect(metrics.measurement).toMatchObject({
    status: "partial",
    measuredDurationMillis: 100,
    unmeasuredMillis: 4900,
  });
  expect(metrics.freezes.seconds).toBe(0);
  expect(metrics.windows.after).toMatchObject({
    cadence: null,
    freezes: null,
    measurement: { status: "unmeasured", measuredDurationMillis: 0, unmeasuredMillis: 3000 },
  });
});
