/**
 * The one error every browser operation fails with.
 *
 * `reason` says what went wrong and `dispatched` says whether the action's own input (a press,
 * key, wheel, selection or hover, not the pointer travelling toward a press) or a navigation
 * reached the browser first. `consequence` says what that leaves: what was lost, and whether the
 * call can be repeated. `message` is a sentence for operators.
 *
 * @since 0.3.0
 */
import { Schema } from "effect";

import { DisconnectCause } from "./BrowserEvent.ts";

/** The operation did not finish in time. */
export class Timeout extends Schema.TaggedError<Timeout>()("Timeout", {
  millis: Schema.Finite,
}) {
  override get message() {
    return `timed out after ${this.millis} ms`;
  }
}

/**
 * The operation waited its turn behind others on its page and was not given one in time, or was
 * asked to fail fast: the page may be well, only busy.
 */
export class Busy extends Schema.TaggedError<Busy>()("Busy", {
  waitedMillis: Schema.Finite,
  /** The operations ahead of it: those holding the page and those asked before it. */
  ahead: Schema.Int,
}) {
  override get message() {
    const others = this.ahead === 1 ? "operation" : "operations";

    return `the page was busy: it waited ${this.waitedMillis} ms behind ${this.ahead} other ${others}`;
  }
}

/** The browser has as many pages open as `maxPages` allows, and none closed in time. */
export class Limit extends Schema.TaggedError<Limit>()("Limit", {
  maxPages: Schema.Int,
}) {
  override get message() {
    return `the browser already has ${this.maxPages} pages open, as many as it allows`;
  }
}

/** A ref from an earlier snapshot no longer names an element on the page. */
export class StaleRef extends Schema.TaggedError<StaleRef>()("StaleRef", {
  ref: Schema.String,
}) {
  override get message() {
    return `${this.ref} is not on the page any more`;
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

const closedBy = {
  page: "the page was closed",
  crashed: "the page crashed",
  connection: "the connection to the browser was lost",
  session: "the browser's session ended",
  released: "the browser was released",
};

/**
 * The page is gone: it was closed (`page`) or crashed, or its browser was lost for one of the
 * browser's `DisconnectCause`s.
 */
export class Closed extends Schema.TaggedError<Closed>()("Closed", {
  cause: Schema.Literals(["page", "crashed", ...DisconnectCause.literals]),
}) {
  override get message() {
    return closedBy[this.cause];
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
  /** What made the policy deny, such as the failure of the judge it asked. */
  cause: Schema.optional(Schema.Defect()),
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
  Busy,
  Limit,
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
    return `${this.operation} failed${this.dispatched ? " after it was sent" : ""}: ${this.reason.message}`;
  }
}

/**
 * What a failure leaves. `lost` is `"page"` when the page is gone and its browser stands, and
 * `"session"` when the browser is gone with its pages. `repeat` says whether the call can be made
 * again, on what still stands: `"safe"`, as nothing reached the browser; `"check"`, as it may have
 * taken effect, so look first; `"pointless"`, as it fails again unless something changes, such as
 * a new ref; or `"resume"`, reading events again from a newer cursor.
 */
export interface Consequence {
  readonly lost: "nothing" | "page" | "session";
  readonly repeat: "safe" | "check" | "pointless" | "resume";
}

/** What `error` leaves, from its reason and whether it was dispatched alone. */
export const consequence = ({ reason, dispatched }: BrowserError): Consequence => {
  const repeat = dispatched ? "check" : "safe";

  switch (reason._tag) {
    case "Closed":
      return {
        lost: reason.cause === "page" || reason.cause === "crashed" ? "page" : "session",
        repeat,
      };
    case "Busy":
    case "Timeout":
    case "Failed":
    case "NavigationFailed":
      return { lost: "nothing", repeat };
    case "EventHistoryExpired":
      return { lost: "nothing", repeat: "resume" };
    case "StaleRef":
    case "NotFound":
    case "NotActionable":
    case "InvalidRequest":
    case "Limit":
    case "PolicyDenied":
    case "PolicyTimeout":
      return { lost: "nothing", repeat: "pointless" };
  }
};
