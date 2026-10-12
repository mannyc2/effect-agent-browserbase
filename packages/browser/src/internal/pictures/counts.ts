/** Bounded capture-loss and paint-gap statistics on the owning host clock. */
import { Duration } from "effect";

// Paint-time gaps between consecutive delivered frames.
const paintGaps = () => {
  let count = 0;
  let totalMillis = 0;
  let minMillis: number | null = null;
  let maxMillis: number | null = null;
  let lastMillis: number | null = null;

  return {
    add: (gap: number) => {
      count++;
      totalMillis += gap;
      minMillis = minMillis === null ? gap : Math.min(minMillis, gap);
      maxMillis = maxMillis === null ? gap : Math.max(maxMillis, gap);
      lastMillis = gap;
    },
    snapshot: () => ({ count, totalMillis, minMillis, maxMillis, lastMillis }),
  };
};

const none = () => ({
  received: 0,
  accepted: 0,
  late: 0,
  missingTimestamp: 0,
  foreignSize: 0,
  duringPictures: 0,
  lost: 0,
});

type Counted = keyof ReturnType<typeof none>;

/** How far back a window of capture counts can reach. */
export const countsKept = Duration.minutes(1);

/**
 * A capture's counts and paint gaps over its page's life, and each with when it happened on the
 * owner's clock for the latest minute, so a window of them can be read.
 */
export const tally = (now: () => number) => {
  const totals = none();
  const gaps = paintGaps();

  let recent: Array<{
    readonly at: number;
    readonly counted: Counted | "gap";
    readonly n: number;
  }> = [];

  let oldest = 0;

  const note = (counted: Counted | "gap", n: number) => {
    const at = now();

    recent.push({ at, counted, n });
    while ((recent[oldest]?.at ?? at) < at - Duration.toMillis(countsKept)) oldest++;
    // Shed what is out of reach once it is half the log.
    if (oldest > recent.length / 2) {
      recent = recent.slice(oldest);
      oldest = 0;
    }
  };

  return {
    count: (counted: Counted, n = 1) => {
      totals[counted] += n;
      note(counted, n);
    },
    gap: (millis: number) => {
      gaps.add(millis);
      note("gap", millis);
    },
    /** Lifetime counts, or those of the latest `windowMillis`, at most a minute. */
    read: (windowMillis?: number) => {
      if (windowMillis === undefined) return { ...totals, gaps: gaps.snapshot() };
      const counts = none();
      const windowed = paintGaps();
      const since = now() - windowMillis;

      for (const { at, counted, n } of recent.slice(oldest)) {
        if (at < since) continue;
        if (counted === "gap") windowed.add(n);
        else counts[counted] += n;
      }

      return { ...counts, gaps: windowed.snapshot() };
    },
  };
};
