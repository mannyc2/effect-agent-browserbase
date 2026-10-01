import { Reasons } from "../../Errors.ts";
import { failure } from "./NativeCalls.ts";
import type { Performance, Ticket } from "./Owner.ts";

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
