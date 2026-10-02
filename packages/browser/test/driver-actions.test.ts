import { EventEmitter } from "node:events";

import { expect, it } from "@effect/vitest";
import { Effect } from "effect";

import { nativeSelection, waitEvent } from "../src/internal/browser/Actions.ts";
import { makeKeyboard } from "../src/internal/browser/Keyboard.ts";
import type { Ticket } from "../src/internal/browser/Owner.ts";
import { prepare } from "../src/internal/browser/Performance.ts";
import { DefaultMotionProfile } from "../src/PlanData.ts";
import { gate } from "./fixtures/ScriptedOwner.ts";

type KeyInput = {
  readonly type?: string;
  readonly key?: string;
  readonly text?: string;
};

// https://github.com/mannyc2/effect-agent-browserbase/issues/94#issuecomment-5914182775
// The accepted typing slice names this seam. Held replies and setup retirement cannot be
// forced reliably through Chromium; native workflow tests own event trust, focus and key data.
const target = { pageId: "page-1", frameId: "frame-1" };

const scriptedKeyboard = (
  send: (method: string, input?: KeyInput) => Promise<unknown>,
  options: {
    readonly setup?: () => Promise<void>;
    readonly detach?: () => Promise<void>;
    /** The page keyboard that performed strokes drive, one reply per call. */
    readonly keys?: (command: "down" | "up" | "insertText", key: string) => Promise<void>;
  } = {},
) => {
  const keys = options.keys ?? (async () => {});

  const port = Object.assign(new EventEmitter(), {
    send,
    detach: options.detach ?? (async () => {}),
  });

  const page = {
    context: () => ({
      newCDPSession: async () => {
        await options.setup?.();

        return port;
      },
    }),
    keyboard: {
      press: async () => {},
      // Preserve the old engine's awaited down/up behavior, so a baseline failure is the
      // reply dependency itself rather than a fake that lacks the legacy keyboard API.
      type: async (character: string) => {
        if (character.length > 1) {
          await send("Input.insertText", { text: character });

          return;
        }
        await send("Input.dispatchKeyEvent", { type: "keyDown", key: character });
        await send("Input.dispatchKeyEvent", { type: "keyUp", key: character });
      },
      down: (key: string) => keys("down", key),
      up: (key: string) => keys("up", key),
      insertText: (text: string) => keys("insertText", text),
    },
  };

  return makeKeyboard({ current: () => ({ entry: { page } }) } as never, {} as never, () => ({
    position: null,
  }));
};

const nativeTurn = () =>
  new Promise<void>((resolve) => {
    setImmediate(resolve);
  });

const cancellableTicket = (controller: AbortController): Ticket => ({
  ...ticketFor(controller.signal),
  check: () => {
    if (controller.signal.aborted) throw new Error("fenced");
  },
});

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

it("plain typing submits ordered balanced input while earlier replies are held, within a finite window", async () => {
  const controller = new AbortController();
  const sent: KeyInput[] = [];
  const held: Array<ReturnType<typeof gate<void>>> = [];
  const text = "abcdefghijklmnopqrstuvwxyz0123456789";
  let maximumPending = 0;

  const keyboard = scriptedKeyboard((_method, input) => {
    const reply = gate<void>();

    sent.push(input ?? {});
    held.push(reply);
    maximumPending = Math.max(maximumPending, held.length);

    return reply.promise;
  });

  const result = keyboard
    .type(text, undefined, cancellableTicket(controller), undefined, target)
    .then(
      () => "completed",
      () => "failed",
    );

  try {
    await nativeTurn();
    // More than one full stroke must be submitted before the first reply. The documented
    // private work bound is 32 commands; its precise chunk size is not the expected result.
    expect(sent.length).toBeGreaterThan(2);
    expect(held.length).toBeLessThanOrEqual(32);
    expect(sent.at(-1)?.type).toBe("keyUp");
    for (let batch = 0; batch < text.length && held.length > 0; batch++) {
      for (const reply of held.splice(0)) reply.resolve();
      await nativeTurn();
      expect(held.length).toBeLessThanOrEqual(32);
    }
    await expect(result).resolves.toBe("completed");
    expect(maximumPending).toBeLessThanOrEqual(32);
    expect(sent.map((input) => [input.type, input.key])).toEqual(
      [...text].flatMap((key) => [
        ["keyDown", key],
        ["keyUp", key],
      ]),
    );
  } finally {
    controller.abort();
    for (const reply of held.splice(0)) reply.resolve();
    // The baseline's already-started stroke can still submit its second native command.
    await nativeTurn();
    for (const reply of held.splice(0)) reply.resolve();
    await result;
  }
});

