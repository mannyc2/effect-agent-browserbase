import assert from "node:assert/strict";

import type { Scope } from "effect";
import { Effect, Exit, Fiber, Stream } from "effect";

import { type CaptureOptions } from "../../src/Capture.ts";
import { type CaptureParent } from "../../src/internal/Association.ts";
import { startCapture } from "../../src/internal/Capture.ts";
import { type NativeFrame } from "../../src/internal/Driver.ts";
import { makeOwner } from "../../src/internal/Owner.ts";
import type { BrowserbaseError } from "../../src/Types.ts";
import { Target } from "../../src/Types.ts";
import { jpeg, widerJpeg } from "./Jpeg.ts";
import { fixture as sessionFixture, gate } from "./ScriptedProvider.ts";
import { advance, timed } from "./Time.ts";

interface Case {
  readonly name: string;
  readonly run: Effect.Effect<void, BrowserbaseError>;
}

const test = (
  name: string,
  run: () => Effect.Effect<void, BrowserbaseError, Scope.Scope>,
): Case => ({
  name,
  run: timed(Effect.scoped(Effect.suspend(run))),
});

const expectReason = <A, R>(
  effect: Effect.Effect<A, BrowserbaseError, R>,
  reason: BrowserbaseError["reason"],
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
  } = {},
) {
  const owner = yield* makeOwner({
    maxActions: 20,
    maxElapsedMillis: 30_000,
    actionTimeoutMillis: 10_000,
  });

  owner.state.phase = "open";
  let callback: ((frame: NativeFrame) => void) | undefined;
  let starts = 0;
  let stops = 0;

  const parent: CaptureParent = {
    owner,
    target: () =>
      Target.make({ generation: owner.state.generation, pageId: "page-1", frameId: "frame-1" }),
    source: () =>
      Effect.succeed({
        start: async (receive) => {
          starts++;
          callback = receive;
          if (options.startFailure) throw new Error("PRIVATE-NATIVE-START");
          await options.start?.();
        },
        stop: async () => {
          stops++;
          await options.stop?.();
        },
      }),
  };

  owner.onInvalidate((reason) => {
    if (reason !== "observation") parent.captureLease?.invalidate(reason);
  });

  const emit = (timestamp: number, data = jpeg(), viewportWidth = 64, viewportHeight = 48) => {
    assert.ok(callback, "capture must install its callback before the fixture can emit");
    callback({ data, timestamp, viewportWidth, viewportHeight });
  };

  return { parent, emit, counts: () => ({ starts, stops }) };
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
  test("stopping one interval permits another and a stale stop cannot end the replacement", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const first = yield* startCapture(f.parent, options);

      yield* first.stop;
      const second = yield* startCapture(f.parent, options);

      yield* first.stop;
      assert.equal(f.counts().stops, 1);
      assert.notEqual(f.parent.captureLease, undefined);
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
  test("a slow native stop quarantines the lease until confirmation", () =>
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
      release.resolve();
      yield* Fiber.join(stopping);
      assert.equal(f.parent.captureLease, undefined);
    })),
  test("native stop failure prevents a second competing screencast without closing the browser", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({
        stop: async () => {
          throw new Error("PRIVATE-STOP");
        },
      });

      const interval = yield* startCapture(f.parent, options);

      assert.equal((yield* interval.stop).nativeStop, "unconfirmed");
      yield* expectReason(startCapture(f.parent, options), "busy");
      assert.equal(f.parent.owner.state.phase, "open");
      assert.equal(f.counts().starts, 1);
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
      assert.equal(f.parent.captureLease, undefined);
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
  test("ordinary page mutation leaves capture running but target changes segment it", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.parent.owner.invalidate("observation");
      f.emit(1000);
      assert.equal(f.counts().stops, 0);
      f.parent.owner.invalidate("target-changed");
      yield* expectReason(Stream.runDrain(interval.frames), "target-changed");
    })),
  test("failed native start runs cleanup and leaves no active capture lease", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ startFailure: true });

      yield* expectReason(startCapture(f.parent, options), "provider");
      assert.equal(f.counts().stops, 1);
      assert.equal(f.parent.captureLease, undefined);
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
      assert.equal(f.parent.captureLease, undefined);
    })),
];
