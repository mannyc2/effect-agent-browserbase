import { expect, it } from "@effect/vitest";

import {
  performedClickMillis,
  roundTripOf,
  timedRoundTrip,
} from "../src/internal/browser/NativePacing.ts";

const millis = (value: number) => BigInt(value) * 1_000_000n;

/** Records one round trip of `elapsed` milliseconds on `page`, on a clock the test advances. */
const sample = (page: object, elapsed: number) => {
  const clock = { at: 0n };

  return timedRoundTrip(
    page,
    () => clock.at,
    async () => {
      clock.at += millis(elapsed);
    },
  );
};

it("a Page's round trips charge dispatch at their upper median and work ahead at the fastest", async () => {
  const page = {};

  expect(roundTripOf(page)).toEqual({ typical: 0, fastest: 0 });

  // One stalled reply among quick ones moves neither statistic far.
  for (const elapsed of [72, 230, 70]) await sample(page, elapsed);
  expect(roundTripOf(page)).toEqual({ typical: 72, fastest: 70 });

  // With an even count, work about to be dispatched takes the slower middle.
  await sample(page, 75);
  expect(roundTripOf(page)).toEqual({ typical: 75, fastest: 70 });

  // Each Page keeps its own.
  expect(roundTripOf({})).toEqual({ typical: 0, fastest: 0 });
});

it("a Page keeps only its sixteen most recent round trips", async () => {
  const page = {};

  for (let index = 0; index < 16; index++) await sample(page, 10);
  for (let index = 0; index < 16; index++) await sample(page, 80);
  expect(roundTripOf(page)).toEqual({ typical: 80, fastest: 80 });
});

it("a performed click is charged twenty typical round trips, not the fastest one", async () => {
  const page = {};

  // Jitter: a box read answered in 70 ms, the viewport and a second box read in 200 and 210.
  for (const elapsed of [200, 70, 210]) await sample(page, elapsed);
  expect(performedClickMillis(page)).toBe(100 + 20 * 200);
  expect(performedClickMillis({})).toBe(100);
});
