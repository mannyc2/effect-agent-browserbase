import assert from "node:assert/strict";

import type { Scope } from "effect";
import { Effect, Exit, Fiber, Stream } from "effect";

import { PageInfo, Target } from "../../src/BrowserData.ts";
import { type CaptureOptions, type CaptureSize } from "../../src/Capture.ts";
import {
  BrowserError,
  type AllocationError,
  type ClientError,
  type ContextError,
  type InitializationError,
} from "../../src/Errors.ts";
import { type CaptureParent } from "../../src/internal/browser/Association.ts";
import { type CaptureInvalidation, type NativeFrame } from "../../src/internal/browser/Driver.ts";
import { makeOwner } from "../../src/internal/browser/Owner.ts";
import { startCapture } from "../../src/internal/capture/Capture.ts";
import { jpeg, widerJpeg } from "./Jpeg.ts";
import { fixture as sessionFixture, gate } from "./ScriptedProvider.ts";
import { advance, timed } from "./Time.ts";

type CaptureFailure =
  | AllocationError
  | BrowserError
  | ClientError
  | ContextError
  | InitializationError;

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, CaptureFailure>;
}

const test = (name: string, run: () => Effect.Effect<void, CaptureFailure, Scope.Scope>): Case => ({
  name,
  run: timed(Effect.scoped(Effect.suspend(run))),
});

const expectReason = <A, R>(
  effect: Effect.Effect<A, BrowserError, R>,
  reason: BrowserError["reason"],
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason, reason);
    }),
  );

const makeFixture = Effect.fnUntraced(function* (
  options: {
    readonly start?: () => Promise<void>;
    readonly stop?: () => Promise<void>;
    readonly startFailure?: boolean;
    readonly onRequest?: (quality: number, size: CaptureSize | undefined) => void;
  } = {},
) {
  const owner = yield* makeOwner({
    maxActions: 20,
    maxElapsedMillis: 30_000,
    actionTimeoutMillis: 10_000,
  });

  owner.state.phase = "open";
  const callbacks = new Map<string, (frame: NativeFrame) => void>();
  const invalidators = new Map<string, (reason: CaptureInvalidation) => void>();
  let starts = 0;
  let stops = 0;

  const page = (pageId = "page-1") =>
    PageInfo.make({
      pageId,
      targetId: `target-${pageId}`,
      title: pageId,
      url: `https://${pageId}.example.test/`,
      selected: pageId === "page-1",
    });

  const parent: CaptureParent = {
    owner,
    target: () =>
      Target.make({ generation: owner.state.generation, pageId: "page-1", frameId: "frame-1" }),
    resolve: (_ticket, requested) => {
      const chosen = requested ?? page();

      if (chosen.targetId !== `target-${chosen.pageId}`)
        return Effect.fail(
          BrowserError.make({ operation: "capture", reason: "stale", outcome: "undispatched" }),
        );

      return Effect.succeed({
        key: chosen.targetId,
        target: Target.make({
          generation: owner.state.generation,
          pageId: chosen.pageId,
          frameId: "frame-1",
        }),
        source: {
          start: async (receive, quality, invalidate, size) => {
            starts++;
            options.onRequest?.(quality, size);
            callbacks.set(chosen.pageId, receive);
            invalidators.set(chosen.pageId, invalidate);
            if (options.startFailure) throw new Error("PRIVATE-NATIVE-START");
            await options.start?.();
          },
          stop: async () => {
            stops++;
            callbacks.delete(chosen.pageId);
            invalidators.delete(chosen.pageId);
            await options.stop?.();
          },
        },
      });
    },
    captureLeases: new Map(),
    captureReservedBytes: 0,
  };

  owner.onInvalidate((reason) => {
    if (["paused", "disconnected", "uncertain", "closed"].includes(reason))
      for (const lease of parent.captureLeases.values()) lease.invalidate(reason);
  });

  const emitPage = (
    pageId: string,
    timestamp: number,
    data = jpeg(),
    viewportWidth = 64,
    viewportHeight = 48,
  ) => {
    const callback = callbacks.get(pageId);

    assert.ok(
      callback,
      `capture for ${pageId} must install its callback before the fixture can emit`,
    );
    callback({ data, timestamp, viewportWidth, viewportHeight });
  };

  const emit = (timestamp: number, data = jpeg(), viewportWidth = 64, viewportHeight = 48) =>
    emitPage("page-1", timestamp, data, viewportWidth, viewportHeight);

  const invalidate = (pageId: string, reason: CaptureInvalidation) => {
    const invalidator = invalidators.get(pageId);

    assert.ok(invalidator, `capture for ${pageId} must install invalidation before use`);
    invalidator(reason);
  };

  return {
    parent,
    page,
    emit,
    emitPage,
    invalidate,
    counts: () => ({ starts, stops }),
  };
});

