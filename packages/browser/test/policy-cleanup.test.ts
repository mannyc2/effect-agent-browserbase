import { expect, it, vi } from "@effect/vitest";

import { CallbackTasks, type CallbackDisposition } from "../src/internal/browser/CallbackTasks.ts";
import type { DriverFault } from "../src/internal/browser/Driver.ts";
import { PolicyCleanup, type CleanupDisposition } from "../src/internal/browser/PolicyCleanup.ts";

const gate = () => {
  let resolve: () => void = () => {};
  let reject: (error: Error) => void = () => {};

  const promise = new Promise<void>((yes, no) => {
    resolve = yes;
    reject = no;
  });

  return { promise, resolve: () => resolve(), reject: (error: Error) => reject(error) };
};

const fixture = () => {
  const faults: Array<DriverFault> = [];
  const cleanup = new PolicyCleanup({ fault: (fault) => faults.push(fault) });

  return { cleanup, faults };
};

it("overflow cleanup shares the exact command and publishes confirmation only after native acknowledgement", async () => {
  const f = fixture();
  const ack = gate();
  const subject = {};
  const outcomes: Array<CleanupDisposition> = [];
  let calls = 0;

  const close = () => {
    calls++;

    return ack.promise;
  };

  const first = f.cleanup.run(subject, close, {
    overflow: "popup-overflow",
    settled: (disposition) => outcomes.push(disposition),
  });

  expect(f.cleanup.run(subject, close)).toBe(first);
  expect(f.faults).toMatchObject([
    { source: "policy", reason: "popup-overflow", disposition: "pending" },
  ]);
  await Promise.resolve();
  expect(calls).toBe(1);
  expect(outcomes).toEqual([]);
  expect(f.faults.map((fault) => fault.disposition)).toEqual(["pending", "dispatched"]);
  ack.resolve();
  expect(await first).toBe("confirmed");
  expect(outcomes).toEqual(["confirmed"]);
  expect(f.faults.map((fault) => fault.disposition)).toEqual([
    "pending",
    "dispatched",
    "confirmed",
  ]);
  const tokens = f.faults.flatMap((fault) => (fault.source === "policy" ? [fault.token] : []));

  expect(new Set(tokens).size).toBe(1);
  expect(await f.cleanup.run(subject, close)).toBe("confirmed");
  expect(calls).toBe(1);
  expect(await f.cleanup.run({}, async () => {})).toBe("confirmed");
  expect(f.faults).toHaveLength(3);
});

it("32 unresolved native cleanups keep their capacity after timeout and never resend uncertain commands", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  const ack = gate();
  const subjects = Array.from({ length: 100 }, () => ({}));
  const outcomes: Array<CleanupDisposition> = [];
  let calls = 0;

  const close = () => {
    calls++;

    return ack.promise;
  };

  try {
    const results = subjects.map((subject) =>
      f.cleanup.run(subject, close, {
        overflow: "popup-overflow",
        settled: (disposition) => outcomes.push(disposition),
      }),
    );

    await Promise.resolve();
    expect(calls).toBe(32);
    expect(outcomes).toEqual(Array.from({ length: 68 }, () => "not-dispatched"));

    const blocked = f.faults.filter(
      (fault) => fault.source === "policy" && fault.disposition === "not-dispatched",
    );

    expect(
      new Set(blocked.flatMap((fault) => (fault.source === "policy" ? [fault.token] : []))).size,
    ).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(await Promise.all(results)).toEqual([
      ...Array.from({ length: 32 }, () => "unknown"),
      ...Array.from({ length: 68 }, () => "not-dispatched"),
    ]);
    expect(await f.cleanup.run({}, close, { overflow: "dialog-overflow" })).toBe("not-dispatched");
    expect(calls).toBe(32);
    expect(f.cleanup.run(subjects[0]!, close)).toBe(results[0]);
    ack.resolve();
    await f.cleanup.settle();
    expect(f.faults.filter((fault) => fault.disposition === "confirmed")).toHaveLength(32);
    expect(outcomes).toHaveLength(100);
    expect(await results[0]).toBe("unknown");
    expect(
      await f.cleanup.run({}, async () => {
        calls++;
      }),
    ).toBe("confirmed");
    expect(calls).toBe(33);
  } finally {
    ack.resolve();
    await f.cleanup.settle();
    f.cleanup.retired();
    vi.useRealTimers();
  }
});

