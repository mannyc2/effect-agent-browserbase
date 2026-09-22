import { expect, it } from "@effect/vitest";

import { nativeSelection, waitEvent } from "../src/internal/browser/Actions.ts";
import { makeKeyboard } from "../src/internal/browser/Keyboard.ts";
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
      // A native step names no operation; the owner stamps the one the caller asked for.
      expect.objectContaining({
        _tag: "NativeFailure",
        reason: { _tag: "Configuration" },
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
    await expect(wait.promise).rejects.toMatchObject({
      _tag: "NativeFailure",
      reason: { _tag: "Interrupted" },
    });
    expect(source.listeners.size).toBe(0);
  }
});

it("an event wait is bounded by the ticket's remaining time", async () => {
  const source = emitter<number>();
  const wait = waitEvent(source.add, source.remove, ticketFor(new AbortController().signal, 1));

  await expect(wait.promise).rejects.toMatchObject({
    _tag: "NativeFailure",
    reason: { _tag: "Timeout" },
  });
  expect(source.listeners.size).toBe(0);
});

it("a fence between characters stops the rest of a run of text", async () => {
  const sent: Array<string> = [];
  let fenceAfter = 2;
  let fenced = false;

  const page = {
    keyboard: {
      press: async () => {},
      type: async (character: string) => {
        sent.push(character);
        // The owner is fenced while this character is on its way.
        if (sent.length === fenceAfter) fenced = true;
      },
    },
  };

  const ticket: Ticket = {
    ...ticketFor(new AbortController().signal),
    check: () => {
      if (fenced) throw new Error("fenced");
    },
  };

  const keyboard = makeKeyboard(
    { current: () => ({ entry: { page } }) } as never,
    {} as never,
    () => ({ position: null }),
  );

  await expect(keyboard.type("abcd", undefined, ticket)).rejects.toBeDefined();
  // Characters are whole code points, and none follows the fence.
  expect(sent).toEqual(["a", "b"]);

  fenced = false;
  fenceAfter = Number.POSITIVE_INFINITY;
  sent.length = 0;
  await keyboard.type("a🚆", undefined, ticket);
  expect(sent).toEqual(["a", "🚆"]);
});
