import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import { receiptWindow, segmentMetrics, type SegmentCaption } from "./bench/GameSegment.ts";
import type { RecordingFrame } from "./bench/Records.ts";
import { grade } from "./bench/Understanding.ts";
import { gameSite, type TruthReceipt } from "./fixtures/GameSite.ts";

const truth = {
  facts: { spin: 1, balance: 990, bet: 10, win: 0, notable: "near-miss" },
  money: ["balance", "bet", "win"],
};

const events: ReadonlyArray<TruthReceipt> = [
  {
    kind: "reels",
    sequence: 1,
    receivedAtMillis: 1000,
    event: {
      tag: "spinStart",
      spin: 1,
      atMillis: 99999,
      bet: 10,
      balanceAfter: 990,
      durationMillis: 2000,
    },
  },
  {
    kind: "reels",
    sequence: 2,
    receivedAtMillis: 3000,
    event: {
      tag: "result",
      spin: 1,
      atMillis: 199999,
      grid: [],
      win: 0,
      balanceAfter: 990,
      moment: "near-miss",
    },
  },
];

const frame = (at: number, pixel: number): RecordingFrame => ({
  bytes: Uint8Array.of(pixel),
  receivedAt: at,
  receivedMonotonicNanos: String(at * 1000000),
  sourceTimeMillis: 123456789 + at,
  sourceClock: "presentation-unix-millis",
  sequence: at,
  document: 0,
  width: 1280,
  height: 720,
  viewportWidth: 1280,
  viewportHeight: 720,
});

const caption = (atMillis: number, facts = truth.facts): SegmentCaption => ({
  atMillis,
  kind: "result",
  output: { caption: "The spin has finished.", facts },
  truth,
  grade: grade({ caption: "The spin has finished.", facts }, truth),
});

const measure = (
  captions: ReadonlyArray<SegmentCaption>,
  frames: ReadonlyArray<RecordingFrame> = [],
) =>
  segmentMetrics({
    window: { start: 0, end: 6000 },
    events,
    captions,
    frames,
    airDelayMillis: 500,
    interstitials: [
      { start: 0, end: 1000 },
      { start: 3000, end: 4500 },
    ],
    usage: null,
  });

it("digest receipt anchors remain useful after the 32-entry host window starts evicting", () => {
  const receipts = Array.from({ length: 32 }, (_, index) => ({
    invocationId: `call-${index + 10}`,
  }));

  expect(receiptWindow(receipts, 9, "call-40")).toEqual({
    receipts: [{ invocationId: "call-41" }],
    dropped: 0,
    anchor: "present",
  });
  expect(receiptWindow(receipts, 9, "call-1")).toEqual({ receipts, dropped: 9, anchor: "evicted" });
  expect(receiptWindow([], 0, null)).toEqual({ receipts: [], dropped: 0, anchor: "initial" });
});

it("segment reaction timing uses host result receipts and structured spin correlation", () => {
  const metrics = measure([caption(2800), caption(3500)]);

  expect(metrics.resultCaptions).toEqual([
    {
      spin: 1,
      resultAtMillis: 3000,
      captionAtMillis: 3500,
      latencyMillis: 500,
      eligibleToAir: true,
    },
  ]);
  expect(metrics.spinsPerMinute).toBe(10);
  expect(metrics.lobbyToFirstSpinMillis).toBe(1000);
  expect(metrics.moneyFactAccuracy).toBe(1);
  expect(metrics.interstitialSeconds).toBe(2.5);
  expect(metrics.usageStatus).toBe("scripted-unmeasured");
  expect(metrics.costMicrousd).toBeNull();
});

it("missing or wrong spin captions do not claim a reaction; false money facts remain wrong", () => {
  const wrong = { ...truth.facts, spin: 2, balance: 12345 };
  const metrics = measure([caption(3501, wrong)]);

  expect(metrics.resultToCaptionMillis.p50).toBeNull();
  expect(metrics.eligibleToAirRate).toBe(0);
  expect(metrics.moneyFactAccuracy).toBeCloseTo(2 / 3);
  expect(metrics.anyFalseFactRate).toBe(1);
});

it("unchanged pictures and silent gaps count as dead air; freezes use spin windows", () => {
  const metrics = measure(
    [caption(3500)],
    [frame(0, 1), frame(500, 1), frame(2000, 2), frame(2100, 2), frame(4000, 3)],
  );

  expect(metrics.deadAir.intervals).toEqual([
    { start: 0, end: 2000 },
    { start: 2000, end: 3500 },
    { start: 4000, end: 6000 },
  ]);
  expect(metrics.deadAir.seconds).toBe(5.5);
  expect(metrics.spinFreezes.seconds).toBeGreaterThan(0);
  expect(metrics.resultToCaptionMillis.p95).toBe(500);
});

it.live("public fixture origins retain one loopback truth owner and reject ambiguous hosts", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const site = yield* gameSite({
        publicOrigins: { top: "https://lobby.example.org", frame: "https://game.example.net" },
      });

      expect(site.url).toBe("https://lobby.example.org/");
      expect(site.frameOrigin).toBe("https://game.example.net");
      expect(site.localUrl).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/u);
      expect(site.playUrl("reels")).toBe("https://lobby.example.org/play/reels");
      expect(site.originQualification).toBe("configured-cross-origin-operator-site-prepared");
      const local = yield* gameSite();

      expect(local.originQualification).toBe("loopback-distinct-sites");
      expect(local.localFrameOrigin).toMatch(/^http:\/\/localhost:\d+$/u);
      yield* local.setPublicOrigins({
        top: "https://lobby.example.org",
        frame: "https://game.example.net",
      });
      expect(local.url).toBe(site.url);
      expect(local.frameOrigin).toBe(site.frameOrigin);
      expect(local.playUrl("reels")).toBe(site.playUrl("reels"));
      expect(local.events()).toEqual([]);

      const result = yield* gameSite({
        publicOrigins: { top: "https://same.example.org", frame: "https://same.example.org:8443" },
      }).pipe(Effect.exit);

      expect(result._tag).toBe("Failure");
      expect(Schema.is(Schema.Json)(site.events())).toBe(true);
    }),
  ),
);
