import { expect, it } from "@effect/vitest";
import { Effect, Schema, type Scope, Stream } from "effect";
import { type PageInfo, Target } from "effect-browser/browser-data";
import * as Capture from "effect-browser/capture";
import type { BrowserError } from "effect-browser/errors";

import type { CaptureParent } from "../src/internal/browser/Association.ts";
import type { NativeFrame } from "../src/internal/browser/Driver.ts";
import { makeOwner } from "../src/internal/browser/Owner.ts";
import { startCapture } from "../src/internal/capture/Capture.ts";
import { jpeg } from "./fixtures/Jpeg.ts";

type Same<A, B> =
  (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
type Requirements<T> = T extends Effect.Effect<infer _A, infer _E, infer R> ? R : never;

interface PreviousFrame {
  readonly bytes: Uint8Array;
  readonly mediaType: "image/jpeg";
  readonly target: Target;
  readonly sequence: number;
  readonly document: number;
  readonly sourceTimeMillis: number;
  readonly sourceClock: "presentation-unix-millis";
  readonly receivedMonotonicNanos: bigint;
  readonly width: number;
  readonly height: number;
  readonly viewportWidth: number;
  readonly viewportHeight: number;
}

interface PreviousOptions {
  readonly target?: PageInfo;
  readonly maxFrames?: number;
  readonly maxBufferedBytes?: number;
  readonly maxFrameBytes?: number;
  readonly maxDurationMillis?: number;
  readonly quality?: number;
  readonly size?: { readonly width: number; readonly height: number };
  readonly lifetime?: "document" | "page";
}

const frameShape: Same<Capture.CapturedFrame, PreviousFrame> = true;
const optionsShape: Same<Capture.CaptureOptions, PreviousOptions> = true;
const error: Same<Effect.Error<ReturnType<typeof Capture.start>>, BrowserError> = true;
const scope: Same<Requirements<ReturnType<typeof Capture.start>>, Scope.Scope> = true;
const decoderEnvironment: Same<typeof Capture.CapturedFrame.DecodingServices, never> = true;

const frame: Capture.CapturedFrame = {
  bytes: jpeg(),
  mediaType: "image/jpeg",
  target: Target.make({ generation: 0, pageId: "page-1", frameId: "frame-1" }),
  sequence: 0,
  document: 0,
  sourceTimeMillis: 1700000000123.25,
  sourceClock: "presentation-unix-millis",
  receivedMonotonicNanos: 123456789n,
  width: 64,
  height: 48,
  viewportWidth: 800,
  viewportHeight: 600,
};

it("adds data schemas without changing structural public shapes or capture E/R", () => {
  expect(frameShape && optionsShape && error && scope && decoderEnvironment).toBe(true);
  const encoded = Schema.encodeSync(Capture.CapturedFrame)(frame);
  const decoded = Schema.decodeSync(Capture.CapturedFrame)(encoded);

  expect(decoded).toEqual(frame);
  expect(Object.getPrototypeOf(decoded)).toBe(Object.prototype);
  expect(decoded.bytes).toBe(frame.bytes);
  expect(decoded.sourceTimeMillis).toBe(1700000000123.25);
  expect(decoded.receivedMonotonicNanos).toBe(123456789n);
});

it("rejects malformed frame fields and impossible geometry without repairing them", () => {
  const invalid: ReadonlyArray<unknown> = [
    { ...frame, bytes: Array.from(frame.bytes) },
    { ...frame, bytes: new Uint8Array(3) },
    { ...frame, mediaType: "image/png" },
    { ...frame, sourceClock: "monotonic" },
    { ...frame, sourceTimeMillis: Number.NaN },
    { ...frame, sourceTimeMillis: 0 },
    { ...frame, receivedMonotonicNanos: 123456789 },
    { ...frame, sequence: -1 },
    { ...frame, sequence: 0.5 },
    { ...frame, width: 0 },
    { ...frame, height: 16385 },
    { ...frame, viewportWidth: 1.5 },
    { ...frame, width: 16384, height: 16384 },
  ];

  for (const value of invalid) expect(Schema.is(Capture.CapturedFrame)(value)).toBe(false);
  // Field validation cannot establish JPEG bitstream validity, target authority, or a clock epoch.
  expect(Schema.is(Capture.CapturedFrame)({ ...frame, bytes: new Uint8Array(4) })).toBe(true);
  expect(Schema.is(Capture.CapturedFrame)({ ...frame, receivedMonotonicNanos: -1n })).toBe(true);
});

it("validates optional limits against resolved defaults without materializing defaults", () => {
  expect(Schema.decodeSync(Capture.CaptureOptions)({})).toEqual({});
  expect(Schema.decodeSync(Capture.CaptureOptions)({ quality: 1 })).toEqual({ quality: 1 });
  expect(Schema.is(Capture.CaptureOptions)({ maxBufferedBytes: 1, maxFrameBytes: 1 })).toBe(true);
  expect(Schema.is(Capture.CaptureOptions)({ maxBufferedBytes: 1 })).toBe(false);
  expect(Schema.is(Capture.CaptureOptions)({ maxFrameBytes: 32 * 1024 * 1024 })).toBe(false);
  expect(
    Schema.is(Capture.CaptureOptions)({
      maxFrames: 1024,
      maxBufferedBytes: 64 * 1024 * 1024,
      maxFrameBytes: 64 * 1024 * 1024,
      maxDurationMillis: 21_600_000,
      quality: 100,
      size: { width: 16384, height: 16384 },
    }),
  ).toBe(true);
});

it("rejects invalid numeric controls and keeps the documented upper bounds", () => {
  for (const value of [0, -1, 0.5, Number.NaN, Number.POSITIVE_INFINITY]) {
    for (const key of [
      "maxFrames",
      "maxBufferedBytes",
      "maxFrameBytes",
      "maxDurationMillis",
      "quality",
    ]) {
      expect(Schema.is(Capture.CaptureOptions)({ [key]: value })).toBe(false);
    }
  }
  for (const value of [
    { maxFrames: 1025 },
    { maxBufferedBytes: 64 * 1024 * 1024 + 1 },
    { maxFrameBytes: 64 * 1024 * 1024 + 1 },
    { maxDurationMillis: 21_600_001 },
    { quality: 101 },
    { size: { width: 16385, height: 1 } },
  ])
    expect(Schema.is(Capture.CaptureOptions)(value)).toBe(false);
});

it.effect("rejects invalid admission before resolving a native target or reserving capacity", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* makeOwner({
        maxActions: 1,
        maxHostReads: 10_000,
        maxElapsedMillis: 1000,
        actionTimeoutMillis: 500,
      });

      owner.state.phase = "open";
      let resolutions = 0;

      const parent: CaptureParent = {
        owner,
        target: () => frame.target,
        resolve: () => {
          resolutions++;

          return Effect.die("invalid limits must not resolve a target");
        },
        captureLeases: new Map(),
        captureReservedBytes: 0,
      };

      for (const options of [
        { maxFrames: 0 },
        { maxFrames: 1025 },
        { maxBufferedBytes: 1 },
        { maxBufferedBytes: 64 * 1024 * 1024 + 1 },
        { maxFrameBytes: Number.NaN },
        { maxFrameBytes: 32 * 1024 * 1024 },
        { maxDurationMillis: 21_600_001 },
        { quality: 101 },
      ]) {
        const result = yield* startCapture(parent, options).pipe(Effect.result);

        expect(result._tag).toBe("Failure");
        if (result._tag === "Failure") {
          expect(result.failure.reason._tag).toBe("Configuration");
          expect(result.failure.outcome).toBe("undispatched");
        }
      }
      expect(resolutions).toBe(0);
      expect(parent.captureLeases.size).toBe(0);
      expect(parent.captureReservedBytes).toBe(0);
      expect(owner.state.phase).toBe("open");
      expect(owner.state.actions).toBe(0);
    }),
  ),
);

