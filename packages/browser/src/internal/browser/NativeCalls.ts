import { Option, Schema } from "effect";

import {
  BrowserError,
  BrowserOutcome,
  Reasons,
  type BrowserOperation,
  type BrowserReason,
} from "../../Errors.ts";
import type { ReadTicket } from "./Owner.ts";

/**
 * A native step failed. It names no operation: the owner stamps the one the caller asked for
 * when it admits the work, so a step's own vocabulary can never become public API.
 */
export class NativeFailure extends Schema.TaggedError<NativeFailure>()("NativeFailure", {
  reason: BrowserError.fields.reason,
  // Some native helpers run both before and after dispatch. Only their owner has that evidence.
  outcome: Schema.optionalKey(BrowserOutcome),
}) {}

/**
 * The only way a native failure becomes public. A fenced ticket already speaks publicly and
 * passes through with the operation the owner gave it; a native failure keeps its reason and
 * takes the caller's operation; anything else is the caller's fallback.
 */
export const publicError = (
  error: unknown,
  operation: BrowserOperation,
  fallback: Pick<BrowserError, "reason" | "outcome">,
): BrowserError => {
  if (Schema.is(BrowserError)(error)) return error;
  const known = Schema.is(NativeFailure)(error) ? error : fallback;

  return BrowserError.make({
    operation,
    reason: known.reason,
    outcome: known.outcome ?? fallback.outcome,
  });
};

/** Shared by the Playwright driver's seams, so every native call fails in the same vocabulary. */
export const failure = (reason: BrowserReason, outcome?: BrowserOutcome) =>
  NativeFailure.make({ reason, ...(outcome === undefined ? {} : { outcome }) });

export const safeDecode = <A>(codec: Schema.Codec<A, unknown, never, never>, raw: unknown): A => {
  const decoded = Schema.decodeUnknownOption(codec)(raw);

  if (Option.isNone(decoded)) throw failure(Reasons.Malformed.make({}));

  return decoded.value;
};

/**
 * No raw exception from Playwright crosses this private boundary. A ticket's own fence is
 * already a public error and passes through with the operation the owner gave it.
 */
export const sanitize = <A>(action: () => Promise<A>): Promise<A> =>
  Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      throw Schema.is(BrowserError)(error) || Schema.is(NativeFailure)(error)
        ? error
        : failure(Reasons.Provider.make({}));
    });

export const closeWithin = async (
  action: () => Promise<unknown>,
  milliseconds = 2000,
): Promise<void> => {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    await Promise.race([
      Promise.resolve().then(action),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(failure(Reasons.Timeout.make({}))), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// The native timeout is finite as well as Effect's authoritative deadline. It cannot undo dispatch.
export const timeout = (ticket: ReadTicket) => {
  ticket.check();

  return ticket.remainingMillis();
};
