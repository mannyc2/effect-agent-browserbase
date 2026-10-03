import { describe, expect, it } from "@effect/vitest";

import { cursorArtwork, cursorFromInput } from "./bench/Clip.ts";
import type { InputEvent } from "./bench/InputLog.ts";
import { compareMotion, ksDistance, motionStats } from "./bench/Motion.ts";

const event = (
  kind: InputEvent["kind"],
  atMillis: number,
  point: InputEvent["point"] = null,
  extra: Partial<InputEvent> = {},
): InputEvent => ({
  kind,
  atMillis,
  documentTimeOriginMillis: 1000,
  sourceTimeMillis: 1000 + atMillis,
  sourceOrigin: "http://127.0.0.1:3000",
  coordinateSpace: "main-viewport",
  trusted: true,
  point,
  code: null,
  repeat: false,
  delta: null,
  target: null,
  ...extra,
});

describe("measured motion", () => {
  it("measures a path, dwell, Fitts difficulty and sampled peak without inventing a glide", () => {
    const stats = motionStats([
      event("pointermove", 0, { x: 0, y: 0 }),
      event("pointermove", 100, { x: 50, y: 0 }),
      event("pointermove", 200, { x: 100, y: 0 }),
      event(
        "pointerdown",
        300,
        { x: 100, y: 0 },
        { target: { kind: "dom", center: { x: 100, y: 0 }, width: 20, height: 20 } },
      ),
    ]);

    expect(stats.movements).toEqual([
      {
        startedAt: 1000,
        clickedAt: 1300,
        durationMillis: 300,
        distancePixels: 100,
        pathLengthPixels: 100,
        straightness: 1,
        peakVelocityPosition: 1 / 6,
        overshoot: false,
        preClickDwellMillis: 100,
        fittsIndex: Math.log2(6),
        samples: 4,
      },
    ]);
    expect(stats.overshootRate).toBe(0);
    expect(motionStats([event("pointerdown", 0, { x: 100, y: 0 })]).movements).toEqual([]);
  });

  it("records overshoot and independent overlapping key holds, and excludes canvas hitboxes", () => {
    const stats = motionStats([
      event("pointermove", 0, { x: 0, y: 0 }),
      event("pointermove", 100, { x: 120, y: 0 }),
      event("pointermove", 200, { x: 100, y: 0 }),
      event(
        "pointerdown",
        250,
        { x: 100, y: 0 },
        { target: { kind: "dom", center: { x: 100, y: 0 }, width: 20, height: 20 } },
      ),
      event("keydown", 300, null, { code: "key-1" }),
      event("keydown", 350, null, { code: "key-2" }),
      event("keydown", 360, null, { code: "key-2", repeat: true }),
      event("keyup", 380, null, { code: "key-1" }),
      event("keyup", 450, null, { code: "key-2" }),
      event("wheel", 500, { x: 100, y: 0 }, { delta: { x: 0, y: 80 } }),
      event("wheel", 600, { x: 100, y: 0 }, { delta: { x: 0, y: 80 } }),
      event("pointermove", 700, { x: 0, y: 0 }),
      event(
        "pointerdown",
        800,
        { x: 20, y: 0 },
        { target: { kind: "canvas", center: { x: 480, y: 270 }, width: 960, height: 540 } },
      ),
      event("pointermove", 810, { x: 999, y: 999 }, { trusted: false }),
    ]);

    expect(stats.movements[0]?.straightness).toBe(100 / 140);
    expect(stats.movements[0]?.overshoot).toBe(true);
    expect(stats.movements[1]?.fittsIndex).toBeNull();
    expect(stats.keyHoldMillis).toEqual([80, 100]);
    expect(stats.interKeyMillis).toEqual([50]);
    expect(stats.scrollCadenceMillis).toEqual([100]);
    expect(stats.ignoredUntrusted).toBe(1);
    expect(stats.overshootRate).toBe(1);
  });

  it("uses empirical KS with ties and exposes unavailable reference distributions", () => {
    expect(ksDistance([1, 1, 2], [1, 1, 2])).toBe(0);
    expect(ksDistance([1, 2], [3, 4])).toBe(1);
    expect(ksDistance([1, 2], [2, 3])).toBe(0.5);
    expect(ksDistance([], [1])).toBeNull();
    expect(compareMotion(motionStats([]), motionStats([])).keyHoldMillis).toEqual({
      ksDistance: null,
      humanCount: 0,
      candidateCount: 0,
    });
  });
});

describe("blind cursor artwork", () => {
  it("uses identical cursor and pulse art, with native samples aligned to source frame time", () => {
    const samples = cursorFromInput(
      [event("pointermove", 0, { x: 10, y: 20 }), event("pointerdown", 100, { x: 20, y: 20 })],
      1000,
    );

    const art = cursorArtwork(samples, { width: 640, height: 480 }, 15000);

    expect(samples.map((sample) => [sample.atMillis, sample.kind, sample.qualification])).toEqual([
      [0, "cursor", "native-input"],
      [100, "press", "native-input"],
    ]);
    expect(art).toContain("PlayResX: 640");
    expect(art).toContain("0:00:00.10,0:00:15.00");
    expect(art).toContain("\\fad(0,350)");
    expect(art).not.toContain("human");
    expect(art).not.toContain("performed");
  });
});