it.effect("returned target metadata cannot mutate the capture generation guard", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const owner = yield* makeOwner({
        maxActions: 3,
        maxHostReads: 10_000,
        maxElapsedMillis: 1000,
        actionTimeoutMillis: 500,
      });

      owner.state.phase = "open";
      let receive: ((frame: NativeFrame) => void) | undefined;
      let stops = 0;
      const target = Target.make({ generation: 0, pageId: "page-1", frameId: "frame-1" });

      const parent: CaptureParent = {
        owner,
        target: () => target,
        resolve: () =>
          Effect.succeed({
            key: "native-page-1",
            target,
            source: {
              start: async ({ receive: callback }) => {
                receive = callback;
              },
              stop: async () => {
                stops++;
              },
            },
          }),
        captureLeases: new Map(),
        captureReservedBytes: 0,
      };

      const interval = yield* startCapture(parent);
      const seen: number[] = [];

      const emit = (timestamp: number) => {
        if (receive === undefined) throw new Error("capture callback was not installed");
        receive({ data: jpeg(), timestamp, viewportWidth: 64, viewportHeight: 48 });
      };

      emit(1000);
      yield* Stream.runForEach(interval.frames, (value) =>
        Effect.gen(function* () {
          seen.push(value.sequence);
          expect(Object.isFrozen(value.target)).toBe(true);
          if (value.sequence === 0) {
            expect(Reflect.set(value.target, "generation", 1)).toBe(false);
            expect(Reflect.set(value.target, "pageId", "other-page")).toBe(false);
            emit(1001);
          } else yield* interval.stop;
        }),
      );
      const summary = yield* interval.completed;

      expect(seen).toEqual([0, 1]);
      expect(summary.target).toEqual(target);
      expect(summary.target.generation).toBe(owner.state.generation);
      expect(summary.reason).toBe("stopped");
      expect(summary.nativeStop).toBe("confirmed");
      expect(stops).toBe(1);
      expect(parent.captureReservedBytes).toBe(0);
      expect(owner.state.phase).toBe("open");
    }),
  ),
);

