import type { TerminalReason } from "../../TimelineData.ts";

/** Original bounded logical owners finish their evidence before the domain's one terminal. */
export const makeRetirement = (complete: (reason: TerminalReason) => void) => {
  let count = 0;
  let requested: TerminalReason | null = null;
  let finished = false;

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
      finish();
    },
  };
};
