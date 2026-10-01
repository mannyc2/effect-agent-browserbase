import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { InputReceipt, Target } from "effect-browser/browser-data";
import { type CapturedFrame, CaptureSummary } from "effect-browser/capture";
import { TestClock } from "effect/testing";

import * as Reel from "../examples/realistic-footage/Reel.ts";
import { Storyboard } from "../examples/realistic-footage/Storyboard.ts";
import { clockOffset, distribution, Telemetry } from "../examples/realistic-footage/Telemetry.ts";

it("the reel holds a still page and keeps only the newest picture in a slot", () => {
  const picture = (label: number) => new Uint8Array([label]);
  let reel: Reel.Reel | undefined;
  const film: Array<number> = [];

  // 30 fps: slots are 33⅓ms wide. Two frames share slot 0; then the page is still for a second.
  for (const [label, sourceTimeMillis] of [
    [1, 1_000],
    [2, 1_020],
    [3, 1_040],
    [4, 2_040],
  ] as const) {
    const [next, settled] = Reel.expose(reel, { bytes: picture(label), sourceTimeMillis }, 30);

    reel = next;
    film.push(...settled.map((bytes) => bytes[0]!));
  }
  film.push(...Reel.cut(reel, 500).map((bytes) => bytes[0]!));

  expect(film[0]).toBe(2);
  expect(film.filter((label) => label === 3)).toHaveLength(30);
  expect(film.filter((label) => label === 4)).toHaveLength(16);
  // 1,540ms of source time at thirty frames per second.
  expect(film).toHaveLength(47);
  expect(Reel.cut(undefined, 500)).toEqual([]);
});

it("a storyboard is decoded before it is performed", () => {
  const accepts = Schema.is(Storyboard);

  const target = {
    _tag: "Descriptor",
    descriptor: { kind: "input", label: "Destination", matchScope: "document" },
  } as const;

  const typed = (text: string) => [
    {
      _tag: "Browser",
      step: {
        id: "type",
        action: { _tag: "Type", target, text: { _tag: "Literal", value: text } },
        resolution: { _tag: "Strict" },
      },
    },
  ];

  expect(
    accepts([
      {
        _tag: "Browser",
        step: {
          id: "hold",
          action: { _tag: "Click", target },
          resolution: { _tag: "Strict" },
        },
      },
    ]),
  ).toBe(true);
  expect(accepts([])).toBe(false);
  expect(
    accepts([
      {
        _tag: "Browser",
        step: {
          id: "",
          action: { _tag: "Click", target },
          resolution: { _tag: "Strict" },
        },
      },
    ]),
  ).toBe(false);
  expect(accepts([{ _tag: "Evaluate", script: "alert(1)" }])).toBe(false);
  // Typed text is held to the library's own rule: a line break would press Enter, so it is
  // refused while the storyboard is decoded rather than halfway through a film.
  expect(accepts(typed("Venice"))).toBe(true);
  expect(accepts(typed("Venice\n"))).toBe(false);
  expect(accepts(typed(""))).toBe(false);
});

it("two clocks are compared from the tightest exchange, and its round trip bounds the error", () => {
  // The browser's clock runs 250ms ahead of the host's. One exchange crossed a slow network.
  const exchange = (pageSentMillis: number, outbound: number, held: number, inbound: number) => ({
    pageSentMillis,
    hostReceivedMillis: pageSentMillis - 250 + outbound,
    hostRepliedMillis: pageSentMillis - 250 + outbound + held,
    pageReceivedMillis: pageSentMillis + outbound + held + inbound,
  });

  const measured = clockOffset([exchange(10_000, 40, 9_000, 90), exchange(20_000, 6, 3_000, 4)]);

  // A long-held poll costs nothing: only the time in flight counts as round trip.
  expect(measured).toEqual({ offsetMillis: -249, uncertaintyMillis: 5, samples: 2 });
  expect(Math.abs(-250 - measured!.offsetMillis)).toBeLessThanOrEqual(measured!.uncertaintyMillis);
  expect(clockOffset([])).toBeNull();
});

it("quantiles are nearest-rank, and nothing measured is reported as nothing", () => {
  expect(distribution([])).toBeNull();
  expect(distribution([5])).toEqual({ count: 1, p50: 5, p95: 5, p99: 5, max: 5 });
  expect(distribution(Array.from({ length: 100 }, (_, index) => 100 - index))).toEqual({
    count: 100,
    p50: 50,
    p95: 95,
    p99: 99,
    max: 100,
  });
});

