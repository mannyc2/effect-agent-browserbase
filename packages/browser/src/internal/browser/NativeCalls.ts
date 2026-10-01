import { Exit, Schema } from "effect";

import {
  BrowserError,
  BrowserOutcome,
  Reasons,
  type BrowserOperation,
  type BrowserReason,
} from "../../Errors.ts";
import type { ReadTicket } from "./Owner.ts";

/** Carries a captured Clock defect/interruption across the native Promise boundary unchanged. */
export class NativeEffectFailure extends Schema.TaggedError<NativeEffectFailure>()(
  "NativeEffectFailure",
  { cause: Schema.Cause(Schema.Never, Schema.Unknown) },
) {}

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
  const decoded = Schema.decodeUnknownExit(codec)(raw);

  // A schema issue and a throw while reading the reply are both a malformed reply.
  if (Exit.isFailure(decoded)) throw failure(Reasons.Malformed.make({}));

  return decoded.value;
};

// oxlint-disable-next-line no-control-regex -- matches the terminal escape codes Playwright colours its call log with
const escapes = /\u001b\[[0-9;]*m/g;

const addresses = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]*/gi;

/**
 * An address keeps only its origin: a path, query or user name can carry a credential, such as
 * a DevTools endpoint's browser id or a provider's signed connection URL.
 */
const originOf = (address: string): string => {
  try {
    const parsed = new URL(address);

    return parsed.host === "" ? `${parsed.protocol}…` : `${parsed.protocol}//${parsed.host}/…`;
  } catch {
    return "…";
  }
};

/**
 * The first line of what the engine said, which names the call and its reason. Playwright's
 * call log below it repeats addresses, selectors and endpoints, so it never leaves.
 */
export const nativeDetail = (error: unknown): string | undefined => {
  const message =
    error instanceof Error ? error.message : typeof error === "string" ? error : undefined;

  const line = message?.replace(escapes, "").split("\n", 1)[0]?.trim();

  if (line === undefined || line === "") return undefined;

  return line.replace(addresses, originOf).slice(0, 512);
};

/** A raw failure the engine raised, with what it said about it. */
export const providerReason = (error: unknown) => {
  const detail = nativeDetail(error);

  return Reasons.Provider.make(detail === undefined ? {} : { detail });
};

/**
 * No raw exception from Playwright crosses this private boundary: only its sanitized first line
 * does, as the provider reason's detail. A ticket's own fence is already a public error and
 * passes through with the operation the owner gave it.
 */
export const sanitize = <A>(action: () => Promise<A>): Promise<A> =>
  Promise.resolve()
    .then(action)
    .catch((error: unknown) => {
      throw Schema.is(NativeEffectFailure)(error) ||
        Schema.is(BrowserError)(error) ||
        Schema.is(NativeFailure)(error)
        ? error
        : failure(providerReason(error));
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
