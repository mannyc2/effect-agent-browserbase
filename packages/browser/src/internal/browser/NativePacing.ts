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
