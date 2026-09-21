import { expect, it } from "@effect/vitest";

import { captureLifecycle, type CaptureLifecycleEvidence } from "./fixtures/CaptureLifecycle.ts";
import { CaptureTimingTrace } from "./fixtures/CaptureTiming.ts";

const frame = (timestamp: number) => ({ timestamp, viewportWidth: 640, viewportHeight: 480 });

it("retains a zero-callback attempt and distinguishes start, acknowledgement and stop clocks", () => {
  const events: CaptureLifecycleEvidence[] = [];
  let clock = 10n;

  const attempt = captureLifecycle(
    () => {},
    () => {},
    (e) => events.push(e),
    () => clock++,
  );

  attempt.acknowledged();
  attempt.finish("stop-confirmed");
  expect(events).toEqual([
    {
      end: "stop-confirmed",
      startedMonotonicNanos: "10",
      acknowledgedMonotonicNanos: "11",
      completedMonotonicNanos: "12",
      received: 0,
      firstReceived: null,
      lastReceived: null,
    },
  ]);
});

it("retains a frame delivered before acknowledgement and emits only the first completion", () => {
  const events: CaptureLifecycleEvidence[] = [];
  let clock = 0n;

  const attempt = captureLifecycle(
    () => {},
    () => {},
    (e) => events.push(e),
    () => clock++,
  );

  attempt.receive(frame(42));
  attempt.acknowledged();
  attempt.finish("page-closed");
  attempt.finish("stop-failed");
  attempt.acknowledged();
  expect(events).toHaveLength(1);
  expect(events[0]?.end).toBe("page-closed");
  expect(events[0]?.received).toBe(1);
  expect(events[0]?.firstReceived).toEqual(events[0]?.lastReceived);
  expect(events[0]?.firstReceived?.receivedMonotonicNanos).toBe("1");
  expect(events[0]?.acknowledgedMonotonicNanos).toBe("2");
});

it("preserves original native callback Promise identity and rejection", async () => {
  const failure = new Error("native failure");
  const promise = Promise.reject(failure);
  const original = frame(1);
  let count = 0;

  const attempt = captureLifecycle(
    (value: typeof original) => {
      count++;
      expect(value).toBe(original);

      return promise;
    },
    () => {},
    () => {},
    () => 1n,
  );

  expect(attempt.receive(original)).toBe(promise);
  await expect(promise).rejects.toBe(failure);
  expect(count).toBe(1);
});

it("retains first and last receipts without growing recent-frame history", () => {
  const trace = new CaptureTimingTrace();

  for (let i = 0; i < 10000; i++) trace.record(frame(i), BigInt(i + 5));
  const snapshot = trace.snapshot();

  expect(snapshot.received).toBe(10000);
  expect(snapshot.firstReceived?.receivedMonotonicNanos).toBe("5");
  expect(snapshot.lastReceived?.receivedMonotonicNanos).toBe("10004");
  expect(snapshot.recent).toHaveLength(CaptureTimingTrace.capacity);
});

it("counts repeated source timestamps without dropping them or claiming discontinuity", () => {
  const events: CaptureLifecycleEvidence[] = [];
  const seen: number[] = [];

  const attempt = captureLifecycle(
    (value: ReturnType<typeof frame>) => seen.push(value.timestamp),
    () => {
      throw new Error("not backward");
    },
    (e) => events.push(e),
    () => 1n,
  );

  attempt.receive(frame(5));
  attempt.receive(frame(5));
  attempt.finish("stop-confirmed");
  expect(seen).toEqual([5, 5]);
  expect(events[0]?.received).toBe(2);
  expect(events[0]?.firstReceived?.sourceTimeMillis).toBe(5);
  expect(events[0]?.lastReceived?.sourceTimeMillis).toBe(5);
});

it("clock and reporting failures cannot suppress a callback or replace its failure", () => {
  const failure = new Error("native callback");

  const attempt = captureLifecycle(
    () => {
      throw failure;
    },
    () => {
      throw new Error("sink");
    },
    () => {
      throw new Error("sink");
    },
    () => {
      throw new Error("clock");
    },
  );

  expect(() => attempt.receive(frame(1))).toThrow(failure);
  expect(() => attempt.acknowledged()).not.toThrow();
  expect(() => attempt.finish("stop-failed")).not.toThrow();
});

it("reports failed starts and missing acknowledgement without inventing a native stop", () => {
  const events: CaptureLifecycleEvidence[] = [];

  const attempt = captureLifecycle(
    () => {},
    () => {},
    (e) => events.push(e),
    () => 1n,
  );

  attempt.finish("start-failed");
  expect(events[0]?.end).toBe("start-failed");
  expect(events[0]?.acknowledgedMonotonicNanos).toBeNull();
  expect(events[0]?.received).toBe(0);
});

it("lifecycle receipts exclude native bytes and arbitrary page or vendor fields", () => {
  const events: CaptureLifecycleEvidence[] = [];

  const attempt = captureLifecycle(
    () => {},
    () => {},
    (e) => events.push(e),
    () => 1n,
  );

  const value = {
    ...frame(1),
    data: new Uint8Array([1]),
    url: "PRIVATE-URL",
    token: "PRIVATE-TOKEN",
  };

  attempt.receive(value);
  attempt.finish("disconnected");
  const encoded = JSON.stringify(events);

  expect(encoded).not.toContain("PRIVATE");
  expect(encoded).not.toContain('"data"');
  expect(encoded).not.toContain('"url"');
});
