import assert from "node:assert/strict";

import { Effect, Exit, Fiber, type Scope, Stream } from "effect";
import { BrowserError, Reasons, type InitializationError } from "effect-browser/errors";

import { PageInfo, Target } from "../../../packages/browser/src/BrowserData.ts";
import { type CaptureOptions, type CaptureSize } from "../../../packages/browser/src/Capture.ts";
import { type CaptureParent } from "../../../packages/browser/src/internal/browser/Association.ts";
import {
  type CaptureInvalidation,
  type NativeFrame,
} from "../../../packages/browser/src/internal/browser/Driver.ts";
import { makeOwner } from "../../../packages/browser/src/internal/browser/Owner.ts";
import { startCapture } from "../../../packages/browser/src/internal/capture/Capture.ts";
import {
  type AllocationError,
  type ClientError,
  type ContextError,
} from "../../../packages/browserbase/src/Errors.ts";
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
  reason: BrowserError["reason"]["_tag"],
) =>
  effect.pipe(
    Effect.result,
    Effect.map((result) => {
      assert.equal(result._tag, "Failure");
      if (result._tag === "Failure") assert.equal(result.failure.reason._tag, reason);
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
    maxHostReads: 10_000,
    maxElapsedMillis: 30_000,
    actionTimeoutMillis: 10_000,
  });

  owner.state.phase = "open";
  const callbacks = new Map<string, (frame: NativeFrame) => void>();
  const invalidators = new Map<string, (reason: CaptureInvalidation) => void>();
  const documents = new Map<string, (url: string) => void>();
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
          BrowserError.make({
            operation: "capture",
            reason: Reasons.Stale.make({}),
            outcome: "undispatched",
          }),
        );

      return Effect.succeed({
        key: chosen.targetId,
        target: Target.make({
          generation: owner.state.generation,
          pageId: chosen.pageId,
          frameId: "frame-1",
        }),
        source: {
          start: async ({ receive, quality, invalidate, size, opened, document }) => {
            starts++;
            options.onRequest?.(quality, size);
            callbacks.set(chosen.pageId, receive);
            invalidators.set(chosen.pageId, invalidate);
            if (document !== undefined) documents.set(chosen.pageId, document);
            // As the driver does: the address is reported in the turn the watch is installed.
            opened?.(chosen.url);
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

  /** What the driver does when a followed page's main frame navigates. */
  const navigate = (url = "https://page-1.example.test/next", pageId = "page-1") => {
    const document = documents.get(pageId);

    // An interval that lasts one document registers no hook, and ends instead.
    if (document === undefined) invalidate(pageId, "target-changed");
    else document(url);
  };

  return {
    parent,
    page,
    emit,
    emitPage,
    invalidate,
    navigate,
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
      assert.equal(stopped.discarded, 98);
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
      assert.equal(summary.discarded, 4);
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
      assert.equal(summary.discarded, 1);
      assert.deepEqual(
        frames.map((frame) => frame.sequence),
        [0, 2],
      );
    })),
  test("a frame that arrives behind a newer one is discarded and counted, not reordered in", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, { ...options, maxFrames: 8 });

      // The pair recorded on #9: stamped 1.094ms apart after a 33ms stall, emitted in the
      // order their concurrent encodes completed.
      f.emit(1_789_919_823_339.043);
      f.emit(1_789_919_823_372.043);
      f.emit(1_789_919_823_370.949);
      f.emit(1_789_919_823_388.7);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      assert.deepEqual(
        frames.map((frame) => frame.sequence),
        [0, 1, 3],
      );
      assert.deepEqual(
        frames.map((frame) => frame.sourceTimeMillis),
        [1_789_919_823_339.043, 1_789_919_823_372.043, 1_789_919_823_388.7],
      );
      assert.equal(summary.late, 1);
      assert.equal(summary.discarded, 1);
      assert.equal(summary.duplicates, 0);
      assert.equal(summary.reason, "stopped");
      assert.equal(summary.error, undefined);
      assert.equal(summary.sourceLastMillis, 1_789_919_823_388.7);
    })),
  test("discarded is the sum of disjoint overflow, duplicate, late and rejected frames", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(1010);
      f.emit(1020); // Evicts only the first frame from the two-frame buffer.
      f.emit(1020); // Duplicate.
      f.emit(1015); // Late.
      const active = yield* interval.snapshot;

      assert.deepEqual(
        [active.discarded, active.overflow, active.duplicates, active.late, active.rejected],
        [3, 1, 1, 1, 0],
      );
      f.emit(1030, new Uint8Array(9000)); // Measured frame-byte limit, not a late frame.
      const sequences: number[] = [];

      yield* expectReason(
        Stream.runForEach(interval.frames, (frame) =>
          Effect.sync(() => {
            sequences.push(frame.sequence);
          }),
        ),
        "Limit",
      );
      const final = yield* interval.completed;

      assert.deepEqual(sequences, [1, 2]);
      assert.deepEqual(
        [
          final.received,
          final.delivered,
          final.discarded,
          final.overflow,
          final.duplicates,
          final.late,
          final.rejected,
        ],
        [6, 2, 4, 1, 1, 1, 1],
      );
      assert.equal(
        final.discarded,
        final.overflow + final.duplicates + final.late + final.rejected,
      );
      assert.equal(final.upstreamDrops, "unknown");
      assert.deepEqual(final.error?.reason, {
        _tag: "Limit",
        dimension: "frame-bytes",
        maximum: 8192,
        observed: 9000,
      });
    })),
  test("two late frames in a row are the most concurrent encoding can produce", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, { ...options, maxFrames: 8 });

      // Three frames in flight, and the newest encode finishes first.
      f.emit(1000);
      f.emit(1012);
      f.emit(1010);
      f.emit(1011);
      f.emit(1030);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      assert.deepEqual(
        frames.map((frame) => frame.sourceTimeMillis),
        [1000, 1012, 1030],
      );
      assert.equal(summary.late, 2);
      assert.equal(summary.error, undefined);
    })),
  test("an accepted frame ends a late run, so separate reorderings never accumulate", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, { ...options, maxFrames: 8 });

      for (const time of [1000, 990, 995, 1010, 1005, 1006, 1020]) f.emit(time);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      assert.deepEqual(
        frames.map((frame) => frame.sourceTimeMillis),
        [1000, 1010, 1020],
      );
      assert.equal(summary.late, 4);
      assert.equal(summary.error, undefined);
    })),
  test("a third consecutive late frame is source time going backwards and ends the interval", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      for (const time of [900, 910, 920]) f.emit(time);
      // The interval has ended, so nothing later is admitted even if it looks in order.
      f.emit(2000);
      const delivered: number[] = [];

      yield* expectReason(
        Stream.runForEach(interval.frames, (frame) =>
          Effect.sync(() => {
            delivered.push(frame.sequence);
          }),
        ),
        "Timestamp",
      );
      assert.deepEqual(delivered, [0]);
      const summary = yield* interval.completed;

      assert.equal(summary.reason, "timestamp-discontinuity");
      assert.equal(summary.late, 3);
      assert.equal(summary.received, 4);
      assert.equal(summary.nativeStop, "confirmed");
    })),
  test("an interval that follows its page spans a navigation and marks where the document changed", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();

      const interval = yield* startCapture(f.parent, {
        ...options,
        maxFrames: 8,
        lifetime: "page",
      });

      f.emit(1000);
      f.emit(1010);
      f.navigate("https://page-1.example.test/loading");
      f.emit(1020);
      // Longer than any address this package will record.
      f.navigate(`https://page-1.example.test/${"a".repeat(8192)}`);
      f.emit(1030);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      // One interval, never restarted: no frame is lost to the navigation itself.
      assert.equal(f.counts().starts, 1);
      assert.equal(summary.error, undefined);
      assert.deepEqual(
        frames.map((frame) => [frame.sequence, frame.document]),
        [
          [0, 0],
          [1, 0],
          [2, 1],
          [3, 2],
        ],
      );
      // Enough to segment by sequence without guessing which document a frame belongs to.
      assert.deepEqual(
        summary.documentBoundaries.map((boundary) => [boundary.document, boundary.afterSequence]),
        [
          [1, 1],
          [2, 2],
        ],
      );
      assert.equal(summary.documentBoundariesTruncated, false);
      // Every document a frame can name has an address: the first from when the watch began,
      // the rest from the navigation that committed them. One too long to record is null, never
      // cut down to an address the page did not show.
      assert.equal(summary.initialUrl, "https://page-1.example.test/");
      assert.deepEqual(
        summary.documentBoundaries.map((boundary) => boundary.url),
        ["https://page-1.example.test/loading", null],
      );
    })),
  test("live metadata preserves boundaries and loss without consuming or restarting capture", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, { ...options, lifetime: "page" });
      const initial = yield* interval.snapshot;

      assert.equal(initial.phase, "capturing");
      assert.equal(initial.reason, null);
      assert.equal(initial.nativeStop, null);
      assert.equal(initial.initialUrl, "https://page-1.example.test/");
      assert.equal(initial.currentDocument, 0);

      f.emit(1000);
      f.emit(1010);
      f.navigate("https://page-1.example.test/next");
      f.emit(1020);
      f.emit(1015);
      const active = yield* interval.snapshot;

      assert.equal(active.phase, "capturing");
      assert.equal(active.delivered, 0);
      assert.equal(active.discarded, 2);
      assert.equal(active.late, 1);
      assert.equal(active.upstreamDrops, "unknown");
      assert.equal(active.currentDocument, 1);
      assert.equal(active.documentBoundaries[0]?.afterSequence, 1);
      assert.equal(active.documentBoundaries[0]?.url, "https://page-1.example.test/next");
      assert.ok(active.observedMonotonicNanos >= initial.observedMonotonicNanos);
      assert.deepEqual(f.counts(), { starts: 1, stops: 0 });
      assert.equal(f.parent.owner.state.actions, 0);
      assert.equal(initial.documentBoundaries.length, 0);

      // JavaScript consumers cannot change the owner's facts through a returned record.
      const boundary = active.documentBoundaries[0];

      assert.ok(boundary);
      Reflect.set(boundary, "url", "https://forged.example/");
      assert.equal(
        (yield* interval.snapshot).documentBoundaries[0]?.url,
        "https://page-1.example.test/next",
      );
      yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);
      const final = yield* interval.completed;
      const stopped = yield* interval.snapshot;

      assert.deepEqual(
        frames.map((frame) => frame.sequence),
        [1, 2],
      );
      assert.equal(stopped.phase, "stopped");
      assert.equal(stopped.nativeStop, "confirmed");
      assert.equal(stopped.reason, final.reason);
      assert.equal(stopped.delivered, final.delivered);
      assert.equal(stopped.discarded, final.discarded);
      assert.deepEqual(stopped.documentBoundaries, final.documentBoundaries);
    })),
  test("metadata reads report pending cleanup without waiting and retain truncation", () =>
    Effect.gen(function* () {
      const entered = gate<void>();
      const release = gate<void>();

      const f = yield* makeFixture({
        stop: async () => {
          entered.resolve();
          await release.promise;
        },
      });

      const interval = yield* startCapture(f.parent, { ...options, lifetime: "page" });

      f.navigate(`https://page-1.example.test/${"a".repeat(8192)}`);
      for (let i = 0; i < 64; i++) f.navigate();
      const running = yield* interval.snapshot;

      assert.equal(running.currentDocument, 65);
      assert.equal(running.documentBoundaries.length, 64);
      assert.equal(running.documentBoundaries[0]?.url, null);
      assert.equal(running.documentBoundariesTruncated, true);
      const stopping = yield* interval.stop.pipe(Effect.forkChild);

      yield* Effect.promise(() => entered.promise);
      const pending = yield* interval.snapshot;

      assert.equal(pending.phase, "stopping");
      assert.equal(pending.nativeStop, null);
      assert.equal(pending.reason, "stopped");
      assert.deepEqual(pending.documentBoundaries, running.documentBoundaries);
      release.resolve();
      yield* Fiber.join(stopping);
      assert.equal((yield* interval.snapshot).nativeStop, "confirmed");
    })),
  test("mutating returned failure metadata cannot change the capture's terminal failure", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.navigate();
      const observed = yield* interval.snapshot;

      assert.ok(observed.error);
      assert.equal(observed.error.reason._tag, "TargetChanged");
      Reflect.set(observed.error.reason, "_tag", "Denied");
      Reflect.set(observed.error, "operation", "fill");
      Reflect.set(observed.error.reason, "status", 401);
      const next = yield* interval.snapshot;

      assert.equal(next.error?.reason._tag, "TargetChanged");
      assert.equal(next.error?.operation, "capture");
      assert.equal(
        next.error === undefined ? undefined : Reflect.get(next.error.reason, "status"),
        undefined,
      );
      yield* expectReason(Stream.runDrain(interval.frames), "TargetChanged");
      const final = yield* interval.completed;

      assert.ok(final.error);
      Reflect.set(final.error.reason, "_tag", "Configuration");
      assert.equal((yield* interval.completed).error?.reason._tag, "TargetChanged");
      assert.equal((yield* interval.snapshot).error?.reason._tag, "TargetChanged");
    })),
  test("an interval that lasts one document still ends when its page navigates", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.navigate();
      f.emit(1010);
      yield* expectReason(Stream.runDrain(interval.frames), "TargetChanged");
      const summary = yield* interval.completed;

      assert.equal(summary.received, 1);
      assert.deepEqual(summary.documentBoundaries, []);
      // It filmed one document, and still says which.
      assert.equal(summary.initialUrl, "https://page-1.example.test/");
    })),
  test("boundary records are bounded, and frames keep counting documents past the bound", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, { ...options, lifetime: "page" });

      for (let i = 0; i < 70; i++) f.navigate();
      f.emit(1000);
      const summary = yield* interval.stop;
      const frames = yield* Stream.runCollect(interval.frames);

      assert.equal(summary.documentBoundaries.length, 64);
      assert.equal(summary.documentBoundariesTruncated, true);
      assert.equal(frames[0]?.document, 70);
      // Before any frame arrived there is no sequence to point at.
      assert.equal(summary.documentBoundaries[0]?.afterSequence, null);
    })),
  test("actual JPEG geometry changes terminate an interval even at unchanged CSS dimensions", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(1010, widerJpeg());
      yield* expectReason(Stream.runDrain(interval.frames), "Resized");
      assert.equal((yield* interval.completed).received, 2);
    })),
  test("CSS viewport changes segment capture even when image dimensions are unchanged", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture();
      const interval = yield* startCapture(f.parent, options);

      f.emit(1000);
      f.emit(1010, jpeg(), 100, 48);
      yield* expectReason(Stream.runDrain(interval.frames), "Resized");
    })),
  test("a malformed or oversized frame is rejected before retention", () =>
    Effect.gen(function* () {
      for (const [data, reason] of [
        [new Uint8Array([1, 2, 3]), "Malformed"],
        [new Uint8Array(9000), "Limit"],
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

      yield* expectReason(startCapture(f.parent, { ...options, target }), "Busy");
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
        "Limit",
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
        "Limit",
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
      yield* expectReason(startCapture(f.parent, options), "Busy");
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
      yield* expectReason(startCapture(f.parent, options), "Busy");
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
      yield* expectReason(Stream.runDrain(interval.frames), "Busy");
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
          start: async ({ receive: callback }) => {
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
      yield* expectReason(Stream.runDrain(interval.frames), "TargetChanged");
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
      yield* expectReason(Stream.runDrain(interval.frames), "TargetChanged");
    })),
  test("failed native start runs cleanup and leaves no active capture lease", () =>
    Effect.gen(function* () {
      const f = yield* makeFixture({ startFailure: true });

      yield* expectReason(startCapture(f.parent, options), "Provider");
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
          yield* expectReason(startCapture(f.parent, { ...options, size }), "Configuration");
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
      yield* expectReason(Stream.runDrain(oversized.frames), "Limit");
      const summary = yield* oversized.completed;

      assert.equal(summary.received, 1);
      assert.equal(summary.delivered, 0);
      assert.equal(summary.discarded, 1);
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
      yield* expectReason(Stream.runDrain(interval.frames), "Limit");
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