it.effect(
  "capture snapshots and drained summaries partition overflow, duplicates, late and rejected frames",
  () =>
    Effect.scoped(
      Effect.gen(function* () {
        const owner = yield* makeOwner({
          maxActions: 3,
          maxHostReads: 10_000,
          maxElapsedMillis: 1000,
          actionTimeoutMillis: 500,
        });

        owner.state.phase = "open";
        const bytes = jpeg();
        let receive: ((frame: NativeFrame) => void) | undefined;
        let stops = 0;
        const target = Target.make({ generation: 0, pageId: "page-1", frameId: "frame-1" });

        const parent: CaptureParent = {
          owner,
          target: () => target,
          resolve: () =>
            Effect.succeed({
              key: "capture-accounting",
              target,
              source: {
                start: async ({ receive: callback }) => {
                  receive = callback;
                },
                stop: async () => {
                  stops++;
                },
              },
            }),
          captureLeases: new Map(),
          captureReservedBytes: 0,
        };

        const interval = yield* startCapture(parent, {
          maxFrames: 2,
          maxBufferedBytes: bytes.length * 2,
          maxFrameBytes: bytes.length,
        });

        const emit = (timestamp: number, data = bytes) => {
          if (receive === undefined) throw new Error("capture callback was not installed");
          receive({ data, timestamp, viewportWidth: 64, viewportHeight: 48 });
        };

        emit(1000);
        emit(1001);
        emit(1002); // The two-frame buffer evicts sequence 0.
        emit(1002); // Duplicate source timestamp, sequence 3.
        emit(1001.5); // Arrives behind the accepted timestamp, sequence 4.
        const live = yield* interval.snapshot;

        expect(live).toMatchObject({
          phase: "capturing",
          reason: null,
          nativeStop: null,
          received: 5,
          delivered: 0,
          discarded: 3,
          overflow: 1,
          duplicates: 1,
          late: 1,
          rejected: 0,
          bufferedFrames: 2,
          upstreamDrops: "unknown",
        });
        const encodedSnapshot = yield* Schema.encodeEffect(Capture.CaptureSnapshot)(live);

        expect(yield* Schema.decodeEffect(Capture.CaptureSnapshot)(encodedSnapshot)).toEqual(live);

        emit(1003, new Uint8Array(bytes.length + 1)); // A frame-size refusal, not buffer overflow.
        const seen: number[] = [];

        const failure = yield* interval.frames.pipe(
          Stream.runForEach((frame) =>
            Effect.sync(() => {
              seen.push(frame.sequence);
            }),
          ),
          Effect.flip,
        );

        expect(failure).toMatchObject({
          _tag: "BrowserError",
          operation: "capture",
          reason: {
            _tag: "Limit",
            dimension: "frame-bytes",
            maximum: bytes.length,
            observed: bytes.length + 1,
          },
          outcome: "undispatched",
        });
        const summary = yield* interval.completed;
        const stopped = yield* interval.snapshot;

        expect(seen).toEqual([1, 2]);
        for (const recorded of [summary, stopped]) {
          expect(recorded).toMatchObject({
            reason: "frame-limit",
            nativeStop: "confirmed",
            received: 6,
            delivered: 2,
            discarded: 4,
            overflow: 1,
            duplicates: 1,
            late: 1,
            rejected: 1,
            bufferedFrames: 0,
            bufferedBytes: 0,
            sourceFirstMillis: 1000,
            sourceLastMillis: 1002,
            upstreamDrops: "unknown",
            error: failure,
          });
          expect(recorded.discarded).toBe(
            recorded.overflow + recorded.duplicates + recorded.late + recorded.rejected,
          );
          expect("dropped" in recorded).toBe(false);
        }
        const encodedSummary = yield* Schema.encodeEffect(Capture.CaptureSummary)(summary);

        expect(yield* Schema.decodeEffect(Capture.CaptureSummary)(encodedSummary)).toEqual(summary);
        for (const field of ["discarded", "overflow", "rejected"] as const) {
          expect(Schema.is(Capture.CaptureSummary)({ ...summary, [field]: undefined })).toBe(false);
          expect(Schema.is(Capture.CaptureSnapshot)({ ...live, [field]: undefined })).toBe(false);
        }
        expect(stopped.phase).toBe("stopped");
        expect(live.discarded).toBe(3);
        expect(live.rejected).toBe(0);
        expect(stops).toBe(1);
        expect(parent.captureReservedBytes).toBe(0);
        expect(owner.state.phase).toBe("open");
      }),
    ),
);
