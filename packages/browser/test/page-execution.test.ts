import { expect, it } from "@effect/vitest";
import { PageSuspension } from "effect-browser/browser-data";
import { BrowserError, Reasons } from "effect-browser/errors";

import type { Ticket } from "../src/internal/browser/Owner.ts";
import { PageExecution, type PageExecutionNative } from "../src/internal/browser/PageExecution.ts";

const fixture = (overrides: Partial<PageExecutionNative> = {}) => {
  const calls: string[] = [];

  let serial = 0,
    dispatched = false,
    aborted = false;

  const ticket: Ticket = {
    signal: new AbortController().signal,
    deadline: 10000,
    generation: 1,
    get dispatched() {
      return dispatched;
    },
    remainingMillis: () => 1000,
    check: () => {
      if (aborted)
        throw BrowserError.make({
          operation: "page-control",
          reason: Reasons.Stale.make({}),
          outcome: dispatched ? "unknown" : "undispatched",
        });
    },
    dispatch: () => {
      dispatched = true;
    },
  };

  const port: PageExecutionNative = {
    readRate: async () => {
      calls.push("read");

      return 0.5;
    },
    rate: async (n) => {
      calls.push(`rate:${n}`);
    },
    focus: async (n) => {
      calls.push(`focus:${n}`);
    },
    lifecycle: async (n) => {
      calls.push(n);
    },
    activate: async () => {
      calls.push("activate");
    },
    frameBarrier: async () => {
      calls.push("frame");
    },
    closed: () => false,
    detach: async () => {
      calls.push("detach");
    },
    ...overrides,
  };

  return {
    calls,
    ticket,
    port,
    abort: () => {
      aborted = true;
    },
    control: new PageExecution("page-a", "target-a", () => `hold-${++serial}`, port),
  };
};

it("holds with an owned receipt and restores prior rate only after the actual frame barrier", async () => {
  const f = fixture(),
    receipt = await f.control.suspend(f.ticket);

  expect(f.calls).toEqual(["read", "rate:0", "focus:false", "frozen"]);
  expect(f.control.state().state).toBe("suspended");
  expect(Object.isFrozen(receipt)).toBe(true);
  expect(() => f.control.assertRunning()).toThrow();
  await f.control.resume(receipt, f.ticket);
  expect(f.calls.slice(4)).toEqual(["active", "activate", "focus:true", "frame", "rate:0.5"]);
  expect(f.control.state().state).toBe("running");
  expect(() => f.control.assertRunning()).not.toThrow();
});
it("duplicate suspend and stale or foreign receipts do not dispatch native work", async () => {
  const f = fixture(),
    receipt = await f.control.suspend(f.ticket),
    before = f.calls.slice();

  await expect(f.control.suspend(f.ticket)).rejects.toMatchObject({
    reason: { _tag: "Busy" },
    outcome: "undispatched",
  });
  await expect(
    f.control.resume(PageSuspension.make({ ...receipt, suspensionId: "foreign" }), f.ticket),
  ).rejects.toMatchObject({ reason: { _tag: "Stale" } });
  expect(f.calls).toEqual(before);
  await f.control.resume(receipt, f.ticket);
  const after = f.calls.slice();

  await expect(f.control.resume(receipt, f.ticket)).rejects.toMatchObject({
    reason: { _tag: "Stale" },
  });
  expect(f.calls).toEqual(after);
});
it("a partial hold failure stays unknown without rollback or a successful receipt", async () => {
  const failure = new Error("native failure"),
    f = fixture({
      focus: async () => {
        throw failure;
      },
    });

  await expect(f.control.suspend(f.ticket)).rejects.toBe(failure);
  expect(f.control.state()).toMatchObject({ state: "unknown" });
  expect(f.control.state().suspensionId).toBeUndefined();
  expect(f.calls).toEqual(["read", "rate:0"]);
  expect(() => f.control.assertRunning()).toThrow();
});
it("a failed resume barrier cannot restore playback or be replayed", async () => {
  const f = fixture({
      frameBarrier: async () => {
        throw new Error("barrier");
      },
    }),
    receipt = await f.control.suspend(f.ticket);

  await expect(f.control.resume(receipt, f.ticket)).rejects.toThrow("barrier");
  expect(f.control.state().state).toBe("unknown");
  expect(f.calls).not.toContain("rate:0.5");
  const before = f.calls.slice();

  await expect(f.control.resume(receipt, f.ticket)).rejects.toMatchObject({
    reason: { _tag: "Stale" },
  });
  expect(f.calls).toEqual(before);
});
it("invalid prior native rate fails before any mutation", async () => {
  const f = fixture({ readRate: async () => Number.NaN });

  await expect(f.control.suspend(f.ticket)).rejects.toMatchObject({
    reason: { _tag: "Malformed" },
  });
  expect(f.ticket.dispatched).toBe(false);
  expect(f.control.state().state).toBe("running");
  expect(f.calls).toEqual([]);
});
it("late completion after cancellation cannot send subsequent native commands", async () => {
  let release: (() => void) | undefined;

  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });

  const f = fixture({ rate: () => pending }),
    hold = f.control.suspend(f.ticket);

  await Promise.resolve();
  f.abort();
  release?.();
  await expect(hold).rejects.toMatchObject({ reason: { _tag: "Stale" } });
  expect(f.calls).toEqual(["read"]);
  expect(f.control.state().state).toBe("unknown");
});
it("external invalidation fences held receipts but running navigation stays runnable", async () => {
  const f = fixture();

  expect(f.control.invalidate()).toBe(false);
  expect(() => f.control.assertRunning()).not.toThrow();
  const receipt = await f.control.suspend(f.ticket);

  expect(f.control.invalidate()).toBe(true);
  expect(f.control.state().state).toBe("unknown");
  await expect(f.control.resume(receipt, f.ticket)).rejects.toMatchObject({
    reason: { _tag: "Stale" },
  });
});
it("cleanup detaches once without an implicit lifecycle resume or rate restoration", async () => {
  const f = fixture();

  await f.control.suspend(f.ticket);
  await f.control.dispose();
  await f.control.dispose();
  expect(f.calls).toEqual(["read", "rate:0", "focus:false", "frozen", "detach"]);
  expect(() => f.control.state()).toThrow();
});
