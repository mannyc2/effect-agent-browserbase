import { expect, it } from "@effect/vitest";
import { BrowserError, Reasons } from "effect-browser/errors";

import type { Ticket } from "../src/internal/browser/Owner.ts";
import { PageExecution } from "../src/internal/browser/PageExecution.ts";

const hold = ["read", "zero-rate", "unfocus", "freeze"] as const;
const resume = ["activate-lifecycle", "activate-target", "focus", "frame", "restore-rate"] as const;

const fixture = () => {
  const calls: string[] = [];
  const failure = new Error("native phase failed");
  let reject: string | undefined;
  let abortAfter: string | undefined;
  let aborted = false;
  let dispatched = false;

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

  const step = async (name: string) => {
    calls.push(name);
    if (name === reject) throw failure;
    if (name === abortAfter) aborted = true;
  };

  const control = new PageExecution("stage", "stage-native", () => "suspension-1", {
    readRate: async () => {
      await step("read");

      return 0.5;
    },
    rate: (value) => step(value === 0 ? "zero-rate" : "restore-rate"),
    focus: (enabled) => step(enabled ? "focus" : "unfocus"),
    lifecycle: (state) => step(state === "frozen" ? "freeze" : "activate-lifecycle"),
    activate: () => step("activate-target"),
    frameBarrier: () => step("frame"),
    closed: () => false,
    detach: () => step("detach"),
  });

  return {
    control,
    ticket,
    calls,
    failure,
    reject: (name: string) => {
      reject = name;
    },
    abortAfter: (name: string) => {
      abortAfter = name;
    },
    resetAdmission: () => {
      calls.length = 0;
      dispatched = false;
    },
  };
};

for (const [index, phase] of hold.entries()) {
  it(`hold failure at ${phase} stops the exact command sequence without rollback`, async () => {
    const f = fixture();

    f.reject(phase);
    await expect(f.control.suspend(f.ticket)).rejects.toBe(f.failure);
    expect(f.calls).toEqual(hold.slice(0, index + 1));
    expect(f.ticket.dispatched).toBe(index !== 0);
    expect(f.control.state().state).toBe(index === 0 ? "running" : "unknown");
    expect(f.control.state().suspensionId).toBeUndefined();
  });
}

for (const [index, phase] of resume.entries()) {
  it(`resume failure at ${phase} consumes the receipt without replay or rollback`, async () => {
    const f = fixture();
    const receipt = await f.control.suspend(f.ticket);

    f.resetAdmission();
    f.reject(phase);
    await expect(f.control.resume(receipt, f.ticket)).rejects.toBe(f.failure);
    expect(f.calls).toEqual(resume.slice(0, index + 1));
    expect(f.ticket.dispatched).toBe(true);
    expect(f.control.state().state).toBe("unknown");
    expect(f.control.state().suspensionId).toBeUndefined();
    f.resetAdmission();
    await expect(f.control.resume(receipt, f.ticket)).rejects.toMatchObject({
      reason: { _tag: "Stale" },
      outcome: "undispatched",
    });
    expect(f.ticket.dispatched).toBe(false);
    expect(f.calls).toEqual([]);
  });
}

for (const [index, phase] of hold.entries()) {
  it(`cancellation after ${phase} cannot send a later hold command or publish a receipt`, async () => {
    const f = fixture();

    f.abortAfter(phase);
    await expect(f.control.suspend(f.ticket)).rejects.toMatchObject({
      reason: { _tag: "Stale" },
      outcome: index === 0 ? "undispatched" : "unknown",
    });
    expect(f.calls).toEqual(hold.slice(0, index + 1));
    expect(f.control.state().state).toBe(index === 0 ? "running" : "unknown");
    expect(f.control.state().suspensionId).toBeUndefined();
  });
}

for (const [index, phase] of resume.entries()) {
  it(`cancellation after ${phase} cannot dispatch the next resume phase`, async () => {
    const f = fixture();
    const receipt = await f.control.suspend(f.ticket);

    f.resetAdmission();
    f.abortAfter(phase);
    await expect(f.control.resume(receipt, f.ticket)).rejects.toMatchObject({
      reason: { _tag: "Stale" },
      outcome: "unknown",
    });
    expect(f.calls).toEqual(resume.slice(0, index + 1));
    expect(f.control.state().state).toBe("unknown");
    expect(f.control.state().suspensionId).toBeUndefined();
  });
}
