import { expect, it } from "@effect/vitest";

import { nativeSelection, waitEvent } from "../src/internal/browser/Actions.ts";
import type { Ticket } from "../src/internal/browser/Owner.ts";

const ticketFor = (signal: AbortSignal, remaining = 1000): Ticket => ({
  signal,
  deadline: 10000,
  generation: 1,
  dispatched: false,
  remainingMillis: () => remaining,
  check: () => {},
  dispatch: () => {},
});

const emitter = <A>() => {
  const listeners = new Set<(value: A) => void>();

  return {
    listeners,
    add: (listener: (value: A) => void) => listeners.add(listener),
    remove: (listener: (value: A) => void) => listeners.delete(listener),
    emit: (value: A) => {
      for (const listener of listeners) listener(value);
    },
  };
};

it("a file selection is either held bytes or provider paths, never a mix or nothing", () => {
  const inline = {
    _tag: "Inline" as const,
    name: "a.txt",
    mediaType: "text/plain",
    bytes: new Uint8Array([104, 105]),
  };

  const remote = { _tag: "Remote" as const, path: "/provider/a.txt" };

  expect(nativeSelection([inline])).toEqual({
    _tag: "Inline",
    payload: [{ name: "a.txt", mimeType: "text/plain", buffer: Buffer.from([104, 105]) }],
  });
  expect(nativeSelection([remote, remote])).toEqual({
    _tag: "Remote",
    paths: ["/provider/a.txt", "/provider/a.txt"],
  });
  for (const files of [[], [inline, remote]])
    expect(() => nativeSelection(files)).toThrow(
      expect.objectContaining({
        operation: "select-files",
        reason: "configuration",
        outcome: "undispatched",
      }),
    );
});

it("an event wait settles once on an accepted value and releases its listener", async () => {
  const source = emitter<number>();
  const controller = new AbortController();

  const wait = waitEvent(
    source.add,
    source.remove,
    ticketFor(controller.signal),
    (value) => value > 1,
  );

  source.emit(1);
  source.emit(2);
  source.emit(3);
  await expect(wait.promise).resolves.toBe(2);
  expect(source.listeners.size).toBe(0);
  controller.abort();
  wait.cancel();
  await expect(wait.promise).resolves.toBe(2);
});

it("an event wait is interrupted by its ticket, even one already aborted", async () => {
  for (const early of [false, true]) {
    const source = emitter<number>();
    const controller = new AbortController();

    if (early) controller.abort();
    const wait = waitEvent(source.add, source.remove, ticketFor(controller.signal));

    controller.abort();
    source.emit(1);
    await expect(wait.promise).rejects.toMatchObject({ operation: "wait", reason: "interrupted" });
    expect(source.listeners.size).toBe(0);
  }
});

it("an event wait is bounded by the ticket's remaining time", async () => {
  const source = emitter<number>();
  const wait = waitEvent(source.add, source.remove, ticketFor(new AbortController().signal, 1));

  await expect(wait.promise).rejects.toMatchObject({ operation: "wait", reason: "timeout" });
  expect(source.listeners.size).toBe(0);
});
