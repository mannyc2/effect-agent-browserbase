import { BrowserError, Reasons, type BrowserReason } from "effect-browser/errors";

import type { ClientError } from "../../Errors.ts";

type RequestFailure = Pick<ClientError, "reason" | "outcome" | "status" | "retryAfterMillis">;

/** Only control-plane reads reach this bridge, before a modeled browser action dispatches. */
export const browserRequestFailure = (
  operation: "connect" | "reconnect" | "live-view",
  error: RequestFailure,
): BrowserError => {
  const reason = (): BrowserReason => {
    switch (error.reason) {
      case "configuration":
        return Reasons.Configuration.make({});
      case "authorization":
        return Reasons.Authorization.make({});
      case "rate-limited":
        return Reasons.RateLimited.make(
          error.retryAfterMillis === undefined ? {} : { retryAfterMillis: error.retryAfterMillis },
        );
      case "not-found":
        return Reasons.NotFound.make({});
      case "active":
        return Reasons.Active.make({});
      case "disabled":
        return Reasons.Disabled.make({});
      case "expired":
        return Reasons.Expired.make({});
      case "transport":
        return Reasons.Transport.make(error.status === undefined ? {} : { status: error.status });
      case "timeout":
        return Reasons.Timeout.make({});
      case "malformed":
        return Reasons.Malformed.make({});
      case "unsafe-url":
        return Reasons.UnsafeUrl.make({});
      case "content-type":
        return Reasons.ContentType.make({});
      // A control-plane limit carries no measured bound. Do not invent native Limit facts.
      case "limit":
      case "provider":
        return Reasons.Provider.make(error.status === undefined ? {} : { status: error.status });
    }
  };

  return BrowserError.make({
    operation,
    reason: reason(),
    outcome: error.outcome ?? "undispatched",
  });
};
