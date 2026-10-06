import { type Clock, Duration, Effect, Exit } from "effect";

import { type BrowserError, Reasons } from "../../Errors.ts";
import { failure, NativeEffectFailure } from "./NativeCalls.ts";
import type { Performance, Ticket } from "./Owner.ts";

/**
 * The one bridge from performed pacing back into Effect. A performed input paces between the
 * native commands of a single admitted operation, inside the Promise driver that the Playwright
 * and scripted engines share, so its pauses must be awaitable there. The sleep runs on the
 * owner's captured Clock, the clock that stamps the operation's evidence and that tests control,
 * and the admission's signal interrupts it; a failed Exit returns to the driver unchanged.
 * Scheduling the pauses in Effect instead would need the driver to expose each native command on
 * its own: a driver redesign, not a change to how pacing waits.
 */
const sleepOnOwnerClock = async (clock: Clock.Clock, nanos: bigint, signal: AbortSignal) => {
  // oxlint-disable-next-line no-restricted-properties -- the native Promise callback awaits only its captured Clock and carries the original Exit back to Effect
  const exit = await Effect.runPromiseExit(clock.sleep(Duration.nanos(nanos)), { signal });

  if (Exit.isFailure(exit)) throw NativeEffectFailure.make({ cause: exit.cause });
};

/**
 * The pacing an admitted performed operation grants its driver: the original owner's clock, the
 * time left before the operation's deadline, and pauses on that clock which the admission's
 * signal interrupts. A pause that would end at or past the deadline is refused before it starts.
 */
export const grantedPacing = (owner: {
  readonly clock: Clock.Clock;
  readonly deadlineNanos: () => bigint;
  readonly signal: AbortSignal;
  readonly check: () => void;
  readonly overBudget: () => BrowserError;
}): Pick<Performance, "now" | "remainingTimeNanos" | "pauseUntil"> => ({
  now: () => owner.clock.monotonicTimeNanosUnsafe(),
  remainingTimeNanos: () => owner.deadlineNanos() - owner.clock.monotonicTimeNanosUnsafe(),
  pauseUntil: async (atNanos) => {
    owner.check();
    if (atNanos >= owner.deadlineNanos()) throw owner.overBudget();
    const remaining = atNanos - owner.clock.monotonicTimeNanosUnsafe();

    if (remaining > 0n) await sleepOnOwnerClock(owner.clock, remaining, owner.signal);
    owner.check();
  },
});

/** The most recent single-call round trips a Page keeps, newest last. */
const keptRoundTrips = 16;

const roundTrips = new WeakMap<object, Array<bigint>>();

/**
 * Times one protocol call that costs a single round trip to the Page's browser, and keeps the
 * sample for every later performed charge on that Page. Only calls known to take one round
 * trip belong here: a read in a child frame can take several, which would inflate every charge.
 */
export const timedRoundTrip = async <A>(
  page: object,
  now: () => bigint,
  call: () => Promise<A>,
): Promise<A> => {
  const started = now();
  const result = await call();
  const samples = roundTrips.get(page) ?? [];

  samples.push(now() - started);
  if (samples.length > keptRoundTrips) samples.shift();
  roundTrips.set(page, samples);

  return result;
};

/**
 * What a Page's recent round trips say, in milliseconds, or 0 before any was measured. `typical`
 * (the median) charges work about to be dispatched, which one fast or slow sample cannot move;
 * `fastest` bounds work further ahead, which must not be refused for one stalled reply.
 */
export const roundTripOf = (
  page: object,
): { readonly typical: number; readonly fastest: number } => {
  const samples = [...(roundTrips.get(page) ?? [])].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
  const [fastest] = samples;
  // The upper median: with an even count, work about to be dispatched takes the slower middle.
  const typical = samples[Math.floor(samples.length / 2)];

  return {
    typical: typical === undefined ? 0 : Number(typical) / 1e6,
    fastest: fastest === undefined ? 0 : Number(fastest) / 1e6,
  };
};

/**
 * The round trips a performed click is charged before dispatch. Over relays adding 18 to 70 ms
 * each way, Playwright 1.63's positioned click took 17 to 23 round trips in all, 14 to 19 of them
 * checking the node before its first input event, counted in median round trips. A deadline
 * inside those checks closes the Page over input never sent, while a refusal leaves it open, so
 * the charge covers the most checking measured, at the cost of refusing a click that had a few
 * round trips to spare.
 */
const performedClickRoundTrips = 20;

/**
 * What a performed click is charged besides its round trips. Playwright's stability check waits
 * for the node across animation frames, which no round trip measures: without a relay, a whole
 * click took 57 ms.
 */
const performedClickFloorMillis = 100;

/**
 * What a performed click on `page` must still have before its dispatch is marked: its fixed
 * floor and its round trips at the Page's typical one, the statistic they were counted in.
 */
export const performedClickMillis = (page: object) =>
  performedClickFloorMillis + performedClickRoundTrips * roundTripOf(page).typical;

/** A performed admission's ticket: the owner's pacing is always present on it. */
export type PerformedTicket = Ticket & { readonly performance: Performance };

/** Whether this admission is performed, which narrows the ticket to carry the owner's pacing. */
export const isPerformed = (ticket: Ticket): ticket is PerformedTicket =>
  ticket.performance !== undefined;

/** The original owner's pacing for a performed admission, checked before any input is planned. */
export const ownerPacing = (ticket: PerformedTicket) => {
  const { now, pauseUntil, remainingTimeNanos } = ticket.performance;

  return {
    now,
    pauseUntil,
    requireDuration: (durationMillis: number) => {
      ticket.check();
      if (!Number.isFinite(durationMillis) || durationMillis < 0)
        throw failure(Reasons.Malformed.make({}), ticket.outcome ?? "undispatched");
      if (BigInt(Math.round(durationMillis * 1_000_000)) >= remainingTimeNanos())
        throw failure(Reasons.TimingBudgetExceeded.make({}), ticket.outcome ?? "undispatched");
    },
    /** Refuses, before more input, work the original deadline would not see finish by `atNanos`. */
    requireBy: (atNanos: bigint) => {
      ticket.check();
      if (atNanos >= now() + remainingTimeNanos())
        throw failure(Reasons.TimingBudgetExceeded.make({}), ticket.outcome ?? "undispatched");
    },
  };
};
