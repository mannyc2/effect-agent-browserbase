import { Deferred, Effect } from "effect";

import type { TerminalReason } from "../../TimelineData.ts";

/** Original bounded logical owners finish their evidence before the domain's one terminal. */
export const makeRetirement = (complete: (reason: TerminalReason) => void) => {
  let count = 0;
  let requested: TerminalReason | null = null;
  let finished = false;
  const signal = Deferred.makeUnsafe<void>();

  const finish = () => {
    if (finished || requested === null || count !== 0) return;
    finished = true;
    complete(requested);
  };

  return {
    retain: (): (() => void) => {
      if (finished) return () => {};
      count++;
      let released = false;

      return () => {
        if (released) return;
        released = true;
        count--;
        finish();
      };
    },
    request: (reason: TerminalReason): void => {
      requested ??= reason;
      // Waiters resume on their own fibers, never inside the native callback that retires.
      Deferred.doneUnsafe(signal, Effect.yieldNow);
      finish();
    },
    /** Completes once retirement is requested, before retained owners have finished. */
    requested: Deferred.await(signal),
  };
};
