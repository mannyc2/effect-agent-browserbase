import { Reasons } from "../../Errors.ts";
import { failure } from "./NativeCalls.ts";
import type { Ticket } from "./Owner.ts";

/** Validate the original owner's bridge before a performed action can submit any mutation. */
export const ownerPacing = (ticket: Ticket) => {
  if (
    ticket.monotonicTimeNanosUnsafe === undefined ||
    ticket.remainingTimeNanos === undefined ||
    ticket.pauseUntil === undefined
  )
    throw failure(Reasons.Unsupported.make({}), "undispatched");
  const remainingTimeNanos = ticket.remainingTimeNanos;
  const now = ticket.monotonicTimeNanosUnsafe;

  return {
    now,
    pauseUntil: ticket.pauseUntil,
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
