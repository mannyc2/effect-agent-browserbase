import { expect, it } from "@effect/vitest";

import { CaptureTimingTrace, observeCaptureFrames } from "./fixtures/CaptureTiming.ts";

const frame = (timestamp: number) => ({ timestamp, viewportWidth: 640, viewportHeight: 480 });

it("captures the first backward pair in callback order without changing source time", () => {
  const trace = new CaptureTimingTrace();

  expect(trace.record(frame(100), 10n)).toBeUndefined();
  expect(trace.record(frame(110), 20n)).toBeUndefined();
  const event = trace.record(frame(105), 30n);

  expect(event?.previous.sourceTimeMillis).toBe(110);
  expect(event?.current.sourceTimeMillis).toBe(105);
  expect(event?.current.sequence).toBe(2);
  expect(event?.current.receivedMonotonicNanos).toBe("30");
  expect(event?.history.map((point) => point.sourceTimeMillis)).toEqual([100, 110, 105]);
  expect(trace.record(frame(90), 40n)).toBeUndefined();
  expect(trace.snapshot().first).toBe(event);
});

it("keeps bounded recent history and the original failure after continued delivery", () => {
  const trace = new CaptureTimingTrace();

  trace.record(frame(10), 1n);
  const first = trace.record(frame(9), 2n);

  for (let i = 0; i < 10000; i++) trace.record(frame(20 + i), BigInt(i + 3));
  expect(trace.snapshot().received).toBe(10002);
  expect(trace.snapshot().recent).toHaveLength(CaptureTimingTrace.capacity);
  expect(trace.snapshot().first).toBe(first);
  expect(first?.history.map((point) => point.sourceTimeMillis)).toEqual([10, 9]);
});

it("observes equal source timestamps without calling them backward or removing callbacks", () => {
  const seen: number[] = [];
  const reports: unknown[] = [];

  const receive = observeCaptureFrames(
    (value: ReturnType<typeof frame>) => seen.push(value.timestamp),
    (event) => reports.push(event),
    () => 1n,
  );

  receive(frame(10));
  receive(frame(10));
  receive(frame(11));
  expect(seen).toEqual([10, 10, 11]);
  expect(reports).toEqual([]);
});

it("forwards the original frame exactly once and returns the original Promise", () => {
  const value = { ...frame(1), data: new Uint8Array([1, 2]), privateUrl: "PRIVATE-FIXTURE" };
  const promise = Promise.resolve();
  let calls = 0;

  const receive = observeCaptureFrames(
    (input: typeof value) => {
      calls++;
      expect(input).toBe(value);

      return promise;
    },
    () => {},
    () => 1n,
  );

  expect(receive(value)).toBe(promise);
  expect(calls).toBe(1);
});

it("does not swallow or replace a native callback failure", () => {
  const failure = new Error("native callback failure");

  const receive = observeCaptureFrames(
    () => {
      throw failure;
    },
    () => {},
    () => 1n,
  );

  expect(() => receive(frame(1))).toThrow(failure);
});

it("does not interrupt native delivery when the diagnostic sink fails", () => {
  const seen: number[] = [];

  const receive = observeCaptureFrames(
    (value: ReturnType<typeof frame>) => seen.push(value.timestamp),
    () => {
      throw new Error("sink failure");
    },
    () => 1n,
  );

  receive(frame(2));
  receive(frame(1));
  expect(seen).toEqual([2, 1]);
});

it("does not include bytes, URLs or arbitrary native fields in diagnostic evidence", () => {
  const trace = new CaptureTimingTrace();

  const value = {
    ...frame(2),
    data: new Uint8Array([1]),
    url: "PRIVATE-FIXTURE",
    token: "PRIVATE-TOKEN",
  };

  trace.record(value, 1n);
  trace.record({ ...value, timestamp: 1 }, 2n);
  const encoded = JSON.stringify(trace.snapshot());

  expect(encoded).not.toContain("PRIVATE");
  expect(encoded).not.toContain('"data"');
  expect(encoded).not.toContain('"url"');
  expect(encoded).not.toContain('"token"');
});

it("preserves a rejected native Promise without handling or replacing it", async () => {
  const failure = new Error("asynchronous native callback failure");
  const promise = Promise.reject(failure);

  const receive = observeCaptureFrames(
    () => promise,
    () => {},
    () => 1n,
  );

  const result = receive(frame(1));

  expect(result).toBe(promise);
  await expect(result).rejects.toBe(failure);
});

it("still calls the native consumer when diagnostic clock sampling fails", () => {
  let calls = 0;

  const receive = observeCaptureFrames(
    () => ++calls,
    () => {},
    () => {
      throw new Error("diagnostic clock unavailable");
    },
  );

  expect(receive(frame(1))).toBe(1);
  expect(calls).toBe(1);
});