it("ordinary policy failures stay bounded and do not fabricate overflow diagnostics", async () => {
  const f = fixture();
  const subject = {};
  let calls = 0;

  const dismiss = async () => {
    calls++;
    throw new Error("PRIVATE-DIALOG-DETAIL");
  };

  expect(await f.cleanup.run(subject, dismiss)).toBe("unknown");
  expect(await f.cleanup.run(subject, dismiss)).toBe("unknown");
  expect(calls).toBe(1);
  expect(f.faults).toEqual([{ source: "native", reason: "callback", disposition: "unknown" }]);
});

it("predispatch refusal settles the captured dialog without sending it", async () => {
  const f = fixture();
  const outcomes: Array<CleanupDisposition> = [];
  let calls = 0;

  expect(
    await f.cleanup.run(
      {},
      async () => {
        calls++;
      },
      {
        overflow: "dialog-overflow",
        dispatch: () => {
          throw new Error("Retired ticket");
        },
        settled: (disposition) => outcomes.push(disposition),
      },
    ),
  ).toBe("not-dispatched");
  expect(calls).toBe(0);
  expect(outcomes).toEqual(["not-dispatched"]);
  expect(f.faults.map((fault) => fault.disposition)).toEqual(["pending", "not-dispatched"]);
});

it("stopping before deferred dispatch sends nothing and cannot later reopen cleanup admission", async () => {
  const f = fixture();
  let calls = 0;

  const close = async () => {
    calls++;
  };

  const result = f.cleanup.run({}, close, { overflow: "popup-overflow" });

  f.cleanup.stop();
  expect(await result).toBe("not-dispatched");
  expect(await f.cleanup.run({}, close)).toBe("not-dispatched");
  expect(calls).toBe(0);
  await f.cleanup.settle();
});

it("confirmed connection retirement resolves pending observers and ignores late native settlement", async () => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const f = fixture();
  const ack = gate();
  const outcomes: Array<CleanupDisposition> = [];
  const subject = {};
  let calls = 0;

  try {
    const result = f.cleanup.run(
      subject,
      () => {
        calls++;

        return ack.promise;
      },
      {
        overflow: "dialog-overflow",
        settled: (disposition) => outcomes.push(disposition),
      },
    );

    await Promise.resolve();
    expect(calls).toBe(1);
    f.cleanup.retired();
    expect(await result).toBe("unknown");
    expect(outcomes).toEqual(["unknown"]);
    expect(vi.getTimerCount()).toBe(0);
    ack.reject(new Error("Late private native rejection"));
    await Promise.resolve();
    await Promise.resolve();
    expect(f.faults.map((fault) => fault.disposition)).toEqual(["pending", "dispatched"]);
    expect(
      await f.cleanup.run(subject, async () => {
        calls++;
      }),
    ).toBe("unknown");
    expect(calls).toBe(1);
  } finally {
    f.cleanup.retired();
    vi.useRealTimers();
  }
});

it("callback pressure and a dispatched callback failure report different evidence", async () => {
  const dispositions: Array<CallbackDisposition> = [];
  const ack = gate();
  const callbacks = new CallbackTasks(1, (disposition) => dispositions.push(disposition));

  expect(callbacks.submit(() => ack.promise)).toBe(true);
  expect(callbacks.submit(async () => {})).toBe(false);
  ack.resolve();
  await callbacks.settle();
  expect(dispositions).toEqual(["not-dispatched"]);
  const failed = new CallbackTasks(1, (disposition) => dispositions.push(disposition));

  failed.submit(async () => {
    throw new Error("Private native failure");
  });
  await failed.settle();
  expect(dispositions).toEqual(["not-dispatched", "unknown"]);
});
