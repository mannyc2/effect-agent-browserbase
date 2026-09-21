import { Schema } from "effect";

import { BrowserError } from "../../Errors.ts";
import type { Ticket } from "./Owner.ts";

/** Shared by the Playwright driver's seams, so every native call fails in the same vocabulary. */
export const failure = (
  operation: string,
  reason: BrowserError["reason"],
  outcome?: BrowserError["outcome"],
) => BrowserError.make({ operation, reason, ...(outcome === undefined ? {} : { outcome }) });

export const safeDecode = <A>(
  codec: Schema.Codec<A, unknown, never, never>,
  raw: unknown,
  operation: string,
): A => {
  try {
    return Schema.decodeUnknownSync(codec)(raw);
  } catch {
    throw failure(operation, "malformed");
  }
};

/** No raw exception from Playwright is allowed to cross this private boundary. */
export const sanitize = <A>(operation: string, action: () => Promise<A>): Promise<A> =>
  Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      throw Schema.is(BrowserError)(error) ? error : failure(operation, "provider");
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
        timer = setTimeout(() => reject(failure("native-close", "timeout")), milliseconds);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

// The native timeout is finite as well as Effect's authoritative deadline. It cannot undo dispatch.
export const timeout = (ticket: Ticket) => {
  ticket.check();

  return ticket.remainingMillis();
};