const options: CaptureOptions = { maxFrames: 2, maxBufferedBytes: 16_384, maxFrameBytes: 8192 };

export const captureCases: ReadonlyArray<Case> = [
  test("capture has a bounded drop-oldest queue with explicit sequence gaps", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      for (let i = 0; i < 100; i++) f.emit(1000 + i * 10);
      const stopped = yield* interval.stop;

      assert.equal(stopped.received, 100);
      assert.equal(stopped.dropped, 98);
      assert.equal(stopped.bufferedFrames, 2);
      assert.equal(stopped.peakBufferedFrames, 2);
      const frames = yield* Stream.runCollect(interval.frames);

      assert.deepEqual(
        frames.map((frame) => frame.sequence),
        [98, 99],
      );
      assert.equal((yield* interval.completed).delivered, 2);
      assert.equal(f.counts().stops, 1);
    })),
  test("byte pressure is enforced independently of the frame count", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const size = jpeg().byteLength;

      const interval = yield* startCapture(f.parent, {
        maxFrames: 10,
        maxBufferedBytes: size * 2,
        maxFrameBytes: size,
      });

      for (let i = 0; i < 6; i++) f.emit(1000 + i);
      const summary = yield* interval.stop;

      assert.equal(summary.peakBufferedBytes, size * 2);
      assert.equal(summary.dropped, 4);
      assert.equal(summary.bufferedFrames, 2);
    })),
  test("capture copies callback bytes and preserves source time separately from receipt time", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);
      const data = jpeg();

      f.emit(1_700_000_000_123.25, data);
      data.fill(0);
      yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      assert.equal(frames[0]?.bytes[0], 255);
      assert.equal(frames[0]?.sourceTimeMillis, 1_700_000_000_123.25);
      assert.equal(frames[0]?.sourceClock, "presentation-unix-millis");
      assert.equal(typeof frames[0]?.receivedMonotonicNanos, "bigint");
      assert.equal(frames[0]?.width, 64);
      assert.equal(frames[0]?.height, 48);
    })),
  test("duplicate timestamps are accounted for, not silently relabeled as new frames", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(1000);
      f.emit(1010);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      assert.equal(summary.duplicates, 1);
      assert.equal(summary.dropped, 1);
      assert.deepEqual(
        frames.map((frame) => frame.sequence),
        [0, 2],
      );
    })),
  test("a backwards source timestamp ends with a typed partial stream", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(900);
      const delivered: number[] = [];

      yield* expectReason(
        Stream.runForEach(interval.frames, (frame) =>
          Effect.sync(() => {
            delivered.push(frame.sequence);
          }),
        ),
        "timestamp",
      );
      assert.deepEqual(delivered, [0]);
      const summary = yield* interval.completed;

      assert.equal(summary.reason, "timestamp-discontinuity");
      assert.equal(summary.nativeStop, "confirmed");
    })),
  test("actual JPEG geometry changes terminate an interval even at unchanged CSS dimensions", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(1010, widerJpeg());
      yield* expectReason(Stream.runDrain(interval.frames), "resized");
      assert.equal((yield* interval.completed).received, 2);
    })),
  test("CSS viewport changes segment capture even when image dimensions are unchanged", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(1010, jpeg(), 100, 48);
      yield* expectReason(Stream.runDrain(interval.frames), "resized");
    })),
  test("a malformed or oversized frame is rejected before retention", () =>
    Effect.gen(function* () {
      for (const [data, reason] of [
        [new Uint8Array([1, 2, 3]), "malformed"],
        [new Uint8Array(9000), "limit"],
      ] as const) {
        const f = yield* makeFixture();
        const interval = yield* startCapture(f.parent, options);

        f.emit(1000, data);
        yield* expectReason(Stream.runDrain(interval.frames), reason);
        assert.equal((yield* interval.completed).peakBufferedBytes, 0);
      }
    })),
  test("distinct page targets capture concurrently and stopping one leaves the other active", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const first = yield* startCapture(f.parent, { ...options, target: f.page("page-1") });
      const second = yield* startCapture(f.parent, { ...options, target: f.page("page-2") });

      assert.equal(f.parent.captureLeases.size, 2);
      f.emitPage("page-1", 1000);
      f.emitPage("page-2", 1000);
      yield* first.stop;
      assert.equal(f.parent.captureLeases.size, 1);
      f.emitPage("page-2", 1010);
      const secondSummary = yield* second.stop;

      assert.equal(secondSummary.received, 2);
      assert.equal(secondSummary.target.pageId, "page-2");
      assert.equal(f.parent.captureLeases.size, 0);
    })),
  test("same-page capture stays exclusive while other pages remain available", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const target = f.page("page-1");
      const first = yield* startCapture(f.parent, { ...options, target });

      yield* expectReason(startCapture(f.parent, { ...options, target }), "busy");
      const second = yield* startCapture(f.parent, { ...options, target: f.page("page-2") });

      yield* first.stop;
      yield* second.stop;
    })),
  test("capture count and aggregate buffer reservations bound parent work", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const intervals = [];

      for (let i = 1; i <= 4; i++)
        intervals.push(
          yield* startCapture(f.parent, {
            ...options,
            target: f.page(`page-${i}`),
          }),
        );
      yield* expectReason(
        startCapture(f.parent, { ...options, target: f.page("page-5") }),
        "limit",
      );
      for (const interval of intervals) yield* interval.stop;

      const largeA = yield* startCapture(f.parent, {
        target: f.page("page-a"),
        maxFrames: 1,
        maxBufferedBytes: 32 * 1024 * 1024,
        maxFrameBytes: 1,
      });

      const largeB = yield* startCapture(f.parent, {
        target: f.page("page-b"),
        maxFrames: 1,
        maxBufferedBytes: 32 * 1024 * 1024,
        maxFrameBytes: 1,
      });

      yield* expectReason(
        startCapture(f.parent, {
          target: f.page("page-c"),
          maxFrames: 1,
          maxBufferedBytes: 1,
          maxFrameBytes: 1,
        }),
        "limit",
      );
      yield* largeA.stop;
      yield* largeB.stop;
      assert.equal(f.parent.captureReservedBytes, 0);
    })),
  test("stopping one interval permits another and a stale stop cannot end the replacement", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const first = yield* startCapture(f.parent, options);

      yield* first.stop;
      const second = yield* startCapture(f.parent, options);

      yield* first.stop;
      assert.equal(f.counts().stops, 1);
      assert.equal(f.parent.captureLeases.size, 1);
      f.emit(2000);
      yield* second.stop;
      assert.equal((yield* Stream.runCollect(second.frames)).length, 1);
      assert.equal(f.counts().stops, 2);
      assert.equal(f.parent.owner.state.phase, "open");
    })),
  test("concurrent stop callers await one native stop rather than returning early", () =>
    Effect.gen(function* () {
      const entered = gate<void>();
      const release = gate<void>();

      const f = yield* makeFixture({
        stop: async () => {
          entered.resolve();
          await release.promise;
        },
      });

      const interval = yield* startCapture(f.parent, options);
      const first = yield* interval.stop.pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      const second = yield* interval.stop.pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      assert.equal(second.pollUnsafe(), undefined);
      release.resolve();
      yield* Fiber.join(first);
      yield* Fiber.join(second);
      assert.equal(f.counts().stops, 1);
    })),
  test("a slow native stop quarantines only its page until confirmation", () =>
    Effect.gen(function* () {
      const release = gate<void>();
      const entered = gate<void>();

      const f = yield* makeFixture({
        stop: async () => {
          entered.resolve();
          await release.promise;
        },
      });

      const interval = yield* startCapture(f.parent, options);
      const stopping = yield* interval.stop.pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      yield* expectReason(startCapture(f.parent, options), "busy");
      const other = yield* startCapture(f.parent, { ...options, target: f.page("page-2") });

      release.resolve();
      yield* Fiber.join(stopping);
      yield* other.stop;
      assert.equal(f.parent.captureLeases.size, 0);
    })),
  test("native stop failure prevents a competing screencast only on that page", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        stop: async () => {
          throw new Error("PRIVATE-STOP");
        },
      });

      const interval = yield* startCapture(f.parent, options);

      assert.equal((yield* interval.stop).nativeStop, "unconfirmed");
      yield* expectReason(startCapture(f.parent, options), "busy");
      const other = yield* startCapture(f.parent, { ...options, target: f.page("page-2") });

      assert.equal((yield* other.stop).nativeStop, "unconfirmed");
      assert.equal(f.parent.owner.state.phase, "open");
      assert.equal(f.counts().starts, 2);
    })),
  test("consumer cancellation ends capture but does not spend or close browser actions", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);
      const consumer = yield* Stream.runDrain(interval.frames).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* Fiber.interrupt(consumer);
      assert.equal(f.counts().stops, 1);
      assert.equal(f.parent.owner.state.phase, "open");
      assert.equal(f.parent.owner.state.actions, 0);
    })),
  test("a capture has one consumer and rejects a second without stopping the first", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);
      const consumer = yield* Stream.runDrain(interval.frames).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      yield* expectReason(Stream.runDrain(interval.frames), "busy");
      assert.equal(f.counts().stops, 0);
      yield* interval.stop;
      yield* Fiber.join(consumer);
    })),
  test("scope closure stops capture even when nobody subscribes", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();

      yield* Effect.scoped(startCapture(f.parent, options));
      assert.equal(f.counts().stops, 1);
      assert.equal(f.parent.captureLeases.size, 0);
      assert.equal(f.parent.owner.state.phase, "open");
    })),
  test("duration expiration ends idle capture without waiting for another callback", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, { ...options, maxDurationMillis: 20 });

      yield* advance(20);
      const summary = yield* interval.completed;

      assert.equal(summary.reason, "duration-limit");
      assert.equal(summary.nativeStop, "confirmed");
    })),
  test("parent generation fencing stops callbacks even when native disconnect fails", () =>
    Effect.gen(function* () {
      let receive: ((frame: NativeFrame) => void) | undefined;
      let stops = 0;

      const f = yield* sessionFixture({
        disconnectFails: true,
        captureSource: {
          start: async (callback) => {
            receive = callback;
          },
          stop: async () => {
            stops++;
          },
        },
      });

      const session = yield* (yield* f.acquisition).connect;
      const interval = yield* startCapture(session.capture, options);
      const result = yield* session.close;

      assert.equal(result.local, "failed");
      receive?.({ data: jpeg(), timestamp: 1000, viewportWidth: 64, viewportHeight: 48 });
      yield* expectReason(Stream.runDrain(interval.frames), "target-changed");
      assert.equal((yield* interval.completed).received, 0);
      assert.equal(stops, 1);
    })),
  test("selection changes leave pinned capture running while page-local invalidation segments it", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.parent.owner.invalidate("observation");
      f.parent.owner.invalidate("target-changed");
      f.emit(1000);
      assert.equal(f.counts().stops, 0);
      f.invalidate("page-1", "target-changed");
      yield* expectReason(Stream.runDrain(interval.frames), "target-changed");
    })),
  test("failed native start runs cleanup and leaves no active capture lease", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ startFailure: true });

      yield* expectReason(startCapture(f.parent, options), "provider");
      assert.equal(f.counts().stops, 1);
      assert.equal(f.parent.captureLeases.size, 0);
      assert.equal(f.parent.owner.state.phase, "open");
    })),
  test("interruption during native start observes its late result and cleans the lease", () =>
    Effect.gen(function* () {
      const entered = gate<void>();
      const complete = gate<void>();

      const f = yield* makeFixture({
        start: async () => {
          entered.resolve();
          await complete.promise;
        },
      });

      const fiber = yield* startCapture(f.parent, options).pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      const interrupt = yield* Fiber.interrupt(fiber).pipe(Effect.forkChild);

      yield* Effect.yieldNow;
      complete.resolve();
      yield* Fiber.join(interrupt);
      assert.equal(Exit.hasInterrupts(yield* Fiber.await(fiber)), true);
      assert.equal(f.counts().stops, 1);
      assert.equal(f.parent.captureLeases.size, 0);
    })),
  test("capture rejects invalid source-size requests before native work or reservation", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();

      for (const invalid of [0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 16385]) {
        for (const size of [
          { width: invalid, height: 48 },
          { width: 64, height: invalid },
        ]) {
          yield* expectReason(startCapture(f.parent, { ...options, size }), "configuration");
        }
      }
      assert.deepEqual(f.counts(), { starts: 0, stops: 0 });
      assert.equal(f.parent.captureLeases.size, 0);
      assert.equal(f.parent.captureReservedBytes, 0);
      assert.equal(f.parent.owner.state.phase, "open");
    })),
  test("capture snapshots the size request and forwards quality without changing geometry or clocks", () =>
    Effect.gen(function* () {
      const size = { width: 64, height: 48 };
      let requested: CaptureSize | undefined;

      const f = yield* makeFixture({
        onRequest: (quality, forwarded) => {
          assert.equal(quality, 71);
          requested = forwarded;
        },
      });

      const interval = yield* startCapture(f.parent, { ...options, size, quality: 71 });

      size.width = 1;
      size.height = 1;
      assert.deepEqual(requested, { width: 64, height: 48 });
      assert.notEqual(requested, size);
      f.emit(1234.5, jpeg(), 1024, 768);
      yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);
      const frame = frames[0];

      assert.equal(frames.length, 1);
      assert.ok(frame);
      assert.equal(frame.width, 64);
      assert.equal(frame.height, 48);
      assert.equal(frame.viewportWidth, 1024);
      assert.equal(frame.viewportHeight, 768);
      assert.equal(frame.sourceTimeMillis, 1234.5);
    })),
  test("capture rejects oversized actual JPEGs on the first frame and releases only their page", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();

      const oversized = yield* startCapture(f.parent, {
        ...options,
        size: { width: 64, height: 48 },
      });

      const sibling = yield* startCapture(f.parent, {
        ...options,
        target: f.page("page-2"),
        size: { width: 80, height: 48 },
      });

      f.emit(1000, widerJpeg(), 64, 48);
      yield* expectReason(Stream.runDrain(oversized.frames), "limit");
      const summary = yield* oversized.completed;

      assert.equal(summary.received, 1);
      assert.equal(summary.delivered, 0);
      assert.equal(summary.dropped, 1);
      assert.equal(summary.nativeStop, "confirmed");
      assert.equal(f.parent.captureLeases.size, 1);
      f.emitPage("page-2", 1001, widerJpeg());
      yield* sibling.stop;
      assert.equal((yield* Stream.runCollect(sibling.frames)).length, 1);
      assert.equal(f.parent.captureReservedBytes, 0);
    })),
  test("source-size height violations are not hidden by matching metadata", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();

      const interval = yield* startCapture(f.parent, {
        ...options,
        size: { width: 64, height: 47 },
      });

      f.emit(1000, jpeg(), 64, 47);
      yield* expectReason(Stream.runDrain(interval.frames), "limit");
      assert.equal((yield* interval.completed).delivered, 0);
    })),
  test("omitting source size preserves native defaults and accepts the existing bounded geometry", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        onRequest: (_quality, size) => assert.equal(size, undefined),
      });

      const interval = yield* startCapture(f.parent, options);

      f.emit(1000, widerJpeg());
      yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);
      const frame = frames[0];

      assert.ok(frame);
      assert.equal(frame.width, 80);
      assert.equal(frame.height, 48);
    })),
];
