/**
 * The one error every browser operation fails with.
 *
 * `reason` says what went wrong and `dispatched` says whether input or a navigation reached the
 * browser first. When `dispatched` is true the action may have taken effect, so it must not be
 * retried blindly: look at the page again first.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

/** The operation did not finish in time. */
export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  millis: Schema.Finite,
}) {
  override get message() {
    return `timed out after ${this.millis} ms`;
  }
}

/** A ref from an earlier snapshot no longer names an element on the page. */
export class StaleRef extends Schema.TaggedError<StaleRef>()("StaleRef", {
  ref: Schema.String,
}) {
  override get message() {
    return `${this.ref} is not on the page any more; take a new snapshot`;
  }
}

/** What the operation looked for is not on the page. */
export class NotFound extends Schema.TaggedError<NotFound>()("NotFound", {
  target: Schema.String,
}) {
  override get message() {
    return `${this.target} was not found`;
  }
}

/** The element exists but cannot take this input: covered, disabled, hidden or the wrong kind. */
export class NotActionable extends Schema.TaggedError<NotActionable>()("NotActionable", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** A navigation failed, for example on a DNS error or a refused connection. */
export class NavigationFailed extends Schema.TaggedError<NavigationFailed>()("NavigationFailed", {
  url: Schema.String,
  detail: Schema.String,
}) {
  override get message() {
    return `could not load ${this.url}: ${this.detail}`;
  }
}

/** The page or the browser is closed. */
export class Closed extends Schema.TaggedError<Closed>()("Closed", {}) {
  override get message() {
    return "the page is closed";
  }
}

/** The request itself is invalid, such as a ref that is not a ref or a point off the screen. */
export class InvalidRequest extends Schema.TaggedError<InvalidRequest>()("InvalidRequest", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

/** The input policy refused the action before any input was sent. */
export class PolicyDenied extends Schema.TaggedError<PolicyDenied>()("PolicyDenied", {
  detail: Schema.String,
}) {
  override get message() {
    return `the input policy denied this action: ${this.detail}`;
  }
}

/** The input policy did not release its hold within its own bound. */
export class PolicyTimeout extends Schema.TaggedError<PolicyTimeout>()("PolicyTimeout", {
  millis: Schema.Finite,
}) {
  override get message() {
    return `the input policy did not allow this action within ${this.millis} ms`;
  }
}

/** The requested event cursor fell behind the browser's bounded replay history. */
export class EventHistoryExpired extends Schema.TaggedError<EventHistoryExpired>()(
  "EventHistoryExpired",
  {
    after: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    oldest: Schema.Int.check(Schema.isGreaterThan(0)),
    latest: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  },
) {
  override get message() {
    return `event history after ${this.after} expired; retained sequences are ${this.oldest}–${this.latest}`;
  }
}

/** The browser, the connection or the provider failed in a way the other reasons do not cover. */
export class Failed extends Schema.TaggedError<Failed>()("Failed", {
  detail: Schema.String,
}) {
  override get message() {
    return this.detail;
  }
}

export const Reason = Schema.Union([
  Timeout,
  StaleRef,
  NotFound,
  NotActionable,
  NavigationFailed,
  Closed,
  InvalidRequest,
  PolicyDenied,
  PolicyTimeout,
  EventHistoryExpired,
  Failed,
]);

export type Reason = typeof Reason.Type;

export class BrowserError extends Schema.TaggedError<BrowserError>()("BrowserError", {
  operation: Schema.String,
  reason: Reason,
  dispatched: Schema.Boolean,
}) {
  override get message() {
    const effect = this.dispatched ? " (it may have taken effect)" : "";

    return `${this.operation} failed: ${this.reason.message}${effect}`;
  }
}

/** Build a `BrowserError` for an operation that sent nothing to the page. */
export const undispatched = (operation: string, reason: Reason): BrowserError =>
  new BrowserError({ operation, reason, dispatched: false });

/** Build a `BrowserError` for an operation that may have reached the page. */
export const dispatched = (operation: string, reason: Reason): BrowserError =>
  new BrowserError({ operation, reason, dispatched: true });