it.effect("a completed action is timed, and a failed one stays the caller's failure", () =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;

    yield* telemetry.action("click", TestClock.adjust("40 millis"));
    const failed = yield* telemetry.action("fill", Effect.fail("stale" as const)).pipe(Effect.flip);

    const metrics = yield* telemetry.metrics;

    expect(failed).toBe("stale");
    expect(metrics.control.actionMillis.click).toMatchObject({ count: 1 });
    // Only completed actions have a duration; a failed one is the caller's error to report.
    expect(metrics.control.actionMillis.fill).toBeUndefined();
    // No frames and no clock comparison yet: latency is absent, not zero.
    expect(metrics.capture.latencyMillis).toBeNull();
    expect(metrics.capture.interval).toBeNull();
    // A film always has an opening document, and knows nothing about it until it is told.
    expect(metrics.documents).toEqual([
      { document: 0, url: null, committedAtMillis: null, heldMillis: null },
    ]);
  }).pipe(Effect.provide(Telemetry.layer)),
);

const target = Target.make({ generation: 0, pageId: "page-1", frameId: "frame-1" });

const frameAt = (document: number, sourceTimeMillis: number, sequence: number): CapturedFrame => ({
  bytes: new Uint8Array([255, 216, 255, 217]),
  mediaType: "image/jpeg",
  target,
  sequence,
  document,
  sourceTimeMillis,
  sourceClock: "presentation-unix-millis",
  receivedMonotonicNanos: BigInt(sequence) * 10_000_000n,
  width: 64,
  height: 48,
  viewportWidth: 64,
  viewportHeight: 48,
});

it.effect("native input is timed by its own receipt, not by the wait around it", () =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;

    const receipt = InputReceipt.make({
      target,
      kind: "type",
      position: null,
      startedMonotonicNanos: 5_000_000_000n,
      completedMonotonicNanos: 5_012_000_000n,
    });

    // Forty milliseconds pass waiting to be admitted; the native command itself took twelve.
    yield* telemetry.input("key", TestClock.adjust("40 millis").pipe(Effect.as(receipt)));
    const metrics = yield* telemetry.metrics;

    expect(metrics.control.inputMillis.key).toEqual({
      count: 1,
      p50: 12,
      p95: 12,
      p99: 12,
      max: 12,
    });
    expect(metrics.control.actionMillis.key).toBeUndefined();
  }).pipe(Effect.provide(Telemetry.layer)),
);

it.effect("each document gets the library's address and commit, and this layer's held time", () =>
  Effect.gen(function* () {
    const telemetry = yield* Telemetry;

    yield* telemetry.frame(frameAt(0, 1_000, 0));
    yield* telemetry.frame(frameAt(0, 1_033, 1));
    // While the film runs, the frames alone say a second document began and how long it held.
    yield* telemetry.frame(frameAt(1, 1_203, 2));
    const during = yield* telemetry.metrics;

    expect(during.documents).toEqual([
      { document: 0, url: null, committedAtMillis: null, heldMillis: null },
      { document: 1, url: null, committedAtMillis: null, heldMillis: 170 },
    ]);
    // Pacing is measured inside a document, so the hold across a navigation is not counted twice.
    expect(during.capture.interFrameMillis).toMatchObject({ count: 1, max: 33 });

    yield* telemetry.captureEnded(
      CaptureSummary.make({
        target,
        qualification: {
          authority: "open",
          containment: { _tag: "NotRequired" },
          ownerPhase: "open",
          ownerGeneration: target.generation,
        },
        reason: "stopped",
        received: 3,
        delivered: 3,
        discarded: 0,
        overflow: 0,
        rejected: 0,
        duplicates: 0,
        late: 0,
        peakBufferedFrames: 1,
        peakBufferedBytes: 4,
        bufferedFrames: 0,
        bufferedBytes: 0,
        sourceFirstMillis: 1_000,
        sourceLastMillis: 1_203,
        initialUrl: "https://rail.example/",
        documentBoundaries: [
          {
            document: 1,
            sameDocument: false,
            observedMonotonicNanos: 15_000_000n,
            afterSequence: 1,
            url: "https://rail.example/routes/vienna-venice",
          },
        ],
        documentBoundariesTruncated: false,
        nativeStop: "confirmed",
        upstreamDrops: "unknown",
      }),
    );
    const after = yield* telemetry.metrics;

    expect(after.documents.map((document) => document.url)).toEqual([
      "https://rail.example/",
      "https://rail.example/routes/vienna-venice",
    ]);
    expect(after.documents[0]?.committedAtMillis).toBeNull();
    expect(after.documents[1]?.committedAtMillis).not.toBeNull();
    expect(after.documents[1]?.heldMillis).toBe(170);
    expect(after.capture.interval).toMatchObject({
      reason: "stopped",
      discarded: 0,
      overflow: 0,
      rejected: 0,
      late: 0,
    });
  }).pipe(Effect.provide(Telemetry.layer)),
);