it("a failed reply stops future input but drains other submitted replies before retiring its port", async () => {
  const controller = new AbortController();
  const held: Array<ReturnType<typeof gate<void>>> = [];
  let sent = 0;
  let detached = false;
  let completed = false;

  const keyboard = scriptedKeyboard(
    () => {
      const reply = gate<void>();

      held.push(reply);
      sent++;

      return reply.promise;
    },
    {
      detach: async () => {
        detached = true;
      },
    },
  );

  const result = keyboard
    .type("abcdefghijklmnopqrstuvwxyz", undefined, cancellableTicket(controller), undefined, target)
    .then(
      () => ({ success: true }),
      (cause: unknown) => ({ success: false, cause }),
    )
    .finally(() => {
      completed = true;
    });

  try {
    await nativeTurn();
    expect(held.length).toBeGreaterThan(2);
    const firstWindow = sent;

    held[0]?.reject(new Error("lost key reply"));
    await nativeTurn();
    expect(sent).toBe(firstWindow);
    expect(completed).toBe(false);
    expect(detached).toBe(false);
    for (const reply of held.splice(1)) reply.resolve();
    await expect(result).resolves.toMatchObject({
      success: false,
      cause: { reason: { _tag: "Provider" } },
    });
    expect(sent).toBe(firstWindow);
    expect(detached).toBe(true);
  } finally {
    controller.abort();
    for (const reply of held.splice(0)) reply.resolve();
    await nativeTurn();
    for (const reply of held.splice(0)) reply.resolve();
    await result;
  }
});

it("a fence between characters stops the rest of a run of text", async () => {
  const sent: KeyInput[] = [];
  let fenceAfter = 2;
  let fenced = false;
  let characters = 0;

  const keyboard = scriptedKeyboard(async (_method, input) => {
    sent.push(input ?? {});
    if (input?.type === "keyUp" || (input?.type === undefined && input?.text !== undefined)) {
      characters++;
      // The owner is fenced while this complete character is on its way.
      if (characters === fenceAfter) fenced = true;
    }
  });

  const ticket: Ticket = {
    ...ticketFor(new AbortController().signal),
    check: () => {
      if (fenced) throw new Error("fenced");
    },
  };

  await expect(keyboard.type("abcd", undefined, ticket, undefined, target)).rejects.toBeDefined();
  // Characters are whole code points, and none follows the fence.
  expect(sent.filter((input) => input.type === "keyDown").map((input) => input.key)).toEqual([
    "a",
    "b",
  ]);

  fenced = false;
  fenceAfter = Number.POSITIVE_INFINITY;
  sent.length = 0;
  await keyboard.type("a🚆", undefined, ticket, undefined, target);
  expect(
    sent
      .filter((input) => input.type === "keyDown" || input.text !== undefined)
      .map((input) => input.key ?? input.text),
  ).toEqual(["a", "🚆"]);
});

