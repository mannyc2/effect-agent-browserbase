import { expect, it } from "@effect/vitest";

import type { Ticket } from "../src/internal/browser/Owner.ts";
import { PageExecution } from "../src/internal/browser/PageExecution.ts";

const fixture = () => {
  let dispatched = false;
  let closed = false;
  let afterRate: () => void = () => {};
  const calls: string[] = [];

  const ticket: Ticket = {
    signal: new AbortController().signal,
    deadline: 10000,
    generation: 1,
    get dispatched() {
      return dispatched;
    },
    remainingMillis: () => 1000,
    check: () => {},
    dispatch: () => {
      dispatched = true;
    },
  };

  const control = new PageExecution("page-a", "target-a", {
    readRate: async () => 1,
    rate: async () => {
      calls.push("rate");
      afterRate();
    },
    focus: async () => {
      calls.push("focus");
    },
    lifecycle: async () => {
      calls.push("lifecycle");
    },
    activate: async () => {
      calls.push("activate");
    },
    frameBarrier: async () => {
      calls.push("frame");
    },
    closed: () => closed,
    detach: async () => {},
  });

  return {
    control,
    ticket,
    calls,
    close: () => {
      closed = true;
    },
    afterRate: (f: () => void) => {
      afterRate = f;
    },
  };
};

it("page closure after a dispatched hold command cannot be reported as undispatched", async () => {
  const f = fixture();

  f.afterRate(f.close);
  await expect(f.control.suspend(f.ticket)).rejects.toMatchObject({
    reason: "closed",
    outcome: "unknown",
  });
  expect(f.ticket.dispatched).toBe(true);
  expect(f.calls).toEqual(["rate"]);
});

it("target invalidation after native dispatch stays unknown and stops the command sequence", async () => {
  const f = fixture();

  f.afterRate(() => {
    f.control.invalidate();
  });
  await expect(f.control.suspend(f.ticket)).rejects.toMatchObject({
    reason: "stale",
    outcome: "unknown",
  });
  expect(f.control.state().state).toBe("unknown");
  expect(f.control.state().suspensionId).toBeUndefined();
  expect(f.calls).toEqual(["rate"]);
});

it("a page already closed before admission remains accurately undispatched", async () => {
  const f = fixture();

  f.close();
  await expect(f.control.suspend(f.ticket)).rejects.toMatchObject({
    reason: "closed",
    outcome: "undispatched",
  });
  expect(f.ticket.dispatched).toBe(false);
  expect(f.calls).toEqual([]);
});