it("authority loss during keydown leaves its unsent keyup and every subsequent input unsent", async () => {
  const controller = new AbortController();
  const sent: KeyInput[] = [];

  const keyboard = scriptedKeyboard(async (_method, input) => {
    sent.push(input ?? {});
    controller.abort();
  });

  await expect(
    keyboard.type("ab", undefined, cancellableTicket(controller), undefined, target),
  ).rejects.toBeDefined();
  expect(sent).toEqual([expect.objectContaining({ type: "keyDown", key: "a" })]);
});

it("canceled setup and failed detach retain typing capacity until that connection positively retires", async () => {
  const controller = new AbortController();
  const setup = gate<void>();
  let setups = 0;
  let detaches = 0;
  let inputs = 0;

  const keyboard = scriptedKeyboard(
    async () => {
      inputs++;
    },
    {
      setup: async () => {
        setups++;
        if (setups === 1) await setup.promise;
      },
      detach: async () => {
        detaches++;
        if (detaches === 1) throw new Error("detach unconfirmed");
      },
    },
  );

  const first = keyboard
    .type("a", undefined, cancellableTicket(controller), undefined, target)
    .then(
      () => "completed",
      () => "failed",
    );

  try {
    await nativeTurn();
    controller.abort();
    await expect(
      keyboard.type("b", undefined, ticketFor(new AbortController().signal), undefined, target),
    ).rejects.toMatchObject({
      reason: { _tag: "Busy" },
      outcome: "undispatched",
    });
    expect(setups).toBe(1);
    expect(inputs).toBe(0);
    setup.resolve();
    await expect(first).resolves.toBe("failed");
    await expect(
      keyboard.type("c", undefined, ticketFor(new AbortController().signal), undefined, target),
    ).rejects.toMatchObject({
      reason: { _tag: "Busy" },
      outcome: "undispatched",
    });
    expect(setups).toBe(1);
    expect(detaches).toBe(1);
    expect(inputs).toBe(0);
    // This is the private driver's positive connection-retirement notification, not a
    // timeout, canceled caller, or fabricated successful detach.
    (keyboard as typeof keyboard & { readonly retire: () => void }).retire();
    await keyboard.type("d", undefined, ticketFor(new AbortController().signal), undefined, target);
    expect(setups).toBe(2);
    expect(inputs).toBe(2);
  } finally {
    controller.abort();
    setup.resolve();
    await first;
  }
});

// Every key is held 20 ms, 30 ms after the last; the owner's clock moves only when it pauses.
const performedPlan = Effect.runSync(
  prepare(
    {
      motion: {
        ...DefaultMotionProfile,
        keys: {
          interval: { minMillis: 30, maxMillis: 30 },
          hold: { minMillis: 20, maxMillis: 20 },
        },
      },
      slips: { probability: 0 },
    },
    7,
    "keys",
  ),
);

const millis = (value: number) => BigInt(value) * 1_000_000n;

const performedTicket = (
  clock: { at: bigint },
  deadline: bigint,
  acknowledged: Array<bigint> = [],
  pause: () => Promise<void> = async () => {},
): Ticket => ({
  ...ticketFor(new AbortController().signal),
  acknowledge: () => {
    acknowledged.push(clock.at);
  },
  performance: {
    plan: performedPlan,
    now: () => clock.at,
    remainingTimeNanos: () => deadline - clock.at,
    pauseUntil: async (at) => {
      if (at >= deadline) throw new Error("over budget");
      if (at <= clock.at) return;
      await pause();
      clock.at = at;
    },
  },
});

const heldKeys = () => {
  const sent: Array<string> = [];
  const held: Array<ReturnType<typeof gate<void>>> = [];

  return {
    sent,
    held,
    keyboard: scriptedKeyboard(async () => {}, {
      keys: (command, key) => {
        const reply = gate<void>();

        sent.push(`${command}:${key}`);
        held.push(reply);

        return reply.promise;
      },
    }),
  };
};

it("a performed stroke releases its key after its hold, not after its key-down's reply", async () => {
  const { sent, held, keyboard } = heldKeys();
  const clock = { at: 0n };
  const acknowledged: Array<bigint> = [];

  const result = keyboard
    .type("A", undefined, performedTicket(clock, millis(10_000), acknowledged), undefined, target)
    .then(
      () => "completed",
      () => "failed",
    );

  await nativeTurn();
  // Shift and the key went down, were held their planned 20 ms and released, before any reply.
  expect(sent).toEqual(["down:Shift", "down:A", "up:A", "up:Shift"]);
  expect(clock.at).toBe(millis(20));
  // The stroke stays unresolved until its last release has answered.
  for (const reply of held.slice(0, 3)) reply.resolve();
  await nativeTurn();
  expect(acknowledged).toEqual([]);
  held[3]?.resolve();
  await expect(result).resolves.toBe("completed");
  expect(acknowledged.length).toBeGreaterThan(0);
});

it("a failed reply stops a performed stroke before its releases, after its other replies", async () => {
  const { sent, held, keyboard } = heldKeys();
  const hold = gate<void>();
  let settled = false;

  const result = keyboard
    .type(
      "A",
      undefined,
      performedTicket({ at: 0n }, millis(10_000), [], () => hold.promise),
      undefined,
      target,
    )
    .then(
      () => ({ success: true }),
      (cause: unknown) => ({ success: false, cause }),
    )
    .finally(() => {
      settled = true;
    });

  await nativeTurn();
  expect(sent).toEqual(["down:Shift", "down:A"]);
  held[0]?.reject(new Error("lost key reply"));
  hold.resolve();
  await nativeTurn();
  // Nothing is sent after the refusal, and the key-down still in flight is waited for.
  expect(sent).toEqual(["down:Shift", "down:A"]);
  expect(settled).toBe(false);
  held[1]?.resolve();
  await expect(result).resolves.toMatchObject({
    success: false,
    cause: { reason: { _tag: "Provider" } },
  });
  expect(sent).toEqual(["down:Shift", "down:A"]);
});

it("a performed run is charged by stroke size, refusing a shifted stroke a slow renderer cannot finish", async () => {
  // A renderer that takes 100 ms over each key event drains a lowercase stroke 180 ms after its
  // release. A shifted stroke has twice the events, so after "a" it is charged 400 ms, not 200.
  const slow = heldKeys();
  const clock = { at: 0n };

  const refused = slow.keyboard
    .type("aA", undefined, performedTicket(clock, millis(500)), undefined, target)
    .then(
      () => ({ success: true }),
      (cause: unknown) => ({ success: false, cause }),
    );

  await nativeTurn();
  expect(slow.sent).toEqual(["down:a", "up:a"]);
  clock.at = millis(200);
  for (const reply of slow.held.splice(0)) reply.resolve();
  await nativeTurn();
  expect(slow.sent).toEqual(["down:a", "up:a"]);
  for (const reply of slow.held.splice(0)) reply.resolve();
  await expect(refused).resolves.toMatchObject({
    success: false,
    cause: { reason: { _tag: "TimingBudgetExceeded" } },
  });

  // Over a 100 ms round trip, a shifted stroke drains like the shifted stroke before it: its
  // modifiers do not multiply the round trip once a stroke of its size has been measured.
  const distant = heldKeys();
  const later = { at: 0n };

  const typed = distant.keyboard
    .type("AB", undefined, performedTicket(later, millis(300)), undefined, target)
    .then(
      () => "completed",
      () => "failed",
    );

  await nativeTurn();
  expect(distant.sent).toEqual(["down:Shift", "down:A", "up:A", "up:Shift"]);
  later.at = millis(120);
  for (const reply of distant.held.splice(0)) reply.resolve();
  await nativeTurn();
  expect(distant.sent.slice(4)).toEqual(["down:Shift", "down:B", "up:B", "up:Shift"]);
  later.at = millis(260);
  for (const reply of distant.held.splice(0)) reply.resolve();
  await expect(typed).resolves.toBe("completed");
});
